// Lume Agent 灵动岛 macOS 原生 helper（Phase 2，macOS 26+）。
//
// JSON Lines stdin/stdout 协议：主进程（TypeScript）持有产品状态，
// 本进程只负责 AppKit 几何、SwiftUI 渲染、受限指针意图回传。
//
// 协议严格对齐 packages/shared/src/types/agent-island.ts 的
// NativeAgentIslandSnapshot（main → Swift 全量状态）与
// NativeAgentIslandEvent（Swift → main 受限事件）。
//
// ⚠️ 待 macOS 26 SDK 编译核对（xcrun swiftc）：
// 当前文件在 Windows 开发机编写，未经过 swiftc 验证。
// 重点核对：① auxiliaryTopLeftArea/Right 在 macOS 26 SDK 仍可用；
//          ② NSHostingView mouseEntered 等 NSView 重写继承 @MainActor；
//          ③ IslandModel.hovered 本地更新路径（非 snapshot 回读）；
//          ④ ExpandedIslandView 顶部 notch 区避让（padding 是否足够）。
//
// 🔄 Codable/渲染已对齐 Electron 路径（Task 1-4 信息密度增强）：
//   - AgentSession 加 project?/queuedCount?/modelRef?/costUSD?/tokenTotal?
//   - 新增 RecentSession struct（idle home surface 用）
//   - AgentState 加 recentSessions?/isIdle?
//   - ExpandedIslandView 据 isIdle 切换 recent 列表 + 空引导
//   - session 行补 model · cost · token 小字（costUSD/tokenTotal > 0 才显）
//   - compact 加队列徽章 + attention pill（needs-interaction ≥ 2）
//   - planning 全量前 5 + overflow（替代原 prefix(3)）
//   偏离 Electron：① model label 直接显原始 modelRef 字符串（native 无 model registry，
//                  不引 findModelMeta；用户 brief 已确认接受此偏离）；
//                  ② compact planning indicator（无 primary + 紧迫 planning 图标）暂未同步，
//                  需移植 selectPlanningIndicator，留 follow-up。
//   仍待 macOS 26 SDK 编译 + 端到端验证（与 Phase 2 既有待验证状态一致）。

import AppKit
import SwiftUI

// expanded island 下沿大圆角半径；与硬件刘海形成一个连续曲面。
private let expandedBottomCornerRadius: CGFloat = 32
// 内容底部留白，避开下沿过渡曲线。
private let expandedBottomCornerClearance: CGFloat = 32

// MARK: - Codable structs（严格对齐 Lume types/agent-island.ts）

/// Lume AgentIslandSessionSnapshot（注意：用 threadId，非 Proma 的 sessionId）。
/// 可选字段对齐 TS `?`：缺省由 Codable decode 自动 nil（与 Phase 2 既有 Optional 同处理）。
struct AgentSession: Codable, Identifiable {
  let threadId: String
  let title: String
  /// 所属工作区/项目名（小字号显示在 title 后）。
  let project: String?
  let phase: String
  let interactionKind: String?
  let detail: String
  let activityLines: [String]
  let attention: Bool
  let unread: Bool
  let terminalAt: Double?
  let lastActivityAt: Double
  /// 排队消息数（compact 徽章用）。
  let queuedCount: Int?
  /// 当前会话模型引用（原始 ref；native 无 registry，直接显原始字符串）。
  let modelRef: String?
  /// 该会话生命周期累计成本（USD）。
  let costUSD: Double?
  /// 该会话生命周期累计 token。
  let tokenTotal: Int?
  var id: String { threadId }
}

/// Lume AgentIslandRecentSession（idle home surface 的最近会话条目，无 runtime-status）。
struct RecentSession: Codable, Identifiable {
  let threadId: String
  let title: String
  let project: String?
  let updatedAt: Double
  let phase: String?
  var id: String { threadId }
}

/// Lume AgentIslandPlanningItem（todos 与 reminders 共用同一结构）。
struct PlanningItem: Codable, Identifiable {
  let id: String
  let title: String
  let kind: String        // "todo" | "calendar_event"
  let dueAt: Double
  let overdue: Bool
}

/// Lume AgentIslandPlanningSnapshot（todos + reminders，同 PlanningItem 结构）。
struct PlanningSnapshot: Codable {
  let todos: [PlanningItem]
  let reminders: [PlanningItem]
}

