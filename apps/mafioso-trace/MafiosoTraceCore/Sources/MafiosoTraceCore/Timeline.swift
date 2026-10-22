import Foundation

/// Seat filter, phase filter, selected row, and scrub position.
/// Choosing a row never changes the filters. `all` stays selected when seats or phases appear.
public struct TimelineState: Equatable, Sendable {
    public static let all = "all"
    public static let harness = "harness"

    public var seat: String
    public var phase: String
    public var selectedIDs: Set<TraceEvent.ID>
    public var scrub: Double

    public init(
        seat: String = TimelineState.all,
        phase: String = TimelineState.all,
        selectedIDs: Set<TraceEvent.ID> = [],
        scrub: Double = 0
    ) {
        self.seat = seat
        self.phase = phase
        self.selectedIDs = selectedIDs
        self.scrub = scrub
    }

    /// Player seats in first-seen order. The harness file is not a player seat.
    public static func playerSeats(in events: [TraceEvent]) -> [String] {
        TimelineIndex(events: events).eventSeats
    }

    /// Phases in first-seen order. Empty phases (pre-game) are not filters.
    public static func phases(in events: [TraceEvent]) -> [String] {
        TimelineIndex(events: events).phases
    }

    /// Pre-game events have no phase yet. The timeline shows an em dash for those.
    public static func phaseLabel(_ phase: String) -> String {
        let trimmed = phase.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "—" : trimmed
    }

    /// Seats the files already named, plus seats that have shown up in events.
    public static func knownSeats(in events: [TraceEvent], files: [String] = []) -> [String] {
        let index = TimelineIndex(events: events, files: files)
        var seen = index.eventSeats
        var known = Set(seen)
        for name in files where !name.isEmpty && name != harness && known.insert(name).inserted {
            seen.append(name)
        }
        return seen
    }

    public func resolvedSeat(in events: [TraceEvent], files: [String] = []) -> String {
        TimelineIndex(events: events, files: files).resolvedSeat(seat)
    }

    public func resolvedPhase(in events: [TraceEvent]) -> String {
        TimelineIndex(events: events).resolvedPhase(phase)
    }

    public func visible(_ events: [TraceEvent], files: [String] = []) -> [TraceEvent] {
        let index = TimelineIndex(events: events, files: files)
        return index.visible(events, seat: seat, phase: phase)
    }

    /// `all` and `harness` always stick. A player seat sticks while that seat is still known.
    public func chooseSeat(_ next: String, events: [TraceEvent], files: [String] = []) -> TimelineState {
        let index = TimelineIndex(events: events, files: files)
        var copy = self
        if next == Self.all || next == Self.harness || index.seatSet.contains(next) {
            copy.seat = next
        }
        return copy.applying(index, events: events)
    }

    /// `all` sticks. A phase sticks while some event still has that phase.
    public func choosePhase(_ next: String, events: [TraceEvent], files: [String] = []) -> TimelineState {
        let index = TimelineIndex(events: events, files: files)
        var copy = self
        if next == Self.all || index.phaseSet.contains(next) {
            copy.phase = next
        }
        return copy.applying(index, events: events)
    }

    /// Select a visible row and move the scrubber to it. Filters stay as they are.
    /// A row the current filters hide is ignored.
    public func select(id: TraceEvent.ID?, in events: [TraceEvent], files: [String] = []) -> TimelineState {
        guard let id else { return self }
        let index = TimelineIndex(events: events, files: files)
        var copy = self
        let rows = index.visible(events, seat: seat, phase: phase)
        guard let indexInRows = rows.firstIndex(where: { $0.id == id }) else { return self }
        copy.selectedIDs = [id]
        copy.scrub = Scrub.clamp(Double(indexInRows), count: rows.count)
        return copy
    }

