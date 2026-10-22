import Foundation
import MafiosoTraceCore

enum RunPhase: Equatable {
    case idle
    case starting
    case running
    case exited(Int32)
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
        }
    }

    private var process: Process?
    private var outBuffer = LineBuffer()
    private var errBuffer = LineBuffer()
    private var secretSnapshot: [String] = []
    private var knownIDs: Set<String> = []
    private var adopted = false
    private var pollTask: Task<Void, Never>?
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
            repository: config.config.repositoryPath
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

    func stop() {
        process?.terminate()
    }

    private func begin(
        config: AppConfigController,
        store: GameStore,
        profile: EnvironmentProfile,
        secrets: LaunchSecrets
    ) {
        let request = LaunchPlan.make(
            profile: profile,
            inference: config.config.inference,
            secrets: secrets,
            repository: config.config.repositoryPath,
            logsRoot: store.logsRootPath,
            parentEnvironment: ProcessInfo.processInfo.environment
        )
        let script = scriptPath(request, local: profile.id == .localContainer)
        guard FileManager.default.fileExists(atPath: script) else {
            phase = .idle
            replaceLog("The launch script is missing.")
            return
        }
        guard FileManager.default.fileExists(atPath: request.currentDirectory) else {
            phase = .idle
            replaceLog("The repository path is missing.")
            return
        }

        logText = ""
        logTick += 1
        outBuffer = LineBuffer()
        errBuffer = LineBuffer()
        secretSnapshot = secrets.values
        knownIDs = Set(store.games.map(\.id))
        adopted = false
        phase = .starting
        appendLine("starting \(profile.displayName)")

        let child = Process()
        child.executableURL = URL(fileURLWithPath: request.executable)
        child.arguments = request.arguments
        child.environment = request.environment
        child.currentDirectoryURL = URL(fileURLWithPath: request.currentDirectory, isDirectory: true)
        child.standardInput = FileHandle.nullDevice
        let output = Pipe()
        let errors = Pipe()
        child.standardOutput = output
        child.standardError = errors
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor in
                self?.ingest(data, error: false)
            }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor in
                self?.ingest(data, error: true)
            }
        }
        child.terminationHandler = { [weak self] child in
            let code = child.terminationStatus
            Task { @MainActor in
                self?.finish(code, store: store)
            }
        }
        process = child
        do {
            try child.run()
            phase = .running
            startPolling(store)
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            process = nil
            phase = .exited(1)
            appendLine("The process did not start.")
        }
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
        guard process != nil || phase == .starting || phase == .running else { return }
        if let output = process?.standardOutput as? Pipe {
            output.fileHandleForReading.readabilityHandler = nil
        }
        if let errors = process?.standardError as? Pipe {
            errors.fileHandleForReading.readabilityHandler = nil
        }
        if let tail = outBuffer.flush() { appendLine(tail) }
        if let tail = errBuffer.flush() { appendLine(tail) }
        process = nil
        phase = .exited(code)
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
            if let tail { appendLine(tail) }
            return
        }
        let lines: [String]
        if error {
            lines = errBuffer.append(data)
        } else {
            lines = outBuffer.append(data)
        }
        for line in lines {
            appendLine(line)
        }
    }

    private func replaceLog(_ line: String) {
        logText = ""
        appendLine(line)
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
