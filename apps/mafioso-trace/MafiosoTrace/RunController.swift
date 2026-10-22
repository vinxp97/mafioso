import Darwin
import Foundation
import MafiosoTraceCore

enum RunPhase: Equatable {
    case idle
    case starting
    case running
    case exited(Int32)
    case stopped
}

/// One harness child. Secrets are copied into the process environment and into the redaction list, never into argv or the log.
@MainActor
final class RunController: ObservableObject {
    @Published private(set) var phase: RunPhase = .idle
    @Published private(set) var logText = ""
    @Published private(set) var logTick = 0
    @Published var confirmName: String?
    @Published var confirmWarning: String?
    @Published var confirmDraft = ""

    var isRunning: Bool {
        switch phase {
        case .starting, .running: return true
        default: return false
        }
    }

    var statusText: String {
        switch phase {
        case .idle: return "Idle"
        case .starting: return "Starting"
        case .running: return "Running"
        case .exited(let code): return "Exited \(code)"
        case .stopped: return "Stopped"
        }
    }

    private var child: GroupedChild?
    private var tracksContainer = false
    private var launchEnvironment: [String: String] = [:]
    private var outBuffer = LineBuffer()
    private var errBuffer = LineBuffer()
    private var secretSnapshot: [String] = []
    private var knownIDs: Set<String> = []
    private var adopted = false
    private var pollTask: Task<Void, Never>?
    private var prepTask: Task<Void, Never>?
    private var prepRunner: ProcessCommandRunner?
    /// Written only after the container script prints `run:`, which is after a successful image build.
    private var pendingImageStamp: (path: String, commit: String)?
    /// Set when Stop or Stop & Quit asked for the full halt. A later natural exit still reads Exited.
    private var stopping = false
    private var haltTask: Task<Void, Never>?
    private let logCap = 100_000

    func requestStart(config: AppConfigController, store: GameStore) {
        guard !isRunning else { return }
        let profile = config.selectedProfile
        let inference = config.config.inference
        let secrets = config.launchSecrets(environment: profile.id, provider: inference.provider)
        let decision = StartPolicy.decide(
            profile: profile,
            inference: inference,
            secrets: secrets,
            repository: config.config.repositoryPath,
            source: config.config.repositorySource
        )
        switch decision {
        case .blocked:
            return
        case .needsConfirmation(let name, let warning):
            confirmName = name
            confirmWarning = warning
            confirmDraft = ""
        case .ready:
            begin(config: config, store: store, profile: profile, secrets: secrets)
        }
    }

    func confirm(config: AppConfigController, store: GameStore) {
        guard !isRunning, let name = confirmName else { return }
        let profile = config.selectedProfile
        guard profile.id.confirmName == name else { return }
        guard ProdGate.accepts(environment: profile.id, typed: confirmDraft) else { return }
        let secrets = config.launchSecrets(environment: profile.id, provider: config.config.inference.provider)
        confirmName = nil
        begin(config: config, store: store, profile: profile, secrets: secrets)
    }

    func cancelConfirm() {
        confirmName = nil
        confirmDraft = ""
        confirmWarning = nil
    }

    /// Same halt as Stop & Quit: SIGTERM the group, wait, SIGKILL, then stop a local container.
    func stop() {
        guard isRunning else { return }
        beginHalt()
    }

    /// SIGTERM the process group, wait, SIGKILL if needed, then stop the local container.
    func stopForQuit() async {
        guard isRunning || haltTask != nil else { return }
        await beginHalt().value
    }