/// Lume AgentIslandState。
/// 注意：无 Proma 的 pill / idleDashboard / planQuotas /
/// visible / hovered / expanded 字段。presentation 单字段决定显示形态。
struct AgentState: Codable {
  let presentation: String   // "hidden" | "compact" | "expanded"
  let primarySessionId: String?
  let compactLabel: String
  let sessions: [AgentSession]
  let planning: PlanningSnapshot
  /// idle home surface 用（无 active session 时展示最近会话）。
  let recentSessions: [RecentSession]?
  /// 无 active session 标志；渲染层据它把 expanded 切换成 recent 区。
  let isIdle: Bool?
  let updatedAt: Double
}

/// main → Swift 的全量快照（NativeAgentIslandSnapshot）。
/// 注意：CodingKeys 不列 `protocol`，JSON 中的 "protocol" 字段会被自动忽略
/// （protocol 校验由 main 已完成；Swift 仅消费 type/revision/state）。
struct SnapshotMessage: Codable {
  let type: String
  let revision: Int
  let state: AgentState

  enum CodingKeys: String, CodingKey {
    case type, revision, state
  }
}

struct ShutdownMessage: Codable { let type: String }

// MARK: - NotchMetrics + Shapes（沿用 Proma，纯几何无业务差异）

struct NotchMetrics {
  let hasNotch: Bool
  let width: CGFloat
  let height: CGFloat
  let compactWidth: CGFloat

  init(screen: NSScreen) {
    if #available(macOS 12.0, *),
       let left = screen.auxiliaryTopLeftArea,
       let right = screen.auxiliaryTopRightArea {
      let notch = max(1, right.minX - left.maxX)
      let topInset = screen.safeAreaInsets.top
      hasNotch = topInset > 0
      width = notch
      // 物理安全区高度，让 compact 岛与硬件刘海无缝相接。
      height = topInset
      // 黑色"耳朵"让原生面板物理桥接硬件刘海。
      compactWidth = min(screen.frame.width - 32, max(420, notch + 276))
    } else {
      hasNotch = false
      width = 0
      height = 0
      compactWidth = 0
    }
  }
}

/// Compact/Expanded 共用的下圆角 Bézier 曲面。
struct NotchSurfaceShape: Shape {
  let radius: CGFloat

