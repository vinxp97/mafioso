import XCTest
@testable import MafiosoTraceCore

final class RunConfigTests: XCTestCase {
    func testPrefillUsesHarnessDefaultsAndLeavesQaAndProdBlank() {
        let config = AppConfig.prefilled()
        let local = try XCTUnwrap(config.profile(.localContainer))
        let dev = try XCTUnwrap(config.profile(.dev))
        let qa = try XCTUnwrap(config.profile(.qa))
        let prod = try XCTUnwrap(config.profile(.production))
        let legacy = try XCTUnwrap(config.profile(.legacy))

        XCTAssertEqual(local.apiBaseURL, "http://192.168.64.1:3000")
        XCTAssertEqual(local.socketURL, "ws://192.168.64.1:3010")
        XCTAssertEqual(local.tunnel.apiPort, 3000)
        XCTAssertEqual(local.tunnel.bridgePort, 2999)
        XCTAssertEqual(local.tunnel.socketPort, 3010)
        XCTAssertEqual(local.tunnel.containerGateway, "192.168.64.1")
        XCTAssertEqual(local.lobby, "Testing")
        XCTAssertEqual(dev.apiBaseURL, "https://dev.ultimafia.gg")
        XCTAssertEqual(dev.socketURL, "wss://dev.ultimafia.gg/3010")
        XCTAssertEqual(dev.tunnel.containerGateway, "192.168.64.1")
        XCTAssertEqual(qa.apiBaseURL, "")
        XCTAssertEqual(prod.apiBaseURL, "")
        XCTAssertEqual(legacy.apiBaseURL, "")
        XCTAssertTrue(prod.id.isProduction)
        XCTAssertTrue(legacy.id.isProduction)
        XCTAssertFalse(legacy.id.harnessSupported)
        XCTAssertEqual(config.inference.lmStudioBaseURL, "http://127.0.0.1:1234/v1")
        XCTAssertEqual(config.inference.experientialBaseURL, "https://api.experientiallabs.ai/v1")
        XCTAssertEqual(config.inference.openCodeBaseURL, "https://opencode.ai/zen/go/v1")
        XCTAssertEqual(config.inference.openRouterBaseURL, "https://openrouter.ai/api/v1")
        XCTAssertEqual(config.inference.provider.llmValue, "lmstudio")
    }

    func testConfigRoundTripOmitsSecrets() throws {
        var config = AppConfig.prefilled()
        config.repositoryPath = "/Users/ada/mafioso"
        config.inference.provider = .openRouter
        config.inference.openRouterModel = "minimax/minimax-m3.1-flash"
        let data = try config.encode()
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(text.contains("sk-or-supersecretkey"))
        XCTAssertFalse(text.contains("client-secret-value"))
        let decoded = try AppConfig.decode(data)
        XCTAssertEqual(decoded, config)
    }

    func testMemorySecretStore() throws {
        let store = MemorySecretStore()
        let account = SecretAccount.apiKey(.openRouter)
        XCTAssertEqual(account, "provider.openRouter.apiKey")
        XCTAssertNil(try store.get(account: account))
        try store.set("sk-or-supersecretkey", account: account)
        XCTAssertEqual(try store.get(account: account), "sk-or-supersecretkey")
        try store.remove(account: account)
        XCTAssertNil(try store.get(account: account))
        XCTAssertEqual(SecretAccount.service, "gg.mafioso.trace")
        XCTAssertEqual(SecretAccount.clientSecret(.dev), "environment.dev.clientSecret")
    }

    func testProdConfirmAndLegacyBlock() {
        let secrets = LaunchSecrets(clientSecret: "client-secret-value", apiKey: "sk-or-supersecretkey")
        var prod = filled(.production, base: "https://ultimafia.gg")
        var inference = InferenceSettings()
        inference.provider = .openRouter
        XCTAssertEqual(
            StartPolicy.decide(profile: prod, inference: inference, secrets: secrets, repository: "/repo"),
            .needsConfirmation(
                name: "ultimafia.gg",
                warning: "The harness allowlist does not include this host. The process will start, and the harness will refuse the connection."
            )
        )
        XCTAssertFalse(ProdGate.accepts(environment: .production, typed: "prod"))
        XCTAssertTrue(ProdGate.accepts(environment: .production, typed: " ultimafia.gg "))
        XCTAssertEqual(
            StartPolicy.decide(profile: filled(.legacy, base: "https://ultimafia.com"), inference: inference, secrets: secrets, repository: "/repo"),
            .blocked("Not supported by the harness yet.")
        )
        prod.apiBaseURL = ""
        XCTAssertEqual(
            StartPolicy.decide(profile: prod, inference: inference, secrets: secrets, repository: "/repo"),
            .blocked("Set the API base URL.")
        )
    }

