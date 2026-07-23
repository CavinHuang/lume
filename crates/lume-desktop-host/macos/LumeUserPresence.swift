import Darwin
import Foundation
import LocalAuthentication

private let protocolVersion = 1
private let maximumRequestBytes = 16 * 1024

private struct Request: Decodable {
    let protocolVersion: Int
    let nonce: String
    let parentPid: Int32
    let parentExecutable: String
    let reason: String
}

private struct Response: Encodable {
    let protocolVersion: Int
    let nonce: String
    let parentPid: Int32
    let authorized: Bool
}

@main
private enum LumeUserPresence {
    static func main() {
        let body = FileHandle.standardInput.readDataToEndOfFile()
        guard body.count <= maximumRequestBytes,
              let request = try? JSONDecoder().decode(Request.self, from: body),
              isValid(request),
              request.parentPid == getppid(),
              parentExecutable(request.parentPid) == canonicalPath(request.parentExecutable)
        else {
            exit(1)
        }

        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            write(Response(protocolVersion: protocolVersion, nonce: request.nonce, parentPid: request.parentPid, authorized: false))
            return
        }
        let completed = DispatchSemaphore(value: 0)
        var authorized = false
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: request.reason) { success, _ in
            authorized = success
            completed.signal()
        }
        if completed.wait(timeout: .now() + 60) == .timedOut {
            authorized = false
        }
        write(Response(protocolVersion: protocolVersion, nonce: request.nonce, parentPid: request.parentPid, authorized: authorized))
    }

    private static func isValid(_ request: Request) -> Bool {
        request.protocolVersion == protocolVersion
            && request.nonce.count == 64
            && request.nonce.unicodeScalars.allSatisfy { CharacterSet(charactersIn: "0123456789abcdefABCDEF").contains($0) }
            && !request.parentExecutable.isEmpty
            && !request.reason.isEmpty
            && request.reason.count <= 160
    }

    private static func parentExecutable(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(PROC_PIDPATHINFO_MAXSIZE))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return canonicalPath(String(cString: buffer))
    }

    private static func canonicalPath(_ path: String) -> String {
        URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
    }

    private static func write(_ response: Response) {
        guard let data = try? JSONEncoder().encode(response) else { exit(1) }
        FileHandle.standardOutput.write(data)
    }
}