  func path(in rect: CGRect) -> Path {
    let r = min(radius, rect.width / 2, rect.height)
    // 标准圆 Bézier 系数，保证两侧切线连续。
    let k: CGFloat = 0.552_284_75
    var path = Path()
    path.move(to: CGPoint(x: rect.minX, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
    path.addCurve(
      to: CGPoint(x: rect.maxX - r, y: rect.maxY),
      control1: CGPoint(x: rect.maxX, y: rect.maxY - r + k * r),
      control2: CGPoint(x: rect.maxX - r + k * r, y: rect.maxY)
    )
    path.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
    path.addCurve(
      to: CGPoint(x: rect.minX, y: rect.maxY - r),
      control1: CGPoint(x: rect.minX + r - k * r, y: rect.maxY),
      control2: CGPoint(x: rect.minX, y: rect.maxY - r + k * r)
    )
    path.closeSubpath()
    return path
  }
}

/// 只画两侧 + 下沿曲线，不画顶部线（顶部与硬件刘海融合）。
struct NotchSurfaceOutline: Shape {
  let radius: CGFloat

  func path(in rect: CGRect) -> Path {
    let r = min(radius, rect.width / 2, rect.height)
    let k: CGFloat = 0.552_284_75
    var path = Path()
    path.move(to: CGPoint(x: rect.maxX, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
    path.addCurve(
      to: CGPoint(x: rect.maxX - r, y: rect.maxY),
      control1: CGPoint(x: rect.maxX, y: rect.maxY - r + k * r),
      control2: CGPoint(x: rect.maxX - r + k * r, y: rect.maxY)
    )
    path.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
    path.addCurve(
      to: CGPoint(x: rect.minX, y: rect.maxY - r),
      control1: CGPoint(x: rect.minX + r - k * r, y: rect.maxY),
      control2: CGPoint(x: rect.minX, y: rect.maxY - r + k * r)
    )
    path.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
    return path
  }
}

// MARK: - Panel + HostingView + Model

/// 非激活式无边框 NSPanel，绝不应成为 key/main。
final class AgentIslandPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

/// 承载 SwiftUI 根视图的 NSHostingView；负责 hover 追踪与 hit-test 收紧。
final class AgentIslandHostingView: NSHostingView<IslandRootView> {
  private let model: IslandModel
  private let onHover: (Bool) -> Void
  private var hovering = false
  override var isOpaque: Bool { false }

  required init(rootView: IslandRootView) {
    self.model = rootView.model
    self.onHover = rootView.hover
    super.init(rootView: rootView)
    wantsLayer = true
    layer?.backgroundColor = NSColor.clear.cgColor
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(
      rect: bounds,
      options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
      owner: self,
      userInfo: nil
    ))
  }

  override func mouseEntered(with event: NSEvent) { updateHover(at: event) }
  override func mouseMoved(with event: NSEvent) { updateHover(at: event) }
  override func mouseExited(with event: NSEvent) { setHover(false) }

  private func updateHover(at event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    setHover(model.isInteractive && model.surfaceRect(in: bounds).contains(point))
  }

  /// Lume 差异：hovered 不从 snapshot 回读，本地维护 + emit set-hovered。
  /// 待 macOS 核对：NSHostingView 的 mouse* 重写是否继承 @MainActor，
  /// 以便直接写 model.hovered（@MainActor 属性）。
  private func setHover(_ next: Bool) {
    guard hovering != next else { return }
    hovering = next
    model.hovered = next
    onHover(next)
  }

  /// 交互式时面板 frame 已紧贴 surface；hit-test 仅放行 surface 内的点击。
  override func hitTest(_ point: NSPoint) -> NSView? {
    guard model.isInteractive, model.surfaceRect(in: bounds).contains(point) else { return nil }
    return super.hitTest(point)
  }
}

@MainActor
final class IslandModel: ObservableObject {
  @Published var snapshot: SnapshotMessage?
  @Published var hasNotch = false
  @Published var compactHeight: CGFloat = 32
  @Published var compactWidth: CGFloat = 460
  @Published var surfaceSize = CGSize(width: 460, height: 32)
  @Published var isInteractive = false
  /// Lume：hovered 不在 snapshot 里读（snapshot.state 无此字段），
  /// 由 AgentIslandHostingView 本地维护并 emit set-hovered intent。
  @Published var hovered = false
  private(set) var revision = -1

  func apply(_ next: SnapshotMessage, screen: NSScreen, surfaceSize: CGSize, force: Bool = false) {
    guard force || next.revision > revision else { return }
    revision = next.revision
    snapshot = next
    let metrics = NotchMetrics(screen: screen)
    hasNotch = metrics.hasNotch
    compactHeight = metrics.height
    compactWidth = metrics.compactWidth
    self.surfaceSize = surfaceSize
    // Lume：presentation=="hidden" 表示完全隐藏且非交互（替代 Proma 的 state.visible）。
    isInteractive = next.state.presentation != "hidden"
  }

  func surfaceRect(in bounds: CGRect) -> CGRect {
    let width = min(surfaceSize.width, bounds.width)
    let height = min(surfaceSize.height, bounds.height)
    return CGRect(x: floor((bounds.width - width) / 2),
                  y: bounds.maxY - height,
                  width: width,
                  height: height)
  }
}

// MARK: - 共享格式化

func phaseText(_ phase: String) -> String {
  switch phase {
  case "running": return "正在执行"
  case "needs-interaction": return "需要你接手"
  case "completed": return "任务已完成"
  case "error": return "执行出错"
  case "idle": return "待命中"
  default: return "待命"
  }
}

/// Lume PlanningItem.dueAt 是必填 number（毫秒时间戳）。
func timeText(_ value: Double) -> String {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "zh_CN")
  formatter.dateFormat = "HH:mm"
  return formatter.string(from: Date(timeIntervalSince1970: value / 1000))
}

/// idle home surface 最近会话相对时间：Date.now - updatedAt → 中文相对描述。
/// 阈值（对齐 Electron formatRelativeTime）：<1min「刚刚」、<1h「N 分钟前」、<24h「N 小时前」、否则「N 天前」。
/// 对未来时间（时钟偏移）兜底成「刚刚」，避免负数分钟。
func relativeTimeText(updatedAt: Double, now: Double = Date().timeIntervalSince1970 * 1000) -> String {
  let diff = max(0, now - updatedAt)
  if diff < 60_000 { return "刚刚" }
  if diff < 3_600_000 { return "\(Int(diff / 60_000)) 分钟前" }
  if diff < 86_400_000 { return "\(Int(diff / 3_600_000)) 小时前" }
  return "\(Int(diff / 86_400_000)) 天前"
}

/// 拼接会话行 model · cost · token 小字（对齐 Electron formatSessionMeta）。
/// 仅 >0 才进 parts，避免「· $0.00」噪声。
/// 偏离 Electron：model label 直接显原始 modelRef 字符串（native 无 model registry，
/// 不引 findModelMeta；用户 brief 已确认接受此偏离）。
func sessionMetaText(session: AgentSession) -> String {
  var parts: [String] = []
  if let ref = session.modelRef, !ref.isEmpty { parts.append(ref) }
  if let cost = session.costUSD, cost > 0 {
    parts.append(String(format: "$%.2f", cost))
  }
  if let tokens = session.tokenTotal, tokens > 0 {
    parts.append(String(format: "%.1fk", Double(tokens) / 1000))
  }
  return parts.joined(separator: " · ")
}

// MARK: - CompactIslandView

struct CompactIslandView: View {
  let snapshot: SnapshotMessage
  let height: CGFloat
  let action: (String, [String: Any]) -> Void

  private var primarySession: AgentSession? { snapshot.state.sessions.first }
  /// needs-interaction 计数（对齐 Electron compact attention pill：>=2 才显数字）。
  private var needInteractionCount: Int {
    snapshot.state.sessions.filter { $0.phase == "needs-interaction" }.count
  }
  /// 排队消息数（对齐 Electron compact queue badge：>0 才显）。
  private var queueCount: Int { primarySession?.queuedCount ?? 0 }

  var body: some View {
    Button(action: { action("set-expanded", ["value": true]) }) {
      HStack(spacing: 8) {
        if primarySession == nil {
          Image(systemName: "bell")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.white.opacity(0.65))
            .frame(width: 14)
        }
        // 队列徽章（对齐 Electron island-queue-badge）。
        if queueCount > 0 {
          Text("队列 \(queueCount)")
            .font(.system(size: 9, weight: .bold))
            .padding(.horizontal, 5)
            .frame(height: 14)
            .background(.white.opacity(0.18), in: Capsule())
            .foregroundStyle(.white.opacity(0.92))
        }
        // attention 数字 pill（needs-interaction >=2 才显；对齐 Electron island-attention-pill）。
        if needInteractionCount >= 2 {
          Text("\(needInteractionCount)")
            .font(.system(size: 9, weight: .bold))
            .padding(.horizontal, 5)
            .frame(height: 14)
            .background(Color(red: 1, green: 0.66, blue: 0.22), in: Capsule())
            .foregroundStyle(.white)
        }
        // Lume 主进程已算好 compactLabel（如 "Lume · 正在执行"），Swift 不再拼接品牌前缀。
        Text(snapshot.state.compactLabel)
          .font(.system(size: 10.5, weight: .semibold))
          .lineLimit(1)
          .foregroundStyle(.white.opacity(0.92))
        Spacer(minLength: 6)
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(.white.opacity(0.46))
      }
      .padding(.horizontal, 14)
      .frame(height: height)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

// MARK: - ExpandedIslandView

struct ExpandedIslandView: View {
  let snapshot: SnapshotMessage
  let action: (String, [String: Any]) -> Void

  /// 优先匹配 primarySessionId；缺失或找不到时回退 sessions 首个。
  private var primarySession: AgentSession? {
    if let id = snapshot.state.primarySessionId,
       let match = snapshot.state.sessions.first(where: { $0.threadId == id }) {
      return match
    }
    return snapshot.state.sessions.first
  }
  private var primaryPhase: String? { primarySession?.phase }

  private var headerEyebrow: String {
    switch primaryPhase {
    case "needs-interaction": return "LUME · HANDOFF"
    case .some: return "LUME · AGENT"
    case .none: return "LUME · REMINDER"
    }
  }

  /// 优先用主进程预计算的 compactLabel；为空时按 phase 映射中文。
  private var headerTitle: String {
    if !snapshot.state.compactLabel.isEmpty {
      return snapshot.state.compactLabel
    }
    switch primaryPhase {
    case "running": return "正在执行"
    case "needs-interaction": return "需要你接手"
    case "completed": return "任务已完成"
    case "error": return "执行出错"
    case "idle": return "待命中"
    case .some: return "Agent 状态更新"
    case .none: return "即将开始"
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      // Header：顶部空白处是收起手势；按钮在上层不抢点击。
      ZStack {
        Button(action: { action("set-expanded", ["value": false]) }) {
          Color.clear.contentShape(Rectangle())
        }.buttonStyle(.plain)
        HStack(spacing: 10) {
          VStack(alignment: .leading, spacing: 2) {
            Text(headerEyebrow)
              .font(.system(size: 9, weight: .bold))
              .tracking(1.1)
              .foregroundStyle(.white.opacity(0.62))
            Text(headerTitle)
              .font(.system(size: 15.5, weight: .bold))
              .foregroundStyle(.white.opacity(0.98))
              .lineLimit(1)
          }
          Spacer()
          Button(action: { action("open-main", [:]) }) {
            HStack(spacing: 5) {
              Text("打开 Lume")
              Image(systemName: "arrow.up.right")
            }
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 9)
            .frame(height: 26)
          }.buttonStyle(IslandButtonStyle())
        }
        .padding(.horizontal, 18)
      }
      .frame(height: 46)

      // idle/active 互斥：isIdle == true 时 sessions 区替换为 recent 列表 + 空引导
      // （对齐 Task 4 Electron：service 已去重，无需渲染层再剔 active）。
      // planning 区在两种状态下都保留（有才显，复用下方全量逻辑）。
      if snapshot.state.isIdle == true {
        Divider().overlay(.white.opacity(0.11))
        VStack(alignment: .leading, spacing: 5) {
          HStack(spacing: 5) {
            Image(systemName: "clock.arrow.circlepath")
              .font(.system(size: 11, weight: .semibold))
              .foregroundStyle(.white.opacity(0.6))
            Text("最近会话")
              .font(.system(size: 12, weight: .bold))
              .foregroundStyle(.white.opacity(0.9))
          }
          .padding(.horizontal, 14)
          .padding(.top, 8)

          let recents = snapshot.state.recentSessions ?? []
          if !recents.isEmpty {
            ForEach(Array(recents.prefix(5))) { recent in
              Button(action: { action("open-session", ["threadId": recent.threadId]) }) {
                HStack(spacing: 10) {
                  Text("◌")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.white.opacity(0.55))
                  VStack(alignment: .leading, spacing: 2) {
                    Text(recent.title)
                      .font(.system(size: 11, weight: .semibold))
                      .lineLimit(1)
                      .foregroundStyle(.white.opacity(0.92))
                    Text(relativeTimeText(updatedAt: recent.updatedAt))
                      .font(.system(size: 9.5))
                      .foregroundStyle(.white.opacity(0.5))
                  }
                  Spacer()
                  if let project = recent.project, !project.isEmpty {
                    Text(project)
                      .font(.system(size: 9.5))
                      .lineLimit(1)
                      .foregroundStyle(.white.opacity(0.40))
                  }
                  Image(systemName: "arrow.up.right")
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.45))
                }
                .padding(.horizontal, 11)
                .frame(minHeight: 42)
                .background(.white.opacity(0.065), in: RoundedRectangle(cornerRadius: 10))
              }.buttonStyle(.plain)
            }
          } else {
            // 空引导：还没有会话 + 新建会话（对齐 Task 4 Electron island-recent-empty）。
            VStack(spacing: 8) {
              Text("还没有会话")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.55))
              Button(action: { action("open-main", [:]) }) {
                Text("新建会话")
                  .font(.system(size: 10, weight: .semibold))
                  .padding(.horizontal, 12)
                  .frame(height: 24)
              }.buttonStyle(IslandButtonStyle())
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
          }
        }.padding(.bottom, 6)
      } else if !snapshot.state.sessions.isEmpty {
        Divider().overlay(.white.opacity(0.11))
        VStack(alignment: .leading, spacing: 5) {
          ForEach(Array(snapshot.state.sessions.prefix(5))) { session in
            Button(action: { action("open-session", ["threadId": session.threadId]) }) {
              HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                  Text(phaseText(session.phase))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white.opacity(0.98))
                  HStack(spacing: 6) {
                    Text(session.title)
                      .font(.system(size: 10, weight: .medium))
                      .lineLimit(1)
                      .foregroundStyle(.white.opacity(0.62))
                    if let project = session.project, !project.isEmpty {
                      Text(project)
                        .font(.system(size: 9.5))
                        .lineLimit(1)
                        .foregroundStyle(.white.opacity(0.40))
                    }
                  }
                  // 最近一行活动作为细节提示（Lume SessionSnapshot 独有字段）。
                  if let activity = session.activityLines.last, !activity.isEmpty {
                    Text(activity)
                      .font(.system(size: 9.5))
                      .lineLimit(1)
                      .foregroundStyle(.white.opacity(0.45))
                  }
                  // model · cost · token 小字（costUSD/tokenTotal > 0 才显；对齐 Task 3 formatSessionMeta）。
                  let meta = sessionMetaText(session: session)
                  if !meta.isEmpty {
                    Text(meta)
                      .font(.system(size: 9))
                      .lineLimit(1)
                      .foregroundStyle(.white.opacity(0.40))
                  }
                }
                Spacer()
                if session.attention {
                  Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(Color(red: 1, green: 0.66, blue: 0.22))
                }
                Image(systemName: "arrow.up.right")
                  .font(.system(size: 10))
                  .foregroundStyle(.white.opacity(0.45))
              }
              .padding(.horizontal, 11)
              .frame(minHeight: 46)
              .background(.white.opacity(0.065), in: RoundedRectangle(cornerRadius: 10))
            }.buttonStyle(.plain)
          }
        }.padding(14)
      }

      let planning = snapshot.state.planning
      // 上一块（idle recent 或 active sessions）非空时，planning 前加分隔线。
      let hasSessionsBlock = snapshot.state.isIdle == true
        ? !(snapshot.state.recentSessions?.isEmpty ?? true)
        : !snapshot.state.sessions.isEmpty
      if !planning.todos.isEmpty || !planning.reminders.isEmpty {
        if hasSessionsBlock {
          Divider().overlay(.white.opacity(0.11))
        }
        // planning 全量排序：overdue 置顶 + dueAt 升序（对齐 Electron sortIslandPlanningItems）。
        // expanded 直出前 5 条 + 「还有 N 条」overflow（对齐 Task 3 PLANNING_VISIBLE_MAX=5）。
        let visibleMax = 5
        let sortedTodos = planning.todos.sorted {
          if $0.overdue != $1.overdue { return $0.overdue }
          return $0.dueAt < $1.dueAt
        }
        let sortedReminders = planning.reminders.sorted {
          if $0.overdue != $1.overdue { return $0.overdue }
          return $0.dueAt < $1.dueAt
        }
        // 两列：todos（待办）+ reminders（提醒），都用 PlanningItem。
        HStack(alignment: .top, spacing: 12) {
          if !sortedTodos.isEmpty {
            Button(action: { action("open-planning", [:]) }) {
              PlanningColumn(title: "接下来待办", symbol: "checklist", count: sortedTodos.count) {
                ForEach(Array(sortedTodos.prefix(visibleMax))) { todo in
                  PlanningItemRow(item: todo)
                }
                if sortedTodos.count > visibleMax {
                  Text("还有 \(sortedTodos.count - visibleMax) 条")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.white.opacity(0.45))
                }
              }
            }.buttonStyle(.plain)
          }
          if !sortedReminders.isEmpty {
            Button(action: { action("open-planning", [:]) }) {
              PlanningColumn(title: "即将提醒", symbol: "bell", count: sortedReminders.count) {
                ForEach(Array(sortedReminders.prefix(visibleMax))) { reminder in
                  PlanningItemRow(item: reminder)
                }
                if sortedReminders.count > visibleMax {
                  Text("还有 \(sortedReminders.count - visibleMax) 条")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.white.opacity(0.45))
                }
              }
            }.buttonStyle(.plain)
          }
        }
        .padding(14)
      }
    }
    .padding(.top, 8)
    .padding(.bottom, expandedBottomCornerClearance)
    // presentation 切换时让 SwiftUI 视为不同视图，触发过渡动画。
    .id(snapshot.state.presentation)
    .transition(.asymmetric(
      insertion: .opacity.combined(with: .move(edge: .top)),
      removal: .opacity.combined(with: .move(edge: .bottom))
    ))
    .animation(.easeInOut(duration: 0.36), value: snapshot.state.presentation)
  }
}

