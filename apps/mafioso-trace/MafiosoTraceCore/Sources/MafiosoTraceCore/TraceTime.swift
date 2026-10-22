import Foundation

/// Clock text for the timeline and the detail header. The stored `ts` stays ISO-8601.
public enum TraceTime {
    /// Local time plus a short zone name, such as `07:00:05 EDT`. A value that is not ISO-8601 is returned unchanged.
    public static func display(_ raw: String, in zone: TimeZone = .current, locale: Locale = .current) -> String {
        guard let date = date(from: raw) else { return raw }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = zone
        formatter.dateFormat = "HH:mm:ss zzz"
        return formatter.string(from: date)
    }

    static func date(from raw: String) -> Date? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = parser.date(from: raw) { return date }
        parser.formatOptions = [.withInternetDateTime]
        return parser.date(from: raw)
    }
}
