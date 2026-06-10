# Codex CLI 插件机制 — 源码级深度分析

> 基于 `openai/codex` 主分支实际源码逐文件分析  
> 调研日期：2026-06-10

---

## 目录

1. [核心类型层：`codex-rs/plugin/`](#1-核心类型层-codex-rsplugin)
2. [Manifest 解析：`core-plugins/src/manifest.rs`](#2-manifest-解析-core-pluginssrcmanifestrs)
3. [插件加载器：`core-plugins/src/loader.rs`](#3-插件加载器-core-pluginssrcloaderrs)
4. [插件 Store：`core-plugins/src/store.rs`](#4-插件-store-core-pluginssrcstorers)
5. [插件管理器：`core-plugins/src/manager.rs`](#5-插件管理器-core-pluginssrcmanagerrs)
6. [Marketplace 系统：`core-plugins/src/marketplace.rs`](#6-marketplace-系统-core-pluginssrcmarketplacers)
7. [Hooks 发现引擎：`hooks/src/engine/discovery.rs`](#7-hooks-发现引擎-hookssrcenginediscoveryrs)
8. [Hooks 运行引擎：`hooks/src/engine/mod.rs`](#8-hooks-运行引擎-hookssrcenginemodrs)
9. [插件注入模型上下文：`core/src/plugins/injection.rs`](#9-插件注入模型上下文-coresrcplugpsinjectionrs)
10. [CLI 命令：`cli/src/plugin_cmd.rs`](#10-cli-命令-clisrcplugincmdrs)
11. [关键设计模式总结](#11-关键设计模式总结)

---

## 1. 核心类型层：`codex-rs/plugin/`

### 1.1 PluginId — 双命名空间标识符

**文件：** `codex-rs/plugin/src/plugin_id.rs`

这是整个插件系统的基石类型。设计精妙之处在于用 `@` 分割双命名空间：

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginId {
    pub plugin_name: String,
    pub marketplace_name: String,
}

impl PluginId {
    pub fn new(plugin_name: String, marketplace_name: String) -> Result<Self, PluginIdError> {
        validate_plugin_segment(&plugin_name, "plugin name").map_err(PluginIdError::Invalid)?;
        validate_plugin_segment(&marketplace_name, "marketplace name")
            .map_err(PluginIdError::Invalid)?;
        Ok(Self { plugin_name, marketplace_name })
    }

    pub fn parse(plugin_key: &str) -> Result<Self, PluginIdError> {
        // 从最后一个 '@' 处分割（允许名字中包含 '@' 的边界情况）
        let Some((plugin_name, marketplace_name)) = plugin_key.rsplit_once('@') else {
            return Err(PluginIdError::Invalid(format!(
                "invalid plugin key `{plugin_key}`; expected <plugin>@<marketplace>"
            )));
        };
        if plugin_name.is_empty() || marketplace_name.is_empty() {
            return Err(PluginIdError::Invalid(format!(
                "invalid plugin key `{plugin_key}`; expected <plugin>@<marketplace>"
            )));
        }
        Self::new(plugin_name.to_string(), marketplace_name.to_string())
            .map_err(|err| match err {
                PluginIdError::Invalid(message) => {
                    PluginIdError::Invalid(format!("{message} in `{plugin_key}`"))
                }
            })
    }

    pub fn as_key(&self) -> String {
        format!("{}@{}", self.plugin_name, self.marketplace_name)
    }
}
```

**关键设计细节：**
- 使用 `rsplit_once('@')` 而非 `split_once` — 从**右侧**分割，防止插件名本身包含 `@`
- 验证函数 `validate_plugin_segment` 被两个字段复用，确保一致性
- 错误消息带有上下文（原始输入 key），便于调试

```rust
pub fn validate_plugin_segment(segment: &str, kind: &str) -> Result<(), String> {
    if segment.is_empty() {
        return Err(format!("invalid {kind}: must not be empty"));
    }
    if !segment.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') {
        return Err(format!(
            "invalid {kind}: only ASCII letters, digits, `_`, and `-` are allowed"
        ));
    }
    Ok(())
}
```

### 1.2 LoadedPlugin — 插件的运行时全量表示

**文件：** `codex-rs/plugin/src/load_outcome.rs`

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedPlugin<M> {
    pub config_name: String,              // "plugin-name@marketplace-name"
    pub manifest_name: Option<String>,    // interface.displayName or manifest.name
    pub manifest_description: Option<String>,
    pub root: AbsolutePathBuf,            // 磁盘绝对路径
    pub enabled: bool,                    // 用户配置的启用状态
    pub skill_roots: Vec<AbsolutePathBuf>, // 技能目录列表
    pub disabled_skill_paths: HashSet<AbsolutePathBuf>, // 被用户禁用的技能路径
    pub has_enabled_skills: bool,         // 是否有可用的技能
    pub mcp_servers: HashMap<String, M>,  // M = McpServerConfig（泛型）
    pub apps: Vec<AppConnectorId>,
    pub hook_sources: Vec<PluginHookSource>,
    pub hook_load_warnings: Vec<String>,
    pub error: Option<String>,            // 加载错误（如果有）
}
```

**泛型设计 `LoadedPlugin<M>`：**
- `M` 被具体化为 `McpServerConfig`（来自 `codex_config` crate）
- 这使得 `codex-plugin` crate 不需要依赖 `codex_config`，实现了解耦
- `PluginLoadOutcome<M>` 通过 `M: Clone` trait bound 实现合并操作

**活跃判断逻辑：**

```rust
impl<M> LoadedPlugin<M> {
    pub fn is_active(&self) -> bool {
        self.enabled && self.error.is_none()
    }
}
```

只有 `enabled = true` **且** 无加载错误的插件才被视为活跃，其能力才会被注入运行时。

### 1.3 PluginLoadOutcome — 多插件能力聚合

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct PluginLoadOutcome<M> {
    plugins: Vec<LoadedPlugin<M>>,
    capability_summaries: Vec<PluginCapabilitySummary>,
}
```

**能力去重合并策略：**

```rust
impl<M: Clone> PluginLoadOutcome<M> {
    pub fn effective_skill_roots(&self) -> Vec<AbsolutePathBuf> {
        let mut skill_roots: Vec<AbsolutePathBuf> = self
            .plugins
            .iter()
            .filter(|plugin| plugin.is_active())
            .flat_map(|plugin| plugin.skill_roots.iter().cloned())
            .collect();
        skill_roots.sort_unstable();
        skill_roots.dedup();  // 排序后去重
        skill_roots
    }

    pub fn effective_mcp_servers(&self) -> HashMap<String, M> {
        let mut mcp_servers = HashMap::new();
        for plugin in self.plugins.iter().filter(|plugin| plugin.is_active()) {
            for (name, config) in &plugin.mcp_servers {
                mcp_servers
                    .entry(name.clone())
                    .or_insert_with(|| config.clone());  // 先到先得
            }
        }
        mcp_servers
    }

    pub fn effective_apps(&self) -> Vec<AppConnectorId> {
        let mut apps = Vec::new();
        let mut seen_connector_ids = HashSet::new();
        for plugin in self.plugins.iter().filter(|plugin| plugin.is_active()) {
            for connector_id in &plugin.apps {
                if seen_connector_ids.insert(connector_id.clone()) {
                    apps.push(connector_id.clone());  // 只保留第一个
                }
            }
        }
        apps
    }
}
```

**关键设计决策：**
- Skill roots：排序 + `dedup()` — 同一路径只保留一份
- MCP servers：`entry().or_insert_with()` — **先注册者优先**，后注册同名 server 被忽略（带 warn 日志）
- Apps：`HashSet::insert` 返回 bool — 仅保留首次出现的 connector

---

## 2. Manifest 解析：`core-plugins/src/manifest.rs`

### 2.1 完整解析流程

```rust
pub fn load_plugin_manifest(plugin_root: &Path) -> Option<PluginManifest> {
    let manifest_path = find_plugin_manifest_path(plugin_root)?;  // 第一步：找文件
    let contents = fs::read_to_string(&manifest_path).ok()?;      // 第二步：读内容
    match serde_json::from_str::<RawPluginManifest>(&contents) {   // 第三步：JSON 解析
        Ok(manifest) => { /* 第四步：路径解析与验证 */ }
        Err(err) => {
            tracing::warn!(path = %manifest_path.display(), "failed to parse plugin manifest: {err}");
            None
        }
    }
}
```

### 2.2 路径安全解析 — 防目录穿越

这是安全层面的核心代码：

```rust
fn resolve_manifest_path(
    plugin_root: &Path,
    field: &'static str,
    path: Option<&str>,
) -> Option<AbsolutePathBuf> {
    let path = path?;
    if path.is_empty() { return None; }

    // 强制要求以 ./ 开头
    let Some(relative_path) = path.strip_prefix("./") else {
        tracing::warn!("ignoring {field}: path must start with `./` relative to plugin root");
        return None;
    };
    if relative_path.is_empty() {
        tracing::warn!("ignoring {field}: path must not be `./`");
        return None;
    }

    // 逐组件检查，禁止 ..
    let mut normalized = std::path::PathBuf::new();
    for component in Path::new(relative_path).components() {
        match component {
            Component::Normal(component) => normalized.push(component),
            Component::ParentDir => {
                tracing::warn!("ignoring {field}: path must not contain '..'");
                return None;
            }
            _ => {
                tracing::warn!("ignoring {field}: path must stay within the plugin root");
                return None;
            }
        }
    }

    AbsolutePathBuf::try_from(plugin_root.join(normalized)).ok()
}
```

**安全策略三层防护：**
1. `strip_prefix("./")` — 强制相对路径语法
2. `Component::ParentDir` 检查 — 禁止 `../` 穿越
3. `Component::Normal` 白名单 — 只接受普通路径组件
4. 最终用 `AbsolutePathBuf::try_from` 做绝对路径合法性校验

### 2.3 双重 Manifest 位置

```rust
const ALTERNATE_PLUGIN_MANIFEST_RELATIVE_PATH: &str = ".claude-plugin/plugin.json";
```

优先查找 `.codex-plugin/plugin.json`，回退到 `.claude-plugin/plugin.json`（兼容旧版/Claude 插件生态）。

### 2.4 Default Prompt 验证

```rust
const MAX_DEFAULT_PROMPT_COUNT: usize = 3;
const MAX_DEFAULT_PROMPT_LEN: usize = 128;
```

- 最多 3 个 prompt
- 每个 prompt 最长 128 字符
- 自动 trim + collapse whitespace
- 跳过非字符串类型（静默忽略）

---

## 3. 插件加载器：`core-plugins/src/loader.rs`

### 3.1 架构总览

Loader 是整个插件系统的**编排中枢**，实现了一个精巧的分层加载策略：

```
ConfigLayerStack (配置层)
        │
        ▼
configured_plugins_from_stack()  →  HashMap<String, PluginConfig>
        │
        ▼
merge_configured_plugins_with_remote_installed()  →  合并远程已安装插件
        │
        ▼
load_plugins_from_layer_stack_with_scope()
        │
        ├── scope = AllCapabilities  →  加载所有组件
        └── scope = HooksOnly        →  仅加载 Hooks
        │
        ▼  (对每个 plugin key 排序后迭代)
load_plugin()
        │
        ├── load_plugin_skills()     →  Skills
        ├── load_mcp_servers_from_file() → MCP Servers
        ├── load_plugin_apps()       →  Apps
        └── load_plugin_hooks()      →  Hooks
```

### 3.2 核心加载函数

```rust
async fn load_plugin(
    config_name: String,
    plugin: &PluginConfig,
    store: &PluginStore,
    scope: &PluginLoadScope<'_>,
) -> LoadedPlugin<McpServerConfig> {
    // 1. 解析 PluginId
    let plugin_id = PluginId::parse(&config_name);

    // 2. 从 Store 获取活跃版本路径
    let active_plugin_root = plugin_id.as_ref()
        .ok()
        .and_then(|plugin_id| store.active_plugin_root(plugin_id));

    // 3. 初始化空 LoadedPlugin
    let mut loaded_plugin = LoadedPlugin { /* ... all defaults ... */ };

    // 4. 如果禁用则提前返回
    if !plugin.enabled { return loaded_plugin; }

    // 5. 校验插件已安装
    let (loaded_plugin_id, plugin_root) = match plugin_id {
        Ok(plugin_id) => {
            let Some(plugin_root) = active_plugin_root else {
                loaded_plugin.error = Some("plugin is not installed".to_string());
                return loaded_plugin;
            };
            (plugin_id, plugin_root)
        }
        Err(err) => {
            loaded_plugin.error = Some(err.to_string());
            return loaded_plugin;
        }
    };

    // 6. 加载 Manifest
    let Some(manifest) = load_plugin_manifest(plugin_root.as_path()) else {
        loaded_plugin.error = Some("missing or invalid plugin.json".to_string());
        return loaded_plugin;
    };

    // 7. 按 Scope 加载能力
    match scope {
        PluginLoadScope::AllCapabilities { restriction_product, skill_config_rules } => {
            // 加载 Skills
            loaded_plugin.skill_roots = plugin_skill_roots(&plugin_root, &manifest.paths);
            let resolved_skills = load_plugin_skills(...).await;
            loaded_plugin.has_enabled_skills = resolved_skills.has_enabled_skills();
            loaded_plugin.disabled_skill_paths = resolved_skills.disabled_skill_paths;

            // 加载 MCP Servers（含策略覆盖）
            for mcp_config_path in plugin_mcp_config_paths(...) {
                let plugin_mcp = load_mcp_servers_from_file(...).await;
                for (name, mut config) in plugin_mcp.mcp_servers {
                    if let Some(policy) = plugin.mcp_servers.get(&name) {
                        apply_plugin_mcp_server_policy(&mut config, policy);
                    }
                    mcp_servers.insert(name.clone(), config);
                }
            }
            loaded_plugin.mcp_servers = mcp_servers;

            // 加载 Apps
            loaded_plugin.apps = load_plugin_apps(plugin_root.as_path()).await;
        }
        PluginLoadScope::HooksOnly => {}  // 跳过 Skills/MCP/Apps
    }

    // 8. Hooks 总是加载（无论 scope）
    let (hook_sources, hook_load_warnings) = load_plugin_hooks(
        &plugin_root, &loaded_plugin_id,
        &store.plugin_data_root(&loaded_plugin_id),
        &manifest.paths,
    );
    loaded_plugin.hook_sources = hook_sources;
    loaded_plugin.hook_load_warnings = hook_load_warnings;

    loaded_plugin
}
```

**关键模式：失败容忍**
- 每个组件加载失败都不阻塞其他组件
- 错误信息存储在 `LoadedPlugin.error` 中
- Hooks 加载警告单独收集，在启动时报告但不阻断

### 3.3 远程/本地插件合并策略

```rust
fn merge_configured_plugins_with_remote_installed(
    mut configured_plugins: HashMap<String, PluginConfig>,
    extra_plugins: HashMap<String, PluginConfig>,
    store: &PluginStore,
    prefer_remote_curated_conflicts: bool,
) -> HashMap<String, PluginConfig> {
    // 查找本地已安装的 curated 插件
    let local_curated_installed_plugin_keys = configured_plugins
        .keys()
        .filter_map(|plugin_key| {
            installed_plugin_name_for_marketplace(
                plugin_key, OPENAI_CURATED_MARKETPLACE_NAME, store,
            ).map(|plugin_name| (plugin_name, plugin_key.clone()))
        })
        .collect::<HashMap<_, _>>();

    for (plugin_key, plugin_config) in extra_plugins {
        // 检查远程 curated 插件是否与本地冲突
        let remote_curated_plugin_name = installed_plugin_name_for_marketplace(
            &plugin_key, REMOTE_GLOBAL_MARKETPLACE_NAME, store,
        );
        let local_curated_plugin_key = remote_curated_plugin_name
            .as_ref()
            .and_then(|plugin_name| local_curated_installed_plugin_keys.get(plugin_name));

        if let Some(local_curated_plugin_key) = local_curated_plugin_key {
            if prefer_remote_curated_conflicts {
                configured_plugins.remove(local_curated_plugin_key);  // 移除本地，保留远程
            } else {
                continue;  // 跳过远程，保留本地
            }
        }
        configured_plugins.insert(plugin_key, plugin_config);
    }
    configured_plugins
}
```

### 3.4 MCP Server 策略覆盖

```rust
fn apply_plugin_mcp_server_policy(
    config: &mut McpServerConfig,
    policy: &PluginMcpServerConfig,
) {
    config.enabled = policy.enabled;  // 用户可禁用插件 MCP server
    if let Some(approval_mode) = policy.default_tools_approval_mode {
        config.default_tools_approval_mode = Some(approval_mode);
    }
    if let Some(enabled_tools) = &policy.enabled_tools {
        config.enabled_tools = Some(enabled_tools.clone());  // allowlist
    }
    if let Some(disabled_tools) = &policy.disabled_tools {
        config.disabled_tools = Some(disabled_tools.clone());  // denylist（在 allowlist 之后应用）
    }
    for (tool_name, tool_policy) in &policy.tools {
        let tool_config = config.tools.entry(tool_name.clone()).or_default();
        if let Some(approval_mode) = tool_policy.approval_mode {
            tool_config.approval_mode = Some(approval_mode);  // 单 tool 覆盖
        }
    }
}
```

### 3.5 MCP Server 归一化

```rust
fn normalize_plugin_mcp_server_value(
    plugin_root: &Path,
    value: JsonValue,
) -> JsonMap<String, JsonValue> {
    let mut object = match value {
        JsonValue::Object(object) => object,
        _ => return JsonMap::new(),  // 非对象直接返回空
    };

    // 迁移 OAuth callbackPort（已被全局设置替代）
    if let Some(JsonValue::Object(mut oauth)) = object.remove("oauth") {
        if oauth.remove("callbackPort").is_some() {
            warn!(plugin = %plugin_root.display(),
                "plugin MCP server OAuth callbackPort is ignored");
        }
        // 字段名迁移：clientId → client_id
        if let Some(client_id) = oauth.remove("clientId") {
            oauth.entry("client_id".to_string()).or_insert(client_id);
        }
        if !oauth.is_empty() {
            object.insert("oauth".to_string(), JsonValue::Object(oauth));
        }
    }

    // 相对 cwd → 绝对路径（基于 plugin root）
    if let Some(JsonValue::String(cwd)) = object.get("cwd")
        && !Path::new(cwd).is_absolute()
    {
        object.insert("cwd".to_string(),
            JsonValue::String(plugin_root.join(cwd).display().to_string()));
    }

    object
}
```

### 3.6 Git 远程源材质化

```rust
pub fn materialize_marketplace_plugin_source(
    codex_home: &Path,
    source: &MarketplacePluginSource,
) -> Result<MaterializedMarketplacePluginSource, String> {
    match source {
        MarketplacePluginSource::Local { path } => {
            // 本地源直接返回，不需要 tempdir
            Ok(MaterializedMarketplacePluginSource { path: path.clone(), _tempdir: None })
        }
        MarketplacePluginSource::Git { url, path, ref_name, sha } => {
            // Git 源需要 clone 到临时目录
            let staging_root = codex_home.join("plugins/.marketplace-plugin-source-staging");
            let tempdir = tempfile::Builder::new()
                .prefix("marketplace-plugin-source-")
                .tempdir_in(&staging_root)?;

            clone_git_plugin_source(url, ref_name.as_deref(), sha.as_deref(),
                path.as_deref(), tempdir.path())?;

            let path = if let Some(path) = path {
                tempdir.path().join(path)  // sparse checkout 子目录
            } else {
                tempdir.path().to_path_buf()  // 整个仓库
            };

            Ok(MaterializedMarketplacePluginSource {
                path: AbsolutePathBuf::try_from(path)?,
                _tempdir: Some(tempdir),  // tempdir 生命周期绑定
            })
        }
    }
}

fn clone_git_plugin_source(
    url: &str, ref_name: Option<&str>, sha: Option<&str>,
    sparse_checkout_path: Option<&str>, destination: &Path,
) -> Result<(), String> {
    if let Some(sparse_path) = sparse_checkout_path {
        // Sparse checkout — 减少 clone 数据量
        run_git(&["clone", "--filter=blob:none", "--sparse", "--no-checkout", url, dest], None)?;
        run_git(&["sparse-checkout", "set", "--no-cone", "--", sparse_path], Some(dest))?;
    } else {
        run_git(&["clone", url, dest], None)?;
    }
    // 检出目标 ref/sha
    if let Some(target) = sha.or(ref_name) {
        run_git(&["checkout", target], Some(dest))?;
    }
    Ok(())
}

fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    let mut command = Command::new("git");
    command.args(args);
    command.env("GIT_TERMINAL_PROMPT", "0");  // 禁止交互式密码提示
    if let Some(cwd) = cwd { command.current_dir(cwd); }
    let output = command.output().map_err(|err| format!("failed to run git {}: {err}", args.join(" ")))?;
    if output.status.success() { return Ok(()); }
    Err(format!("git {} failed: stdout={} stderr={}",
        args.join(" "),
        String::from_utf8_lossy(&output.stdout).trim(),
        String::from_utf8_lossy(&output.stderr).trim(),
    ))
}
```

**Sparse Checkout 优化：** Git 源插件支持 `path` 子目录参数，只 clone 需要的子目录，大幅减少大仓库的 clone 时间。

---

## 4. 插件 Store：`core-plugins/src/store.rs`

### 4.1 磁盘布局

```rust
pub const DEFAULT_PLUGIN_VERSION: &str = "local";
pub const PLUGINS_CACHE_DIR: &str = "plugins/cache";
pub const PLUGINS_DATA_DIR: &str = "plugins/data";

// 最终路径：
// <codex-home>/plugins/cache/<marketplace>/<plugin>/<version>/
// <codex-home>/plugins/data/<plugin>-<marketplace>/
```

### 4.2 版本选择算法

```rust
pub fn active_plugin_version(&self, plugin_id: &PluginId) -> Option<String> {
    let mut discovered_versions = fs::read_dir(self.plugin_base_root(plugin_id).as_path())
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry.file_type().ok().filter(std::fs::FileType::is_dir)?;
            entry.file_name().into_string().ok()
        })
        .filter(|version| validate_plugin_version_segment(version).is_ok())
        .collect::<Vec<_>>();

    // Semver 排序
    discovered_versions.sort_unstable_by(|left, right| compare_plugin_versions(left, right));

    if discovered_versions.is_empty() {
        None
    } else if discovered_versions.iter().any(|v| v == DEFAULT_PLUGIN_VERSION) {
        // "local" 版本优先级最高
        Some(DEFAULT_PLUGIN_VERSION.to_string())
    } else {
        // 否则取 semver 最高的版本
        discovered_versions.pop()
    }
}

fn compare_plugin_versions(left: &str, right: &str) -> Ordering {
    match (Version::parse(left), Version::parse(right)) {
        (Ok(left), Ok(right)) => left.cmp(&right),
        // 非 semver 的版本（如 "local"）按字符串比较
        _ => left.cmp(right),
    }
}
```

**版本优先级：** `local` > 最新 semver > 字符串排序

### 4.3 原子安装 — 三段式提交

这是 Store 最精妙的部分，实现了**带回滚的原子安装**：

```rust
fn replace_plugin_root_atomically(
    source: &Path,
    target_root: &Path,
    plugin_version: &str,
) -> Result<(), PluginStoreError> {
    let staged_dir = tempfile::Builder::new()
        .prefix("plugin-install-")
        .tempdir_in(parent)?;           // 步骤1：创建临时 staging 目录
    let staged_root = staged_dir.path().join(plugin_dir_name);
    let staged_version_root = staged_root.join(plugin_version);
    copy_dir_recursive(source, &staged_version_root)?;  // 步骤2：复制到 staging

    let target_version_root = target_root.join(plugin_version);

    if target_root.exists() && !target_version_root.exists() {
        // 场景A：已有旧版本，新版本不同 → rename 新版本 + 清理旧版本
        fs::rename(&staged_version_root, &target_version_root)?;
        remove_old_plugin_versions(target_root, plugin_version)?;
        return Ok(());
    }

    if target_root.exists() {
        // 场景B：完全替换 → backup → rename → on failure, rollback
        let backup_dir = tempfile::Builder::new()
            .prefix("plugin-backup-")
            .tempdir_in(parent)?;
        fs::rename(target_root, &backup_root)?;  // 先备份

        match fs::rename(&staged_root, target_root) {
            Ok(()) => {}
            Err(err) => {
                // 失败时回滚
                let rollback_result = fs::rename(&backup_root, target_root);
                if rollback_result.is_err() {
                    // 回滚也失败 → 返回包含 backup 路径的错误
                    return Err(PluginStoreError::Invalid(format!(
                        "failed to activate at {}: {err}; \
                         backup left at {}",
                        target_root.display(),
                        backup_path
                    )));
                }
                return Err(PluginStoreError::io("failed to activate", err));
            }
        }
    } else {
        // 场景C：全新安装
        fs::rename(&staged_root, target_root)?;
    }
    Ok(())
}
```

**三种场景的原子性保证：**

| 场景 | 策略 |
|---|---|
| A：同根，新版本 | rename staging → target + 清理旧版本目录 |
| B：替换已存在 | backup → rename staged → on failure, rollback from backup |
| C：全新安装 | 直接 rename staging → target |

### 4.4 版本验证

```rust
pub fn validate_plugin_version_segment(plugin_version: &str) -> Result<(), String> {
    if plugin_version.is_empty() {
        return Err("invalid plugin version: must not be empty".to_string());
    }
    if matches!(plugin_version, "." | "..") {
        return Err("invalid plugin version: path traversal is not allowed".to_string());
    }
    if !plugin_version.chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '+')
    }) {
        return Err("invalid plugin version: only ASCII letters, digits, `.`, `+`, `_`, and `-` are allowed".to_string());
    }
    Ok(())
}
```

---

## 5. 插件管理器：`core-plugins/src/manager.rs`

`PluginsManager` 是系统的中央编排器，导入约 40 个子模块：

```rust
use crate::loader::{
    load_plugins_from_layer_stack, load_plugin_hooks_from_layer_stack,
    refresh_curated_plugin_cache, refresh_non_curated_plugin_cache,
    materialize_marketplace_plugin_source, /* ... */
};
use crate::store::PluginStore;
use crate::marketplace::{Marketplace, load_marketplace, list_marketplaces, /* ... */};
use crate::manifest::load_plugin_manifest;
```

它的核心职责：

| 职责 | 实现方式 |
|---|---|
| 加载插件 | `load_plugins_from_layer_stack()` → 配置层 → Store |
| 安装插件 | `install_plugin()` → 解析 source → materialize → store.install() |
| 卸载插件 | `uninstall_plugin()` → store.uninstall() + 清理配置 |
| 同步缓存 | 区分 curated 和非 curated 两条 refresh 路径 |
| 列出市场 | `list_marketplaces_for_config()` → 聚合所有配置的市场 |
| 策略执行 | 处理 `INSTALLED_BY_DEFAULT`、产品限制 |

---

## 6. Marketplace 系统：`core-plugins/src/marketplace.rs`

### 6.1 Manifest 位置发现

```rust
const MARKETPLACE_MANIFEST_RELATIVE_PATHS: &[&str] = &[
    ".agents/plugins/marketplace.json",    // 新标准位置
    ".claude-plugin/marketplace.json",     // 兼容位置
];

pub fn find_marketplace_manifest_path(root: &Path) -> Option<AbsolutePathBuf> {
    MARKETPLACE_MANIFEST_RELATIVE_PATHS.iter()
        .find_map(|relative_path| {
            let path = root.join(relative_path);
            if !path.is_file() { return None; }
            AbsolutePathBuf::try_from(path).ok()
        })
}
```

**发现顺序：**
1. Home 目录 (`$HOME/.agents/plugins/marketplace.json`)
2. 额外根目录（项目根等）
3. Git 仓库根目录（向上追溯）

### 6.2 插件来源类型

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarketplacePluginSource {
    Local { path: AbsolutePathBuf },
    Git {
        url: String,
        path: Option<String>,      // sparse checkout 子目录
        ref_name: Option<String>,  // branch/tag
        sha: Option<String>,       // 固定 commit
    },
}
```

**Git URL 归一化策略：**

```rust
fn normalize_git_plugin_source_url(
    marketplace_path: &AbsolutePathBuf,
    url: &str,
) -> Result<String, MarketplaceError> {
    let url = url.trim();
    if url.is_empty() { return Err(...); }

    if url.starts_with("http://") || url.starts_with("https://") {
        return Ok(normalize_github_git_url(url));  // GitHub URL 自动加 .git
    }
    if url.starts_with("./") || url.starts_with("../") {
        return normalize_relative_git_plugin_source_url(marketplace_path, url);  // 相对路径
    }
    if url.starts_with("file://") || url.starts_with('/') {
        return Ok(url.to_string());  // 本地绝对路径
    }
    if url.starts_with("ssh://") || (url.starts_with("git@") && url.contains(':')) {
        return Ok(url.to_string());  // SSH
    }
    if let Some(url) = normalize_github_shorthand_url(url) {
        return Ok(url);  // owner/repo → https://github.com/owner/repo.git
    }
    Err(...)
}

fn normalize_github_shorthand_url(source: &str) -> Option<String> {
    // 必须是 "owner/repo" 格式（恰好两段，不允许更多路径段）
    let mut segments = source.split('/');
    let owner = segments.next()?;
    let repo = segments.next()?.strip_suffix(".git").unwrap_or(segments.next()?);
    if repo.is_empty() { return None; }
    Some(format!("https://github.com/{owner}/{repo}.git"))
}
```

### 6.3 产品限制

```rust
pub fn find_installable_marketplace_plugin(
    marketplace_path: &AbsolutePathBuf,
    plugin_name: &str,
    restriction_product: Option<Product>,
) -> Result<ResolvedMarketplacePlugin, MarketplaceError> {
    let resolved = find_marketplace_plugin(marketplace_path, plugin_name)?;
    let product_allowed = match resolved.policy.products.as_deref() {
        None => true,                    // 无限制 → 允许
        Some([]) => false,               // 空列表 → 全部禁止
        Some(products) => restriction_product
            .is_some_and(|product| product.matches_product_restriction(products)),
    };
    if resolved.policy.installation == MarketplacePluginInstallPolicy::NotAvailable
        || !product_allowed
    {
        return Err(MarketplaceError::PluginNotAvailable { ... });
    }
    Ok(resolved)
}
```

---

## 7. Hooks 发现引擎：`hooks/src/engine/discovery.rs`

### 7.1 三层 Hook 来源

```rust
pub(crate) fn discover_handlers(
    config_layer_stack: Option<&ConfigLayerStack>,
    plugin_hook_sources: Vec<PluginHookSource>,
    plugin_hook_load_warnings: Vec<String>,
    bypass_hook_trust: bool,
) -> DiscoveryResult {
    // 第一层：Managed Requirements（企业策略强制注入）
    append_managed_requirement_handlers(&mut handlers, ..., config_layer_stack, ...);

    // 第二层：Config 层（System/User/Project/MDM 等）
    for layer in config_layer_stack.get_layers(LowestPrecedenceFirst, false) {
        let (hook_source, is_managed) = hook_metadata_for_config_layer_source(&layer.name);
        // 支持 JSON (hooks.json) 和 TOML (config.toml [hooks]) 两种格式
        let json_hooks = load_hooks_json(layer.hooks_config_folder().as_deref(), &mut warnings);
        let toml_hooks = load_toml_hooks_from_layer(layer, &mut warnings);
        append_hook_events(&mut handlers, ..., hook_events, policy);
    }

    // 第三层：插件 Hook（通过 PluginHookSource 传入）
    append_plugin_hook_sources(&mut handlers, ..., plugin_hook_sources, ...);
}
```

### 7.2 信任模型

这是 Hooks 安全架构的核心：

```rust
fn append_matcher_groups(..., source: &HookHandlerSource, ...) {
    for (group_index, group) in groups.into_iter().enumerate() {
        // 计算当前 hook 的 hash（用于检测是否被修改）
        let current_hash = command_hook_hash(event_name, matcher, &group, normalized_handler);

        // 信任状态判断
        let trust_status = hook_trust_status(source.is_managed, &current_hash, trusted_hash);

        // 注册 HookListEntry（用于展示/审计）
        hook_entries.push(HookListEntry {
            key, event_name, handler_type: HookHandlerType::Command,
            matcher, command: Some(command.clone()),
            source: source.source, is_managed: source.is_managed,
            current_hash, trust_status, enabled, ...
        });

        // 只有启用 + 可信的 handler 才被加入执行队列
        if enabled && (source.bypass_hook_trust
            || matches!(trust_status, HookTrustStatus::Managed | HookTrustStatus::Trusted))
        {
            handlers.push(ConfiguredHandler { ... });
        }
    }
}
```

**三级信任状态：**

```rust
fn hook_trust_status(
    is_managed: bool,
    current_hash: &str,
    trusted_hash: Option<&str>,
) -> HookTrustStatus {
    if is_managed {
        HookTrustStatus::Managed   // 企业策略管理的 hook → 自动信任
    } else {
        match trusted_hash {
            Some(h) if h == current_hash => HookTrustStatus::Trusted,   // 用户确认过
            Some(_) => HookTrustStatus::Modified,                        // 被修改过
            None => HookTrustStatus::Untrusted,                          // 未确认
        }
    }
}
```

**Hash 计算方式：** 将 event_name + matcher + group + handler 序列化为 TOML 再哈希，确保 JSON 和 TOML 两种格式的等效 hook 产生相同的 hash。

### 7.3 插件 Hook 的环境变量注入

```rust
fn append_plugin_hook_sources(..., source: PluginHookSource, ...) {
    let PluginHookSource {
        plugin_root, plugin_id, plugin_data_root,
        source_path, source_relative_path, hooks,
    } = source;

    let mut env = HashMap::new();
    env.insert("PLUGIN_ROOT".to_string(), plugin_root.display().to_string());
    env.insert("CLAUDE_PLUGIN_ROOT".to_string(), plugin_root.display().to_string());  // 兼容
    env.insert("PLUGIN_DATA".to_string(), plugin_data_root.display().to_string());
    env.insert("CLAUDE_PLUGIN_DATA".to_string(), plugin_data_root.display().to_string());  // 兼容

    // 将环境变量嵌入到 command 字符串中（${VAR} 替换）
    let command = source.env.iter().fold(command, |cmd, (key, value)| {
        cmd.replace(&format!("${{{key}}}"), value)
    });
}
```

### 7.4 来源层级与元数据

```rust
fn hook_metadata_for_config_layer_source(source: &ConfigLayerSource) -> (HookSource, bool) {
    match source {
        ConfigLayerSource::System { .. }         => (HookSource::System, true),
        ConfigLayerSource::User { .. }           => (HookSource::User, false),
        ConfigLayerSource::Project { .. }        => (HookSource::Project, false),
        ConfigLayerSource::Mdm { .. }            => (HookSource::Mdm, true),
        ConfigLayerSource::EnterpriseManaged {..}=> (HookSource::CloudManagedConfig, true),
        ConfigLayerSource::SessionFlags          => (HookSource::SessionFlags, false),
        // ... legacy variants
    }
}
```

`is_managed` 布尔值决定了 hook 是否自动信任（managed = true 的 hook 无条件信任）。

---

## 8. Hooks 运行引擎：`hooks/src/engine/mod.rs`

### 8.1 核心结构

```rust
#[derive(Clone)]
pub(crate) struct ClaudeHooksEngine {
    handlers: Vec<ConfiguredHandler>,     // 所有已注册的 hook handler
    warnings: Vec<String>,                 // 发现阶段的警告
    shell: CommandShell,                   // 命令执行器
    output_spiller: HookOutputSpiller,     // 大输出溢出到文件
}
```

### 8.2 按事件分发

每个生命周期事件都有独立的 `run_*` 方法，委托给 `crate::events::*` 子模块：

```rust
impl ClaudeHooksEngine {
    pub(crate) async fn run_pre_tool_use(&self, request: PreToolUseRequest) -> PreToolUseOutcome {
        crate::events::pre_tool_use::run(&self.handlers, &self.shell, request).await
    }

    pub(crate) async fn run_post_tool_use(&self, request: PostToolUseRequest) -> PostToolUseOutcome {
        let mut outcome = crate::events::post_tool_use::run(&self.handlers, &self.shell, request).await;
        outcome.feedback_message = self.maybe_spill_text(session_id, outcome.feedback_message).await;
        outcome
    }

    // 每个事件都有对应的 preview 方法（用于 dry-run）
    pub(crate) fn preview_pre_tool_use(&self, request: &PreToolUseRequest) -> Vec<HookRunSummary> {
        crate::events::pre_tool_use::preview(&self.handlers, request)
    }
}
```

### 8.3 Hook 输出契约

| 退出码 | stdout | stderr | 效果 |
|---|---|---|---|
| 0 | JSON `{ "permissionDecision": "deny" }` | - | **阻塞**工具执行 |
| 0 | JSON `{ "permissionDecision": "allow", "updatedInput": {...} }` | - | **放行**，可修改输入 |
| 2 | 任意 | 非空 | **阻塞**，stderr 作为阻塞原因 |
| 0 | 非 JSON | - | **忽略**（静默） |
| 非 0/2 | - | - | 忽略 |

### 8.4 输出溢出机制

```rust
async fn maybe_spill_texts(&self, session_id: ThreadId, texts: Vec<String>) -> Vec<String> {
    self.output_spiller.maybe_spill_texts(session_id, texts).await
}
```

当 Hook 输出过大时，自动溢出到临时文件，避免阻塞 Agent 上下文。

---

## 9. 插件注入模型上下文：`core/src/plugins/injection.rs`

### 9.1 @ 提及的处理流程

```rust
pub(crate) fn build_plugin_injections(
    mentioned_plugins: &[PluginCapabilitySummary],
    mcp_tools: &[ToolInfo],
    available_connectors: &[connectors::AppInfo],
) -> Vec<ResponseItem> {
    mentioned_plugins.iter().filter_map(|plugin| {
        // 1. 过滤属于该插件的 MCP tools（排除内置 apps server）
        let available_mcp_servers = mcp_tools.iter()
            .filter(|tool| {
                tool.server_name != CODEX_APPS_MCP_SERVER_NAME
                    && tool.plugin_display_names.iter().any(|n| n == &plugin.display_name)
            })
            .map(|tool| tool.server_name.clone())
            .collect::<BTreeSet<_>>()
            .into_iter().collect::<Vec<_>>();

        // 2. 过滤属于该插件的已启用 App connectors
        let available_apps = available_connectors.iter()
            .filter(|connector| {
                connector.is_enabled
                    && connector.plugin_display_names.iter().any(|n| n == &plugin.display_name)
            })
            .map(connector_display_label)
            .collect::<BTreeSet<_>>()
            .into_iter().collect::<Vec<_>>();

        // 3. 渲染注入指令
        render_explicit_plugin_instructions(plugin, &available_mcp_servers, &available_apps)
            .map(PluginInstructions::new)
            .map(ContextualUserFragment::into)
    }).collect()
}
```

**注入到模型的消息格式（概念）：**
```
Capabilities from the `<PluginName>` plugin:
- Skills from this plugin are prefixed with `PluginName:`.
- MCP servers from this plugin available in this session: `server1`, `server2`.
- Apps from this plugin available in this session: `github`.
Use these plugin-associated capabilities to help solve the task.
```

---

## 10. CLI 命令：`cli/src/plugin_cmd.rs`

### 10.1 命令结构

```rust
#[derive(Debug, Parser)]
#[command(bin_name = "codex plugin")]
pub struct PluginCli {
    pub config_overrides: CliConfigOverrides,
    #[command(subcommand)]
    pub subcommand: PluginSubcommand,
}

pub enum PluginSubcommand {
    Add(AddPluginArgs),
    List(ListPluginsArgs),
    Marketplace(MarketplaceCli),
    Remove(RemovePluginArgs),
}
```

### 10.2 插件选择解析

```rust
fn parse_plugin_selection(
    plugin: String,
    marketplace_name: Option<String>,
) -> Result<PluginSelection> {
    match (PluginId::parse(&plugin), marketplace_name) {
        // 情况1：PLUGIN@MARKETPLACE，无 --marketplace → 解析 key
        (Ok(plugin_id), None) => Ok(PluginSelection::from_plugin_id(plugin_id)),
        // 情况2：PLUGIN@MARKETPLACE，有 --marketplace → 验证一致性
        (Ok(plugin_id), Some(m)) if plugin_id.marketplace_name != m => bail!(
            "plugin id `{}` belongs to marketplace `{}`, but --marketplace specified `{}`",
            plugin, plugin_id.marketplace_name, m
        ),
        // 情况3：仅 PLUGIN，有 --marketplace → 组合
        (Err(_), Some(m)) => Ok(PluginSelection::from_plugin_id(PluginId::new(plugin, m)?)),
        // 情况4：仅 PLUGIN，无 --marketplace → 错误
        (Err(_), None) => bail!("plugin requires --marketplace unless passed as <plugin>@<marketplace>")
    }
}
```

### 10.3 add 命令流程

```rust
pub async fn run_plugin_add(overrides: Vec<...>, args: AddPluginArgs) -> Result<()> {
    let context = load_plugin_command_context(overrides).await?;  // 初始化 Manager
    let selection = parse_plugin_selection(args.plugin, args.marketplace_name)?;

    // 在市场目录中查找插件
    let marketplace = find_marketplace_for_plugin(
        &context.manager, &context.codex_home,
        &context.plugins_input, &selection.marketplace_name, &selection.plugin_name,
    )?;

    // 执行安装
    let outcome = context.manager
        .install_plugin(PluginInstallRequest {
            plugin_name: selection.plugin_name,
            marketplace_path: marketplace.path,
        })
        .await?;

    // 输出结果
    if args.json {
        println!("{}", serde_json::to_string_pretty(&JsonPluginAddOutput::from_outcome(outcome))?);
    } else {
        println!("Added plugin `{}` from marketplace `{}`.",
            outcome.plugin_id.plugin_name, outcome.plugin_id.marketplace_name);
        println!("Installed plugin root: {}", outcome.installed_path.display());
    }
    Ok(())
}
```

### 10.4 list 命令的双模式输出

```rust
pub async fn run_plugin_list(..., args: ListPluginsArgs) -> Result<()> {
    let outcome = manager.list_marketplaces_for_config(&plugins_input, &[])?;

    if args.json {
        // JSON 模式：结构化输出 installed/available 分离
        let output = JsonPluginListOutput::from_marketplaces(marketplaces, args.available, &sources);
        println!("{}", serde_json::to_string_pretty(&output)?);
    } else {
        // 表格模式：计算列宽，格式化输出
        for marketplace in marketplaces {
            println!("Marketplace `{}`", marketplace.name);
            println!("{}", marketplace.path.display());
            // PLUGIN  STATUS  VERSION  PATH
            for (plugin, status, version, path) in rows {
                println!("{plugin:<width$}  {status:<w$}  {version:<w$}  {path:<w$}");
            }
        }
    }
}
```

---

## 11. 关键设计模式总结

### 11.1 安全沙箱模式

```
plugin.json 路径
    → 必须以 ./ 开头
    → 禁止 ParentDir 组件
    → 只允许 Normal 组件
    → 最终转换为 AbsolutePathBuf（合法性校验）
    → 所有路径必须在 plugin_root 边界内
```

### 11.2 分层配置叠加

```
System (managed)  ─┐
User               ├─→ ConfigLayerStack (从低到高优先级)
Project            │
MDM / Enterprise   │
SessionFlags       ─┘
                    ↓
            effective_user_config()
                    ↓
            configured_plugins_from_stack()
```

### 11.3 Scope 模式（Hooks 轻量加载）

```
PluginLoadScope::AllCapabilities { ... }  →  完整加载（Skills + MCP + Apps + Hooks）
PluginLoadScope::HooksOnly                 →  仅加载 Hooks（不触发 Skills/MCP/Apps）
```

这允许 Hooks 引擎在启动时提前加载插件 hooks，而不必等待完整插件初始化。

### 11.4 原子操作 + 回滚

```
install:  tempdir(staging) → copy → rename staged→target
                                ↑ on failure → rollback from backup
uninstall:  remove_dir_all(base_root)
```

### 11.5 缓存刷新策略

| 类型 | 触发时机 | 策略 |
|---|---|---|
| Curated（OpenAI 精选） | 启动时 | 对比 SHA 前缀版本号，不同才重装 |
| Non-curated（用户/Git 市场） | 启动时 | 对比 manifest version，支持 ForceReinstall |
| Local 插件 | 修改后 | 用户手动 `codex plugin add` 重装 |

### 11.6 优雅降级

| 组件 | 加载失败行为 |
|---|---|
| Manifest 解析失败 | warn 日志，返回 `None`，整个插件标记 error |
| Skills 加载失败 | 记录错误，`has_enabled_skills = false` |
| MCP Server 解析失败 | warn 跳过该 server，其他 server 正常 |
| App 解析失败 | warn 跳过该 app |
| Hooks 加载失败 | 收集到 `hook_load_warnings`，其他 hooks 正常 |
| Git clone 失败 | 返回错误，插件标记 error |
| Marketplace 解析失败 | warn 跳过该 marketplace，其他正常 |

**核心原则：一个插件的组件失败不影响其他插件，一个插件的 hooks 失败不影响其他能力。**

---

## 附录：完整文件清单

| 文件路径 | 核心职责 |
|---|---|
| `codex-rs/plugin/src/plugin_id.rs` | 双命名空间 ID 解析与验证 |
| `codex-rs/plugin/src/load_outcome.rs` | LoadedPlugin / PluginLoadOutcome 类型 |
| `codex-rs/plugin/src/lib.rs` | 模块导出、PluginHookSource 等 |
| `codex-rs/core-plugins/src/manifest.rs` | plugin.json 解析 + 路径安全校验 |
| `codex-rs/core-plugins/src/loader.rs` | 插件全能力加载编排 |
| `codex-rs/core-plugins/src/store.rs` | 磁盘 Store + 原子安装 |
| `codex-rs/core-plugins/src/manager.rs` | PluginsManager 中央编排器 |
| `codex-rs/core-plugins/src/marketplace.rs` | Marketplace 解析 + 来源归一化 |
| `codex-rs/core-plugins/src/marketplace_upgrade.rs` | Git Marketplace 快照升级 |
| `codex-rs/core-plugins/src/remote.rs` | 远程插件状态 |
| `codex-rs/core-plugins/src/lib.rs` | 模块导出 |
| `codex-rs/hooks/src/engine/mod.rs` | ClaudeHooksEngine 核心引擎 |
| `codex-rs/hooks/src/engine/discovery.rs` | Hook 发现 + 信任模型 |
| `codex-rs/hooks/src/engine/command_runner.rs` | 外部命令执行 |
| `codex-rs/hooks/src/engine/output_parser.rs` | JSON 输出解析 |
| `codex-rs/hooks/src/engine/dispatcher.rs` | 事件分发器 |
| `codex-rs/hooks/src/events/` | 10 个事件的 per-type 请求/结果类型 |
| `codex-rs/core/src/plugins/injection.rs` | 插件能力注入模型上下文 |
| `codex-rs/cli/src/plugin_cmd.rs` | CLI plugin add/list/remove |
| `codex-rs/cli/src/marketplace_cmd.rs` | CLI marketplace add/list/upgrade/remove |
| `codex-rs/app-server/src/request_processors/plugins.rs` | App Server v2 API 处理器 |
| `codex-rs/utils/plugins/src/` | PluginSkillRoot、mention syntax 等 |
