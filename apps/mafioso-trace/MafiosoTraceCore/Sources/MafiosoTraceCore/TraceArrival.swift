import Foundation

public enum TraceArrival {
    /// The newest game directory that was not in `previous`. Nil when nothing new has a JSONL file yet.
    public static func newest(previous: Set<String>, games: [TraceGame]) -> String? {
        games
            .filter { !previous.contains($0.id) }
            .max { $0.latestChange < $1.latestChange }?
            .id
    }
}
