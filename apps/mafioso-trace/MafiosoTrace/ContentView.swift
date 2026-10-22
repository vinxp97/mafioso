import MafiosoTraceCore
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: GameStore
    @AppStorage(LogsRoot.storageKey) private var logsRoot = LogsRoot.defaultPath

    var body: some View {
        NavigationSplitView {
            sidebar
        } content: {
            seatColumn
        } detail: {
            detail
        }
        .onAppear {
            store.start(arguments: CommandLine.arguments)
            store.setLogsRoot(logsRoot)
        }
        .onChange(of: logsRoot) { _, path in
            store.setLogsRoot(path)
        }
        .onChange(of: store.selection) { _, _ in
            store.userChangedSelection()
        }
    }

    private var sidebar: some View {
        List(selection: gameBinding) {
            if store.games.isEmpty {
                Text(emptyTitle)
                    .foregroundStyle(.secondary)
            }
            ForEach(store.games) { game in
                HStack {
                    Text(game.id)
                        .lineLimit(1)
                    Spacer()
                    if store.fixtureName != nil {
                        badge("FIXTURE", color: .orange)
                    } else if game.isLive {
                        badge("LIVE", color: .green)
                    }
                }
                .tag(game.id as String?)
            }
        }
        .navigationTitle("Games")
        .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 320)
        .safeAreaInset(edge: .bottom) {
            Text(store.fixtureName == nil ? LogsRoot.url(from: store.logsRootPath).path : store.statusLine)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
        }
    }

    private var seatColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            List(selection: seatBinding) {
                Text("All").tag("all" as String?)
                Text("Harness").tag("harness" as String?)
                ForEach(store.playerSeats, id: \.self) { seat in
                    Text(seat).tag(seat as String?)
                }
            }
            .navigationTitle("Seat")
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                Text("Phase")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Picker("Phase", selection: phaseBinding) {
                    Text("All").tag("all")
                    ForEach(store.phases, id: \.self) { phase in
                        Text(phase).tag(phase)
                    }
                }
                .labelsHidden()
            }
            .padding(8)
        }
        .navigationSplitViewColumnWidth(min: 160, ideal: 200, max: 280)
    }

    private var detail: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Toggle("Follow", isOn: Binding(get: { store.follow }, set: { store.setFollow($0) }))
                    .toggleStyle(.switch)
                Button("Reload") {
                    store.reload()
                }
                if !store.currentGameIsLive {
                    if let bounds = store.scrubBounds, bounds.upperBound > bounds.lowerBound {
                        Slider(
                            value: Binding(
                                get: { Scrub.clamp(store.scrub, count: store.visible.count) },
                                set: { store.userScrubbed(to: $0) }
                            ),
                            in: bounds,
                            step: 1
                        )
                    }
                    Text(store.scrubLabel)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                } else if store.follow {
                    Text("Live")
                        .font(.caption)
                        .foregroundStyle(.green)
                }
                Spacer()
                Text(store.statusLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            Table(store.visible, selection: tableSelection) {
                TableColumn("Seq") { (row: TraceEvent) in
                    Text("\(row.seq)").monospacedDigit()
                }
                TableColumn("Time") { (row: TraceEvent) in
                    Text(Self.clock(row.ts))
                }
                TableColumn("Seat") { (row: TraceEvent) in
                    Text(row.seat)
                }
                TableColumn("Phase") { (row: TraceEvent) in
                    Text(row.phase)
                }
                TableColumn("Type") { (row: TraceEvent) in
                    Text(row.type)
                }
                TableColumn("Summary") { (row: TraceEvent) in
                    Text(TraceLink.summary(row)).lineLimit(1)
                }
            }
            Divider()
            DetailPane(event: store.selectedEvent, pair: pair)
                .frame(minHeight: 180)
        }
        .navigationTitle(store.selectedGameID ?? "Trace")
    }

    private var pair: ProposalVerdict {
        guard let event = store.selectedEvent else {
            return ProposalVerdict(proposal: nil, verdict: nil)
        }
        return TraceLink.pair(for: event, in: store.events)
    }

    private var emptyTitle: String {
        if store.fixtureMissing { return "Fixture file is missing" }
        if store.missingRoot { return "Logs folder is missing" }
        return "No games"
    }

    private var tableSelection: Binding<Set<TraceEvent.ID>> {
        Binding(
            get: { Scrub.selection(store.selection, available: store.visible.map(\.id)) },
            set: { store.selection = $0 }
        )
    }

    private var gameBinding: Binding<String?> {
        Binding(get: { store.selectedGameID }, set: { store.select(game: $0) })
    }

    private var seatBinding: Binding<String?> {
        Binding(get: { store.resolvedSeat }, set: { store.seat = $0 ?? "all" })
    }

    private var phaseBinding: Binding<String> {
        Binding(get: { store.resolvedPhase }, set: { store.phase = $0 })
    }

    private func badge(_ title: String, color: Color) -> some View {
        Text(title)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.18), in: RoundedRectangle(cornerRadius: 4))
            .foregroundStyle(color)
    }

    private static func clock(_ ts: String) -> String {
        guard let time = ts.split(separator: "T").dropFirst().first else { return ts }
        return String(time.prefix(12))
    }
}
