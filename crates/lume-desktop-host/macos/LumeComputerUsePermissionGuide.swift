import AppKit
import Foundation

struct PermissionGuideConfig {
    let appBundlePath: String
    let appName: String
    let permission: String
    let settingsURL: URL

    var permissionTitle: String {
        switch permission {
        case "accessibility":
            return "Accessibility"
        case "screenRecording":
            return "Screen & System Audio Recording"
        default:
            return permission
        }
    }

    static func parse(arguments: [String]) -> PermissionGuideConfig {
        var values: [String: String] = [:]
        var index = 1
        while index < arguments.count {
            let key = arguments[index]
            if key.hasPrefix("--"), index + 1 < arguments.count {
                values[String(key.dropFirst(2))] = arguments[index + 1]
                index += 2
            } else {
                index += 1
            }
        }

        let appBundlePath = values["app-bundle"] ?? "/Applications/Lume Computer Use.app"
        let appName = values["app-name"] ?? "Lume Computer Use.app"
        let permission = values["permission"] ?? "accessibility"
        let settingsURL = URL(
            string: values["settings-url"]
                ?? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        )!

        return PermissionGuideConfig(
            appBundlePath: appBundlePath,
            appName: appName,
            permission: permission,
            settingsURL: settingsURL
        )
    }
}

@main
enum LumeComputerUsePermissionGuideMain {
    private static var delegate: PermissionGuideDelegate?

    static func main() {
        let config = PermissionGuideConfig.parse(arguments: CommandLine.arguments)
        let application = NSApplication.shared
        let delegate = PermissionGuideDelegate(config: config)
        self.delegate = delegate
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.applicationIconImage = NSWorkspace.shared.icon(forFile: config.appBundlePath)
        application.run()
    }
}

final class PermissionGuideDelegate: NSObject, NSApplicationDelegate {
    private let config: PermissionGuideConfig
    private var window: NSWindow?

    init(config: PermissionGuideConfig) {
        self.config = config
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 680, height: 420),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Authorize \(config.appName)"
        window.isReleasedWhenClosed = false
        window.center()
        window.contentView = PermissionGuideView(config: config, target: self)
        self.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    @objc
    func openSettings() {
        NSWorkspace.shared.open(config.settingsURL)
    }

    @objc
    func closeGuide() {
        NSApp.terminate(nil)
    }
}

final class PermissionGuideView: NSView {
    private let config: PermissionGuideConfig
    private weak var target: PermissionGuideDelegate?

    init(config: PermissionGuideConfig, target: PermissionGuideDelegate) {
        self.config = config
        self.target = target
        super.init(frame: .zero)
        setup()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        nil
    }

    private func setup() {
        wantsLayer = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        let icon = NSImageView()
        icon.image = NSWorkspace.shared.icon(forFile: config.appBundlePath)
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField(labelWithString: "Authorize \(config.appName)")
        title.font = NSFont.systemFont(ofSize: 28, weight: .bold)
        title.alignment = .center
        title.maximumNumberOfLines = 1

        let body = NSTextField(wrappingLabelWithString:
            "Open macOS System Settings and enable \(config.appName) for \(config.permissionTitle). Do not authorize the main Lume app."
        )
        body.font = NSFont.systemFont(ofSize: 15)
        body.textColor = .secondaryLabelColor
        body.alignment = .center
        body.maximumNumberOfLines = 3

        let tile = DraggableAppTileView(config: config)
        tile.translatesAutoresizingMaskIntoConstraints = false

        let hint = NSTextField(wrappingLabelWithString:
            "If macOS asks you to add an app manually, drag the tile above into the permission list."
        )
        hint.font = NSFont.systemFont(ofSize: 13)
        hint.textColor = .tertiaryLabelColor
        hint.alignment = .center
        hint.maximumNumberOfLines = 2

        let buttons = NSStackView()
        buttons.orientation = .horizontal
        buttons.alignment = .centerY
        buttons.spacing = 10

        let settingsButton = NSButton(
            title: "Open System Settings",
            target: target,
            action: #selector(PermissionGuideDelegate.openSettings)
        )
        settingsButton.bezelStyle = .rounded
        settingsButton.keyEquivalent = "\r"

        let closeButton = NSButton(
            title: "Close",
            target: target,
            action: #selector(PermissionGuideDelegate.closeGuide)
        )
        closeButton.bezelStyle = .rounded

        buttons.addArrangedSubview(settingsButton)
        buttons.addArrangedSubview(closeButton)

        stack.addArrangedSubview(icon)
        stack.addArrangedSubview(title)
        stack.addArrangedSubview(body)
        stack.addArrangedSubview(tile)
        stack.addArrangedSubview(hint)
        stack.addArrangedSubview(buttons)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 52),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -52),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 36),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -28),
            icon.widthAnchor.constraint(equalToConstant: 72),
            icon.heightAnchor.constraint(equalToConstant: 72),
            tile.widthAnchor.constraint(equalToConstant: 420),
            tile.heightAnchor.constraint(equalToConstant: 58),
        ])
    }
}

final class DraggableAppTileView: NSView, NSDraggingSource {
    private let config: PermissionGuideConfig

    init(config: PermissionGuideConfig) {
        self.config = config
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 14
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.35).cgColor
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        nil
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let icon = NSWorkspace.shared.icon(forFile: config.appBundlePath)
        icon.draw(in: NSRect(x: 14, y: 13, width: 32, height: 32))

        let title = config.appName as NSString
        title.draw(
            at: NSPoint(x: 58, y: 20),
            withAttributes: [
                .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
                .foregroundColor: NSColor.labelColor,
            ]
        )

        let subtitle = "Drag this app into the macOS permission list" as NSString
        subtitle.draw(
            at: NSPoint(x: 58, y: 5),
            withAttributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]
        )
    }

    override func mouseDragged(with event: NSEvent) {
        let bundleURL = URL(fileURLWithPath: config.appBundlePath, isDirectory: true)
        let item = NSDraggingItem(pasteboardWriter: bundleURL as NSURL)
        item.setDraggingFrame(bounds, contents: nil)
        let session = beginDraggingSession(with: [item], event: event, source: self)
        session.animatesToStartingPositionsOnCancelOrFail = true
    }

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext
    ) -> NSDragOperation {
        .copy
    }
}
