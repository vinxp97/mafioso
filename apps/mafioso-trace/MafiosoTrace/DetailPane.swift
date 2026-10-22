import MafiosoTraceCore
import SwiftUI

struct DetailPane: View {
    let event: TraceEvent?
    let pair: ProposalVerdict

    var body: some View {
        if let event {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Color.clear
                            .frame(height: 0)
                            .id(Self.topID)
                        if event.type == "llm.call" || event.type == "engine.validation" {
                            proposalVerdict
                        }
                        header(event)
                        if let reasoning = reasoningText {
                            Text("Reasoning")
                                .font(.headline)
                            selectable(reasoning)
                        }
                        if let details = reasoningDetails {
                            Text("Reasoning details")
                                .font(.headline)
                            selectable(details)
                        }
                        Text("Data")
                            .font(.headline)
                        selectable(event.data.display)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .id(event.id)
                .onAppear { scheduleScroll(proxy, to: Self.topID) }
                .onChange(of: event.id) { _, _ in
                    scheduleScroll(proxy, to: Self.topID)
                }
            }
        } else {
            ContentUnavailableView("No event", systemImage: "list.bullet", description: Text("Select a row in the timeline."))
        }
    }

    private var proposalVerdict: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Proposal vs Verdict")
                .font(.headline)
            if let call = callLabel {
                Text(call)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .top, spacing: 12) {
                column(title: "Proposal", text: proposalBody(pair.proposal))
                Divider()
                column(title: "Verdict", text: verdictBody(pair.verdict))
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }

    private static let topID = "detail-top"

    private var callLabel: String? {
        if let id = pair.proposal.flatMap(TraceLink.callID) { return "call \(id)" }
        if let id = pair.verdict.flatMap(TraceLink.callID) { return "call \(id)" }
        return nil
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
            Text("\(event.seat)  \(TimelineState.phaseLabel(event.phase))  #\(event.seq)  \(event.ts)")
                .font(.callout)
                .foregroundStyle(.secondary)
            if event.data["untrusted"]?.bool == true {
                Text("Untrusted player data")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
    }

    /// Scroll after this layout pass. Scrolling during it asks AppKit for another constraints pass.
    private func scheduleScroll(_ proxy: ScrollViewProxy, to id: String) {
        DispatchQueue.main.async {
            proxy.scrollTo(id, anchor: .top)
        }
    }

    private func selectable(_ text: String) -> some View {
        Text(text)
            .font(.system(.body, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func column(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.semibold))
            selectable(text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func proposalBody(_ event: TraceEvent?) -> String {
        guard let event else { return "No model call yet" }
        guard let parsed = event.data["parsed"], parsed != .null else { return "No parsed action" }
        return parsed.display
    }

    private func verdictBody(_ event: TraceEvent?) -> String {
        guard let event else { return "No engine verdict yet" }
        let ok = event.data["ok"]?.bool ?? false
        var lines = [ok ? "accepted" : "rejected"]
        if let reason = event.data["reason"]?.string, !reason.isEmpty { lines.append("reason \(reason)") }
        if let action = event.data["action"]?.string, !action.isEmpty { lines.append("action \(action)") }
        if let meeting = event.data["meetingId"]?.string, !meeting.isEmpty { lines.append("meeting \(meeting)") }
        if let selection = event.data["selection"]?.string, !selection.isEmpty { lines.append("selection \(selection)") }
        if let content = event.data["content"]?.string, !content.isEmpty { lines.append(content) }
        return lines.joined(separator: "\n")
    }
}
