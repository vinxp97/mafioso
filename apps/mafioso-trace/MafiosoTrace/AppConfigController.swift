import Foundation
import MafiosoTraceCore

/// Non-secret settings in Application Support. Secrets stay in the Keychain and in memory for the fields.
@MainActor
final class AppConfigController: ObservableObject {
    @Published private(set) var config: AppConfig
    @Published private(set) var clientSecrets: [GameEnvironment: String] = [:]
    @Published private(set) var apiKeys: [ProviderKind: String] = [:]
    @Published var keychainError: String?
    @Published var saveError: String?

    private let store: SecretStore
    private let fileURL: URL

    init(store: SecretStore = KeychainSecretStore(), fileURL: URL? = nil) {
        self.store = store
        let url = fileURL ?? Self.defaultFileURL()
        self.fileURL = url
        config = Self.load(from: url)
        reloadSecrets()
    }

    var selectedProfile: EnvironmentProfile {
        config.profile(config.selectedEnvironment)
            ?? AppConfig.prefilledEnvironments().first { $0.id == config.selectedEnvironment }
            ?? AppConfig.prefilledEnvironments()[0]
    }

    func launchSecrets(environment: GameEnvironment, provider: ProviderKind) -> LaunchSecrets {
        LaunchSecrets(
            clientSecret: clientSecrets[environment] ?? "",
            apiKey: apiKeys[provider] ?? ""
        )
    }

    func setRepository(_ path: String) {
        var next = config
        next.repositoryPath = path
        config = next
        save()
    }

    func selectEnvironment(_ id: GameEnvironment) {
        var next = config
        next.selectedEnvironment = id
        config = next
        save()
    }

    func updateProfile(_ body: (inout EnvironmentProfile) -> Void) {
        var next = config
        guard let index = next.environments.firstIndex(where: { $0.id == next.selectedEnvironment }) else { return }
        body(&next.environments[index])
        config = next
        save()
    }

    func updateInference(_ body: (inout InferenceSettings) -> Void) {
        var next = config
        body(&next.inference)
        config = next
        save()
    }

    func setClientSecret(_ value: String, environment: GameEnvironment) {
        clientSecrets[environment] = value
        writeSecret(value, account: SecretAccount.clientSecret(environment))
    }

    func setAPIKey(_ value: String, provider: ProviderKind) {
        apiKeys[provider] = value
        writeSecret(value, account: SecretAccount.apiKey(provider))
    }

    func save() {
        do {
            let directory = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try config.encode().write(to: fileURL, options: .atomic)
            saveError = nil
        } catch {
            saveError = "Could not save settings."
        }
    }

    private func reloadSecrets() {
        for environment in GameEnvironment.allCases {
            clientSecrets[environment] = readSecret(SecretAccount.clientSecret(environment))
        }
        for provider in ProviderKind.allCases {
            apiKeys[provider] = readSecret(SecretAccount.apiKey(provider))
        }
    }

    private func readSecret(_ account: String) -> String {
        do {
            return try store.get(account: account) ?? ""
        } catch {
            keychainError = "Could not read the Keychain."
            return ""
        }
    }

    private func writeSecret(_ value: String, account: String) {
        do {
            if value.isEmpty {
                try store.remove(account: account)
            } else {
                try store.set(value, account: account)
            }
            keychainError = nil
        } catch {
            keychainError = "Could not update the Keychain."
        }
    }

    private static func load(from url: URL) -> AppConfig {
        guard let data = try? Data(contentsOf: url), let decoded = try? AppConfig.decode(data) else {
            return .prefilled()
        }
        return normalize(decoded)
    }

    /// A hand-edited file that drops an environment gets the blank preset back. Secrets are not in the file.
    private static func normalize(_ config: AppConfig) -> AppConfig {
        var copy = config
        for preset in AppConfig.prefilledEnvironments() where !copy.environments.contains(where: { $0.id == preset.id }) {
            copy.environments.append(preset)
        }
        return copy
    }

    static func defaultFileURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        return base.appendingPathComponent("MafiosoTrace", isDirectory: true).appendingPathComponent("config.json")
    }
}