struct PlanningItemRow: View {
  let item: PlanningItem

  var body: some View {
    HStack(spacing: 6) {
      RoundedRectangle(cornerRadius: 2.5)
        .stroke(item.overdue ? Color.red : Color.white.opacity(0.5), lineWidth: 1.2)
        .frame(width: 11, height: 11)
      Text(item.title).lineLimit(1)
      Spacer()
      Text(timeText(item.dueAt))
        .foregroundStyle(item.overdue ? .red.opacity(0.9) : .white.opacity(0.5))
    }
    .frame(height: 20)
  }
}

struct IslandButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(.white.opacity(configuration.isPressed ? 0.55 : 0.75))
      .background(
        .white.opacity(configuration.isPressed ? 0.14 : 0.07),
        in: RoundedRectangle(cornerRadius: 8)
      )
  }
}

struct PlanningColumn<Content: View>: View {
  let title: String
  let symbol: String
  let count: Int
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 5) {
        Image(systemName: symbol)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Color(red: 0.62, green: 0.72, blue: 1))
        Text(title)
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(.white.opacity(0.9))
        Text("\(count)")
          .font(.system(size: 10.5, weight: .bold))
          .foregroundStyle(.white.opacity(0.88))
      }
      content
        .font(.system(size: 11))
        .foregroundStyle(.white.opacity(0.86))
        .frame(maxWidth: .infinity, alignment: .leading)
      if count == 0 {
        Text("暂无事项")
          .font(.system(size: 10.5))
          .foregroundStyle(.white.opacity(0.45))
      }
    }
    .padding(13)
    .frame(maxWidth: .infinity, alignment: .topLeading)
    .compositingGroup()
    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    .background(.white.opacity(0.075), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(.white.opacity(0.10), lineWidth: 1))
  }
}

