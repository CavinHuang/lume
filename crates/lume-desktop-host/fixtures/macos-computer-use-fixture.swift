import AppKit
import Foundation

@MainActor
final class FixtureDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private let statePath: String
    private let commandPath: String
    private let headless: Bool
    private var window: NSWindow!
    private let counterLabel = NSTextField(labelWithString: "Counter: 0")
    private let textField = NSTextField(string: "seed")
    private let keyLabel = NSTextField(labelWithString: "Last key: none")
    private let scrollLabel = NSTextField(labelWithString: "Scroll offset: 0")
    private let dragLabel = NSTextField(labelWithString: "Last drag: none")
    private var timer: Timer?
    private var revision: UInt64 = 0
    private var counter = 0
    private var lastKey = "none"
    private var scrollOffset = 0
    private var lastDrag = "none"
    private var focusedElement: String?
    private var lastCommandID: UInt64 = 0

    init(statePath: String, commandPath: String, headless: Bool) {
        self.statePath = statePath
        self.commandPath = commandPath
        self.headless = headless
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        publishState()
        timer = Timer.scheduledTimer(
            timeInterval: 0.025,
            target: self,
            selector: #selector(pollCommand),
            userInfo: nil,
            repeats: true
        )
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
    }

    func controlTextDidChange(_ notification: Notification) {
        revision += 1
        publishState()
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 160, y: 180, width: 640, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Lume Computer Use Fixture"
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 620))
        window.contentView = content

        let button = NSButton(title: "Increment Counter", target: self, action: #selector(incrementCounter))
        button.frame = NSRect(x: 24, y: 560, width: 180, height: 36)
        button.setAccessibilityIdentifier("fixture-increment")
        counterLabel.frame = NSRect(x: 24, y: 520, width: 240, height: 28)
        textField.frame = NSRect(x: 24, y: 476, width: 320, height: 30)
        textField.delegate = self
        textField.setAccessibilityIdentifier("fixture-input")
        keyLabel.frame = NSRect(x: 24, y: 436, width: 320, height: 28)
        scrollLabel.frame = NSRect(x: 24, y: 396, width: 320, height: 28)
        dragLabel.frame = NSRect(x: 24, y: 356, width: 520, height: 28)

        let scrollArea = NSBox(frame: NSRect(x: 24, y: 184, width: 520, height: 160))
        scrollArea.title = "Fixture Scroll"
        scrollArea.setAccessibilityIdentifier("fixture-scroll")
        let dragArea = NSBox(frame: NSRect(x: 24, y: 42, width: 320, height: 120))
        dragArea.title = "Fixture Drag Pad"
        dragArea.fillColor = .systemOrange
        dragArea.boxType = .custom
        dragArea.setAccessibilityIdentifier("fixture-drag")

        for view in [button, counterLabel, textField, keyLabel, scrollLabel, dragLabel, scrollArea, dragArea] {
            content.addSubview(view)
        }
        if headless {
            window.orderOut(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc
    private func incrementCounter() {
        counter += 1
        counterLabel.stringValue = "Counter: \(counter)"
        revision += 1
        publishState()
    }

    @objc
    private func pollCommand() {
        consumeCommand()
    }

    private func consumeCommand() {
        guard
            let data = FileManager.default.contents(atPath: commandPath),
            let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let id = (command["id"] as? NSNumber)?.uint64Value,
            id != lastCommandID,
            let method = command["method"] as? String
        else {
            return
        }
        lastCommandID = id
        let params = command["params"] as? [String: Any] ?? [:]
        apply(method: method, params: params)
    }

    private func apply(method: String, params: [String: Any]) {
        let elementID = params["elementId"] as? String
        switch method {
        case "activate_window":
            window.makeKeyAndOrderFront(nil)
        case "click":
            if elementID == "root.0" || pointFallsInsideButton(params) {
                incrementCounter()
                return
            }
            if elementID == "root.2" {
                focusedElement = "input"
                window.makeFirstResponder(textField)
            } else if elementID == "root.3" {
                focusedElement = "key"
            }
        case "perform_secondary_action":
            if elementID == "root.0", params["action"] as? String == "AXPress" {
                incrementCounter()
                return
            }
        case "set_value":
            if elementID == "root.2" {
                textField.stringValue = params["value"] as? String ?? ""
                focusedElement = "input"
            }
        case "type_text":
            textField.stringValue += params["text"] as? String ?? ""
            focusedElement = "input"
        case "press_key":
            lastKey = params["key"] as? String
                ?? (params["keys"] as? [String])?.joined(separator: "+")
                ?? "unknown"
            keyLabel.stringValue = "Last key: \(lastKey)"
            focusedElement = "key"
        case "scroll":
            let pages = (params["pages"] as? NSNumber)?.doubleValue ?? 1
            let amount = Int((120 * pages).rounded())
            scrollOffset += params["direction"] as? String == "up" ? -amount : amount
            scrollOffset = max(0, scrollOffset)
            scrollLabel.stringValue = "Scroll offset: \(scrollOffset)"
        case "drag":
            let fromX = integer(params["fromX"])
            let fromY = integer(params["fromY"])
            let toX = integer(params["toX"])
            let toY = integer(params["toY"])
            lastDrag = "from (\(fromX), \(fromY)) to (\(toX), \(toY))"
            dragLabel.stringValue = "Last drag: \(lastDrag)"
        case "move_pointer":
            break
        default:
            return
        }
        revision += 1
        publishState()
    }

    private func pointFallsInsideButton(_ params: [String: Any]) -> Bool {
        let x = integer(params["x"])
        let y = integer(params["y"])
        return (184...364).contains(x) && (204...240).contains(y)
    }

    private func integer(_ value: Any?) -> Int {
        (value as? NSNumber)?.intValue ?? 0
    }

    private func publishState() {
        let focusedValue: Any = focusedElement.map { $0 as Any } ?? NSNull()
        let state: [String: Any] = [
            "revision": revision,
            "processId": ProcessInfo.processInfo.processIdentifier,
            "counter": counter,
            "text": textField.stringValue,
            "lastKey": lastKey,
            "scrollOffset": scrollOffset,
            "lastDrag": lastDrag,
            "focusedElement": focusedValue,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) else {
            return
        }
        try? data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}

@main
enum FixtureMain {
    @MainActor private static var delegate: FixtureDelegate?

    @MainActor
    static func main() {
        guard
            let statePath = argument(after: "--state-path"),
            let commandPath = argument(after: "--command-path")
        else {
            FileHandle.standardError.write(Data("fixture paths are required\n".utf8))
            exit(2)
        }
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let delegate = FixtureDelegate(
            statePath: statePath,
            commandPath: commandPath,
            headless: CommandLine.arguments.contains("--headless")
        )
        Self.delegate = delegate
        application.delegate = delegate
        application.run()
    }

    private static func argument(after flag: String) -> String? {
        guard let index = CommandLine.arguments.firstIndex(of: flag) else { return nil }
        let valueIndex = CommandLine.arguments.index(after: index)
        return valueIndex < CommandLine.arguments.endIndex ? CommandLine.arguments[valueIndex] : nil
    }
}