    func testQaWarnsAndDevIsReady() {
        let secrets = LaunchSecrets(clientSecret: "client-secret-value", apiKey: "lm-studio")
        let inference = InferenceSettings()
        XCTAssertEqual(
            StartPolicy.decide(profile: filled(.dev, base: "https://dev.ultimafia.gg"), inference: inference, secrets: secrets, repository: "/repo"),
            .ready(warning: nil)
        )
        let qa = StartPolicy.decide(profile: filled(.qa, base: "https://qa.ultimafia.gg"), inference: inference, secrets: secrets, repository: "/repo")
        guard case .ready(let warning) = qa else {
            return XCTFail("expected a warning, got \(qa)")
        }
        XCTAssertNotNil(warning)
        XCTAssertFalse(HarnessHosts.allows("https://ultimafia.gg"))
        XCTAssertFalse(HarnessHosts.allows("https://ultimafia.com"))
        XCTAssertFalse(HarnessHosts.allows("https://qa.ultimafia.gg"))
        XCTAssertTrue(HarnessHosts.allows("https://dev.ultimafia.gg/api"))
        XCTAssertTrue(HarnessHosts.allows("http://192.168.64.1:3000"))
    }

    func testEnvironmentVariablesForEachProvider() {
        let secrets = LaunchSecrets(clientSecret: "client-secret-value", apiKey: "sk-or-supersecretkey")
        let dev = filled(.dev, base: "https://dev.ultimafia.gg")
        var openRouter = InferenceSettings()
        openRouter.provider = .openRouter
        openRouter.reasoningEffort = .high
        openRouter.excludeReasoning = false
        openRouter.reasoningMode = .on
        openRouter.concurrency = 2
        openRouter.openRouterReferer = "https://example.test"
        openRouter.openRouterTitle = "mafioso"
        let router = launch(dev, openRouter, secrets)
        XCTAssertEqual(router.arguments, ["node", "harness/scripts/live.mjs"])
        XCTAssertEqual(router.executable, "/usr/bin/env")
        XCTAssertEqual(router.environment["MAFIOSO_LLM"], "openrouter")
        XCTAssertEqual(router.environment["OPENROUTER_API_KEY"], "sk-or-supersecretkey")
        XCTAssertEqual(router.environment["OPENROUTER_MODEL"], "minimax/minimax-m3.1-flash")
        XCTAssertEqual(router.environment["OPENROUTER_BASE_URL"], "https://openrouter.ai/api/v1")
        XCTAssertEqual(router.environment["OPENROUTER_REASONING"], "high")
        XCTAssertEqual(router.environment["OPENROUTER_HTTP_REFERER"], "https://example.test")
        XCTAssertEqual(router.environment["OPENROUTER_TITLE"], "mafioso")
        XCTAssertEqual(router.environment["MAFIOSO_TRACE"], "1")
        XCTAssertEqual(router.environment["MAFIOSO_TRACE_REASONING"], "1")
        XCTAssertEqual(router.environment["MAFIOSO_REASONING"], "1")
        XCTAssertEqual(router.environment["MAFIOSO_LLM_CONCURRENCY"], "2")
        XCTAssertEqual(router.environment["DEV_API_BASE_URL"], "https://dev.ultimafia.gg")
        XCTAssertEqual(router.environment["LOBBY_NAME"], "Testing")
        XCTAssertNil(router.environment["EXPLABS_API_KEY"])
        XCTAssertNil(router.environment["LM_API_KEY"])
        XCTAssertFalse(router.arguments.joined(separator: " ").contains("sk-or-supersecretkey"))
        XCTAssertFalse(router.arguments.joined(separator: " ").contains("client-secret-value"))
        XCTAssertNil(router.environment["UNRELATED_SECRET"])

        var labs = InferenceSettings()
        labs.provider = .experiential
        labs.experientialModel = "qwen3.8-27b"
        labs.experientialZDR = true
        labs.excludeReasoning = true
        labs.reasoningMode = .off
        let labLaunch = launch(dev, labs, LaunchSecrets(clientSecret: "client-secret-value", apiKey: "xpl_secret"))
        XCTAssertEqual(labLaunch.environment["MAFIOSO_LLM"], "experiential")
        XCTAssertEqual(labLaunch.environment["EXPLABS_BASE_URL"], "https://api.experientiallabs.ai/v1")
        XCTAssertEqual(labLaunch.environment["EXPLABS_MODEL"], "qwen3.8-27b")
        XCTAssertEqual(labLaunch.environment["EXPLABS_API_KEY"], "xpl_secret")
        XCTAssertEqual(labLaunch.environment["EXPLABS_ZDR"], "1")
        XCTAssertEqual(labLaunch.environment["MAFIOSO_REASONING"], "0")
        XCTAssertNil(labLaunch.environment["MAFIOSO_TRACE_REASONING"])

        var code = InferenceSettings()
        code.provider = .openCodeGo
        code.openCodeModel = "kimi-k2.6"
        code.openCodeSession = "session-1"
        let codeLaunch = launch(dev, code, LaunchSecrets(clientSecret: "client-secret-value", apiKey: "oc-key"))
        XCTAssertEqual(codeLaunch.environment["MAFIOSO_LLM"], "opencode")
        XCTAssertEqual(codeLaunch.environment["OPENCODE_BASE_URL"], "https://opencode.ai/zen/go/v1")
        XCTAssertEqual(codeLaunch.environment["OPENCODE_MODEL"], "kimi-k2.6")
        XCTAssertEqual(codeLaunch.environment["OPENCODE_API_KEY"], "oc-key")
        XCTAssertEqual(codeLaunch.environment["OPENCODE_SESSION"], "session-1")

        var studio = InferenceSettings()
        studio.lmStudioModel = "qwen"
        let studioLaunch = launch(dev, studio, LaunchSecrets(clientSecret: "client-secret-value", apiKey: ""))
        XCTAssertEqual(studioLaunch.environment["MAFIOSO_LLM"], "lmstudio")
        XCTAssertEqual(studioLaunch.environment["LM_STUDIO_BASE_URL"], "http://127.0.0.1:1234/v1")
        XCTAssertEqual(studioLaunch.environment["LM_STUDIO_MODEL"], "qwen")
        XCTAssertEqual(studioLaunch.environment["LM_API_KEY"], "lm-studio")
    }

