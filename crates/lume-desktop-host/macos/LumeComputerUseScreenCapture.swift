import AppKit
import CoreGraphics
import Darwin
import Foundation
import ScreenCaptureKit

private let screenshotCaptureTimeout: TimeInterval = 5
private let screenshotMaxPNGBytes = 900_000
private let screenshotMaxDimension: CGFloat = 1_280
private let screenshotMinScale: CGFloat = 0.25

private enum CaptureError: LocalizedError {
    case invalidWindowID
    case windowUnavailable(CGWindowID)
    case pngEncodingFailed
    case timedOut
    case missingResult

    var errorDescription: String? {
        switch self {
        case .invalidWindowID:
            return "ScreenCaptureKit helper requires one decimal window id."
        case let .windowUnavailable(windowID):
            return "ScreenCaptureKit window \(windowID) is unavailable."
        case .pngEncodingFailed:
            return "ScreenCaptureKit could not encode the window as PNG."
        case .timedOut:
            return "ScreenCaptureKit screenshot timed out after \(Int(screenshotCaptureTimeout)) seconds."
        case .missingResult:
            return "ScreenCaptureKit screenshot finished without a result."
        }
    }
}

@main
private struct LumeComputerUseScreenCapture {
    static func main() {
        do {
            guard CommandLine.arguments.count == 2,
                  let windowID = CGWindowID(CommandLine.arguments[1])
            else {
                throw CaptureError.invalidWindowID
            }

            let png = try BlockingAsyncBridge.run(timeout: screenshotCaptureTimeout) {
                let shareableContent = try await SCShareableContent.current
                guard let window = shareableContent.windows.first(where: { $0.windowID == windowID }) else {
                    throw CaptureError.windowUnavailable(windowID)
                }

                let configuration = SCStreamConfiguration()
                let scaleFactor = bestEffortScaleFactor(for: window.frame)
                configuration.width = max(1, Int(ceil(window.frame.width * scaleFactor)))
                configuration.height = max(1, Int(ceil(window.frame.height * scaleFactor)))
                configuration.showsCursor = false
                configuration.scalesToFit = false
                configuration.ignoreShadowsSingleWindow = true

                let filter = SCContentFilter(desktopIndependentWindow: window)
                let image = try await SCScreenshotManager.captureImage(
                    contentFilter: filter,
                    configuration: configuration
                )
                guard let png = boundedPNGData(for: image) else {
                    throw CaptureError.pngEncodingFailed
                }
                return png
            }
            FileHandle.standardOutput.write(png)
        } catch {
            let message = "\(error.localizedDescription)\n"
            FileHandle.standardError.write(Data(message.utf8))
            exit(EXIT_FAILURE)
        }
    }
}

private func bestEffortScaleFactor(for bounds: CGRect) -> CGFloat {
    NSScreen.screens.first(where: { $0.frame.intersects(bounds) })?.backingScaleFactor
        ?? NSScreen.main?.backingScaleFactor
        ?? 1
}

private func boundedPNGData(for image: CGImage) -> Data? {
    guard image.width > 0, image.height > 0 else {
        return nil
    }
    let original = pngData(for: image)
    var scale = min(1, screenshotMaxDimension / CGFloat(max(image.width, image.height)))
    if scale >= 1, let original, original.count <= screenshotMaxPNGBytes {
        return original
    }

    var smallest = original
    while scale >= screenshotMinScale {
        guard let resized = resizedImage(image, scale: scale),
              let candidate = pngData(for: resized)
        else {
            break
        }
        smallest = candidate
        if candidate.count <= screenshotMaxPNGBytes {
            return candidate
        }
        scale *= 0.85
    }
    return smallest
}

private func pngData(for image: CGImage) -> Data? {
    NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
}

private func resizedImage(_ image: CGImage, scale: CGFloat) -> CGImage? {
    let width = max(1, Int((CGFloat(image.width) * scale).rounded()))
    let height = max(1, Int((CGFloat(image.height) * scale).rounded()))
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return nil
    }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()
}

private final class AsyncResultBox<T>: @unchecked Sendable {
    var result: Result<T, Error>?
}

private enum BlockingAsyncBridge {
    static func run<T>(
        timeout: TimeInterval,
        _ operation: @escaping @Sendable () async throws -> T
    ) throws -> T {
        let semaphore = DispatchSemaphore(value: 0)
        let resultBox = AsyncResultBox<T>()
        let task = Task.detached {
            do {
                resultBox.result = .success(try await operation())
            } catch {
                resultBox.result = .failure(error)
            }
            semaphore.signal()
        }

        let deadline = Date(timeIntervalSinceNow: timeout)
        while semaphore.wait(timeout: .now()) == .timedOut {
            if Date() >= deadline {
                task.cancel()
                throw CaptureError.timedOut
            }
            _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
        }
        return try resultBox.result?.get() ?? { throw CaptureError.missingResult }()
    }
}
