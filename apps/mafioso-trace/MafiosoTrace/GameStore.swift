import Combine
import Foundation
import MafiosoTraceCore

enum LogsRoot {
    static let storageKey = "logsRoot"
    static let defaultPath = "~/mafioso-mac/logs"

    static func url(from stored: String) -> URL {
        let trimmed = stored.trimmingCharacters(in: .whitespacesAndNewlines)
        let raw = trimmed.isEmpty ? defaultPath : trimmed
        return URL(fileURLWithPath: (raw as NSString).expandingTildeInPath, isDirectory: true)
    }

    static func file(from path: String) -> URL {
        let expanded = (path as NSString).expandingTildeInPath
        if (expanded as NSString).isAbsolutePath {
            return URL(fileURLWithPath: expanded)
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(expanded)
    }
}

/// One consumer of the trace files. Parsed events live here. The file text does not.
@MainActor
final class GameStore: ObservableObject {
    @Published var games: [TraceGame] = []
    @Published var selectedGameID: String?
    @Published var seat = "all"
    @Published var phase = "all"
    @Published var events: [TraceEvent] = []
    @Published var selection = Set<TraceEvent.ID>()
    @Published var follow = true
    @Published var scrub: Double = 0
    @Published var logsRootPath = LogsRoot.defaultPath
    @Published var missingRoot = false
    @Published var fixtureName: String?

    private let pump = LinePump()
    private let rootWatcher = RootWatcher()
    private var seatWatchers: [String: SeatWatcher] = [:]
    private let wake = Wake()
    private var loop: Task<Void, Never>?
    private var started = false
    private var fixtureURL: URL?
    private var needsReset = false
    private var pinnedID: TraceEvent.ID?
    private var watchedKey = ""
    private var epoch = 0
    private var fixtureTask: Task<Void, Never>?

    var visible: [TraceEvent] {
        events.filter { event in
            let seatOK: Bool
            switch seat {
            case "all":
                seatOK = true
            case "harness":
                seatOK = event.seat == "harness"
            default:
                seatOK = event.seat == seat
            }
            return seatOK && (phase == "all" || event.phase == phase)
        }
    }

    var playerSeats: [String] {
        var seen: [String] = []
        func add(_ name: String) {
            guard !name.isEmpty, name != "harness", !seen.contains(name) else { return }
            seen.append(name)
        }
        if let game = games.first(where: { $0.id == selectedGameID }) {
            game.seats.forEach(add)
        }
        events.forEach { add($0.seat) }
        return seen
    }

    var phases: [String] {
        var seen: [String] = []
        for event in events where !event.phase.isEmpty && !seen.contains(event.phase) {
            seen.append(event.phase)
        }
        return seen
    }

    var selectedEvent: TraceEvent? {
        events.filter { selection.contains($0.id) }.max { $0.seq < $1.seq }
    }

    var currentGameIsLive: Bool {
        guard fixtureURL == nil else { return false }
        return games.first { $0.id == selectedGameID }?.isLive ?? false
    }

    var statusLine: String {
        if let fixtureURL { return fixtureURL.path }
        if missingRoot { return "Missing \(LogsRoot.url(from: logsRootPath).path)" }
        return "\(events.count) events"
    }

    func start(arguments: [String]) {
        guard !started else { return }
        started = true
        logsRootPath = UserDefaults.standard.string(forKey: LogsRoot.storageKey) ?? LogsRoot.defaultPath
        let options = LaunchOptions(arguments: arguments)
        if let path = options.fixturePath {
            fixtureURL = LogsRoot.file(from: path)
            fixtureName = fixtureURL?.lastPathComponent
            follow = false
            fixtureTask = Task { await self.loadFixture() }
            return
        }
        rootWatcher.onChange = { [weak self] in
            self?.wake.signal()
        }
        loop = Task { await self.watchLoop() }
    }

    func setLogsRoot(_ path: String) {
        guard fixtureURL == nil else { return }
        guard path != logsRootPath else { return }
        logsRootPath = path
        events = []
        selection = []
        selectedGameID = nil
        pinnedID = nil
        watchedKey = ""
        stopSeatWatchers()
        needsReset = true
        wake.signal()
    }

    func select(game id: String?) {
        guard id != selectedGameID else { return }
        selectedGameID = id
        events = []
        selection = []
        pinnedID = nil
        seat = "all"
        phase = "all"
        follow = games.first { $0.id == id }?.isLive ?? false
        watchedKey = ""
        wake.signal()
    }

    func setFollow(_ on: Bool) {
        follow = on
        if on, let last = visible.last {
            pin(last.id)
        }
    }

    func userScrubbed(to value: Double) {
        follow = false
        scrub = value
        let rows = visible
        let index = Int(value.rounded())
        guard rows.indices.contains(index) else { return }
        let id = rows[index].id
        pinnedID = id
        selection = [id]
    }

    func userChangedSelection() {
        guard follow, let chosen = selection.first else { return }
        if chosen == pinnedID { return }
        follow = false
    }

