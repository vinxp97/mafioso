import Foundation

/// One game directory: `logs/traces/<gameId>/*.jsonl`.
public struct TraceGame: Equatable, Identifiable, Sendable {
    public var id: String
    public var directory: URL
    public var seats: [String]
    public var files: [URL]
    public var latestChange: Date
    public var isLive: Bool

    public init(
        id: String,
        directory: URL,
        seats: [String],
        files: [URL],
        latestChange: Date,
        isLive: Bool
    ) {
        self.id = id
        self.directory = directory
        self.seats = seats
        self.files = files
        self.latestChange = latestChange
        self.isLive = isLive
    }
}

public enum TraceCatalog {
    /// A game is live when one of its files changed within this many seconds.
    public static let liveWindow: TimeInterval = 15

    public static func games(
        in root: URL,
        now: Date = Date(),
        liveWindow: TimeInterval = TraceCatalog.liveWindow
    ) -> [TraceGame] {
        let files = FileManager.default
        guard let children = try? files.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }
        var games: [TraceGame] = []
        for directory in children {
            var isDirectory: ObjCBool = false
            guard files.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue else {
                continue
            }
            guard let entries = try? files.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.contentModificationDateKey],
                options: [.skipsHiddenFiles]
            ) else {
                continue
            }
            let jsonl = entries
                .filter { $0.pathExtension == "jsonl" }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            if jsonl.isEmpty { continue }
            var latest = Date.distantPast
            for file in jsonl {
                let modified = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
                if let modified, modified > latest {
                    latest = modified
                }
            }
            let age = now.timeIntervalSince(latest)
            let seats = jsonl.map { $0.deletingPathExtension().lastPathComponent }
            games.append(TraceGame(
                id: directory.lastPathComponent,
                directory: directory,
                seats: seats,
                files: jsonl,
                latestChange: latest,
                isLive: age <= liveWindow && age >= -1
            ))
        }
        games.sort { $0.latestChange > $1.latestChange }
        return games
    }
}
