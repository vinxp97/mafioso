import Foundation

/// One JSONL record from `docs/TRACING.md`. `seq` is unique inside a game.
public struct TraceEvent: Equatable, Identifiable, Sendable {
    public let v: Int
    public let seq: Int
    public let ts: String
    public let gameId: String
    public let seat: String
    public let phase: String
    public let type: String
    public let data: JSONValue

    public var id: String { "\(gameId)#\(seq)" }

    public init(
        v: Int,
        seq: Int,
        ts: String,
        gameId: String,
        seat: String,
        phase: String,
        type: String,
        data: JSONValue
    ) {
        self.v = v
        self.seq = seq
        self.ts = ts
        self.gameId = gameId
        self.seat = seat
        self.phase = phase
        self.type = type
        self.data = data
    }

    /// Parse one line. Blank lines and broken JSON are skipped. The file body is not kept.
    public static func parse(line: String) -> TraceEvent? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        guard let raw = trimmed.data(using: .utf8) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else { return nil }
        let json = JSONValue(jsonObject: object)
        guard let version = json["v"]?.int, let seq = json["seq"]?.int else { return nil }
        guard let type = json["type"]?.string, !type.isEmpty else { return nil }
        return TraceEvent(
            v: version,
            seq: seq,
            ts: json["ts"]?.string ?? "",
            gameId: json["gameId"]?.string ?? "",
            seat: json["seat"]?.string ?? "",
            phase: json["phase"]?.string ?? "",
            type: type,
            data: json["data"] ?? .object([:])
        )
    }
}
