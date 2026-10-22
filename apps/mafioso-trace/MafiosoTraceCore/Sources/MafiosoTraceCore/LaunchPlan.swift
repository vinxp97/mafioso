import Foundation

/// The harness allowlist. These three origins are `DEV_HOSTS` in `engine/src/types.js`.
/// Production and legacy hosts are not added here.
public enum HarnessHosts {
    public static let allowed = [
        "https://dev.ultimafia.gg",
        "http://127.0.0.1:3000",
        "http://192.168.64.1:3000",
    ]

    public static func origin(of base: String) -> String? {
        let trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme, let host = url.host else { return nil }
        guard scheme == "http" || scheme == "https" else { return nil }
        if let port = url.port {
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }

    public static func allows(_ base: String) -> Bool {
        guard let origin = origin(of: base) else { return false }
        return allowed.contains(origin)
    }
}

public enum ProdGate {
    public static func accepts(environment: GameEnvironment, typed: String) -> Bool {
        guard let name = environment.confirmName else { return true }
        return typed.trimmingCharacters(in: .whitespacesAndNewlines) == name
    }
}

public struct LaunchSecrets: Equatable, Sendable {
    public var clientSecret: String
    public var apiKey: String

    public init(clientSecret: String, apiKey: String) {
        self.clientSecret = clientSecret
        self.apiKey = apiKey
    }

    public var values: [String] {
        [clientSecret, apiKey]
    }
}

public enum StartDecision: Equatable, Sendable {
    case ready(warning: String?)
    case needsConfirmation(name: String, warning: String?)
    case blocked(String)
}

public enum StartPolicy {
    public static func decide(
        profile: EnvironmentProfile,
        inference: InferenceSettings,
        secrets: LaunchSecrets,
        repository: String,
        source: RepositorySource? = nil
    ) -> StartDecision {
        if !profile.id.harnessSupported {
            return .blocked("Not supported by the harness yet.")
        }
        let spec = source ?? RepositorySource(kind: .localFolder, url: "", branch: "main", localPath: repository)
        switch spec.kind {
        case .localFolder:
            if spec.localPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return .blocked("Set the repository path in Settings.")
            }
        case .git:
            if RepositoryURL.accepted(spec.url) == nil {
                return .blocked("Set an https repository URL without a token.")
            }
        }
        if profile.apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .blocked("Set the API base URL.")
        }
        if profile.oauthClientID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .blocked("Set the OAuth client id.")
        }
        if secrets.clientSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .blocked("Set the client secret.")
        }
        if profile.setupID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .blocked("Set the setup id.")
        }
        if profile.botCount < 1 || profile.botCount > 50 {
            return .blocked("Bot count must be from 1 to 50.")
        }
        if inference.provider.requiresAPIKey && secrets.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .blocked("Set the \(inference.provider.displayName) API key.")
        }
        if inference.provider.requiresModel && inference.model(for: inference.provider).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .blocked("Set a model id. The list is optional. Type one if \(inference.provider.displayName) has no /models list.")
        }
        let warning = HarnessHosts.allows(profile.apiBaseURL)
            ? nil
            : "The harness allowlist does not include this host. The process will start, and the harness will refuse the connection."
        if let name = profile.id.confirmName {
            return .needsConfirmation(name: name, warning: warning)
        }
        return .ready(warning: warning)
    }
}

public struct LaunchRequest: Equatable, Sendable {
    public var executable: String
    public var arguments: [String]
    public var environment: [String: String]
    public var currentDirectory: String
    public var warning: String?

    public init(
        executable: String,
        arguments: [String],
        environment: [String: String],
        currentDirectory: String,
        warning: String? = nil
    ) {
        self.executable = executable
        self.arguments = arguments
        self.environment = environment
        self.currentDirectory = currentDirectory
        self.warning = warning
    }
}

