# Alice Office Python 脚本分析报告

## 🔍 结论

**8 个 Python 脚本在当前安装中不存在于磁盘上，也不在 app.asar 包中。**

它们是 Alice 源码构建流程中的产物，应在 Vite 构建时从源码目录复制到 `out/main/office-scripts/`，但当前 `app/` 目录中缺失这些文件。

---

## 📂 脚本路径解析

### 路径构建逻辑

```javascript
// 所有路径都基于当前模块的 __dirname
const __dirname = fileURLToPath(import.meta.url);
// __dirname = D:\software\Alice\resources\app\out\main\chunks

// 然后通过 path.join 向上一级找 office-scripts
const officeScripts = path.join(__dirname, "..", "office-scripts");
// 解析为: D:\software\Alice\resources\app\out\main\office-scripts
```

### 8 个脚本的完整路径

| 脚本 | 变量 | 解析路径 |
|------|------|----------|
| `unpack.py` | `Jp` | `out/main/office-scripts/office/unpack.py` |
| `validate.py` | `sd` | `out/main/office-scripts/office/validate.py` |
| `pack.py` | `ld` | `out/main/office-scripts/office/pack.py` |
| `clean.py` | `hd` | `out/main/office-scripts/clean.py` |
| `comment.py` | `bd` | `out/main/office-scripts/comment.py` |
| `thumbnail.py` | `Md` | `out/main/office-scripts/thumbnail.py` |
| `accept_changes.py` | `Pd` | `out/main/office-scripts/accept_changes.py` |
| `recalc.py` | `Qd` | `out/main/office-scripts/recalc.py` |

### 目录结构（应有但缺失）

```
out/main/office-scripts/          ← 不存在！
├── office/                        ← 不存在！
│   ├── unpack.py                  ← office_unpack 使用
│   ├── validate.py                ← office_validate 使用
│   └── pack.py                    ← office_pack 使用
├── clean.py                       ← office_clean 使用
├── comment.py                     ← docx_comment 使用
├── thumbnail.py                   ← office_thumbnail 使用
├── accept_changes.py              ← office_accept_changes 使用
└── recalc.py                      ← xlsx_recalc 使用
```

---

## 🔬 调查过程

### 排除的位置

| 位置 | 结果 |
|------|------|
| `D:\software\Alice\resources\app\out\main\office-scripts\` | ❌ 目录不存在 |
| `app.asar` 内部 | ❌ 无任何 office-scripts 或 .py 文件 |
| `app.asar.unpacked\out\` 内部 | ❌ 只有 renderer 资源（图标/插画） |
| `C:\Users\KSO\AppData\Roaming\alice\` (userData) | ❌ 无 office-scripts 目录 |
| `C:\Users\KSO\AppData\Roaming\alice\python\` | ✅ 内嵌 Python 3.11.15 运行时存在 |
| JS bundle 中内嵌的 Python 代码字符串 | ❌ 未找到任何 Python 代码特征 |
| 运行时动态生成逻辑 | ❌ 未找到任何 writeFile + .py 的代码 |

### 关键发现

1. **app/ 目录覆盖了 app.asar**：Electron 优先加载 `app/` 目录，`app.asar` 中只包含 `node_modules`
2. **Python 运行时存在**：`C:\Users\KSO\AppData\Roaming\alice\python\python.exe` 是完整的 Python 3.11.15 嵌入式环境
3. **Python 下载机制**：`python-downloader` chunk 负责从 GitHub 自动下载和安装 Python
4. **8 个脚本仅在 runtime chunk 中被引用**，且仅通过 `execFile("python3.11", [scriptPath, ...args])` 调用

---

## 🧠 推断：这些脚本是怎么产生的

### 构建流程推断

```
Alice 源码仓库
├── src/
│   └── scripts/
│       └── office-scripts/        ← Python 脚本源码在这里
│           ├── office/
│           │   ├── unpack.py
│           │   ├── validate.py
│           │   └── pack.py
│           ├── clean.py
│           ├── comment.py
│           ├── thumbnail.py
│           ├── accept_changes.py
│           └── recalc.py
├── vite.config.ts                  ← 配置了 vite-plugin-static-copy
│                                    或类似的 copy 插件
└── package.json

                    ↓ Vite Build ↓

out/main/
├── chunks/
│   └── runtime-Biw3JkjY.js        ← JS 中引用 ../office-scripts/
└── office-scripts/                 ← 从 src/scripts/ 复制而来
    └── (8个 .py 文件)
```

### 为什么当前缺失？

可能的原因（按可能性排序）：

1. **Vite 构建配置不完整**：`app/` 目录可能是通过非标准方式生成（如手动解压、部分更新），缺少 copy 插件的输出
2. **平台差异**：这些 .py 脚本可能只在 macOS/Linux 构建中包含，Windows 构建使用了不同的策略
3. **版本回滚**：`app/` 目录是 6月9日 刚生成的，可能是一次不完整的更新
4. **开发模式**：`app/` 目录存在时 Electron 跳过 asar，开发者模式下脚本可能通过其他路径加载

### 运行时行为推断

当 Alice 运行且 office-tools 被调用时：
- 如果 `office-scripts/` 存在 → 正常执行 Python 脚本
- 如果 `office-scripts/` 不存在 → `execFile` 会抛出错误，被 JS 层的 try/catch 捕获，返回 `type: "error"` 错误信息

---

## 📊 依赖的 Python 库（推断）

基于脚本功能推断各 .py 脚本需要的 Python 库：

| 脚本 | 功能 | 可能的依赖 |
|------|------|-----------|
| `unpack.py` | 解压 Office 文档 | `zipfile` (stdlib), `shutil` (stdlib) |
| `pack.py` | 打包 Office 文档 | `zipfile` (stdlib), `shutil` (stdlib) |
| `validate.py` | XML 校验 | `lxml`, `xmlschema` |
| `clean.py` | 清理孤立资源 | `zipfile`, `os` (stdlib) |
| `comment.py` | 添加批注 | `lxml` |
| `thumbnail.py` | 生成缩略图 | `Pillow` (PIL), `python-pptx` |
| `accept_changes.py` | 接受修订 | `lxml` |
| `recalc.py` | 重算 Excel 公式 | `openpyxl` |

### Python 运行时已安装的库

检查 `C:\Users\KSO\AppData\Roaming\alice\python\Lib\site-packages\` 可确认实际安装的第三方库。
