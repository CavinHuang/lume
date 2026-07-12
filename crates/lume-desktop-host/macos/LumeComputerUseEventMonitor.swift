import AppKit
import ApplicationServices
import Darwin
import Foundation

@main
private struct LumeComputerUseEventMonitor {
    static func main() {
        let accessibilityMonitor = AccessibilityEventMonitor()
        let mouseMonitor = MouseEventMonitor()
        accessibilityMonitor.attach(to: NSWorkspace.shared.frontmostApplication)
        mouseMonitor.start()
        let center = NSWorkspace.shared.notificationCenter
        let observer = center.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { notification in
            accessibilityMonitor.attach(
                to: notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            )
            emitContextEvent("foreground_changed")
        }
        withExtendedLifetime((observer, accessibilityMonitor, mouseMonitor)) {
            RunLoop.main.run()
        }
    }
}

private final class MouseEventMonitor {
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?

    func start() {
        let eventTypes: [CGEventType] = [
            .leftMouseUp,
            .rightMouseUp,
            .otherMouseUp,
            .scrollWheel,
        ]
        let mask = eventTypes.reduce(CGEventMask(0)) { result, type in
            result | (CGEventMask(1) << type.rawValue)
        }
        guard let eventTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: mouseEventCallback,
            userInfo: nil
        ) else {
            return
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: eventTap, enable: true)
        self.eventTap = eventTap
        self.runLoopSource = source
    }

    deinit {
        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        }
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
        }
    }
}

private let mouseEventCallback: CGEventTapCallBack = { _, type, event, _ in
    switch type {
    case .leftMouseUp, .rightMouseUp, .otherMouseUp:
        emitContextEvent("interaction_changed")
    case .scrollWheel:
        emitContextEvent("scroll_changed")
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

private final class AccessibilityEventMonitor {
    private var observer: AXObserver?
    private var application: AXUIElement?
    private var focusedElement: AXUIElement?

    func attach(to runningApplication: NSRunningApplication?) {
        detach()
        guard let runningApplication, !runningApplication.isTerminated else {
            return
        }
        var createdObserver: AXObserver?
        guard AXObserverCreate(runningApplication.processIdentifier, axEventCallback, &createdObserver) == .success,
              let createdObserver
        else {
            return
        }
        let application = AXUIElementCreateApplication(runningApplication.processIdentifier)
        let applicationNotifications = [
            kAXFocusedUIElementChangedNotification,
            kAXFocusedWindowChangedNotification,
        ]
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for notification in applicationNotifications {
            _ = AXObserverAddNotification(createdObserver, application, notification as CFString, refcon)
        }
        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(createdObserver),
            .defaultMode
        )
        self.observer = createdObserver
        self.application = application
        attachFocusedElement()
    }

    func handle(notification: String, element: AXUIElement) {
        switch notification {
        case kAXFocusedUIElementChangedNotification as String,
             kAXFocusedWindowChangedNotification as String:
            attachFocusedElement()
            emitContextEvent("focus_changed")
        case kAXSelectedTextChangedNotification as String,
             kAXSelectedRowsChangedNotification as String:
            emitContextEvent("selection_changed")
        case kAXValueChangedNotification as String:
            emitContextEvent(role(of: element) == kAXScrollBarRole as String
                ? "scroll_changed"
                : "value_changed")
        default:
            break
        }
    }

    private func detach() {
        detachFocusedElement()
        if let observer {
            CFRunLoopRemoveSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(observer),
                .defaultMode
            )
        }
        observer = nil
        application = nil
    }

    private func attachFocusedElement() {
        detachFocusedElement()
        guard let observer, let application else {
            return
        }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            application,
            kAXFocusedUIElementAttribute as CFString,
            &value
        ) == .success,
        let value,
        CFGetTypeID(value) == AXUIElementGetTypeID()
        else {
            return
        }
        let element = value as! AXUIElement
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for notification in [
            kAXSelectedTextChangedNotification,
            kAXSelectedRowsChangedNotification,
            kAXValueChangedNotification,
        ] {
            _ = AXObserverAddNotification(observer, element, notification as CFString, refcon)
        }
        focusedElement = element
    }

    private func detachFocusedElement() {
        guard let observer, let focusedElement else {
            self.focusedElement = nil
            return
        }
        for notification in [
            kAXSelectedTextChangedNotification,
            kAXSelectedRowsChangedNotification,
            kAXValueChangedNotification,
        ] {
            _ = AXObserverRemoveNotification(observer, focusedElement, notification as CFString)
        }
        self.focusedElement = nil
    }
}

private let axEventCallback: AXObserverCallback = { _, element, notification, refcon in
    guard let refcon else {
        return
    }
    Unmanaged<AccessibilityEventMonitor>
        .fromOpaque(refcon)
        .takeUnretainedValue()
        .handle(notification: notification as String, element: element)
}

private func role(of element: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) == .success else {
        return nil
    }
    return value as? String
}

private func emitContextEvent(_ type: String) {
    let occurredAt = UInt64((Date().timeIntervalSince1970 * 1_000).rounded())
    let event: [String: Any] = [
        "method": "context.event",
        "params": [
            "type": type,
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
