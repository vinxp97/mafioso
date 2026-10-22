import Foundation

/// Timeline scrubber. A stepped SwiftUI `Slider` requires `upper > lower`, so 0 and 1 events have no range.
public enum Scrub {
    /// `nil` for 0 or 1 rows. Otherwise `0 ... count - 1`, and the upper bound is greater than the lower.
    public static func bounds(count: Int) -> ClosedRange<Double>? {
        guard count > 1 else { return nil }
        return 0 ... Double(count - 1)
    }

    public static func showsSlider(count: Int) -> Bool {
        bounds(count: count) != nil
    }

    /// Pull a scrub value into `0 ... count - 1`. Empty and single-row timelines sit at 0.
    public static func clamp(_ value: Double, count: Int) -> Double {
        guard count > 1, value.isFinite else { return 0 }
        return min(max(value, 0), Double(count - 1))
    }

    /// Row for a scrub value, or nil when there are no rows. Out-of-range values clamp.
    public static func index(for value: Double, count: Int) -> Int? {
        guard count > 0 else { return nil }
        if count == 1 { return 0 }
        let clamped = clamp(value, count: count)
        let rounded = Int(clamped.rounded())
        return min(max(rounded, 0), count - 1)
    }

    public static func label(position: Double, count: Int) -> String {
        guard let index = index(for: position, count: count) else { return "0 / 0" }
        return "\(index + 1) / \(count)"
    }

    /// Drop ids the table is not showing, so selection cannot point past the rows.
    public static func selection<ID: Hashable>(_ selected: Set<ID>, available: [ID]) -> Set<ID> {
        selected.intersection(Set(available))
    }

    /// Keep a filter value only when it is still in the list. Otherwise the fallback (`all`).
    public static func choice(_ current: String, allowed: [String], fallback: String) -> String {
        if current == fallback || allowed.contains(current) { return current }
        return fallback
    }
}