public enum LaunchPlan {
    /// Variables for the child. Secrets are values in `environment`, never arguments.
    public static func make(
        profile: EnvironmentProfile,
        inference: InferenceSettings,
        secrets: LaunchSecrets,
        repository: String,
        logsRoot: String,
        parentEnvironment: [String: String] = [:],
        warning: String? = nil,
        skipContainerBuild: Bool = false
    ) -> LaunchRequest {
        let repo = (repository as NSString).expandingTildeInPath
        let logs = (logsRoot as NSString).expandingTildeInPath
        var env = gameEnvironment(profile: profile, inference: inference, secrets: secrets)
        env["MAFIOSO_LIVE"] = "1"
        env["MAFIOSO_TRACE"] = "1"
        if !inference.excludeReasoning {
            env["MAFIOSO_TRACE_REASONING"] = "1"
        }
        if let reasoning = inference.reasoningMode.envValue {
            env["MAFIOSO_REASONING"] = reasoning
        }
        if inference.concurrency > 0 {
            env["MAFIOSO_LLM_CONCURRENCY"] = String(inference.concurrency)
        }
        providerEnvironment(&env, inference: inference, apiKey: secrets.apiKey)

        let local = profile.id == .localContainer
        if local {
            let gateway = profile.tunnel.containerGateway.trimmingCharacters(in: .whitespacesAndNewlines)
            let host = gateway.isEmpty ? "192.168.64.1" : gateway
            env["MAFIOSO_ENV_FROM_PROCESS"] = "1"
            env["MAFIOSO_HOST_GATEWAY"] = host
            env["DEV_API_BASE_URL"] = "http://\(host):\(profile.tunnel.apiPort == 0 ? 3000 : profile.tunnel.apiPort)"
            env["MAFIOSO_TRACE_MOUNT"] = logs
            if skipContainerBuild {
                env["MAFIOSO_CONTAINER_SKIP_BUILD"] = "1"
            }
        } else {
            env["MAFIOSO_TRACE_DIR"] = logs
        }
        if let stream = devStreamPath(profile.socketURL) {
            env["DEV_STREAM_PATH"] = stream
        }
        env = childEnvironment(launch: env, parent: parentEnvironment)

        if local {
            return LaunchRequest(
                executable: "/bin/bash",
                arguments: [repo + "/scripts/mac-container-run.sh"],
                environment: env,
                currentDirectory: repo,
                warning: warning
            )
        }
        return LaunchRequest(
            executable: "/usr/bin/env",
            arguments: ["node", "harness/scripts/live.mjs"],
            environment: env,
            currentDirectory: repo,
            warning: warning
        )
    }

    /// PATH and a few home variables from the parent. Nothing else is copied, so an unrelated secret stays out.
    public static func childEnvironment(launch: [String: String], parent: [String: String]) -> [String: String] {
        var env = launch
        for key in ["HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "LOGNAME", "SHELL"] {
            if env[key] == nil, let value = parent[key], !value.isEmpty {
                env[key] = value
            }
        }
        let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        if let path = parent["PATH"], !path.isEmpty {
            env["PATH"] = path + ":" + extra
        } else {
            env["PATH"] = extra
        }
        return env
    }

    static func gameEnvironment(
        profile: EnvironmentProfile,
        inference: InferenceSettings,
        secrets: LaunchSecrets
    ) -> [String: String] {
        var env: [String: String] = [
            "DEV_API_BASE_URL": profile.apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines),
            "DEV_API_CLIENT_ID": profile.oauthClientID.trimmingCharacters(in: .whitespacesAndNewlines),
            "DEV_API_CLIENT_SECRET": secrets.clientSecret,
            "DEV_SETUP_ID": profile.setupID.trimmingCharacters(in: .whitespacesAndNewlines),
            "BOT_COUNT": String(profile.botCount),
            "LOBBY_NAME": profile.lobby.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Testing" : profile.lobby.trimmingCharacters(in: .whitespacesAndNewlines),
            "MAFIOSO_LLM": inference.provider.llmValue,
        ]
        return env
    }

    static func providerEnvironment(_ env: inout [String: String], inference: InferenceSettings, apiKey: String) {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        switch inference.provider {
        case .lmStudio:
            put(&env, "LM_STUDIO_BASE_URL", inference.lmStudioBaseURL)
            put(&env, "LM_STUDIO_MODEL", inference.lmStudioModel)
            env["LM_API_KEY"] = key.isEmpty ? "lm-studio" : key
        case .experiential:
            put(&env, "EXPLABS_BASE_URL", inference.experientialBaseURL)
            put(&env, "EXPLABS_MODEL", inference.experientialModel)
            env["EXPLABS_API_KEY"] = key
            if inference.experientialZDR {
                env["EXPLABS_ZDR"] = "1"
            }
        case .openCodeGo:
            put(&env, "OPENCODE_BASE_URL", inference.openCodeBaseURL)
            put(&env, "OPENCODE_MODEL", inference.openCodeModel)
            put(&env, "OPENCODE_SESSION", inference.openCodeSession)
            env["OPENCODE_API_KEY"] = key
        case .openRouter:
            put(&env, "OPENROUTER_BASE_URL", inference.openRouterBaseURL)
            put(&env, "OPENROUTER_MODEL", inference.openRouterModel)
            put(&env, "OPENROUTER_HTTP_REFERER", inference.openRouterReferer)
            put(&env, "OPENROUTER_TITLE", inference.openRouterTitle)
            env["OPENROUTER_API_KEY"] = key
            env["OPENROUTER_REASONING"] = inference.reasoningEffort.openRouterValue
        }
    }

    static func put(_ env: inout [String: String], _ key: String, _ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            env[key] = trimmed
        }
    }

    /// The Dev API stream path, only when the socket field is already a `/api/dev/` path.
    /// A raw game socket such as `/3010` is stored on the profile and is not sent.
    static func devStreamPath(_ socketURL: String) -> String? {
        let trimmed = socketURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("/api/dev/") { return trimmed }
        guard let url = URL(string: trimmed) else { return nil }
        let path = url.path
        guard path.hasPrefix("/api/dev/") else { return nil }
        return path
    }
}

