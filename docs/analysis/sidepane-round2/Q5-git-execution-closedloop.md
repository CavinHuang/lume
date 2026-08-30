All layers are now mapped end-to-end. Artifacts saved under `D:\tmp\zc-analysis\out\sidepane-q5\` (git-core.beauty.js, git-provider.beauty.js, hub.beauty.js, rpc-kgxw.beauty.js, checkpoint.beauty.js)。以下是完整技术报告。

---

# ZCode Desktop Git 执行层逆向报告（renderer gitService → git CLI 闭环）

所有字节偏移均指原始压缩文件的 UTF-8 字节偏移；引用片段为 js-beautify 产物。分析产物位于 `D:\tmp\zc-analysis\out\sidepane-q5\`。

## 1. 执行位置与 DI 注册 / RPC 方法面

**没有独立 sidecar git 进程**。`out/` 下无 sidecar 目录；git 全部在 **host 进程**（独立 Node 进程，`out/host/index.js`，由 Electron main 用 `utilityProcess.fork` 启动）中执行。main 进程只做 RPC 代理，不做任何 git 调用。

- main 侧路径解析：`D:\software\zcode\resources\app\out\main\index.js` @825669
  ```js
  var qx=wt(import.meta.dirname,"../host/index.js"),
      ij=wt(import.meta.dirname,"../scheduler/index.js");
  ```
  fork 点 @1306728（`fork(` / `utilityProcess` @1232998）。

**通道注册链**（host/index.js @2169440 → @2259589）：
```js
var Rt=new dm({currentModelProvider:{...}, textGenerator:{...}, logger:ze("git-commit-message")}),
    ce=tA({commitMessageGenerator:Rt});        // ← createGitService 实例
...
new Of().register($f,ZT({...}))                // "file"
        .register(Df,ce)                       // ← "git" 通道 = gitService
        .register(Nf,d)                        // "git-checkpoint"
...
t.exposeOnChannelServer(l,h);                  // 把 ServiceCollection 变成 RPC channels
```
- `Of` = `chunk-YSDGIE3M.js` 的 `ServiceCollection`（@58053）：`register(t,n){return this._services.set(t.channelName,n),this}`；`exposeOnChannelServer`（@58293）对每个服务调 `t.registerChannel(r, P.fromService(c))`。
- 通道名枚举（`chunk-EGJBTUMC.js` @498470）：`{File:"file",System:"system",Terminal:"terminal",Git:"git",GitCheckpoint:"git-checkpoint",FileWatcher:"file-watcher",...}`。
- main/renderer 客户端用 `toService(channel)` Proxy（`chunk-KGXW6KHC.js` @17369 起）：方法调用 → `channel.call(name,[args])`；`onXxx` → `channel.listen`；`onDynamic*` 是动态事件（@16593 `fromService`：`call` 直接 `service[name].apply(service,args)`，`listen` 返回事件属性）。底层是 VS Code 风格 `ChannelServer/ChannelClient`（消息类型 100=call、102=event-listen、101/103=dispose、201=resolve、202=error、204=event fire），server 侧 1s 未注册通道超时（@chunk-KGXW6KHC `Channel name '${e.channelName}' timed out after ${this.timeoutDelay}ms`）。
- 远程工作区走同一契约，完整通道白名单（host/index.js @2179000）：`NQe=["fileService","gitService","gitCheckpointService","systemService","terminalService",...]`，缺一即抛 `Legacy remote workspace RPC channel 不完整`。

**gitService 完整 RPC 方法面**（`createGitService`，host/index.js @69642，共 18 个方法）：
`getRepositorySummary, getWorkspaceRepositoryInfo, getLocalBranches, getCommitGraph, switchBranch, createBranchAndSwitch, getChanges, getIgnoredPaths, getDiff, getBranchComparison, stagePaths, unstagePaths, discardPaths, generateCommitMessage, commit, push, getIdentity, refresh`。

renderer 侧的 `watch({path,recursive})→onDynamicChange` 和 `readTextFile` **不在 gitService**：watch 走 `fileWatcherService`（"file-watcher" 通道），readTextFile 属工作区 file 服务（host/index.js @20811，返回 `{path,content,offset,bytesRead,totalBytes,truncated,isBinary}`）。renderer 的 `GitAutoRefresh` hook（styles-C2WGZ-SY.js @278007）证实：
```js
for(let i of f) s.watch({path:i.path,recursive:i.recursive}).then(({id:e})=>{
  let i=s.onDynamicChange(e)(e=>{ r(e.dirPath) }); ...
```
其中监听路径 `f` 由 `gitSummary.autoRefreshWatchPaths` 推导（见 §3），变更后 60s 防抖（`Tpe=6e4`）调用 `onRefreshGit` 刷新。

## 2. Git 调用层：spawn git CLI（无 git 库）

核心是 `createGitCliRepo`（host/index.js @64688）+ `createGitCommandProvider`（`_v`，@33425）。全部通过 `child_process.spawn` 直接执行 git CLI，**无 shell、无字符串拼接**（args 数组）。

**超时/输出上限常量**（@26897）：
```js
var _J=3e3,          // git --version 探测 3s
    Bt=15e3,         // 常规命令 15s
    PJ=10*6e4,       // push 10min
    im=2e4,          // diff 20s
    sr=512*1024,     // 常规输出上限 512KB
    SJ=8*1024*1024,  // push 输出 8MB
    qc=1024*1024;    // diff/预览 1MB
```

**二进制解析**（@27668，顺序尝试，结果缓存）：`ZCODE_GIT_BINARY` 环境变量 → `git`（PATH）→ win32 下追加 `%ProgramW6432%\Git\cmd\git.exe`、`\Git\bin\git.exe`、x86 两路径；每个候选用 `git --version`（3s 超时，windowsHide）验证（@30702 `canExecuteGitCandidate`）。

**环境加固**（@27831 `getGitCommandEnv`）：先删除全部可注入 git 位置的变量，再固定确定性行为：
```js
function WT(){let e={...process.env};
  for(let t of jye) delete e[t];   // GIT_DIR/GIT_INDEX_FILE/GIT_CONFIG/GIT_WORK_TREE 等 16 个
  return {...e, GIT_OPTIONAL_LOCKS:"0", GIT_PAGER:"cat", PAGER:"cat",
          TERM:"dumb", LC_ALL:"C", LANG:"C"}}
```
（`jye` 列表 @git-provider.beauty.js L15：`GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_COMMON_DIR, GIT_CONFIG, GIT_CONFIG_COUNT, GIT_CONFIG_PARAMETERS, GIT_DIR, GIT_GRAFT_FILE, GIT_IMPLICIT_WORK_TREE, GIT_INDEX_FILE, GIT_NAMESPACE, GIT_OBJECT_DIRECTORY, GIT_PREFIX, GIT_REPLACE_REF_BASE, GIT_SHALLOW_FILE, GIT_WORK_TREE`。唯一例外：partial commit 时内部显式注入 `GIT_INDEX_FILE`。）

**spawn 与超时杀灭**（@32193）：
```js
Z=MJ(c,i.args,{cwd:i.cwd, env:u, stdio:["ignore","pipe","pipe"], windowsHide:!0});
```
超时后三级升级：`kill()` → 等待 `timeoutKillGraceMs=2000` → win32 `taskkill /PID <pid> /T /F`（否则 SIGKILL）→ 再等 2000ms → 结果标记 `orphaned:true` 并 destroy 流、`unref()`。输出按字节计量，超过 `maxOutputBytes` 立即 kill 并标记 `outputTruncated`。`ensureGitCommandSucceeded`（`At`，@36271）对 timedOut/outputTruncated/意外 exitCode 抛错，错误消息带 `elapsed/killAt/cleanup/forceKill/orphaned` 明细。

**实际执行的 git 命令清单**（全部硬编码于 createGitCliRepo）：

| 用途 | 精确 args | 超时/上限 |
|---|---|---|
| 仓库解析 | `rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir` @50947 | 15s |
| 状态 | `status --porcelain=v2 --branch --untracked-files=all -z`（截断后降级 `--untracked-files=normal`）@48471 | 15s/512KB |
| staged 统计 | `diff --cached --numstat -z --find-renames --` | 15s/512KB |
| unstaged 统计 | `diff --numstat -z --find-renames --` | 15s/512KB |
| 分支对比 | `diff --numstat -z --find-renames <upstream>...HEAD --` | 15s/512KB |
| 单文件 diff | `diff [--cached] --no-ext-diff --no-color --binary [--find-renames] [<upstream>...HEAD] -- <path>` @58270 | 20s/1MB |
| untracked 兜底 | `diff --no-index --no-ext-diff --no-color --binary NUL\|/dev/null <abs>` | 20s/1MB |
| 提交图 | `log HEAD --branches --tags --remotes --date-order --topo-order --skip=N --max-count=N+1 --format=%H%x00%P%x00%an%x00%at%x00%s%x00%D%x1e` @54978 | 15s/512KB |
| 本地分支 | `for-each-ref refs/heads --format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(committerdate:unix)` | 15s/512KB |
| 身份 | `config --show-scope --show-origin --get user.name` / `user.email` | 15s |
| 推送远端解析 | `config --get branch.<b>.remote` / `remote.pushDefault`、`remote` | 15s |
| 切换/新建 | `switch --no-guess <b>`；`switch --no-guess -c <b> [-- <startPoint>]` | 15s/512KB |
| 分支名校验 | `check-ref-format --branch <b>` | 15s |
| 进行中操作检测 | `rev-parse --git-path MERGE_HEAD --git-path CHERRY_PICK_HEAD --git-path REVERT_HEAD --git-path REBASE_HEAD --git-path rebase-merge --git-path rebase-apply --git-path BISECT_LOG` + fs 存在性检查 | 15s |
| stage/unstage/discard | `add -- <paths>`；`restore --staged -- <paths>`；`restore [--source=HEAD] [--staged] --worktree -- <paths>` | 15s |
| commit（普通） | `commit -m <msg> [-- <paths>]` + `rev-parse HEAD` | 15s/512KB |
| push | `push` 或 `push --set-upstream <remote> <branch>` | 10min/8MB |
| 忽略检查 | `check-ignore -- <paths>`（exit 1 = 未忽略） | 15s/512KB |

**partial commit（stagedOnly 选定路径提交）**用临时索引实现（@git-core.beauty.js L1008-1065）：`mkdtemp("zcode-git-index-")` → 注入 `GIT_INDEX_FILE` → `read-tree <HEAD>|--empty` → `update-index --force-remove`（排他路径）→ 对 `ls-files --stage` 每条 `update-index --add --cacheinfo <mode> <hash> <path>` → `commit -m <msg>` → `reset --quiet HEAD -- <paths>` → finally `rm -rf` 临时目录。index 有冲突（stage≠0）时直接拒绝。

git-checkpoint 通道（"git-checkpoint"）同样走 CLI：`createGitCheckpointRepo`（host/index.js @81800-87800 区段）用 `git restore --source=<oid> --worktree`、`update-ref -d <refName>` 等，checkpoint 元数据 JSON 存 `~/.zcode/checkpoints/` 下。

## 3. summary / unstaged / staged / branchComparison 的计算

`getStatus`（createGitCliRepo 内）并行跑 status + 两个 numstat，然后纯 JS 解析：
- `parseStatusPorcelain`（@38366）：解析 `# branch.head/upstream/ab`（ahead/behind 正则 `\+(\d+)/-(\d+)`）、`?`（untracked）、`1`（普通）、`2`（rename，下一 NUL 段为 originalPath）、`u`（conflicted）。
- `parseNumstat`：`added\tremoved\tpath` NUL 分隔，rename 时取后两段。
- untracked 行数不调 git：直接 `readFile` 逐行计数（`buildUntrackedStats`），NUL 字节计 0。
- `kind` 推断：状态码 `A|?→added, D→deleted, R|C→renamed, 其他→modified`；numstat 场景 `added>0&&removed==0→added, removed>0&&added==0→deleted, 否则 modified`。

每项变更经 `buildFileChange`（@64896）成形并按工作区过滤（`isPathInWorkspaceScope`：workspacePath 是 repoRoot 子目录时只保留其下条目）。

`refresh`（host/index.js @69143）：
```js
async refresh(n){ let o=t.getStatus(n.workspacePath),
    r=n.includeIdentity?t.getIdentity(...):Promise.resolve(null),
    i=n.includeBranchComparison?t.getBranchComparison(...):Promise.resolve(null),
    [a,c,d]=await Promise.all([o,r,i]),
    l=d?{baseRef,headRef,comparisonLabel,changes:d.changes.map(u=>YJ(d,u)).filter(...)}:null;
  return { summary:a.summary, identity:c,
           unstagedChanges:cm(a,"unstaged"), stagedChanges:cm(a,"staged"),
           branchComparison:l } }
```
branchComparison 基线是 `trackingBranchName`（upstream），无 upstream 时 `changes:[]`。

**autoRefreshWatchPaths 推导**（`buildAutoRefreshWatchPaths` @43378）——由 rev-parse 的 4 元输出派生，最多 3 条：
```js
function _we(e){ let t=[];
  XT(t,e.workspacePath,!0), XT(t,e.absoluteGitDir,!0);
  let n=e.gitCommonDir?isAbs?...:resolve(repoRoot,gitCommonDir):e.absoluteGitDir;
  return XT(t,n,!0), t }
```
即：工作区目录、`.git` 绝对目录、common dir（worktree 场景），全部 `recursive:true`，交给 renderer 通过 fileWatcherService 建监听（§1 的 60s 防抖刷新闭环）。

**缓存**：resolveRepository/getWorkspaceRepositoryInfo/getStatus 各有 per-workspacePath Map 缓存 + in-flight 去重（`reuseInFlightRequest`）；所有写操作（stage/unstage/discard/commit/switch/push）后调用 `invalidate` 清缓存再重读。

## 4. 数据形状（跨 RPC 传给 renderer 的结构）

- **summary**：`{workspacePath, repoRoot, workspaceInRepoPath, autoRefreshWatchPaths, branchName|null, trackingBranchName|null, headRefType:"branch"|"detached", ahead, behind, isDirty, isGitAvailable, isRepository}`（非仓库时由 `createEmptySummary` 给全零版）。
- **变更条目**（unstaged/staged/branch 共用）：`{path(绝对), repoRelativePath, workspaceRelativePath, x, y, kind, section:"staged"|"unstaged"|"untracked"|"conflicted"|"branch", added, removed, isStaged, isUntracked, isConflicted}`。行数 `added/removed` 可能是 0（二进制/目录）；untracked 目录（`path` 以 `/` 结尾）仅当有行数时显示。
- **diff 结果**（getDiff，含 4 态）：`{path(绝对), availability:"patch"|"binary"|"truncated"|"unavailable", patch(原始 unified diff 文本, --binary), beforeContent|null, afterContent|null, summary(人话说明)}`。仅 `availability==="patch"` 时附加全文 `before/afterContent`（`withDiffContents`）：branch → `merge-base` blob vs HEAD blob；staged → HEAD blob vs index blob（`git show <commit>:<path>`，1MB 上限 + NUL 检测）；unstaged → index blob vs 工作区文件（fs 读取，>1MB→truncated）。二进制判定：输出含 `GIT binary patch`/`Binary files ` 或内容含 NUL。untracked 文件无 index 基线时本地合成 patch（`--- /dev/null +++ b/<path> @@ -0,0 +1,N @@`）。
- **commitGraph 提交**：`{hash, parents[], refs:[{name, kind:"head"|"branch"|"remote"|"tag"}], subject, authorName, authoredAtMs}`，`maxCount` 归一化 1..200（默认 100），`hasMore` 分页标志。
- **identity**：`{userName, userEmail, nameSource(config 路径), emailSource, scopeLabel}`，解析自 `scope\tsource\tvalue` 三段输出。
- **分支列表**：`{name, isCurrent, upstreamName, commitHash, commitTimestampMs}`，当前分支置顶、按提交时间降序。

## 5. 安全与性能

**安全**：
- 无 shell：仅 `spawn(git, argsArray)`，路径参数走 `normalizeInputPath` —— `relative(repoRoot, path)` 结果为空、`.`、`..` 或以 `../` 开头时抛 `Path is outside repository scope`（@git-core.beauty.js L57）。
- 环境 16 个 `GIT_*` 变量全部剥离（防 GIT_DIR/GIT_INDEX_FILE 劫持），`LC_ALL=C` 保证输出可解析。
- 命令面是硬编码闭集（上表），没有通用“命令 allowlist”机制——因为根本不接受任意命令。分支操作前强制 `check-ref-format` + `--no-guess` + 冲突/进行中操作预检；push 前显式解析 remote（多 remote 且未配置时报错而不是猜）。

**性能/大仓库**：
- 全命令 15s 超时（diff 20s、push 10min）+ 512KB/1MB 输出上限，超限主动 kill 并向 renderer 报 `truncated`/`unavailable` 语义状态而非挂死。
- 大仓库 untracked 优化：`--untracked-files=all` 输出超限时记住该 repoRoot（Set），永久降级 `normal` 并告警 `git status detailed output exceeded limit; collapsing untracked directories`。
- 提交图硬顶 200 条 + `hasMore`；commit message 生成仅取前 20 个文件、8 个 diff（每 diff 2KB、总量 12KB）、12 条会话上下文（每条 600 字符），maxOutputTokens=256，产出强制过 Conventional Commit 正则校验（`/^(feat|fix|docs|...)(\(...\))?!?: .{1,100}$/`）。
- 请求级 dedup + per-workspace 缓存，写后失效。

**残留风险**：untracked 行数统计对大文件全量读内存（仅受读取失败兜底，无大小上限，只有 getDiff 阶段才有 1MB cap）；60s 的 autoRefresh 防抖意味着 watch 触发后状态刷新最多延迟 1 分钟（设计取舍）；main 进程的 git 代理无任何独立鉴权——安全边界完全依赖 host 进程的通道白名单。

**关键文件**：
- `D:\software\zcode\resources\app\out\host\index.js`（git 全部执行层：@26897-69650，checkpoint @81800-87800，服务组装 @2169440/@2259589）
- `D:\software\zcode\resources\app\out\host\chunk-YSDGIE3M.js`（ServiceCollection/通道描述符 @58053-58399）
- `D:\software\zcode\resources\app\out\host\chunk-KGXW6KHC.js`（fromService/toService/ChannelServer @16593-17388）
- `D:\software\zcode\resources\app\out\host\chunk-EGJBTUMC.js`（通道名枚举 @498470）
- `D:\software\zcode\resources\app\out\main\index.js`（host 进程启动 @825669）
- `D:\software\zcode\resources\app\out\renderer\assets\styles-C2WGZ-SY.js`（GitAutoRefresh 闭环 @278007）