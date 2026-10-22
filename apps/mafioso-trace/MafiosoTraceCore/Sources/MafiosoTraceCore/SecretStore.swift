import Foundation

public enum SecretStoreError: Error, Equatable {
    case failed(String)
}

/// One generic-password item. The account name is the item; the service is always `gg.mafioso.trace`.
public protocol SecretStore: AnyObject {
    func set(_ value: String, account: String) throws
    func get(account: String) throws -> String?
    func remove(account: String) throws
}

public enum SecretAccount {
    public static let service = "gg.mafioso.trace"

    public static func clientSecret(_ environment: GameEnvironment) -> String {
        "environment.\(environment.rawValue).clientSecret"
    }

    public static func apiKey(_ provider: ProviderKind) -> String {
        "provider.\(provider.rawValue).apiKey"
    }
}

/// In-memory stand-in for the Keychain. Tests use this. The app uses Security.framework.
public final class MemorySecretStore: SecretStore {
    private var items: [String: String] = [:]
    private let lock = NSLock()

    public init() {}

    public func set(_ value: String, account: String) throws {
        lock.lock()
        defer { lock.unlock() }
        items[account] = value
    }

    public func get(account: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return items[account]
    }

    public func remove(account: String) throws {
        lock.lock()
        defer { lock.unlock() }
        items.removeValue(forKey: account)
    }
}