public enum OutputRedactor {
    /// Replace secret values of 4 characters or more. Longer values are replaced first.
    public static func redact(_ text: String, secrets: [String]) -> String {
        var result = text
        let list = secrets
            .filter { $0.count >= 4 }
            .sorted { $0.count > $1.count }
        for secret in list {
            result = result.replacingOccurrences(of: secret, with: "[redacted]")
        }
        return result
    }
}

public struct ModelInfo: Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var contextLength: Int?
    public var promptPrice: String?
    public var completionPrice: String?
    public var isFree: Bool

    public init(
        id: String,
        name: String = "",
        contextLength: Int? = nil,
        promptPrice: String? = nil,
        completionPrice: String? = nil,
        isFree: Bool = false
    ) {
        self.id = id
        self.name = name.isEmpty ? id : name
        self.contextLength = contextLength
        self.promptPrice = promptPrice
        self.completionPrice = completionPrice
        self.isFree = isFree
    }
}

public enum ModelCatalog {
    public static func modelsURL(base: String) -> URL? {
        let trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var url = URL(string: trimmed), let scheme = url.scheme, scheme == "http" || scheme == "https" else {
            return nil
        }
        if url.path.hasSuffix("/models") { return url }
        url = url.appendingPathComponent("models")
        return url
    }

    public static func apiURL(base: String) -> URL? {
        let trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme, scheme == "http" || scheme == "https", url.host != nil else {
            return nil
        }
        return url
    }

    public static func parse(_ data: Data) -> [ModelInfo] {
        guard let json = try? JSONSerialization.jsonObject(with: data) else { return [] }
        let rows: [[String: Any]]
        if let root = json as? [String: Any], let dataRows = root["data"] as? [[String: Any]] {
            rows = dataRows
        } else if let list = json as? [[String: Any]] {
            rows = list
        } else {
            return []
        }
        var models: [ModelInfo] = []
        for row in rows {
            guard let rawID = row["id"] as? String else { continue }
            let id = rawID.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty else { continue }
            let name = (row["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let context = intValue(row["context_length"])
            let pricing = row["pricing"] as? [String: Any]
            let prompt = priceString(pricing?["prompt"])
            let completion = priceString(pricing?["completion"])
            let free = id.hasSuffix(":free") || (priceIsZero(prompt) && priceIsZero(completion))
            models.append(ModelInfo(
                id: id,
                name: name,
                contextLength: context,
                promptPrice: prompt,
                completionPrice: completion,
                isFree: free
            ))
        }
        return models
    }

    public static func filter(_ models: [ModelInfo], query: String, freeOnly: Bool) -> [ModelInfo] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return models.filter { model in
            if freeOnly && !model.isFree { return false }
            if needle.isEmpty { return true }
            return model.id.lowercased().contains(needle) || model.name.lowercased().contains(needle)
        }
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let number = value as? Int { return number }
        if let number = value as? Double { return Int(number) }
        if let text = value as? String, let number = Int(text) { return number }
        return nil
    }

    private static func priceString(_ value: Any?) -> String? {
        if let text = value as? String {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if let number = value as? Double { return String(number) }
        if let number = value as? Int { return String(number) }
        return nil
    }

    private static func priceIsZero(_ raw: String?) -> Bool {
        guard let raw, let value = Double(raw) else { return false }
        return value == 0
    }
}