    /// Move the scrubber and select the row at that index. Filters stay as they are.
    public func scrub(to value: Double, in events: [TraceEvent], files: [String] = []) -> TimelineState {
        let index = TimelineIndex(events: events, files: files)
        var copy = self
        let rows = index.visible(events, seat: seat, phase: phase)
        guard let indexInRows = Scrub.index(for: value, count: rows.count), rows.indices.contains(indexInRows) else {
            copy.selectedIDs = []
            copy.scrub = 0
            return copy
        }
        copy.selectedIDs = [rows[indexInRows].id]
        copy.scrub = Double(indexInRows)
        return copy
    }

    /// New seats and phases do not change `all`. A seat or phase that disappeared falls back to `all`.
    /// A selected row that is still visible keeps the scrubber on that row. A row the filter now hides is cleared.
    public func reconcile(_ events: [TraceEvent], files: [String] = []) -> TimelineState {
        applying(TimelineIndex(events: events, files: files), events: events)
    }

    public func label(in events: [TraceEvent], files: [String] = []) -> String {
        Scrub.label(position: scrub, count: visible(events, files: files).count)
    }

    public func bounds(in events: [TraceEvent], files: [String] = []) -> ClosedRange<Double>? {
        Scrub.bounds(count: visible(events, files: files).count)
    }

    private func applying(_ index: TimelineIndex, events: [TraceEvent]) -> TimelineState {
        var copy = self
        copy.seat = index.resolvedSeat(copy.seat)
        copy.phase = index.resolvedPhase(copy.phase)
        let rows = index.visible(events, seat: copy.seat, phase: copy.phase)
        if let id = copy.selectedIDs.first, let indexInRows = rows.firstIndex(where: { $0.id == id }) {
            copy.selectedIDs = [id]
            copy.scrub = Double(indexInRows)
        } else {
            copy.selectedIDs = []
            copy.scrub = Scrub.clamp(copy.scrub, count: rows.count)
        }
        return copy
    }
}

/// One pass over the events. Phase and seat checks after this are set lookups, not another scan per row.
public struct TimelineIndex: Equatable, Sendable {
    public var phases: [String]
    public var phaseSet: Set<String>
    /// Player seats in first-seen order. The harness file is not included.
    public var eventSeats: [String]
    /// Files on disk first, then seats that have shown up only in events.
    public var listedSeats: [String]
    public var seatSet: Set<String>
    /// Events per file name, including a file that exists and has no rows yet.
    public var countsByFile: [String: Int]

    public init(events: [TraceEvent], files: [String] = []) {
        var phases: [String] = []
        var phaseSet: Set<String> = []
        var eventSeats: [String] = []
        var seatSet: Set<String> = []
        var counts: [String: Int] = [:]
        for event in events {
            if !event.phase.isEmpty, phaseSet.insert(event.phase).inserted {
                phases.append(event.phase)
            }
            if !event.seat.isEmpty {
                counts[event.seat, default: 0] += 1
                if event.seat != TimelineState.harness, seatSet.insert(event.seat).inserted {
                    eventSeats.append(event.seat)
                }
            }
        }
        var listed: [String] = []
        var listedSet: Set<String> = []
        for name in files where !name.isEmpty {
            if counts[name] == nil { counts[name] = 0 }
            if name != TimelineState.harness, listedSet.insert(name).inserted {
                listed.append(name)
                seatSet.insert(name)
            }
        }
        for name in eventSeats where listedSet.insert(name).inserted {
            listed.append(name)
        }
        self.phases = phases
        self.phaseSet = phaseSet
        self.eventSeats = eventSeats
        self.listedSeats = listed
        self.seatSet = seatSet
        self.countsByFile = counts
    }

    public func resolvedPhase(_ phase: String) -> String {
        if phase == TimelineState.all || phaseSet.contains(phase) { return phase }
        return TimelineState.all
    }

    public func resolvedSeat(_ seat: String) -> String {
        if seat == TimelineState.harness || seat == TimelineState.all || seatSet.contains(seat) { return seat }
        return TimelineState.all
    }

