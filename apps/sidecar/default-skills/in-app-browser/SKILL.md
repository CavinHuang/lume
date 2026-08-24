---
name: "In-App 浏览器操作"
description: "操作 Lume 内置浏览器(in-app browser):snapshot 读取、click/fill/type 等语义交互、上传下载、保存密码填充、JS 对话框与 run_script 兜底。含错误码恢复流程。浏览器任务出现时使用。"
allowed_tools: ["mcp__browser__*"]
version: "1.0"
---

## In-App 浏览器操作手册

通过 `mcp__browser__*` 工具操作任务专属的内置浏览器标签页。核心循环只有一步:**先 `snapshot` 拿 ref,再按 ref 行动**。

### 标签页管理

| 工具 | 用途 |
|------|------|
| `list_tabs` | 列出本任务拥有的标签页与当前锁定 tab |
| `open` | 新开一个 Agent 标签页并锁定(仅当没有合适 tab 时) |
| `switch_tab` | 切换锁定目标到另一个 Agent 标签页 |
| `navigate` / `back` / `forward` / `reload` | 在锁定的 tab 内导航,返回新 snapshot |

- 任务已有可用 tab 时用 `list_tabs` 找到它继续,不要重复 `open`。
- 跨回合的 tab 交接信息在系统上下文 `<browser_continuity>` 块中,优先复用其中给出的 tab。

### 观察与交互循环

1. **`snapshot`**:把页面读成紧凑的可访问性树。交互节点带 `[ref=e12]` 形式的标记。
   - 大页面用 `next_cursor` 翻页继续读(截断时结果自带翻页提示);已知目标子树时 `scope_ref="@e12"` 只读该子树,否则优先翻页;`interactive_only=true` 只看可交互节点。
2. **行动**:把最新 snapshot 的 ref 传给动作工具,ref 写 `@e12`(带 @)或不带均可:
   - 点击类:`click` / `double_click` / `hover`
   - 输入类:`fill`(整体替换)/ `type`(追加)/ `press`(按键,如 Enter、Control+A)/ `select`/ `check`(勾选状态)
     - `select` 的 value 是 `<option>` 的 value 属性,**不是 snapshot 里看到的显示文本**;快照拿不到 value 时用 `run_script` 枚举 option 再选
   - `scroll`:锚点 ref 必填(取页面上任一元素的 ref,通常为目标区域或根元素),`delta_y` 正值向下滚
   - 元素不可见/被遮挡/禁用时不要盲试坐标;重新 snapshot 找替代元素或先滚动到可见
3. **每次动作自动返回新 snapshot**。只使用最新一次 snapshot 的 ref;旧 ref 一律失效。

### 视觉核对

`screenshot` 只用于观察(布局、验证码样式、图表),不能作为交互目标:
- 默认截当前视口;`full_page=true` 截整页。
- `annotated=true` 在截图上标注 ref(需先 snapshot,不能与 full_page 同用)。

### 确认门

`navigate` 与提交、发送、删除、授权、上传、填入凭据(`fill_secret`)、`run_script` 类动作**可能**弹出 Lume 用户确认(取决于动作语义,以工具返回为准;`open` 新开 tab 与下载等待本身不弹),确认在工具调用内同步等待用户裁决。**用户拒绝表示否决该路径**,换方案而不是换个说法重试同一动作。

### 上传、下载与对话框

- `upload`:传 ref + 文件数组(本地路径或此前下载返回的 file ref),工具自己等文件选择器,不要拆成脚本模拟。
- `download`:点下载控件并等待;超时未完按返回的 `download_id` 轮询,完成后返回任务级 file ref。
- alert/confirm/prompt 阻塞页面时的处理见错误码表 `dialog_blocking` 行。

### 保存的密码

- `list_secrets`:列出当前站点 origin 可用的凭据元数据。
- `fill_secret`:按 secret_id 填入密码,**明文不会进入模型上下文**。禁止让用户口述密码或用 `fill` 明文填密码。

### run_script(兜底)

语义工具表达不了的操作才用 `run_script`:隔离世界执行 JS 函数体,入参经 `arg` 传入,必须返回 JSON 可序列化值,超时上限 10s。优先级:语义工具 > run_script。

### 错误码与恢复

| 错误码 | 含义 | 处理 |
|--------|------|------|
| `stale_target` / `stale_snapshot_cursor` | 页面已导航或用户刚手动操作过页面,旧 snapshot 失效(正常避让) | 重新 `snapshot`,用新 ref 重试 |
| `tab_not_found` | 锁定 tab 已不存在 | `list_tabs` 后 `open` 或 `switch_tab` |
| `dialog_blocking` | JS 对话框挡着页面 | 先 `dialog` 读取,再 `handle_dialog` 处理后继续 |
| `element_not_visible` / `element_occluded` / `element_disabled` / `element_readonly` / `actionability_failed` / `strict_locator_violation` | 元素当前不可交互或定位不唯一 | 重新 snapshot 换可见的替代元素,或先滚动/填写前置字段;不要对同一 ref 连续硬试 |
| `repeated_action_failure` | 同动作同 ref 在同代际连续失败 ≥2 次,已熔断 | 解除路径是成功执行一次 `navigate`/`reload`/`back`/`forward`/`open`/`switch_tab`/`handle_dialog`(换代际;用户手动导航后同样解锁);在此之前一切点击输入类动作都被拒 |
| `action_denied` | 策略拒绝(如支付、购买) | 停止该意图,交用户处理;不得变相绕过 |
| `user_declined` | 用户在确认弹窗明确拒绝了该动作 | 否决该路径:停止该意图、换方案或询问用户,不要原样或换措辞重试 |
| `confirmation_unavailable` | 确认通道异常(非用户拒绝) | 可重试一次;持续出现说明通道故障,如实告知用户 |
| `confirmation_timeout` | 确认弹窗等待超时,动作未执行(弹窗可能仍开着) | 告知用户完成或关闭弹窗;不要立即重试以免叠出第二个弹窗 |
| `user_action_required` | CAPTCHA/MFA/硬件密钥步骤 | 停下请用户完成该步;换措辞重试也会被拒(按元素语义识别),不要尝试 |
| `user_takeover_required` | 协议级接管信号(当前流程下极少出现) | 停止全部浏览器动作,向用户说明并等待明确指示后再继续 |
| `navigation_timeout` | 页面加载超上限被中断,页面可能仍在后台继续加载 | 先 `snapshot` 确认实际状态再决定;不要立即重试同一 `navigate`,持续超时改开新 tab 或如实告知用户 |
| `browser_unavailable` | 浏览器运行时不可用 | 可重试;确认不可用后说明能力降级,才考虑原生 computer-use |

### 红线

- CAPTCHA、MFA、硬件密钥必须由用户完成;支付与购买会被直接拒绝,不要尝试或绕过。
- 保存密码一律走 `fill_secret`(值不进上下文);禁止用 `fill` 明文填密码或让用户口述密码。
- 用户在页面上手动操作时让行避让;用户明确要求停止时立即停止全部浏览器动作。
- 编码/本地文件工作用 Read/Write/Edit/Grep/Bash,不要因为 browser 工具在场就用浏览器打开本地文件。