    func testLocalContainerKeepsSecretsOutOfArgv() {
        let secrets = LaunchSecrets(clientSecret: "client-secret-value", apiKey: "sk-or-supersecretkey")
        var inference = InferenceSettings()
        inference.provider = .openRouter
        let local = filled(.localContainer, base: "http://192.168.64.1:3000")
        let request = launch(local, inference, secrets, logs: "~/mafioso-mac/logs")
        XCTAssertEqual(request.executable, "/bin/bash")
        XCTAssertEqual(request.arguments, ["/repo/scripts/mac-container-run.sh"])
        XCTAssertEqual(request.environment["MAFIOSO_ENV_FROM_PROCESS"], "1")
        XCTAssertEqual(request.environment["MAFIOSO_HOST_GATEWAY"], "192.168.64.1")
        XCTAssertEqual(
            request.environment["MAFIOSO_TRACE_MOUNT"],
            ("~/mafioso-mac/logs" as NSString).expandingTildeInPath
        )
        XCTAssertNil(request.environment["MAFIOSO_TRACE_DIR"])
        XCTAssertEqual(request.environment["OPENROUTER_API_KEY"], "sk-or-supersecretkey")
        XCTAssertFalse(request.arguments.joined(separator: "\n").contains("sk-or-supersecretkey"))
        XCTAssertNil(request.environment["DEV_STREAM_PATH"])
    }

