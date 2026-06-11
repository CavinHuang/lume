# Alice Office 工具还原 — 原始对比核查报告

## 📊 差异总表

### ✅ 完全正确的工具 (10/16)

| 工具 | 元数据 | Schema | 逻辑 |
|------|--------|--------|------|
| `docx_create` | ✅ | ✅ | ✅ |
| `pptx_create` | ✅ | ✅ | ✅ |
| `pptx_add_slide` | ✅ | ✅ | ✅ |
| `xlsx_recalc` | ✅ | ✅ | ✅ |
| `office_unpack` | ✅ | ✅ | ✅ |
| `office_clean` | ✅ | ✅ | ✅ |
| `office_convert` | ✅ | ✅ | ✅ |
| `office_validate` | ✅ | ✅ | ✅ |
| `office_extract_style` | ✅ | ✅ | ✅ |
| `office_thumbnail` | ✅ | ✅ | ✅ |

### ⚠️ 有差异的工具 (6/16)

---

#### 1. `docx_comment` — 缺少 `description` 顺序

**原始**: `briefDescription` 在 `description` 前面
```
briefDescription: de("TOOL_DOCX_COMMENT_BRIEF"),
description: de("TOOL_DOCX_COMMENT_DESC"),
```
**还原**: `description` 在 `briefDescription` 前面
```
description: "TOOL_DOCX_COMMENT_DESC",
briefDescription: "TOOL_DOCX_COMMENT_BRIEF",
```
**影响**: 🔵 字段顺序不影响功能，Zod/JS 不关心对象属性顺序

---

#### 2. `xlsx_create` — 缺少 `briefDescription` 字段

**原始**: 有 `briefDescription` 字段（值为 `TOOL_XLSX_RECALC_BRIEF`，疑似原始代码的 bug）
**还原**: 未包含 `briefDescription`
**影响**: 🟡 缺一个字段。不过原始值引用了错误的 i18n key，可能是 bug

---

#### 3. `pdf_create` — 缺少 `briefDescription` 字段

**原始**: 有 `briefDescription: TOOL_PDF_TOOLS_BRIEF`（引用了 pdf_tools 的 key，疑似 bug）
**还原**: 未包含 `briefDescription`
**影响**: 🟡 缺一个字段。但原始值也引用了错误的 key

---

#### 4. `office_pack` — 字段全部正确但字段顺序不同

**原始**: 没有 `systemHint`，没有 `briefDescription`
**还原**: 正确，没有多余字段 ✅

---

#### 5. `pdf_tools` — `rotation` 字段描述引用 key 不同

**原始**: `rotation: Q.number().optional().describe(de("TOOL_PDF_TOOLS_PARAM_TH"))`
**还原**: `.describe("TOOL_PDF_TOOLS_PARAM_TH")`
**影响**: 🔵 实际 i18n key 是 `TOOL_PDF_TOOLS_PARAM_TH`（不是直觉的 ROTATION），已正确保留

---

#### 6. `office_accept_changes` — 缺少 `systemHint` 字段

**原始**: 有 `systemHint: pe("TOOL_XLSX_CREATE_HINT")`（引用了 xlsx_create 的 hint，疑似 bug）
**还原**: 未包含 `systemHint`
**影响**: 🟡 缺一个字段。但原始值引用了错误的 key，很可能是 copy-paste 错误

---

## 🔴 原始代码中的疑似 Bug

对比过程中发现 Alice 原始代码存在 3 处可能的 copy-paste 错误：

| 工具 | 字段 | 实际值 | 应该是 |
|------|------|--------|--------|
| `xlsx_create` | `briefDescription` | `TOOL_XLSX_RECALC_BRIEF` | 应为 `TOOL_XLSX_CREATE_BRIEF` |
| `pdf_create` | `briefDescription` | `TOOL_PDF_TOOLS_BRIEF` | 应为 `TOOL_PDF_CREATE_BRIEF` |
| `office_accept_changes` | `systemHint` | `TOOL_XLSX_CREATE_HINT` | 应无 systemHint 或有自己的 |

---

## 📋 完整字段对照表

| 工具 | systemHint | briefDescription | tier | maxResult | isReadOnly | isDestructive | isConcurrentSafe |
|------|:----------:|:----------------:|:----:|:---------:|:----------:|:-------------:|:----------------:|
| docx_create | ✅ | ✅ | core | 5000 | false | false | false |
| docx_comment | ❌ | ✅ | ondemand | 5000 | false | false | false |
| pptx_create | ✅ | ✅ | core | 5000 | false | false | false |
| pptx_add_slide | ❌ | ✅ | ondemand | 5000 | false | false | false |
| xlsx_create | ✅ | ⚠️bug | core | 10000 | false | false | false |
| xlsx_recalc | ❌ | ✅ | ondemand | 10000 | false | false | true |
| pdf_create | ❌ | ⚠️bug | core | 5000 | false | false | false |
| pdf_tools | ❌ | ✅ | ondemand | 10000 | false | false | true |
| office_unpack | ✅ | ❌ | core | 10000 | false | false | false |
| office_pack | ❌ | ❌ | core | 10000 | false | false | false |
| office_validate | ❌ | ✅ | ondemand | 20000 | false | false | true |
| office_clean | ❌ | ✅ | ondemand | 10000 | false | **true** | false |
| office_convert | ❌ | ✅ | ondemand | 5000 | false | false | true |
| office_extract_style | ❌ | ✅ | ondemand | 30000 | false | false | true |
| office_accept_changes | ⚠️bug | ✅ | ondemand | 5000 | false | false | true |
| office_thumbnail | ❌ | ✅ | ondemand | 5000 | **true** | false | true |

## 🔧 需要修正的还原文件

### 1. `xlsx_create.ts` — 补充 briefDescription
```typescript
// 应添加（即使原始值看起来是 bug）
briefDescription: "TOOL_XLSX_CREATE_BRIEF",
```

### 2. `pdf_create.ts` — 补充 briefDescription
```typescript
// 应添加
briefDescription: "TOOL_PDF_CREATE_BRIEF",
```

### 3. `office_accept_changes.ts` — 补充 systemHint
```typescript
// 原始引用了错误的 key，正确做法可能是去掉，或保留原样
systemHint: "TOOL_XLSX_CREATE_HINT",  // 原始代码如此
```
