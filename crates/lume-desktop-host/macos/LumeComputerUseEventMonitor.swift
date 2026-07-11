import AppKit
import Darwin
import Foundation

@main
private struct LumeComputerUseEventMonitor {
    static func main() {
        let center = NSWorkspace.shared.notificationCenter
        let observer = center.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: nil
        ) { _ in
            emitForegroundChanged()
        }
        withExtendedLifetime(observer) {
            RunLoop.main.run()
        }
    }
}

private func emitForegroundChanged() {
    let occurredAt = UInt64((Date().timeIntervalSince1970 * 1_000).rounded())
    let event: [String: Any] = [
        "method": "context.event",
        "params": [
            "type": "foreground_changed",
            "occurredAt": occurredAt,
        ],
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: event),
          let newline = "\n".data(using: .utf8)
    else {
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(newline)
}
