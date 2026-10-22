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
        var seen: [String] = []
        for event in events {
            let name = event.seat
            guard !name.isEmpty, name != harness, !seen.contains(name) else { continue }
            seen.append(name)
        }
        return seen
    }

    /// Phases in first-seen order. Empty phases (pre-game) are not filters.
    public static func phases(in events: [TraceEvent]) -> [String] {
        var seen: [String] = []
        for event in events where !event.phase.isEmpty && !seen.contains(event.phase) {
            seen.append(event.phase)
        }
        return seen
    }

    /// Pre-game events have no phase yet. The timeline shows an em dash for those.
    public static func phaseLabel(_ phase: String) -> String {
        let trimmed = phase.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "—" : trimmed
    }

    /// Seats the files already named, plus seats that have shown up in events.
    public static func knownSeats(in events: [TraceEvent], files: [String] = []) -> [String] {
        var seen = playerSeats(in: events)
        for name in files where !name.isEmpty && name != harness && !seen.contains(name) {
            seen.append(name)
        }
        return seen
    }

    public func resolvedSeat(in events: [TraceEvent], files: [String] = []) -> String {
        if seat == Self.harness { return Self.harness }
        return Scrub.choice(seat, allowed: Self.knownSeats(in: events, files: files), fallback: Self.all)
    }

    public func resolvedPhase(in events: [TraceEvent]) -> String {
        Scrub.choice(phase, allowed: Self.phases(in: events), fallback: Self.all)
    }

    public func visible(_ events: [TraceEvent], files: [String] = []) -> [TraceEvent] {
        let seatFilter = resolvedSeat(in: events, files: files)
        let phaseFilter = resolvedPhase(in: events)
        return events.filter { event in
            let seatOK: Bool
            switch seatFilter {
            case Self.all:
                seatOK = true
            case Self.harness:
                seatOK = event.seat == Self.harness
            default:
                seatOK = event.seat == seatFilter
            }
            return seatOK && (phaseFilter == Self.all || event.phase == phaseFilter)
        }
    }

    /// `all` and `harness` always stick. A player seat sticks while that seat is still known.
    public func chooseSeat(_ next: String, events: [TraceEvent], files: [String] = []) -> TimelineState {
        var copy = self
        if next == Self.all || next == Self.harness || Self.knownSeats(in: events, files: files).contains(next) {
            copy.seat = next
        }
        return copy.reconcile(events, files: files)
    }

    /// `all` sticks. A phase sticks while some event still has that phase.
    public func choosePhase(_ next: String, events: [TraceEvent], files: [String] = []) -> TimelineState {
        var copy = self
        if next == Self.all || Self.phases(in: events).contains(next) {
            copy.phase = next
        }
        return copy.reconcile(events, files: files)
    }

    /// Select a visible row and move the scrubber to it. Filters stay as they are.
    /// A row the current filters hide is ignored.
    public func select(id: TraceEvent.ID?, in events: [TraceEvent], files: [String] = []) -> TimelineState {
        guard let id else { return self }
        var copy = self
        let rows = copy.visible(events, files: files)
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return self }
        copy.selectedIDs = [id]
        copy.scrub = Scrub.clamp(Double(index), count: rows.count)
        return copy
    }

    /// Move the scrubber and select the row at that index. Filters stay as they are.
    public func scrub(to value: Double, in events: [TraceEvent], files: [String] = []) -> TimelineState {
        var copy = self
        let rows = copy.visible(events, files: files)
        guard let index = Scrub.index(for: value, count: rows.count), rows.indices.contains(index) else {
            copy.selectedIDs = []
            copy.scrub = 0
            return copy
        }
        copy.selectedIDs = [rows[index].id]
        copy.scrub = Double(index)
        return copy
    }

    /// New seats and phases do not change `all`. A seat or phase that disappeared falls back to `all`.
    /// A selected row that is still visible keeps the scrubber on that row. A row the filter now hides is cleared.
    public func reconcile(_ events: [TraceEvent], files: [String] = []) -> TimelineState {
        var copy = self
        copy.seat = copy.resolvedSeat(in: events, files: files)
        copy.phase = copy.resolvedPhase(in: events)
        let rows = copy.visible(events, files: files)
        if let id = copy.selectedIDs.first, let index = rows.firstIndex(where: { $0.id == id }) {
            copy.selectedIDs = [id]
            copy.scrub = Double(index)
        } else {
            copy.selectedIDs = []
            copy.scrub = Scrub.clamp(copy.scrub, count: rows.count)
        }
        return copy
    }

    public func label(in events: [TraceEvent], files: [String] = []) -> String {
        Scrub.label(position: scrub, count: visible(events, files: files).count)
    }

    public func bounds(in events: [TraceEvent], files: [String] = []) -> ClosedRange<Double>? {
        Scrub.bounds(count: visible(events, files: files).count)
    }
}
