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
    @Published var timeline = TimelineState()
    @Published var events: [TraceEvent] = []
    @Published var follow = true
    @Published var logsRootPath = LogsRoot.defaultPath
    @Published var missingRoot = false
    @Published var fixtureMissing = false
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

    var seat: String { timeline.seat }
    var phase: String { timeline.phase }
    var selection: Set<TraceEvent.ID> { timeline.selectedIDs }
    var scrub: Double { timeline.scrub }

    /// Seat names already on disk for the open game, before their lines have been read.
    private var fileSeats: [String] {
        games.first { $0.id == selectedGameID }?.seats ?? []
    }

    /// Seat filter that is still present. A seat that disappeared falls back to all.
    var resolvedSeat: String { timeline.resolvedSeat(in: events, files: fileSeats) }

    /// Phase filter that is still present. A phase that disappeared falls back to all.
    var resolvedPhase: String { timeline.resolvedPhase(in: events) }

    var visible: [TraceEvent] { timeline.visible(events, files: fileSeats) }

    var playerSeats: [String] {
        var seen: [String] = []
        func add(_ name: String) {
            guard !name.isEmpty, name != TimelineState.harness, !seen.contains(name) else { return }
            seen.append(name)
        }
        fileSeats.forEach(add)
        TimelineState.playerSeats(in: events).forEach(add)
        return seen
    }

    var phases: [String] { TimelineState.phases(in: events) }

    var selectedEvent: TraceEvent? {
        visible.first { timeline.selectedIDs.contains($0.id) }
    }

    var scrubBounds: ClosedRange<Double>? { timeline.bounds(in: events, files: fileSeats) }

    var scrubLabel: String { timeline.label(in: events, files: fileSeats) }

    var currentGameIsLive: Bool {
        guard fixtureURL == nil else { return false }
        return games.first { $0.id == selectedGameID }?.isLive ?? false
    }

    var statusLine: String {
        if fixtureMissing, let fixtureURL { return "Missing fixture \(fixtureURL.path)" }
        if let fixtureURL { return fixtureURL.path }
        if missingRoot { return "Missing \(LogsRoot.url(from: logsRootPath).path)" }
        return "\(events.count) events"
    }

    /// Path shown in the sidebar footer. The full string is the tooltip.
    var sidebarPath: String {
        if let fixtureURL { return fixtureURL.path }
        return LogsRoot.url(from: logsRootPath).path
    }

    /// Path in the timeline toolbar. Nil while a live game is showing an event count.
    var pathLine: String? {
        if fixtureURL != nil || missingRoot { return sidebarPath }
        return nil
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
        clearTimeline()
        selectedGameID = nil
        watchedKey = ""
        stopSeatWatchers()
        needsReset = true
        wake.signal()
    }

    func select(game id: String?) {
        guard id != selectedGameID else { return }
        selectedGameID = id
        clearTimeline()
        timeline = TimelineState()
        follow = games.first { $0.id == id }?.isLive ?? false
        watchedKey = ""
        wake.signal()
    }

    func chooseSeat(_ seat: String) {
        timeline = timeline.chooseSeat(seat, events: events, files: fileSeats)
    }

    func choosePhase(_ phase: String) {
        timeline = timeline.choosePhase(phase, events: events, files: fileSeats)
    }

    /// A timeline click. The seat and phase filters stay where the user left them.
    func selectRow(_ id: TraceEvent.ID) {
        let next = timeline.select(id: id, in: events, files: fileSeats)
        guard next != timeline else { return }
        if follow, next.selectedIDs.first != pinnedID {
            follow = false
        }
        timeline = next
        pinnedID = id
    }

    func setFollow(_ on: Bool) {
        follow = on
        if on, let last = visible.last {
            pin(last.id)
        }
    }

    func userScrubbed(to value: Double) {
        follow = false
        timeline = timeline.scrub(to: value, in: events, files: fileSeats)
        pinnedID = timeline.selectedIDs.first
    }

    /// Wake the directory watcher. A launch polls this until a new game directory has a JSONL file.
    func nudge() {
        wake.signal()
    }

    /// Switch the sidebar to a game that appeared after `previous` was snapshotted. A fixture stays put.
    @discardableResult
    func adoptNewGame(notIn previous: Set<String>) -> Bool {
        guard fixtureURL == nil else { return false }
        guard let id = TraceArrival.newest(previous: previous, games: games) else { return false }
        if id != selectedGameID {
            select(game: id)
            follow = true
        }
        return true
    }

    func reload() {
        clearTimeline()
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
            self.clearTimeline()
            self.wake.signal()
        }
    }

    private func loadFixture() async {
        guard let fixtureURL else { return }
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: fixtureURL.path, isDirectory: &isDirectory)
        if !exists || isDirectory.boolValue {
            fixtureMissing = true
            clearTimeline()
            games = []
            selectedGameID = nil
            return
        }
        fixtureMissing = false
        await pump.setFiles([fixtureURL])
        let generation = await pump.bump()
        epoch = generation
        if Task.isCancelled { return }
        clearTimeline()
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
                clearTimeline()
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
            clearTimeline()
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
        let files = game.files.filter { FileManager.default.fileExists(atPath: $0.path) }
        let key = files.map(\.path).sorted().joined(separator: "\n")
        if key == watchedKey { return }
        watchedKey = key
        stopSeatWatchers()
        for file in files {
            let watcher = SeatWatcher()
            watcher.onChange = { [weak self] in
                self?.wake.signal()
            }
            watcher.start(path: file.path)
            seatWatchers[file.path] = watcher
        }
        await pump.setFiles(files)
    }

    private func append(_ batch: [TraceEvent]) {
        guard !batch.isEmpty else { return }
        events.append(contentsOf: batch)
        events.sort { lhs, rhs in
            if lhs.seq != rhs.seq { return lhs.seq < rhs.seq }
            return lhs.seat < rhs.seat
        }
        timeline = timeline.reconcile(events, files: fileSeats)
        if follow, let last = visible.last {
            pin(last.id)
        }
    }

    private func pin(_ id: TraceEvent.ID) {
        pinnedID = id
        timeline = timeline.select(id: id, in: events, files: fileSeats)
    }

    private func clearTimeline() {
        events = []
        var next = timeline
        next.selectedIDs = []
        next.scrub = 0
        timeline = next
        pinnedID = nil
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
