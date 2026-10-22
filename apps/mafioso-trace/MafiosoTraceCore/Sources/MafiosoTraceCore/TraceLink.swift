import Foundation

/// An `llm.call` and the `engine.validation` that belongs to the same seat.
public struct ProposalVerdict: Equatable, Sendable {
    public var proposal: TraceEvent?
    public var verdict: TraceEvent?

    public init(proposal: TraceEvent?, verdict: TraceEvent?) {
        self.proposal = proposal
        self.verdict = verdict
    }
}

public enum TraceLink {
    /// `data.callId` when the record has one. Empty and missing ids are the same.
    public static func callID(_ event: TraceEvent) -> String? {
        guard let text = event.data["callId"]?.string else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Pair a model call with the engine verdict that carries the same `callId`.
    /// A line written before call ids existed still pairs by seat and order:
    /// `llm.call` looks forward to the next validation, and a validation looks backward.
    public static func pair(for event: TraceEvent, in events: [TraceEvent]) -> ProposalVerdict {
        if event.type == "llm.call" || event.type == "engine.validation", let id = callID(event) {
            let proposal = events.first { $0.type == "llm.call" && callID($0) == id }
            let verdict = events.first { $0.type == "engine.validation" && callID($0) == id }
            return ProposalVerdict(
                proposal: proposal ?? (event.type == "llm.call" ? event : nil),
                verdict: verdict ?? (event.type == "engine.validation" ? event : nil)
            )
        }
        switch event.type {
        case "llm.call":
            let verdict = events.first {
                $0.seq > event.seq && $0.seat == event.seat && $0.type == "engine.validation"
            }
            return ProposalVerdict(proposal: event, verdict: verdict)
        case "engine.validation":
            let proposal = events.last {
                $0.seq < event.seq && $0.seat == event.seat && $0.type == "llm.call"
            }
            return ProposalVerdict(proposal: proposal, verdict: event)
        default:
            return ProposalVerdict(proposal: nil, verdict: nil)
        }
    }

    public static func summary(_ event: TraceEvent) -> String {
        let data = event.data
        switch event.type {
        case "game.start":
            if let role = data["self"]?["role"]?.string, !role.isEmpty {
                let name = data["self"]?["name"]?.string ?? ""
                return name.isEmpty ? "start \(role)" : "start \(name) \(role)"
            }
            if let setup = data["setupId"]?.string, !setup.isEmpty {
                return "start \(setup)"
            }
            return "start"
        case "game.end":
            if let status = data["status"]?.string, !status.isEmpty { return status }
            return "end"
        case "phase.change":
            let from = data["from"]?.string ?? ""
            let to = data["to"]?.string ?? ""
            if from.isEmpty { return to }
            return "\(from) → \(to)"
        case "llm.call":
            let model = data["model"]?.string ?? ""
            let latency = data["latencyMs"]?.int.map { "\($0) ms" } ?? ""
            let text = [model, latency].filter { !$0.isEmpty }.joined(separator: " ")
            return text.isEmpty ? "model call" : text
        case "engine.validation":
            let ok = data["ok"]?.bool ?? false
            if ok { return "accepted" }
            let reason = data["reason"]?.string ?? ""
            return reason.isEmpty ? "rejected" : "rejected \(reason)"
        case "chat.sent":
            return data["content"]?.string ?? "sent"
        case "chat.suppressed":
            let filter = data["filter"]?.string ?? ""
            let reason = data["reason"]?.string ?? ""
            return [filter, reason].filter { !$0.isEmpty }.joined(separator: " ")
        case "chat.observed":
            let name = data["name"]?.string ?? data["senderId"]?.string ?? "player"
            let text = data["text"]?.string ?? ""
            return "untrusted \(name): \(text)"
        case "vote.sent", "night.sent":
            let meeting = data["meetingName"]?.string ?? data["meetingId"]?.string ?? ""
            let selection = data["selection"]?.string ?? ""
            return [meeting, selection].filter { !$0.isEmpty }.joined(separator: " ")
        case "vote.notice":
            let leader = data["leader"]?.string ?? ""
            return leader.isEmpty ? "untrusted tally" : "untrusted tally \(leader)"
        case "error":
            return data["message"]?.string ?? "error"
        case "retry":
            return data["reason"]?.string ?? "retry"
        case "rate_limit":
            return "429"
        default:
            return event.type
        }
    }
}

/// `-fixture <path>` from the process arguments. Other arguments are ignored.
public struct LaunchOptions: Equatable, Sendable {
    public var fixturePath: String?

    public init(fixturePath: String? = nil) {
        self.fixturePath = fixturePath
    }

    public init(arguments: [String]) {
        var fixture: String?
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "-fixture" || argument == "--fixture", index + 1 < arguments.count {
                fixture = arguments[index + 1]
                index += 2
                continue
            }
            index += 1
        }
        fixturePath = fixture
    }
}
