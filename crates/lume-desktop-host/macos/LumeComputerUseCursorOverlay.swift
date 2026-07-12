import AppKit
import CoreGraphics

private let windowSize = CGSize(width: 126, height: 126)
private let tipAnchor = CGPoint(x: 60.35, y: 70.3)

@MainActor
private final class CursorOverlayApp: NSObject, NSApplicationDelegate {
    private let assetPath: String
    private var panel: NSPanel?
    private var hideWorkItem: DispatchWorkItem?

    init(assetPath: String) {
        self.assetPath = assetPath
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        preparePanel()
        readCommands()
    }

    private func preparePanel() {
        let panel = NSPanel(
            contentRect: CGRect(origin: .zero, size: windowSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]

        let imageView = NSImageView(frame: CGRect(origin: .zero, size: windowSize))
        imageView.image = NSImage(contentsOfFile: assetPath)
        imageView.imageScaling = .scaleProportionallyUpOrDown
        panel.contentView = imageView
        self.panel = panel
    }

    private func readCommands() {
        Thread.detachNewThread {
            while let line = readLine() {
                let command = line
                DispatchQueue.main.async { [weak self] in
                    self?.handle(command)
                }
            }
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
        }
    }

    private func handle(_ line: String) {
        let parts = line.split(separator: " ")
        guard let command = parts.first else {
            return
        }
        if command == "hide" {
            hide()
            return
        }
        guard parts.count == 3, let x = Double(parts[1]), let y = Double(parts[2]) else {
            return
        }
        let point = appKitPoint(fromQuartzX: x, y: y)
        place(at: point)
        if command == "pulse" {
            pulse()
        }
    }

    private func place(at point: CGPoint) {
        guard let panel else {
            return
        }
        panel.setFrameOrigin(CGPoint(x: point.x - tipAnchor.x, y: point.y - tipAnchor.y))
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        scheduleHide()
    }

    private func pulse() {
        guard let panel else {
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.08
            panel.animator().alphaValue = 0.55
        } completionHandler: {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                panel.animator().alphaValue = 1
            }
        }
    }

    private func scheduleHide() {
        hideWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.hide()
        }
        hideWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: item)
    }

    private func hide() {
        hideWorkItem?.cancel()
        hideWorkItem = nil
        panel?.orderOut(nil)
    }

    private func appKitPoint(fromQuartzX x: Double, y: Double) -> CGPoint {
        for screen in NSScreen.screens {
            guard
                let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            else {
                continue
            }
            let quartzFrame = CGDisplayBounds(CGDirectDisplayID(number.uint32Value))
            if quartzFrame.contains(CGPoint(x: x, y: y)) {
                return CGPoint(
                    x: screen.frame.minX + (x - quartzFrame.minX),
                    y: screen.frame.maxY - (y - quartzFrame.minY)
                )
            }
        }
        let frame = NSScreen.main?.frame ?? .zero
        return CGPoint(x: x, y: frame.maxY - y)
    }
}

@main
private struct CursorOverlayMain {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = CursorOverlayApp(assetPath: CommandLine.arguments.dropFirst().first ?? "")
        application.delegate = delegate
        application.run()
    }
}
