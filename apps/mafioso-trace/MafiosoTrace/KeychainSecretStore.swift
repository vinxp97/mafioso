import Foundation
import MafiosoTraceCore
import Security

/// Generic passwords in the login keychain. One item per account. The app target owns this;
/// the core package never imports Security, so `swift test` still runs without it.
final class KeychainSecretStore: SecretStore {
    func set(_ value: String, account: String) throws {
        let query = baseQuery(account: account)
        let data = Data(value.utf8)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let updated = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if updated == errSecSuccess { return }
        if updated != errSecItemNotFound {
            throw SecretStoreError.failed("keychain update \(updated)")
        }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else {
            throw SecretStoreError.failed("keychain add \(added)")
        }
    }

    func get(account: String) throws -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw SecretStoreError.failed("keychain read \(status)")
        }
        return String(data: data, encoding: .utf8)
    }

    func remove(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { return }
        throw SecretStoreError.failed("keychain delete \(status)")
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: SecretAccount.service,
            kSecAttrAccount as String: account,
        ]
    }
}
