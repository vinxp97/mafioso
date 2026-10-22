import MafiosoTraceCore
import SwiftUI

struct DetailPane: View {
    let event: TraceEvent?
    let pair: ProposalVerdict

    var body: some View {
        if let event {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    header(event)
                    if event.type == "llm.call" || event.type == "engine.validation" {
                        HStack(alignment: .top, spacing: 16) {
                            column(title: "Proposal", text: proposalText(pair.proposal))
                            column(title: "Engine verdict", text: verdictText(pair.verdict))
                        }
                    }
                    if let reasoning = reasoningText {
                        Text("Reasoning")
                            .font(.headline)
                        Text(reasoning)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if let details = reasoningDetails {
                        Text("Reasoning details")
                            .font(.headline)
                        Text(details)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Text("Data")
                        .font(.headline)
                    Text(event.data.display)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            ContentUnavailableView("No event", systemImage: "list.bullet", description: Text("Select a row in the timeline."))
        }
    }

    private var reasoningText: String? {
        let source = pair.proposal ?? event
        guard let text = source?.data["reasoning"]?.string, !text.isEmpty else { return nil }
        return text
    }

    private var reasoningDetails: String? {
        let source = pair.proposal ?? event
        guard let value = source?.data["reasoningDetails"], value != .null else { return nil }
        if let text = value.string, text.isEmpty { return nil }
        return value.display
    }

    private func header(_ event: TraceEvent) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(event.type)
                .font(.title3)
            Text("\(event.seat)  \(event.phase)  #\(event.seq)  \(event.ts)")
                .font(.callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            if event.data["untrusted"]?.bool == true {
                Text("Untrusted player data")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func column(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline)
            Text(text)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func proposalText(_ event: TraceEvent?) -> String {
        guard let event else { return "No model call yet" }
        let model = event.data["model"]?.string ?? ""
        let raw = event.data["raw"]?.string ?? ""
        let parsed = event.data["parsed"]?.display ?? "null"
        return [model, raw, parsed].filter { !$0.isEmpty }.joined(separator: "\n")
    }

    private func verdictText(_ event: TraceEvent?) -> String {
        guard let event else { return "No engine verdict yet" }
        let ok = event.data["ok"]?.bool ?? false
        let reason = event.data["reason"]?.string ?? ""
        let action = event.data["action"]?.string ?? ""
        let selection = event.data["selection"]?.string ?? ""
        if ok {
            return ["accepted", action, selection].filter { !$0.isEmpty }.joined(separator: " ")
        }
        return ["rejected", reason].filter { !$0.isEmpty }.joined(separator: " ")
    }
}
