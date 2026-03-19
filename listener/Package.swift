// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WinstonListener",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "winston-listener", targets: ["WinstonListener"])
    ],
    targets: [
        .executableTarget(
            name: "WinstonListener",
            path: "Sources"
        )
    ]
)
