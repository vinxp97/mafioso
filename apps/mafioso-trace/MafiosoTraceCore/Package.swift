// swift-tools-version:5.9
// JSONL parser and file tail for the Mafioso trace viewer.
// No SwiftUI here, so `swift test` can run on Linux.
import PackageDescription

let package = Package(
    name: "MafiosoTraceCore",
    products: [
        .library(name: "MafiosoTraceCore", targets: ["MafiosoTraceCore"]),
    ],
    targets: [
        .target(name: "MafiosoTraceCore"),
        .testTarget(
            name: "MafiosoTraceCoreTests",
            dependencies: ["MafiosoTraceCore"]
        ),
    ]
)
