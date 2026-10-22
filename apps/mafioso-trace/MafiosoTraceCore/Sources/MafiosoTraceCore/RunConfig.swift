import Foundation

/// One Ultimafia environment. Production hosts stay outside the harness allowlist.
public enum GameEnvironment: String, Codable, CaseIterable, Identifiable, Sendable {
    case localContainer
    case dev
    case qa
    case production
    case legacy

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .localContainer: return "Local Apple container"
        case .dev: return "dev.ultimafia.gg"
        case .qa: return "qa.ultimafia.gg"
        case .production: return "ultimafia.gg"
        case .legacy: return "ultimafia.com"
        }
    }

    /// The string the user must type before a production start.
    public var confirmName: String? {
        switch self {
        case .production: return "ultimafia.gg"
        case .legacy: return "ultimafia.com"
        default: return nil
        }
    }

    public var isProduction: Bool {
        self == .production || self == .legacy
    }

    /// The harness speaks the Dev API. ultimafia.com is the old cookie-and-socket client.
    public var harnessSupported: Bool {
        self != .legacy
    }

    public var showsTunnel: Bool {
        self == .localContainer || self == .dev
    }
}

public struct TunnelSettings: Codable, Equatable, Sendable {
    public var sshHostAlias: String
    public var apiPort: Int
    public var bridgePort: Int
    public var socketPort: Int
    public var containerGateway: String

    public init(
        sshHostAlias: String = "",
        apiPort: Int = 3000,
        bridgePort: Int = 2999,
        socketPort: Int = 3010,
        containerGateway: String = "192.168.64.1"
    ) {
        self.sshHostAlias = sshHostAlias
        self.apiPort = apiPort
        self.bridgePort = bridgePort
        self.socketPort = socketPort
        self.containerGateway = containerGateway
    }

    public static let localDefaults = TunnelSettings()
    public static let empty = TunnelSettings(sshHostAlias: "", apiPort: 0, bridgePort: 0, socketPort: 0, containerGateway: "")
}

public struct EnvironmentProfile: Codable, Equatable, Identifiable, Sendable {
    public var id: GameEnvironment
    public var apiBaseURL: String
    public var socketURL: String
    public var oauthClientID: String
    public var setupID: String
    public var botCount: Int
    public var lobby: String
    public var tunnel: TunnelSettings

    public init(
        id: GameEnvironment,
        apiBaseURL: String,
        socketURL: String,
        oauthClientID: String = "",
        setupID: String = "",
        botCount: Int = 9,
        lobby: String = "Testing",
        tunnel: TunnelSettings = .empty
    ) {
        self.id = id
        self.apiBaseURL = apiBaseURL
        self.socketURL = socketURL
        self.oauthClientID = oauthClientID
        self.setupID = setupID
        self.botCount = botCount
        self.lobby = lobby
        self.tunnel = tunnel
    }
}

/// The four backends `createBackendComplete` already knows. No fifth factory.
public enum ProviderKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case lmStudio
    case experiential
    case openCodeGo
    case openRouter

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .lmStudio: return "LM Studio"
        case .experiential: return "Experiential Labs"
        case .openCodeGo: return "OpenCode Go"
        case .openRouter: return "OpenRouter"
        }
    }

    /// `MAFIOSO_LLM` value, not an alias.
    public var llmValue: String {
        switch self {
        case .lmStudio: return "lmstudio"
        case .experiential: return "experiential"
        case .openCodeGo: return "opencode"
        case .openRouter: return "openrouter"
        }
    }

    /// LM Studio ships a placeholder key. The other three refuse to start without one.
    public var requiresAPIKey: Bool {
        self != .lmStudio
    }

    /// Experiential Labs and OpenCode Go throw when the model id is empty. LM Studio and OpenRouter have defaults.
    public var requiresModel: Bool {
        self == .experiential || self == .openCodeGo
    }
}

/// Which inference providers show a model search box. The model id field is always available.
public enum ModelListUI {
    public static func showsSearch(provider: ProviderKind, modelsRequestSucceeded: Bool) -> Bool {
        if provider == .experiential {
            return modelsRequestSucceeded
        }
        return true
    }
}

public enum ReasoningEffort: String, Codable, CaseIterable, Identifiable, Sendable {
    case none
    case low
    case medium
    case high

    public var id: String { rawValue }

    public var displayName: String { rawValue }

    /// `OPENROUTER_REASONING`. `none` is `off`, which omits the reasoning object.
    public var openRouterValue: String {
        self == .none ? "off" : rawValue
    }
}

/// Unset lets the model name decide. `1` and `0` are the harness override.
public enum ReasoningMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case automatic
    case on
    case off

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .automatic: return "Automatic"
        case .on: return "On"
        case .off: return "Off"
        }
    }

    public var envValue: String? {
        switch self {
        case .automatic: return nil
        case .on: return "1"
        case .off: return "0"
        }
    }
}