    @discardableResult
    private func beginHalt() -> Task<Void, Never> {
        if let haltTask { return haltTask }
        stopping = true
        prepTask?.cancel()
        prepRunner?.cancel()
        let request = ShutdownRequest(
            pid: child?.pid ?? 0,
            stopContainer: tracksContainer,
            containerName: RunShutdown.containerName(environment: launchEnvironment)
        )
        let terminator = AppRunTerminator(child: child)
        if child == nil, phase == .starting {
            pendingImageStamp = nil
            phase = .stopped
            appendLine("Stopped.")
        }
        let task = Task { @MainActor in
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                DispatchQueue.global(qos: .userInitiated).async {
                    RunShutdown.perform(request, using: terminator)
                    continuation.resume()
                }
            }
        }
        haltTask = task
        return task
    }

    private func begin(
        config: AppConfigController,
        store: GameStore,
        profile: EnvironmentProfile,
        secrets: LaunchSecrets
    ) {
        logText = ""
        logTick += 1
        outBuffer = LineBuffer()
        errBuffer = LineBuffer()
        secretSnapshot = secrets.values
        knownIDs = Set(store.games.map(\.id))
        adopted = false
        pendingImageStamp = nil
        stopping = false
        haltTask = nil
        phase = .starting
        appendLine("starting \(profile.id.displayName)")

        let checkout = CheckoutRequest(
            source: config.config.repositorySource,
            cacheRoot: TraceCaches.repos,
            stampRoot: TraceCaches.stamps,
            container: profile.id == .localContainer
        )
        let inference = config.config.inference
        let logsRoot = store.logsRootPath
        let parent = ProcessInfo.processInfo.environment
        let runner = ProcessCommandRunner()
        prepRunner = runner
        prepTask = Task { @MainActor in
            let prepared: PreparedRepository
            do {
                prepared = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<PreparedRepository, Error>) in
                    DispatchQueue.global(qos: .userInitiated).async {
                        do {
                            let value = try RepositoryPrep.prepare(
                                checkout,
                                runner: runner,
                                files: FileCheckoutStorage()
                            )
                            continuation.resume(returning: value)
                        } catch {
                            continuation.resume(throwing: error)
                        }
                    }
                }
            } catch {
                self.prepRunner = nil
                guard !Task.isCancelled, self.phase == .starting else { return }
                let message = (error as? CheckoutError)?.message ?? "The checkout did not finish."
                self.failPrep(message)
                return
            }
            self.prepRunner = nil
            guard !Task.isCancelled, self.phase == .starting else { return }
            self.launch(
                prepared: prepared,
                store: store,
                profile: profile,
                inference: inference,
                secrets: secrets,
                logsRoot: logsRoot,
                parentEnvironment: parent
            )
        }
    }

    private func failPrep(_ message: String) {
        prepTask = nil
        pendingImageStamp = nil
        phase = .idle
        appendLine(message)
    }

    private func launch(
        prepared: PreparedRepository,
        store: GameStore,
        profile: EnvironmentProfile,
        inference: InferenceSettings,
        secrets: LaunchSecrets,
        logsRoot: String,
        parentEnvironment: [String: String]
    ) {
        for line in prepared.lines {
            appendLine(line)
        }
        let local = profile.id == .localContainer
        let request = LaunchPlan.make(
            profile: profile,
            inference: inference,
            secrets: secrets,
            repository: prepared.path,
            logsRoot: logsRoot,
            parentEnvironment: parentEnvironment,
            skipContainerBuild: local && !prepared.rebuildImage
        )
        let script = scriptPath(request, local: local)
        guard FileManager.default.fileExists(atPath: script) else {
            phase = .idle
            appendLine("The launch script is missing.")
            return
        }
        guard FileManager.default.fileExists(atPath: request.currentDirectory) else {
            phase = .idle
            appendLine("The repository path is missing.")
            return
        }
        if prepared.rebuildImage && !prepared.commit.isEmpty {
            pendingImageStamp = (prepared.imageStampPath, prepared.commit)
        }

        let spawned: GroupedChild
        do {
            spawned = try GroupedChild.spawn(
                executable: request.executable,
                arguments: request.arguments,
                environment: request.environment,
                currentDirectory: request.currentDirectory
            )
        } catch {
            pendingImageStamp = nil
            phase = .exited(1)
            appendLine("The process did not start.")
            return
        }
        spawned.stdout.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor in
                self?.ingest(data, error: false)
            }
        }
        spawned.stderr.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor in
                self?.ingest(data, error: true)
            }
        }
        child = spawned
        tracksContainer = local
        launchEnvironment = request.environment
        spawned.startWatching { [weak self] code in
            Task { @MainActor in
                self?.finish(code, store: store)
            }
        }
        phase = .running
        startPolling(store)
    }

    private func scriptPath(_ request: LaunchRequest, local: Bool) -> String {
        if local {
            return request.arguments.first ?? ""
        }
        return (request.currentDirectory as NSString).appendingPathComponent("harness/scripts/live.mjs")
    }

    private func startPolling(_ store: GameStore) {
        pollTask?.cancel()
        pollTask = Task { @MainActor in
            while !Task.isCancelled {
                self.considerAdoption(store)
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func considerAdoption(_ store: GameStore) {
        store.nudge()
        guard !adopted else { return }
        if store.adoptNewGame(notIn: knownIDs) {
            adopted = true
        }
    }

    private func finish(_ code: Int32, store: GameStore) {
        guard child != nil || phase == .starting || phase == .running else { return }
        child?.stdout.readabilityHandler = nil
        child?.stderr.readabilityHandler = nil
        if let tail = outBuffer.flush() { appendChildLine(tail) }
        if let tail = errBuffer.flush() { appendChildLine(tail) }
        child = nil
        tracksContainer = false
        phase = stopping ? .stopped : .exited(code)
        pollTask?.cancel()
        pollTask = nil
        considerAdoption(store)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !self.adopted else { return }
            self.considerAdoption(store)
        }
    }

    private func ingest(_ data: Data, error: Bool) {
        if data.isEmpty {
            let tail = error ? errBuffer.flush() : outBuffer.flush()
            if let tail { appendChildLine(tail) }
            return
        }
        let lines: [String]
        if error {
            lines = errBuffer.append(data)
        } else {
            lines = outBuffer.append(data)
        }
        for line in lines {
            appendChildLine(line)
        }
    }

    private func appendChildLine(_ line: String) {
        appendLine(line)
        recordImageStamp(line)
    }

    /// The container script prints `run:` only after `container build` succeeds. A failed build leaves the stamp stale.
    private func recordImageStamp(_ line: String) {
        guard let pending = pendingImageStamp, line.contains("run:") else { return }
        pendingImageStamp = nil
        let storage = FileCheckoutStorage()
        let parent = (pending.path as NSString).deletingLastPathComponent
        do {
            try storage.makeDirectory(parent)
            try storage.write(pending.path, pending.commit)
        } catch {
            appendLine("Could not record the image stamp.")
        }
    }

    private func appendLine(_ line: String) {
        let clean = OutputRedactor.redact(line, secrets: secretSnapshot)
        logText.append(contentsOf: clean)
        logText.append("\n")
        if logText.count > logCap {
            logText.removeFirst(logText.count - logCap)
        }
        logTick += 1
    }
}
