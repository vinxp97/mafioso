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
    @State private var modelRequestSucceeded = false

    var body: some View {
        TabView {
            environments
                .tabItem { Text("Environments") }
            inference
                .tabItem { Text("Inference") }
            logs
                .tabItem { Text("Logs") }
        }
        .frame(minWidth: 760, idealWidth: 900, minHeight: 640, idealHeight: 760)
    }

    private var environments: some View {
        Form {
            Section {
                labeledPicker("Repository", selection: repositoryKind) {
                    ForEach(RepositoryKind.allCases, id: \.self) { kind in
                        Text(kind.displayName).tag(kind)
                    }
                }
                if config.config.repositoryKind == .git {
                    labeled("URL", text: repositoryURL, prompt: "https://github.com/vinxp97/mafioso")
                    labeled("Branch", text: repositoryBranch, prompt: "main")
                } else {
                    labeled("Folder", text: repository, prompt: "Path to the checkout")
                }
            } footer: {
                help("A Git URL is cloned into ~/Library/Caches/MafiosoTrace/repos and updated on each Start. A local folder is never reset. engine and harness install when node_modules is missing or package.json changed. The checkout contains scripts/mac-container-run.sh and harness/scripts/live.mjs.")
            }
            Section {
                labeledPicker("Environment", selection: environment) {
                    ForEach(GameEnvironment.allCases) { item in
                        Text(item.displayName).tag(item)
                    }
                }
                notice
            }
            Section {
                labeled("API base URL", text: profileString(\.apiBaseURL), prompt: "Required")
                labeled("Socket URL", text: profileString(\.socketURL), prompt: "Optional")
                labeled("OAuth client id", text: profileString(\.oauthClientID), prompt: "Required")
                labeledSecret(
                    "Client secret",
                    text: clientSecret,
                    revealed: $revealClient,
                    prompt: "Paste secret",
                    accessibility: "\(revealClient ? "Hide" : "Show") client secret"
                )
                labeled("Setup id", text: profileString(\.setupID), prompt: "Required")
                LabeledContent("Bot count") {
                    Stepper(value: botCount, in: 1 ... 50) {
                        Text("\(config.selectedProfile.botCount)")
                            .monospacedDigit()
                    }
                }
                labeled("Lobby", text: profileString(\.lobby), prompt: "Testing")
            } footer: {
                help("A raw socket such as /3010 is stored and is not sent. A path under /api/dev/ is sent as DEV_STREAM_PATH. The client secret is a Keychain item (\(SecretAccount.service)) and is not written to the config file. Lobby is sent as LOBBY_NAME.")
            }
            if config.selectedProfile.id.showsTunnel {
                Section {
                    labeled("SSH host alias", text: tunnelString(\.sshHostAlias), prompt: "Optional")
                    labeledInteger("API port", value: tunnelInt(\.apiPort), prompt: "3000")
                    labeledInteger("Bridge port", value: tunnelInt(\.bridgePort), prompt: "2999")
                    labeledInteger("Socket port", value: tunnelInt(\.socketPort), prompt: "3010")
                    labeled("Container gateway", text: tunnelString(\.containerGateway), prompt: "192.168.64.1")
                } footer: {
                    help("Stored only. The app does not open the tunnel.")
                }
            }
            Section {
                namedButton(
                    apiProbing ? "Testing…" : "Test connection",
                    accessibility: "Test \(config.selectedProfile.id.displayName) connection",
                    disabled: apiProbing
                ) {
                    probeAPI()
                }
                if !apiProbe.isEmpty {
                    probeStatus(apiProbe)
                }
                if let keychainError = config.keychainError {
                    Text(keychainError)
                        .foregroundStyle(.red)
                }
                if let saveError = config.saveError {
                    Text(saveError)
                        .foregroundStyle(.red)
                }
            }
        }
        .formStyle(.grouped)
        .onChange(of: config.config.selectedEnvironment) { _, _ in
            apiProbe = ""
            revealClient = false
        }
    }

    @ViewBuilder
    private var notice: some View {
        let id = config.selectedProfile.id
        if id == .legacy {
            help("Not supported by the harness yet. Start stays off. ultimafia.com uses a cookie and a raw socket, and the harness speaks the Dev API.")
        } else if id == .production {
            help("Production. Start asks you to type ultimafia.gg. The harness allowlist still rejects this host.", color: .orange)
        } else if id == .qa {
            help("qa.ultimafia.gg is not on the harness allowlist. Start stays available. The process will start, and the harness will refuse the host.", color: .orange)
        }
    }

    private var inference: some View {
        Form {
            Section {
                labeledPicker("Provider", selection: provider) {
                    ForEach(ProviderKind.allCases) { item in
                        Text(item.displayName).tag(item)
                    }
                }
            } footer: {
                help(providerHelp)
            }
            if showsModelSearch {
                Section {
                    labeled("Base URL", text: baseURL, prompt: "Required")
                    LabeledContent("Model id") {
                        borderedField(modelPlaceholder, text: modelID)
                    }
                } footer: {
                    help("The list comes from /models. Type an id if that request fails.")
                }
            } else {
                Section {
                    labeled("Base URL", text: baseURL, prompt: "Required")
                    LabeledContent("Model id") {
                        borderedField(modelPlaceholder, text: modelID)
                    }
                }
            }
            if config.config.inference.provider == .openRouter {
                Toggle("Free only", isOn: inferenceBool(\.openRouterFreeOnly))
            }
            if showsModelSearch {
                Section {
                    LabeledContent("Search models") {
                        borderedField("Name or id", text: $modelQuery)
                    }
                    modelList
                }
            }
            providerExtras
            Section {
                labeledPicker("Reasoning", selection: reasoningMode) {
                    ForEach(ReasoningMode.allCases) { mode in
                        Text(mode.displayName).tag(mode)
                    }
                }
                LabeledContent("Concurrency") {
                    Stepper(value: concurrency, in: 0 ... 64) {
                        Text(concurrencyValue)
                            .monospacedDigit()
                    }
                }
                Toggle("Trace reasoning", isOn: traceReasoning)
            } footer: {
                help("Automatic omits MAFIOSO_REASONING. On sends 1. Off sends 0. Concurrency 0 omits MAFIOSO_LLM_CONCURRENCY, and the harness then uses 1 for LM Studio and 4 for the others. Trace reasoning on sets MAFIOSO_TRACE_REASONING=1.")
            }
            Section {
                labeledSecret(
                    "API key",
                    text: apiKey,
                    revealed: $revealKey,
                    prompt: apiKeyPrompt,
                    accessibility: "\(revealKey ? "Hide" : "Show") API key"
                )
                namedButton(
                    modelProbing ? "Testing…" : "Test connection",
                    accessibility: "Test \(config.config.inference.provider.displayName) connection",
                    disabled: modelProbing
                ) {
                    probeModels()
                }
                if !modelProbe.isEmpty {
                    probeStatus(modelProbe)
                }
            } footer: {
                help(keyHelp)
            }
        }
        .formStyle(.grouped)
        .onChange(of: config.config.inference.provider) { _, _ in
            models = []
            modelProbe = ""
            modelQuery = ""
            modelRequestSucceeded = false
            revealKey = false
        }
    }

    private var showsModelSearch: Bool {
        ModelListUI.showsSearch(
            provider: config.config.inference.provider,
            modelsRequestSucceeded: modelRequestSucceeded
        )
    }

    private var modelList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                if visibleModels.isEmpty {
                    help("No model list yet.")
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
                                .truncationMode(.middle)
                            if !modelDetail(model).isEmpty {
                                Text(modelDetail(model))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(minHeight: 80, maxHeight: 180)
    }

    @ViewBuilder
    private var providerExtras: some View {
        switch config.config.inference.provider {
        case .experiential:
            Section {
                Toggle("Zero data retention", isOn: inferenceBool(\.experientialZDR))
            } footer: {
                help("On sends EXPLABS_ZDR=1. Off omits it.")
            }
        case .openCodeGo:
            Section {
                labeled("Session", text: inferenceString(\.openCodeSession), prompt: "Optional")
            } footer: {
                help("Optional. An empty OPENCODE_SESSION lets the harness generate one. The factory sets user-agent mafioso/0.1.")
            }
        case .openRouter:
            Section {
                labeledPicker("OpenRouter reasoning", selection: reasoningEffort) {
                    ForEach(ReasoningEffort.allCases) { effort in
                        Text(effort.displayName).tag(effort)
                    }
                }
                labeled("HTTP referer", text: inferenceString(\.openRouterReferer), prompt: "Optional")
                labeled("Title", text: inferenceString(\.openRouterTitle), prompt: "Optional")
            } footer: {
                help("OPENROUTER_HTTP_REFERER and OPENROUTER_TITLE are sent only when set. None sends OPENROUTER_REASONING=off.")
            }
        case .lmStudio:
            EmptyView()
        }
    }

    private var logs: some View {
        Form {
            Section {
                labeled("Logs root", text: $logsRoot, prompt: LogsRoot.defaultPath)
            } footer: {
                help("Folder of game directories. Each game is a folder of seat JSONL files. The default is ~/mafioso-mac/logs. A launch turns tracing on and writes here. A container run mounts this folder at /app/logs/traces.")
            }
        }
        .formStyle(.grouped)
    }

    private func help(_ text: String, color: Color = .secondary) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func labeled(_ title: String, text: Binding<String>, prompt: String) -> some View {
        LabeledContent(title) {
            TextField(prompt, text: text, prompt: Text(prompt))
                .textFieldStyle(.roundedBorder)
                .labelsHidden()
                .frame(maxWidth: .infinity)
        }
    }

    private func labeledInteger(_ title: String, value: Binding<Int>, prompt: String) -> some View {
        LabeledContent(title) {
            TextField(prompt, value: value, format: IntegerFormatStyle<Int>.number.grouping(.never), prompt: Text(prompt))
                .textFieldStyle(.roundedBorder)
                .labelsHidden()
                .frame(maxWidth: .infinity)
        }
    }

    private func borderedField(_ prompt: String, text: Binding<String>) -> some View {
        TextField(prompt, text: text, prompt: Text(prompt))
            .textFieldStyle(.roundedBorder)
            .labelsHidden()
            .frame(maxWidth: .infinity)
    }

    private func probeStatus(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Show sits in the field's row. The button keeps its own accessibility
    /// element so the row title does not replace that label.
    private func labeledSecret(
        _ title: String,
        text: Binding<String>,
        revealed: Binding<Bool>,
        prompt: String,
        accessibility: String
    ) -> some View {
        LabeledContent(title) {
            HStack {
                Group {
                    if revealed.wrappedValue {
                        TextField(prompt, text: text, prompt: Text(prompt))
                            .textFieldStyle(.roundedBorder)
                    } else {
                        SecureField(prompt, text: text, prompt: Text(prompt))
                            .textFieldStyle(.roundedBorder)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: .infinity)
                namedButton(
                    revealed.wrappedValue ? "Hide" : "Show",
                    accessibility: accessibility
                ) {
                    revealed.wrappedValue.toggle()
                }
            }
            .accessibilityElement(children: .contain)
        }
        .accessibilityElement(children: .contain)
    }

    private var apiKeyPrompt: String {
        config.config.inference.provider == .lmStudio ? "Optional" : "Paste key"
    }

    /// Visible title, then a single accessibility element. Grouped form rows
    /// otherwise keep the `LabeledContent` name and drop this label.
    private func namedButton(
        _ title: String,
        accessibility: String,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: "circle.fill")
                .labelStyle(.titleOnly)
        }
        .buttonStyle(.bordered)
        .disabled(disabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(.default) {
            if !disabled { action() }
        }
    }

    private func labeledPicker<Selection: Hashable, Content: View>(
        _ title: String,
        selection: Binding<Selection>,
        @ViewBuilder content: () -> Content
    ) -> some View {
        LabeledContent(title) {
            Picker(title, selection: selection, content: content)
                .labelsHidden()
                .frame(maxWidth: .infinity, alignment: .leading)
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

    private var concurrencyValue: String {
        let value = config.config.inference.concurrency
        if value <= 0 { return "Default" }
        return String(value)
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

    private var repositoryKind: Binding<RepositoryKind> {
        Binding(get: { config.config.repositoryKind }, set: { config.setRepositoryKind($0) })
    }

    private var repositoryURL: Binding<String> {
        Binding(get: { config.config.repositoryURL }, set: { config.setRepositoryURL($0) })
    }

    private var repositoryBranch: Binding<String> {
        Binding(get: { config.config.repositoryBranch }, set: { config.setRepositoryBranch($0) })
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
            modelRequestSucceeded = report.succeeded
            modelProbing = false
        }
    }
}