    /// Filter with the already resolved seat and phase. Does not rebuild the phase list.
    public func visible(_ events: [TraceEvent], seat: String, phase: String) -> [TraceEvent] {
        let seatFilter = resolvedSeat(seat)
        let phaseFilter = resolvedPhase(phase)
        if seatFilter == TimelineState.all, phaseFilter == TimelineState.all { return events }
        return events.filter { event in
            let seatOK: Bool
            switch seatFilter {
            case TimelineState.all:
                seatOK = true
            case TimelineState.harness:
                seatOK = event.seat == TimelineState.harness
            default:
                seatOK = event.seat == seatFilter
            }
            return seatOK && (phaseFilter == TimelineState.all || event.phase == phaseFilter)
        }
    }
}

/// What the timeline view reads. Built when the events or the filters change, not during layout.
public struct TimelineSnapshot: Equatable, Sendable {
    public var resolvedSeat: String
    public var resolvedPhase: String
    public var visible: [TraceEvent]
    public var phases: [String]
    public var playerSeats: [String]
    public var label: String
    public var bounds: ClosedRange<Double>?
    public var selectedEvent: TraceEvent?

    public init(
        resolvedSeat: String,
        resolvedPhase: String,
        visible: [TraceEvent],
        phases: [String],
        playerSeats: [String],
        label: String,
        bounds: ClosedRange<Double>?,
        selectedEvent: TraceEvent?
    ) {
        self.resolvedSeat = resolvedSeat
        self.resolvedPhase = resolvedPhase
        self.visible = visible
        self.phases = phases
        self.playerSeats = playerSeats
        self.label = label
        self.bounds = bounds
        self.selectedEvent = selectedEvent
    }

    public static let empty = TimelineSnapshot(
        resolvedSeat: TimelineState.all,
        resolvedPhase: TimelineState.all,
        visible: [],
        phases: [],
        playerSeats: [],
        label: "0 / 0",
        bounds: nil,
        selectedEvent: nil
    )

    /// `index` must be the index of `events` and `files`. Passing it avoids a second scan.
    public static func make(
        events: [TraceEvent],
        files: [String] = [],
        state: TimelineState,
        index: TimelineIndex? = nil
    ) -> TimelineSnapshot {
        let index = index ?? TimelineIndex(events: events, files: files)
        let seat = index.resolvedSeat(state.seat)
        let phase = index.resolvedPhase(state.phase)
        let visible = index.visible(events, seat: seat, phase: phase)
        let selected = visible.first { state.selectedIDs.contains($0.id) }
        return TimelineSnapshot(
            resolvedSeat: seat,
            resolvedPhase: phase,
            visible: visible,
            phases: index.phases,
            playerSeats: index.listedSeats,
            label: Scrub.label(position: state.scrub, count: visible.count),
            bounds: Scrub.bounds(count: visible.count),
            selectedEvent: selected
        )
    }
}

/// Skips a rebuild when the per-file counts and the filters are the ones already shown.
public struct TimelineCacheKey: Equatable, Sendable {
    public var countsByFile: [String: Int]
    public var files: [String]
    public var seat: String
    public var phase: String
    public var selectedIDs: Set<TraceEvent.ID>
    public var scrub: Double

    public init(
        countsByFile: [String: Int],
        files: [String],
        seat: String,
        phase: String,
        selectedIDs: Set<TraceEvent.ID>,
        scrub: Double
    ) {
        self.countsByFile = countsByFile
        self.files = files
        self.seat = seat
        self.phase = phase
        self.selectedIDs = selectedIDs
        self.scrub = scrub
    }

    /// `index` must be the index of `events` and `files`. Passing it avoids a second scan.
    public static func make(
        events: [TraceEvent],
        files: [String],
        state: TimelineState,
        index: TimelineIndex? = nil
    ) -> TimelineCacheKey {
        let counts = index?.countsByFile ?? TimelineIndex(events: events, files: files).countsByFile
        return TimelineCacheKey(
            countsByFile: counts,
            files: files,
            seat: state.seat,
            phase: state.phase,
            selectedIDs: state.selectedIDs,
            scrub: state.scrub
        )
    }
}