// MARK: - IslandRootView

struct IslandRootView: View {
  @ObservedObject var model: IslandModel
  let action: (String, [String: Any]) -> Void
  let hover: (Bool) -> Void

  var body: some View {
    let presentation = model.snapshot?.state.presentation
    let expanded = presentation == "expanded"
    let visible = presentation != "hidden"
    // Lume：hovered 由本地 model 维护（hosting view 写入），不从 snapshot 回读。
    let hovered = model.hovered
    let cornerRadius = expanded ? expandedBottomCornerRadius : (hovered ? 18 : 16)
    let shape = NotchSurfaceShape(radius: cornerRadius)
    let outline = NotchSurfaceOutline(radius: cornerRadius)
    ZStack(alignment: .top) {
      ZStack(alignment: .top) {
        shape.fill(expanded
          ? Color(red: 0.035, green: 0.035, blue: 0.035)
          : Color.black)
        if let snapshot = model.snapshot, visible {
          if expanded {
            // 刘海避让：= safeAreaInsets.top（= model.compactHeight），待 macOS 实测确认无遮挡。
            // ExpandedIslandView 整体下移 compactHeight，让内容落在硬件刘海下方；
            // 顶部空出的区域由底层 shape.fill 渲染深灰背景，视觉上与刘海形成连续曲面。
            // 注意：expandedHeight(for:width:notchHeight:) 测量时必须同步加同等内容 padding，
            // 否则 surfaceSize 高度不足，底部会被 clipShape(shape) 裁剪。
            ExpandedIslandView(snapshot: snapshot, action: action)
              .padding(.top, model.compactHeight)
              .transition(.opacity.combined(with: .move(edge: .top)))
          } else {
            CompactIslandView(snapshot: snapshot, height: model.compactHeight, action: action)
              .transition(.opacity)
          }
        }
      }
      .compositingGroup()
      .clipShape(shape)
      .overlay {
        if expanded {
          ZStack {
            outline.stroke(.white.opacity(0.08), lineWidth: 3)
            outline.stroke(.white.opacity(0.20), lineWidth: 1.2)
          }
        } else if hovered {
          shape.stroke(.white.opacity(0.15), lineWidth: 1)
        }
      }
      .overlay(alignment: .bottom) {
        if !expanded {
          Rectangle()
            .fill(.white.opacity(hovered ? 0.16 : 0.10))
            .frame(height: 1)
            .padding(.horizontal, 18)
        }
      }
      .shadow(
        color: .black.opacity(hovered && !expanded ? 0.42 : 0.26),
        radius: hovered && !expanded ? 10 : 5,
        y: hovered && !expanded ? 3 : 1
      )
      .scaleEffect(hovered && !expanded ? 1.012 : 1, anchor: .top)
      .frame(width: model.surfaceSize.width, height: model.surfaceSize.height, alignment: .top)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .animation(.timingCurve(0.2, 0, 0, 1, duration: 0.16), value: hovered)
    .animation(.timingCurve(0.2, 0, 0, 1, duration: 0.22), value: expanded)
  }
}

// MARK: - IslandController

@MainActor
final class IslandController {
  private static let maximumWidth: CGFloat = 620
  private static let maximumHeight: CGFloat = 640

