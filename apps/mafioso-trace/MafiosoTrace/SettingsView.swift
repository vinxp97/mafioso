import MafiosoTraceCore
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var config: AppConfigController
    @AppStorage(LogsRoot.storageKey) private var logsRoot = LogsRoot.defaultPath
    @State private var revealClient = false
    @State private var revealKey = false
    @State private var apiProbe = ""
    @State private var apiProbing = false
    @State private var modelProbe = ""
    @State private var modelProbing = false
    @State private var models: [ModelInfo] = []
    @State private var modelQuery = ""

    var body: some View {
        TabView {
            environments
                .tabItem { Text("Environments") }
            inference
                .tabItem { Text("Inference") }
            logs
                .tabItem { Text("Logs") }
        }
        .padding(12)
        .frame(width: 680, height: 640)
    }

    private var environments: some View {
        Form {
            TextField("Repository", text: repository)
            Text("Checkout that contains scripts/mac-container-run.sh and harness/scripts/live.mjs.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("Environment", selection: environment) {
                ForEach(GameEnvironment.allCases) { item in
                    Text(item.displayName).tag(item)
                }
            }
            notice
            TextField("API base URL", text: profileString(\.apiBaseURL))
            TextField("Socket URL", text: profileString(\.socketURL))
            Text("A raw socket such as /3010 is stored and is not sent. A path under /api/dev/ is sent as DEV_STREAM_PATH.")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("OAuth client id", text: profileString(\.oauthClientID))
            secretRow(
                "Client secret",
                text: clientSecret,
                reveal: $revealClient
            )
            Text("The client secret is a Keychain item for this environment (\(SecretAccount.service)). It is not written to the config file.")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("Setup id", text: profileString(\.setupID))
            Stepper(value: botCount, in: 1 ... 50) {
                Text("Bot count: \(config.selectedProfile.botCount)")
            }
            TextField("Lobby", text: profileString(\.lobby))
            Text("Sent as LOBBY_NAME. The default is Testing.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if config.selectedProfile.id.showsTunnel {
                tunnel
            }
            HStack {
                Button(apiProbing ? "Testing…" : "Test connection") {
                    probeAPI()
                }
                .disabled(apiProbing)
                Text(apiProbe)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let keychainError = config.keychainError {
                Text(keychainError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            if let saveError = config.saveError {
                Text(saveError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .onChange(of: config.config.selectedEnvironment) { _, _ in
            apiProbe = ""
            revealClient = false
        }
    }

    @ViewBuilder
    private var notice: some View {
        let id = config.selectedProfile.id
        if id == .legacy {
            Text("Not supported by the harness yet. Start stays off. ultimafia.com uses a cookie and a raw socket, and the harness speaks the Dev API.")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else if id == .production {
            Text("Production. Start asks you to type ultimafia.gg. The harness allowlist still rejects this host.")
                .font(.caption)
                .foregroundStyle(.orange)
        } else if id == .qa {
            Text("qa.ultimafia.gg is not on the harness allowlist. Start stays available. The process will start, and the harness will refuse the host.")
                .font(.caption)
                .foregroundStyle(.orange)
        }
    }

    private var tunnel: some View {
        Group {
            TextField("SSH host alias", text: tunnelString(\.sshHostAlias))
            Text("Stored only. The app does not open the tunnel.")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("API port", value: tunnelInt(\.apiPort), format: .number)
            TextField("Bridge port", value: tunnelInt(\.bridgePort), format: .number)
            TextField("Socket port", value: tunnelInt(\.socketPort), format: .number)
            TextField("Container gateway", text: tunnelString(\.containerGateway))
        }
    }

    private var inference: some View {
        Form {
            Picker("Provider", selection: provider) {
                ForEach(ProviderKind.allCases) { item in
                    Text(item.displayName).tag(item)
                }
            }
            Text(providerHelp)
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("Base URL", text: baseURL)
            Text("Model id")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField(modelPlaceholder, text: modelID)
            Text("The list comes from /models. Type an id if that request fails.")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("Search models", text: $modelQuery)
            if config.config.inference.provider == .openRouter {
                Toggle("Free only", isOn: inferenceBool(\.openRouterFreeOnly))
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    if visibleModels.isEmpty {
                        Text("No model list yet.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(visibleModels) { model in
                        Button {
                            let id = model.id
                            let kind = config.config.inference.provider
                            config.updateInference { $0.setModel(id, for: kind) }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(model.id)
                                    .lineLimit(1)
                                if !modelDetail(model).isEmpty {
                                    Text(modelDetail(model))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(minHeight: 120, maxHeight: 180)
            providerExtras
            Picker("Reasoning", selection: reasoningMode) {
                ForEach(ReasoningMode.allCases) { mode in
                    Text(mode.displayName).tag(mode)
                }
            }
            Text("Automatic omits MAFIOSO_REASONING. On sends 1. Off sends 0.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Stepper(value: concurrency, in: 0 ... 64) {
                Text(concurrencyLabel)
            }
            Text("0 omits MAFIOSO_LLM_CONCURRENCY. The harness then uses 1 for LM Studio and 4 for the others.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Toggle("Trace reasoning", isOn: traceReasoning)
            Text("On sets MAFIOSO_TRACE_REASONING=1. Off omits it, and the harness leaves reasoning out of the trace.")
                .font(.caption)
                .foregroundStyle(.secondary)
            secretRow("API key", text: apiKey, reveal: $revealKey)
            Text(keyHelp)
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack {
                Button(modelProbing ? "Testing…" : "Test connection") {
                    probeModels()
                }
                .disabled(modelProbing)
                Text(modelProbe)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .onChange(of: config.config.inference.provider) { _, _ in
            models = []
            modelProbe = ""
            modelQuery = ""
            revealKey = false
        }
    }

    @ViewBuilder
    private var providerExtras: some View {
        switch config.config.inference.provider {
        case .experiential:
            Toggle("Zero data retention", isOn: inferenceBool(\.experientialZDR))
            Text("On sends EXPLABS_ZDR=1. Off omits it.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .openCodeGo:
            TextField("Session", text: inferenceString(\.openCodeSession))
            Text("Optional. An empty OPENCODE_SESSION lets the harness generate one. The factory sets user-agent mafioso/0.1.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .openRouter:
            Picker("OpenRouter reasoning", selection: reasoningEffort) {
                ForEach(ReasoningEffort.allCases) { effort in
                    Text(effort.displayName).tag(effort)
                }
            }
            TextField("HTTP referer", text: inferenceString(\.openRouterReferer))
            TextField("Title", text: inferenceString(\.openRouterTitle))
            Text("OPENROUTER_HTTP_REFERER and OPENROUTER_TITLE are sent only when set. None sends OPENROUTER_REASONING=off.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .lmStudio:
            EmptyView()
        }
    }

    private var logs: some View {
        Form {
            TextField("Logs root", text: $logsRoot)
            Text("Folder of game directories. Each game is a folder of seat JSONL files. The default is ~/mafioso-mac/logs. A launch turns tracing on and writes here. A container run mounts this folder at /app/logs/traces.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func secretRow(_ title: String, text: Binding<String>, reveal: Binding<Bool>) -> some View {
        HStack {
            if reveal.wrappedValue {
                TextField(title, text: text)
            } else {
                SecureField(title, text: text)
            }
            Button(reveal.wrappedValue ? "Hide" : "Show") {
                reveal.wrappedValue.toggle()
            }
        }
    }

    private var providerHelp: String {
        switch config.config.inference.provider {
        case .lmStudio:
            return "LM_STUDIO_BASE_URL, LM_STUDIO_MODEL, and LM_API_KEY. An empty model uses the first id from /models."
        case .experiential:
            return "EXPLABS_BASE_URL, EXPLABS_MODEL, and EXPLABS_API_KEY. Example model: qwen3.8-27b."
        case .openCodeGo:
            return "OPENCODE_BASE_URL, OPENCODE_MODEL, OPENCODE_API_KEY, and OPENCODE_SESSION. Examples: kimi-k2.6, mimo-v2.5, glm-5.1."
        case .openRouter:
            return "OPENROUTER_BASE_URL, OPENROUTER_MODEL, OPENROUTER_API_KEY, and OPENROUTER_REASONING."
        }
    }

    private var keyHelp: String {
        let account = SecretAccount.apiKey(config.config.inference.provider)
        if config.config.inference.provider == .lmStudio {
            return "Leave the key blank to send lm-studio. Stored in the Keychain as \(account) under \(SecretAccount.service)."
        }
        return "Required. Stored in the Keychain as \(account) under \(SecretAccount.service). It is not written to the config file."
    }

    private var modelPlaceholder: String {
        switch config.config.inference.provider {
        case .lmStudio: return "Empty uses the first id from /models"
        case .experiential: return "qwen3.8-27b"
        case .openCodeGo: return "kimi-k2.6"
        case .openRouter: return "minimax/minimax-m3.1-flash"
        }
    }

    private var concurrencyLabel: String {
        let value = config.config.inference.concurrency
        if value <= 0 { return "Concurrency: harness default" }
        return "Concurrency: \(value)"
    }

    private var visibleModels: [ModelInfo] {
        let freeOnly = config.config.inference.provider == .openRouter && config.config.inference.openRouterFreeOnly
        return ModelCatalog.filter(models, query: modelQuery, freeOnly: freeOnly)
    }

    private func modelDetail(_ model: ModelInfo) -> String {
        var parts: [String] = []
        if model.name != model.id { parts.append(model.name) }
        if let context = model.contextLength { parts.append("context \(context)") }
        if let prompt = model.promptPrice { parts.append("prompt \(prompt)") }
        if let completion = model.completionPrice { parts.append("completion \(completion)") }
        if model.isFree { parts.append("free") }
        return parts.joined(separator: " · ")
    }

    private var repository: Binding<String> {
        Binding(get: { config.config.repositoryPath }, set: { config.setRepository($0) })
    }

    private var environment: Binding<GameEnvironment> {
        Binding(get: { config.config.selectedEnvironment }, set: { config.selectEnvironment($0) })
    }

    private var clientSecret: Binding<String> {
        Binding(
            get: { config.clientSecrets[config.config.selectedEnvironment] ?? "" },
            set: { config.setClientSecret($0, environment: config.config.selectedEnvironment) }
        )
    }

    private var provider: Binding<ProviderKind> {
        Binding(
            get: { config.config.inference.provider },
            set: { kind in config.updateInference { $0.provider = kind } }
        )
    }

    private var baseURL: Binding<String> {
        Binding(
            get: { config.config.inference.baseURL(for: config.config.inference.provider) },
            set: { value in
                let kind = config.config.inference.provider
                config.updateInference { settings in
                    switch kind {
                    case .lmStudio: settings.lmStudioBaseURL = value
                    case .experiential: settings.experientialBaseURL = value
                    case .openCodeGo: settings.openCodeBaseURL = value
                    case .openRouter: settings.openRouterBaseURL = value
                    }
                }
            }
        )
    }

    private var modelID: Binding<String> {
        Binding(
            get: { config.config.inference.model(for: config.config.inference.provider) },
            set: { value in
                let kind = config.config.inference.provider
                config.updateInference { $0.setModel(value, for: kind) }
            }
        )
    }

    private var apiKey: Binding<String> {
        Binding(
            get: { config.apiKeys[config.config.inference.provider] ?? "" },
            set: { config.setAPIKey($0, provider: config.config.inference.provider) }
        )
    }

    private var reasoningMode: Binding<ReasoningMode> {
        Binding(
            get: { config.config.inference.reasoningMode },
            set: { mode in config.updateInference { $0.reasoningMode = mode } }
        )
    }

    private var reasoningEffort: Binding<ReasoningEffort> {
        Binding(
            get: { config.config.inference.reasoningEffort },
            set: { effort in config.updateInference { $0.reasoningEffort = effort } }
        )
    }

    private var concurrency: Binding<Int> {
        Binding(
            get: { config.config.inference.concurrency },
            set: { value in config.updateInference { $0.concurrency = min(64, max(0, value)) } }
        )
    }

    private var traceReasoning: Binding<Bool> {
        Binding(
            get: { !config.config.inference.excludeReasoning },
            set: { on in config.updateInference { $0.excludeReasoning = !on } }
        )
    }

    private var botCount: Binding<Int> {
        Binding(
            get: { config.selectedProfile.botCount },
            set: { value in config.updateProfile { $0.botCount = min(50, max(1, value)) } }
        )
    }

    private func profileString(_ keyPath: WritableKeyPath<EnvironmentProfile, String>) -> Binding<String> {
        Binding(
            get: { config.selectedProfile[keyPath: keyPath] },
            set: { value in config.updateProfile { $0[keyPath: keyPath] = value } }
        )
    }

    private func tunnelString(_ keyPath: WritableKeyPath<TunnelSettings, String>) -> Binding<String> {
        Binding(
            get: { config.selectedProfile.tunnel[keyPath: keyPath] },
            set: { value in config.updateProfile { $0.tunnel[keyPath: keyPath] = value } }
        )
    }

    private func tunnelInt(_ keyPath: WritableKeyPath<TunnelSettings, Int>) -> Binding<Int> {
        Binding(
            get: { config.selectedProfile.tunnel[keyPath: keyPath] },
            set: { value in config.updateProfile { $0.tunnel[keyPath: keyPath] = value } }
        )
    }

    private func inferenceString(_ keyPath: WritableKeyPath<InferenceSettings, String>) -> Binding<String> {
        Binding(
            get: { config.config.inference[keyPath: keyPath] },
            set: { value in config.updateInference { $0[keyPath: keyPath] = value } }
        )
    }

    private func inferenceBool(_ keyPath: WritableKeyPath<InferenceSettings, Bool>) -> Binding<Bool> {
        Binding(
            get: { config.config.inference[keyPath: keyPath] },
            set: { value in config.updateInference { $0[keyPath: keyPath] = value } }
        )
    }

    private func probeAPI() {
        apiProbing = true
        let base = config.selectedProfile.apiBaseURL
        Task { @MainActor in
            let report = await ConnectionProbe.api(base: base)
            apiProbe = report.summary
            apiProbing = false
        }
    }

    private func probeModels() {
        modelProbing = true
        let inference = config.config.inference
        let kind = inference.provider
        let base = inference.baseURL(for: kind)
        let key = config.apiKeys[kind] ?? ""
        let session = inference.openCodeSession
        Task { @MainActor in
            let report = await ConnectionProbe.models(base: base, apiKey: key, provider: kind, sessionHeader: session)
            modelProbe = report.summary
            models = report.models
            modelProbing = false
        }
    }
}
