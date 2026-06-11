# Alice Office 工具还原 — 汇总索引

> 从 `runtime-Biw3JkjY.js` 混淆代码中还原的 16 个 Office 相关工具定义与实现。
> 
> 还原时间: 2026-06-09

---

## 📋 工具清单

### 🔧 Core 工具 (6 个 — 始终可用)

| # | 工具名 | 文件 | 说明 | 实现模式 |
|---|--------|------|------|----------|
| 1 | `docx_create` | [docx_create.ts](docx_create.ts) | 使用 docx 库 JS 代码创建 Word 文档 | JS 代码注入执行 |
| 2 | `pptx_create` | [pptx_create.ts](pptx_create.ts) | 使用 PptxGenJS 库 JS 代码创建 PPT | JS 代码注入执行 |
| 3 | `xlsx_create` | [xlsx_create.ts](xlsx_create.ts) | 使用 Python (openpyxl) 创建 Excel | Python 临时文件执行 |
| 4 | `pdf_create` | [pdf_create.ts](pdf_create.ts) | 使用 Python (reportlab) 创建 PDF | Python 临时文件执行 |
| 5 | `office_unpack` | [office_unpack.ts](office_unpack.ts) | 解压 Office 文档为 XML 目录 | Python (unpack.py) |
| 6 | `office_pack` | [office_pack.ts](office_pack.ts) | 将 XML 目录打包回 Office 文档 | Python (pack.py) + 校验 |

### ⚡ Ondemand 工具 (10 个 — 按需加载)

| # | 工具名 | 文件 | 说明 | 实现模式 |
|---|--------|------|------|----------|
| 7 | `docx_comment` | [docx_comment.ts](docx_comment.ts) | 向 Word 文档添加批注 | Python (comment.py) |
| 8 | `pptx_add_slide` | [pptx_add_slide.ts](pptx_add_slide.ts) | 向 PPT 添加幻灯片 | Node.js XML 操作 |
| 9 | `xlsx_recalc` | [xlsx_recalc.ts](xlsx_recalc.ts) | 重新计算 Excel 公式 | Python (recalc.py) |
| 10 | `pdf_tools` | [pdf_tools.ts](pdf_tools.ts) | PDF 合并/拆分/旋转/水印/加密/提取图片 | Python (pypdf) 动态生成 |
| 11 | `office_validate` | [office_validate.ts](office_validate.ts) | 校验 Office 文档 XML 结构 | Python (validate.py) |
| 12 | `office_clean` | [office_clean.ts](office_clean.ts) | 清理文档中的孤立资源 ⚠️破坏性 | Python (clean.py) |
| 13 | `office_convert` | [office_convert.ts](office_convert.ts) | Office 格式转换 (LibreOffice) | LibreOffice headless |
| 14 | `office_extract_style` | [office_extract_style.ts](office_extract_style.ts) | 提取文档设计样式规范 | XML 解析 + YAML 输出 |
| 15 | `office_accept_changes` | [office_accept_changes.ts](office_accept_changes.ts) | 接受 Word 修订 (Tracked Changes) | Python (accept_changes.py) |
| 16 | `office_thumbnail` | [office_thumbnail.ts](office_thumbnail.ts) | 为 PPT 生成缩略图网格 | Python (thumbnail.py) |

---

## 🏗️ 技术架构

```
实现模式:
┌─────────────────────────────────────────────────────────┐
│ JS 代码注入执行 (docx_create, pptx_create)               │
│   new Function("async ()=>{ ... }")()  → 直接生成文件     │
├─────────────────────────────────────────────────────────┤
│ Python 临时文件执行 (xlsx_create, pdf_create, pdf_tools)  │
│   写 .py → execFile("python3") → 检查输出 → 清理临时文件   │
├─────────────────────────────────────────────────────────┤
│ Python 脚本调用 (recalc, clean, validate, thumbnail...)   │
│   execFile("python3.11", [script.py, ...args])           │
├─────────────────────────────────────────────────────────┤
│ Node.js XML 操作 (office_unpack, office_pack,             │
│   pptx_add_slide, office_extract_style)                   │
│   readFile/writeFile 操作 Office Open XML 结构             │
├─────────────────────────────────────────────────────────┤
│ LibreOffice headless (office_convert)                     │
│   execFile(soffice, ["--headless", "--convert-to", ...])  │
└─────────────────────────────────────────────────────────┘
```

## 🔗 依赖关系

```
Python 脚本位置: office-scripts/
├── office/
│   ├── unpack.py      ← office_unpack
│   ├── pack.py        ← office_pack
│   └── validate.py    ← office_validate
├── clean.py           ← office_clean
├── comment.py         ← docx_comment
├── thumbnail.py       ← office_thumbnail
├── accept_changes.py  ← office_accept_changes
└── recalc.py          ← xlsx_recalc

npm 依赖:
├── docx (^9.6.1)      ← docx_create
├── pptxgenjs (^4.0.1) ← pptx_create
├── xlsx (^0.18.5)     ← (读取 Excel 用，非工具直接依赖)
└── mammoth (^1.12.0)  ← (Word → HTML 转换，非工具直接依赖)

Python 库:
├── openpyxl           ← xlsx_create
├── reportlab          ← pdf_create
└── pypdf              ← pdf_tools

外部工具:
└── LibreOffice        ← office_convert (可选)
```

## ⚠️ 还原限制说明

以下内容因混淆程度较高，**未能完全精确还原**，标注了已知差异：

| 工具 | 限制 | 说明 |
|------|------|------|
| `office_unpack` | 解压逻辑 | 核心解压调用 Python `unpack.py`，JS 端只做格式检测和文件计数，Python 脚本本身未包含在 JS bundle 中 |
| `office_validate` | 校验规则 | 校验逻辑完全在 `validate.py` 中，JS 端仅解析 JSON 结果并格式化输出 |
| `office_clean` | 清理规则 | 同上，清理逻辑在 `clean.py` 中，JS 端解析 "Removed" 输出段 |
| `office_extract_style` | 部分辅助函数 | `Ad()` (extractColors)、`Td()` (extractFonts)、`vd()` (extractLayouts) 的完整 XML 正则实现基于推断还原，可能有遗漏的匹配模式 |
| `office_convert` | Windows 路径 | 原始代码只列出了 macOS/Linux 的 LibreOffice 路径，Windows 路径可能通过 `which` 回退或环境变量 |
| `pdf_tools` | Python 代码生成 | 6 种操作的 Python 代码是模板化生成的，原始代码中 `var i` 的作用域推断可能有微小差异 |
| 所有 Python 脚本 | 不可还原 | `unpack.py`、`pack.py`、`validate.py`、`clean.py`、`comment.py`、`thumbnail.py`、`accept_changes.py`、`recalc.py` 这些 Python 脚本不包含在 JS bundle 中，无法还原其内部实现 |