  private let model = IslandModel()
  private let panel: AgentIslandPanel
  private var screen: NSScreen
  private var latestMessage: SnapshotMessage?
  private var screenObserver: NSObjectProtocol?

  init() {
    screen = Self.preferredScreen() ?? NSScreen.main ?? NSScreen.screens[0]
    let metrics = NotchMetrics(screen: screen)
    panel = AgentIslandPanel(
      contentRect: Self.topFrame(
        screen: screen,
        width: max(metrics.compactWidth, 1),
        height: max(metrics.height, 1)
      ),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.statusWindow)) + 2)
    panel.acceptsMouseMovedEvents = true
    panel.ignoresMouseEvents = true
    let hosting = AgentIslandHostingView(rootView: IslandRootView(
      model: model,
      action: emitIntent,
      // Lume：set-hovered intent 用 `value` 键（非 Proma 的 `hovered` 键）。
      hover: { hovered in emitIntent("set-hovered", ["value": hovered]) }
    ))
    panel.contentView = hosting
    screenObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor in self?.refreshForDisplayChange() }
    }
  }

  deinit {
    if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
  }

  func apply(_ message: SnapshotMessage) {
    let prev = latestMessage?.state.presentation
    let next = message.state.presentation
    // expanded→expanded 的尺寸过渡用动画；首次或跨形态切换走瞬时 setFrame。
    let animateExpandedResize = prev == "expanded" && next == "expanded"
    latestMessage = message
    layout(message, forceModelUpdate: false, animateFrame: animateExpandedResize)
  }

  func close() { panel.orderOut(nil) }

  private func refreshForDisplayChange() {
    guard let latestMessage else { return }
    layout(latestMessage, forceModelUpdate: true)
  }

  private func layout(_ message: SnapshotMessage, forceModelUpdate: Bool, animateFrame: Bool = false) {
    screen = Self.preferredScreen() ?? NSScreen.main ?? screen
    let metrics = NotchMetrics(screen: screen)

    // 非刘海屏不伪造 notch；隐藏时面板完全 click-through，避免覆盖系统菜单栏控件。
    guard metrics.hasNotch else {
      model.apply(message, screen: screen, surfaceSize: .zero, force: forceModelUpdate)
      panel.ignoresMouseEvents = true
      panel.orderOut(nil)
      return
    }

    let visible = message.state.presentation != "hidden"
    let expanded = message.state.presentation == "expanded"
    let width = expanded ? min(Self.maximumWidth, screen.frame.width - 32) : metrics.compactWidth
    // 把 notchHeight（= safeAreaInsets.top）传给 expandedHeight，与 IslandRootView 中
    // ExpandedIslandView `.padding(.top, notchHeight)` 对齐，确保 panel 高度包含刘海避让区。
    let height = expanded
      ? Self.expandedHeight(for: message, width: width, notchHeight: metrics.height)
      : metrics.height
    let surfaceSize = CGSize(width: width, height: height)

    // 把 NSPanel 紧贴真实可交互 surface，避免巨型透明 WindowServer 命中区。
    let targetFrame = Self.topFrame(screen: screen, width: width, height: height)
    if panel.frame != targetFrame {
      if animateFrame {
        NSAnimationContext.runAnimationGroup { context in
          context.duration = 0.36
          panel.animator().setFrame(targetFrame, display: true)
        }
      } else {
        panel.setFrame(targetFrame, display: true, animate: false)
      }
    }
    model.apply(message, screen: screen, surfaceSize: surfaceSize, force: forceModelUpdate)
    panel.ignoresMouseEvents = !visible
    panel.acceptsMouseMovedEvents = visible
    if visible { panel.orderFrontRegardless() } else { panel.orderOut(nil) }
  }

  private static func preferredScreen() -> NSScreen? {
    NSScreen.screens.first(where: { NotchMetrics(screen: $0).hasNotch })
  }

  /// 用最终宽度的 SwiftUI 树做 hosting 测量，避免二次 resize。
  /// notchHeight 必须与 IslandRootView 中 ExpandedIslandView 的 `.padding(.top, notchHeight)`
  /// 保持一致，否则 panel 高度不足会让底部内容被 clipShape 裁剪。
  private static func expandedHeight(
    for message: SnapshotMessage,
    width: CGFloat,
    notchHeight: CGFloat
  ) -> CGFloat {
    let measuringView = NSHostingView(rootView:
      ExpandedIslandView(snapshot: message, action: { _, _ in })
        .padding(.top, notchHeight)
        .frame(width: width, alignment: .topLeading)
        .fixedSize(horizontal: false, vertical: true)
    )
    let height = ceil(measuringView.fittingSize.height)
    return min(maximumHeight, max(height, 1))
  }

  private static func topFrame(screen: NSScreen, width: CGFloat, height: CGFloat) -> NSRect {
    NSRect(
      x: round(screen.frame.midX - width / 2),
      y: screen.frame.maxY - height,
      width: width,
      height: height
    )
  }
}

// MARK: - main entry

func emitJson(_ object: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(object),
        let data = try? JSONSerialization.data(withJSONObject: object),
        let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func emitIntent(_ name: String, _ values: [String: Any]) {
  var payload: [String: Any] = ["type": "intent", "name": name]
  values.forEach { payload[$0.key] = $0.value }
  emitJson(payload)
}

@main
@MainActor
struct LumeAgentIslandHost {
  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let controller = IslandController()
    emitJson(["type": "ready", "protocol": 1])

    // stdin JSONL 循环放在后台队列；解析后的 SnapshotMessage 派回 main actor 应用。
    DispatchQueue.global(qos: .userInitiated).async {
      while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let type = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["type"] as? String
        else { continue }
        if type == "shutdown" {
          DispatchQueue.main.async { controller.close(); app.terminate(nil) }
          return
        }
        if type == "snapshot",
           let message = try? JSONDecoder().decode(SnapshotMessage.self, from: data) {
          DispatchQueue.main.async { controller.apply(message) }
        }
      }
      // stdin 关闭即退出（main 已离开）。
      DispatchQueue.main.async { controller.close(); app.terminate(nil) }
    }
    app.run()
  }
}
