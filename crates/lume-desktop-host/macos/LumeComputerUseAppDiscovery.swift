import AppKit
import CoreServices
import Foundation

private struct DiscoveredApp: Codable {
    let id: String
    let name: String
    let path: String
    let isRunning: Bool
    let isFrontmost: Bool
    let lastUsedAt: UInt64?
    let usageCount: UInt64?
}

private struct IndexedApp {
    let id: String
    let name: String
    let path: String
    let lastUsedAt: UInt64?
    let usageCount: UInt64?
}

@main
private enum LumeComputerUseAppDiscovery {
    private static let recentCutoff = Date().addingTimeInterval(-14 * 24 * 60 * 60)
    private static let queryExpression = #"kMDItemContentType == "com.apple.application-bundle" && kMDItemFSName == "*.app""#

    static func main() {
        let data = (try? JSONEncoder().encode(discover())) ?? Data("[]".utf8)
        FileHandle.standardOutput.write(data)
    }

    private static func discover() -> [DiscoveredApp] {
        let running = NSWorkspace.shared.runningApplications.filter {
            !$0.isTerminated && $0.activationPolicy == .regular
        }
        let runningById = Dictionary(
            running.compactMap { app -> (String, NSRunningApplication)? in
                guard let id = app.bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty else {
                    return nil
                }
                return (id.lowercased(), app)
            },
            uniquingKeysWith: { first, _ in first }
        )
        let frontmostId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier?.lowercased()
        var indexedById = Dictionary(
            uniqueKeysWithValues: recentIndexedApps().map { ($0.id.lowercased(), $0) }
        )
        for (key, app) in runningById where indexedById[key] == nil {
            let bundle = app.bundleURL.flatMap(Bundle.init(url:))
            indexedById[key] = IndexedApp(
                id: app.bundleIdentifier ?? key,
                name: app.localizedName ?? bundleName(bundle) ?? app.executableURL?.lastPathComponent ?? key,
                path: app.bundleURL?.path ?? "",
                lastUsedAt: nil,
                usageCount: nil
            )
        }

        let apps = indexedById.map { key, indexed -> DiscoveredApp in
            let runningApp = runningById[key]
            return DiscoveredApp(
                id: indexed.id,
                name: runningApp?.localizedName ?? indexed.name,
                path: runningApp?.bundleURL?.path ?? indexed.path,
                isRunning: runningApp != nil,
                isFrontmost: key == frontmostId,
                lastUsedAt: indexed.lastUsedAt,
                usageCount: indexed.usageCount
            )
        }.sorted(by: appSort)

        return apps.filter(\.isRunning) + Array(apps.filter { !$0.isRunning }.prefix(10))
    }

    private static func recentIndexedApps() -> [IndexedApp] {
        let sorting = ["kMDItemLastUsedDate_Ranking" as CFString, "kMDItemUseCount" as CFString] as CFArray
        guard let query = MDQueryCreate(kCFAllocatorDefault, queryExpression as CFString, nil, sorting) else {
            return []
        }
        let scopes = [
            "/Applications",
            "/System/Applications",
            "/System/Library/CoreServices",
            NSString(string: "~/Applications").expandingTildeInPath,
        ].filter { FileManager.default.fileExists(atPath: $0) }
        MDQuerySetSearchScope(query, scopes as CFArray, 0)
        guard MDQueryExecute(query, CFOptionFlags(kMDQuerySynchronous.rawValue)) else {
            return []
        }

        var seen = Set<String>()
        var result: [IndexedApp] = []
        for index in 0..<MDQueryGetResultCount(query) {
            guard let rawItem = MDQueryGetResultAtIndex(query, index) else { continue }
            let item = unsafeBitCast(rawItem, to: MDItem.self)
            guard
                let id = MDItemCopyAttribute(item, kMDItemCFBundleIdentifier) as? String,
                let path = MDItemCopyAttribute(item, kMDItemPath) as? String,
                !id.isEmpty,
                seen.insert(id.lowercased()).inserted
            else { continue }
            let bundle = Bundle(url: URL(fileURLWithPath: path))
            if bundle?.object(forInfoDictionaryKey: "LSBackgroundOnly") as? Bool == true { continue }
            if bundle?.object(forInfoDictionaryKey: "LSUIElement") as? Bool == true { continue }
            let lastUsed = (MDItemCopyAttribute(item, "kMDItemLastUsedDate_Ranking" as CFString) as? Date)
                ?? (MDItemCopyAttribute(item, kMDItemLastUsedDate) as? Date)
            guard let lastUsed, lastUsed >= recentCutoff else { continue }
            let usage = (MDItemCopyAttribute(item, "kMDItemUseCount" as CFString) as? NSNumber)?.uint64Value
            let displayName = bundleName(bundle)
                ?? (MDItemCopyAttribute(item, kMDItemDisplayName) as? String)?.replacingOccurrences(of: ".app", with: "")
                ?? URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
            result.append(IndexedApp(
                id: id,
                name: displayName,
                path: path,
                lastUsedAt: UInt64(lastUsed.timeIntervalSince1970 * 1_000),
                usageCount: usage
            ))
        }
        return result
    }

    private static func bundleName(_ bundle: Bundle?) -> String? {
        (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
            ?? (bundle?.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String)
    }

    private static func appSort(_ left: DiscoveredApp, _ right: DiscoveredApp) -> Bool {
        if left.isFrontmost != right.isFrontmost { return left.isFrontmost }
        if left.isRunning != right.isRunning { return left.isRunning }
        if left.lastUsedAt != right.lastUsedAt { return (left.lastUsedAt ?? 0) > (right.lastUsedAt ?? 0) }
        if left.usageCount != right.usageCount { return (left.usageCount ?? 0) > (right.usageCount ?? 0) }
        return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
    }
}