    func testDevStreamPathIsOnlyTheDevAPIPath() {
        var dev = filled(.dev, base: "https://dev.ultimafia.gg")
        dev.socketURL = "https://dev.ultimafia.gg/api/dev/stream"
        let request = launch(dev, InferenceSettings(), LaunchSecrets(clientSecret: "client-secret-value", apiKey: "lm-studio"))
        XCTAssertEqual(request.environment["DEV_STREAM_PATH"], "/api/dev/stream")
        dev.socketURL = "wss://dev.ultimafia.gg/3010"
        let socket = launch(dev, InferenceSettings(), LaunchSecrets(clientSecret: "client-secret-value", apiKey: "lm-studio"))
        XCTAssertNil(socket.environment["DEV_STREAM_PATH"])
    }

    func testRedactionAndModelList() throws {
        XCTAssertEqual(
            OutputRedactor.redact("token sk-or-supersecretkey and client-secret-value", secrets: ["sk-or-supersecretkey", "client-secret-value", "ab"]),
            "token [redacted] and [redacted]"
        )
        let data = Data("""
        {"data":[
          {"id":"minimax/minimax-m3.1-flash:free","name":"MiniMax Flash","context_length":1000000,"pricing":{"prompt":"0","completion":"0"}},
          {"id":"paid/model","name":"Paid","context_length":8192,"pricing":{"prompt":"0.000002","completion":"0.000006"}}
        ]}
        """.utf8)
        let models = ModelCatalog.parse(data)
        XCTAssertEqual(models.count, 2)
        XCTAssertEqual(models[0].contextLength, 1_000_000)
        XCTAssertTrue(models[0].isFree)
        XCTAssertFalse(models[1].isFree)
        XCTAssertEqual(models[0].promptPrice, "0")
        let filtered = ModelCatalog.filter(models, query: "flash", freeOnly: true)
        XCTAssertEqual(filtered.map(\.id), ["minimax/minimax-m3.1-flash:free"])
        XCTAssertEqual(
            ModelCatalog.modelsURL(base: "https://openrouter.ai/api/v1")?.absoluteString,
            "https://openrouter.ai/api/v1/models"
        )
        XCTAssertEqual(
            ModelCatalog.modelsURL(base: "https://api.experientiallabs.ai/v1/")?.absoluteString,
            "https://api.experientiallabs.ai/v1/models"
        )
        XCTAssertNil(ModelCatalog.apiURL(base: "not a url"))
    }

    func testNewTraceDirectoryIsChosenOnce() {
        let older = game("old", age: 100)
        let fresh = game("g-new", age: 1)
        XCTAssertEqual(TraceArrival.newest(previous: ["old"], games: [older, fresh]), "g-new")
        XCTAssertNil(TraceArrival.newest(previous: ["old", "g-new"], games: [older, fresh]))
    }

    func testLineBufferFlush() {
        var buffer = LineBuffer()
        XCTAssertEqual(buffer.append(Data("partial".utf8)), [])
        XCTAssertEqual(buffer.flush(), "partial")
        XCTAssertNil(buffer.flush())
    }

    private func filled(_ id: GameEnvironment, base: String) -> EnvironmentProfile {
        EnvironmentProfile(
            id: id,
            apiBaseURL: base,
            socketURL: "",
            oauthClientID: "client-id",
            setupID: "setup-1",
            botCount: 9,
            lobby: "Testing",
            tunnel: id.showsTunnel ? .localDefaults : .empty
        )
    }

    private func launch(
        _ profile: EnvironmentProfile,
        _ inference: InferenceSettings,
        _ secrets: LaunchSecrets,
        logs: String = "/tmp/logs"
    ) -> LaunchRequest {
        LaunchPlan.make(
            profile: profile,
            inference: inference,
            secrets: secrets,
            repository: "/repo",
            logsRoot: logs,
            parentEnvironment: ["PATH": "/usr/bin", "HOME": "/Users/ada", "UNRELATED_SECRET": "nope"]
        )
    }

    private func game(_ id: String, age: TimeInterval) -> TraceGame {
        TraceGame(
            id: id,
            directory: URL(fileURLWithPath: "/tmp/\(id)"),
            seats: ["harness"],
            files: [URL(fileURLWithPath: "/tmp/\(id)/harness.jsonl")],
            latestChange: Date().addingTimeInterval(-age),
            isLive: age < 15
        )
    }
}