    func reload() {
        events = []
        selection = []
        pinnedID = nil
        if fixtureURL != nil {
            fixtureTask?.cancel()
            fixtureTask = Task { await self.loadFixture() }
            return
        }
        needsReset = true
        watchedKey = ""
        Task {
            let next = await self.pump.bump()
            self.epoch = next
            self.events = []
            self.selection = []
            self.pinnedID = nil
            self.wake.signal()
        }
    }

    private func loadFixture() async {
        guard let fixtureURL else { return }
        await pump.setFiles([fixtureURL])
        let generation = await pump.bump()
        epoch = generation
        if Task.isCancelled { return }
        events = []
        selection = []
        var spins = 0
        while spins < 4000 {
            if Task.isCancelled { return }
            let batch = await pump.poll(maxChunks: 4, epoch: generation)
            if Task.isCancelled { return }
            if !batch.events.isEmpty { append(batch.events) }
            if !batch.pending { break }
            spins += 1
            await Task.yield()
        }
        if Task.isCancelled { return }
        let id = events.first?.gameId ?? fixtureURL.deletingPathExtension().lastPathComponent
        var seats: [String] = []
        for event in events where !event.seat.isEmpty && !seats.contains(event.seat) {
            seats.append(event.seat)
        }
        games = [TraceGame(
            id: id,
            directory: fixtureURL.deletingLastPathComponent(),
            seats: seats,
            files: [fixtureURL],
            latestChange: Date(),
            isLive: false
        )]
        selectedGameID = id
        missingRoot = false
        if let first = visible.first {
            pin(first.id)
            scrub = 0
        }
    }

    private func watchLoop() async {
        rootWatcher.start(path: LogsRoot.url(from: logsRootPath).path)
        while !Task.isCancelled {
            await refreshGames()
            await bindGame()
            if needsReset {
                needsReset = false
                await pump.reset()
                events = []
                selection = []
                pinnedID = nil
            }
            var spins = 0
            while spins < 2000, !Task.isCancelled, !needsReset {
                let batch = await pump.poll(maxChunks: 8, epoch: epoch)
                if !batch.events.isEmpty { append(batch.events) }
                if !batch.pending { break }
                spins += 1
                await Task.yield()
            }
            if !follow, selection.isEmpty, let first = visible.first {
                pin(first.id)
            }
            await wake.wait()
        }
    }

    private func refreshGames() async {
        let root = LogsRoot.url(from: logsRootPath)
        rootWatcher.start(path: root.path)
        missingRoot = !FileManager.default.fileExists(atPath: root.path)
        let found = TraceCatalog.games(in: root)
        games = found
        if let id = selectedGameID, !found.contains(where: { $0.id == id }) {
            events = []
            selection = []
            pinnedID = nil
            selectedGameID = found.first?.id
            watchedKey = ""
            follow = found.first?.isLive ?? false
        } else if selectedGameID == nil, let first = found.first {
            selectedGameID = first.id
            follow = first.isLive
        }
    }

    private func bindGame() async {
        guard let id = selectedGameID, let game = games.first(where: { $0.id == id }) else {
            stopSeatWatchers()
            watchedKey = ""
            await pump.setFiles([])
            return
        }
        let key = game.files.map(\.path).sorted().joined(separator: "\n")
        if key == watchedKey { return }
        watchedKey = key
        stopSeatWatchers()
        for file in game.files {
            let watcher = SeatWatcher()
            watcher.onChange = { [weak self] in
                self?.wake.signal()
            }
            watcher.start(path: file.path)
            seatWatchers[file.path] = watcher
        }
        await pump.setFiles(game.files)
    }

    private func append(_ batch: [TraceEvent]) {
        guard !batch.isEmpty else { return }
        events.append(contentsOf: batch)
        events.sort { lhs, rhs in
            if lhs.seq != rhs.seq { return lhs.seq < rhs.seq }
            return lhs.seat < rhs.seat
        }
        if follow, let last = visible.last {
            pin(last.id)
        }
    }

    private func pin(_ id: TraceEvent.ID) {
        pinnedID = id
        selection = [id]
        if let index = visible.firstIndex(where: { $0.id == id }) {
            scrub = Double(index)
        }
    }

    private func stopSeatWatchers() {
        for watcher in seatWatchers.values {
            watcher.stop()
        }
        seatWatchers = [:]
    }
}

/// Coalesces file-watch wakeups. One waiter, and a signal that arrives early is kept.
private final class Wake: @unchecked Sendable {
    private let stream: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    private var iterator: AsyncStream<Void>.AsyncIterator

    init() {
        var slot: AsyncStream<Void>.Continuation!
        let stream = AsyncStream<Void>(bufferingPolicy: .bufferingNewest(1)) { slot = $0 }
        self.stream = stream
        self.continuation = slot
        iterator = stream.makeAsyncIterator()
    }

    func signal() {
        continuation.yield(())
    }

    func wait() async {
        _ = await iterator.next()
    }
}
