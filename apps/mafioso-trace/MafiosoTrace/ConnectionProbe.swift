import Foundation
import MafiosoTraceCore

struct ProbeReport: Equatable {
    var summary: String
    var models: [ModelInfo]

    static func message(_ summary: String) -> ProbeReport {
        ProbeReport(summary: summary, models: [])
    }
}

/// HTTP status and, for a provider, how many model ids parsed. The response body is not kept.
enum ConnectionProbe {
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        return URLSession(configuration: configuration)
    }()

    static func api(base: String) async -> ProbeReport {
        guard let url = ModelCatalog.apiURL(base: base) else {
            return .message("The address is not an http(s) URL.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        return await send(request, parseModels: false)
    }

    static func models(base: String, apiKey: String, provider: ProviderKind, sessionHeader: String) async -> ProbeReport {
        guard let url = ModelCatalog.modelsURL(base: base) else {
            return .message("The address is not an http(s) URL.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("mafioso/0.1", forHTTPHeaderField: "User-Agent")
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let bearer = key.isEmpty && provider == .lmStudio ? "lm-studio" : key
        if !bearer.isEmpty {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        let sessionValue = sessionHeader.trimmingCharacters(in: .whitespacesAndNewlines)
        if provider == .openCodeGo, !sessionValue.isEmpty {
            request.setValue(sessionValue, forHTTPHeaderField: "x-opencode-session")
        }
        return await send(request, parseModels: true)
    }

    private static func send(_ request: URLRequest, parseModels: Bool) async -> ProbeReport {
        do {
            let (data, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard parseModels else {
                return .message("HTTP \(code)")
            }
            let models = ModelCatalog.parse(data)
            return ProbeReport(summary: "HTTP \(code), \(models.count) models", models: models)
        } catch {
            return .message("Could not connect.")
        }
    }
}