public struct InferenceSettings: Codable, Equatable, Sendable {
    public var provider: ProviderKind
    public var lmStudioBaseURL: String
    public var lmStudioModel: String
    public var experientialBaseURL: String
    public var experientialModel: String
    public var experientialZDR: Bool
    public var openCodeBaseURL: String
    public var openCodeModel: String
    public var openCodeSession: String
    public var openRouterBaseURL: String
    public var openRouterModel: String
    public var openRouterReferer: String
    public var openRouterTitle: String
    public var reasoningEffort: ReasoningEffort
    public var excludeReasoning: Bool
    public var reasoningMode: ReasoningMode
    public var concurrency: Int
    public var openRouterFreeOnly: Bool

    public init(
        provider: ProviderKind = .lmStudio,
        lmStudioBaseURL: String = "http://127.0.0.1:1234/v1",
        lmStudioModel: String = "",
        experientialBaseURL: String = "https://api.experientiallabs.ai/v1",
        experientialModel: String = "",
        experientialZDR: Bool = false,
        openCodeBaseURL: String = "https://opencode.ai/zen/go/v1",
        openCodeModel: String = "",
        openCodeSession: String = "",
        openRouterBaseURL: String = "https://openrouter.ai/api/v1",
        openRouterModel: String = "minimax/minimax-m3.1-flash",
        openRouterReferer: String = "",
        openRouterTitle: String = "",
        reasoningEffort: ReasoningEffort = .low,
        excludeReasoning: Bool = true,
        reasoningMode: ReasoningMode = .automatic,
        concurrency: Int = 0,
        openRouterFreeOnly: Bool = false
    ) {
        self.provider = provider
        self.lmStudioBaseURL = lmStudioBaseURL
        self.lmStudioModel = lmStudioModel
        self.experientialBaseURL = experientialBaseURL
        self.experientialModel = experientialModel
        self.experientialZDR = experientialZDR
        self.openCodeBaseURL = openCodeBaseURL
        self.openCodeModel = openCodeModel
        self.openCodeSession = openCodeSession
        self.openRouterBaseURL = openRouterBaseURL
        self.openRouterModel = openRouterModel
        self.openRouterReferer = openRouterReferer
        self.openRouterTitle = openRouterTitle
        self.reasoningEffort = reasoningEffort
        self.excludeReasoning = excludeReasoning
        self.reasoningMode = reasoningMode
        self.concurrency = concurrency
        self.openRouterFreeOnly = openRouterFreeOnly
    }

    public func baseURL(for provider: ProviderKind) -> String {
        switch provider {
        case .lmStudio: return lmStudioBaseURL
        case .experiential: return experientialBaseURL
        case .openCodeGo: return openCodeBaseURL
        case .openRouter: return openRouterBaseURL
        }
    }

    public func model(for provider: ProviderKind) -> String {
        switch provider {
        case .lmStudio: return lmStudioModel
        case .experiential: return experientialModel
        case .openCodeGo: return openCodeModel
        case .openRouter: return openRouterModel
        }
    }

    public mutating func setModel(_ model: String, for provider: ProviderKind) {
        switch provider {
        case .lmStudio: lmStudioModel = model
        case .experiential: experientialModel = model
        case .openCodeGo: openCodeModel = model
        case .openRouter: openRouterModel = model
        }
    }
}

public struct AppConfig: Codable, Equatable, Sendable {
    public var repositoryPath: String
    public var selectedEnvironment: GameEnvironment
    public var environments: [EnvironmentProfile]
    public var inference: InferenceSettings

    public init(
        repositoryPath: String = "",
        selectedEnvironment: GameEnvironment = .dev,
        environments: [EnvironmentProfile] = AppConfig.prefilledEnvironments(),
        inference: InferenceSettings = InferenceSettings()
    ) {
        self.repositoryPath = repositoryPath
        self.selectedEnvironment = selectedEnvironment
        self.environments = environments
        self.inference = inference
    }

    public static func prefilled() -> AppConfig {
        AppConfig()
    }

    public static func prefilledEnvironments() -> [EnvironmentProfile] {
        let tunnel = TunnelSettings.localDefaults
        return [
            EnvironmentProfile(
                id: .localContainer,
                apiBaseURL: "http://192.168.64.1:3000",
                socketURL: "ws://192.168.64.1:3010",
                tunnel: tunnel
            ),
            EnvironmentProfile(
                id: .dev,
                apiBaseURL: "https://dev.ultimafia.gg",
                socketURL: "wss://dev.ultimafia.gg/3010",
                tunnel: tunnel
            ),
            EnvironmentProfile(id: .qa, apiBaseURL: "", socketURL: ""),
            EnvironmentProfile(id: .production, apiBaseURL: "", socketURL: ""),
            EnvironmentProfile(id: .legacy, apiBaseURL: "", socketURL: ""),
        ]
    }

    public func profile(_ id: GameEnvironment) -> EnvironmentProfile? {
        environments.first { $0.id == id }
    }

    public var selectedProfile: EnvironmentProfile? {
        profile(selectedEnvironment)
    }

    public static func decode(_ data: Data) throws -> AppConfig {
        try JSONDecoder().decode(AppConfig.self, from: data)
    }

    public func encode() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }
}
