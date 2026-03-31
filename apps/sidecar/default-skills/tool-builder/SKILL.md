---
name: tool-builder
description: "交互式创建自定义 HTTP API 工具，让助手在 Chat 模式中调用外部 API。当用户说'帮我创建/添加一个工具'、'我想接入 XX API'、'帮我做个能查 XX 的工具'时触发。适用于所有需要通过 HTTP API 集成外部服务到 Chat 工具系统的场景。"
---

# Tool Builder — 自定义 HTTP 工具创建器

通过对话引导用户创建自定义 HTTP API 工具，创建后的工具可在 Chat 模式中直接调用。

## 工具配置结构

工具配置写入 `~/.lume/chat-tools.json` 的 `customTools` 数组。每个工具的结构：

```json
{
  "id": "tool_unique_id",
  "name": "工具显示名",
  "description": "工具描述（LLM 用此判断何时调用）",
  "icon": "Wrench",
  "category": "custom",
  "executorType": "http",
  "params": [
    {
      "name": "paramName",
      "type": "string",
      "description": "参数说明",
      "required": true
    }
  ],
  "httpConfig": {
    "method": "GET",
    "urlTemplate": "https://api.example.com/v1/{{paramName}}",
    "headers": {
      "Authorization": "Bearer {{credential:api_key}}"
    },
    "bodyTemplate": "{\"key\": \"{{paramName}}\"}",
    "resultPath": "data.results"
  }
}
```

**字段说明：**
- `id`: 小写字母+数字+下划线，2-64 字符，如 `weather_query`
- `params[].type`: `"string"` | `"number"` | `"boolean"`
- `httpConfig.urlTemplate`: 支持 `{{paramName}}` 参数插值
- `httpConfig.headers`: 支持 `{{credential:keyName}}` 引用凭据
- `httpConfig.bodyTemplate`: POST 请求的 JSON 字符串模板
- `httpConfig.resultPath`: 可选，从响应 JSON 中提取结果的路径（如 `data.items[0].content`）

## 创建流程

### 第 1 步：需求收集

通过 AskUserQuestion 逐步引导，收集以下信息（一次问 1-2 个问题）：

1. **工具用途**：一句话描述想做什么
2. **API 信息**：端点 URL、HTTP 方法、参数格式
3. **认证方式**：API Key / Bearer Token / 无认证
4. **输入参数**：用户需要提供什么参数
5. **输出期望**：需要从响应中提取什么信息

如果用户不确定 API 细节，可用 web_search 帮助查找公开 API 文档。

### 第 2 步：生成配置

根据收集的信息生成完整的工具配置 JSON。向用户展示配置预览，确认无误后继续。

关键决策点：
- GET vs POST：查询类用 GET，提交类用 POST
- `resultPath`：分析 API 响应结构，选择最有价值的数据路径
- `description`：写清楚工具的使用场景，LLM 靠这个判断何时调用

### 第 3 步：写入配置

读取当前 `~/.lume/chat-tools.json`，将新工具追加到 `customTools` 数组，写回文件。

**注意事项：**
- 先读取再写入，不要覆盖已有的工具配置
- 如果文件不存在，创建包含默认结构的新文件：`{"version": 1, "toolStates": {}, "toolCredentials": {}, "customTools": []}`
- 新工具的 id 不能与已有工具重复

### 第 4 步：凭据配置

如果工具需要 API Key 或其他凭据：
1. 引导用户获取凭据（提供 API 官网链接）
2. 将凭据写入 `toolCredentials[toolId]` 对象中
3. 凭据 key 名称需与 `httpConfig.headers` 中的 `{{credential:keyName}}` 匹配

### 第 5 步：测试验证

告知用户工具已创建完成，建议在 Chat 模式中测试：
1. 打开 Chat 对话
2. 在工具列表中找到并启用新工具
3. 发送一个测试请求验证工具正常工作

如果测试发现问题，帮助用户调试并修改配置。

## 常见 API 模式

### 带 API Key 的 GET 请求
```json
{
  "method": "GET",
  "urlTemplate": "https://api.example.com/data?q={{query}}&appid={{credential:api_key}}",
  "resultPath": "results"
}
```

### Bearer Token + POST 请求
```json
{
  "method": "POST",
  "urlTemplate": "https://api.example.com/v1/completions",
  "headers": {
    "Authorization": "Bearer {{credential:token}}",
    "Content-Type": "application/json"
  },
  "bodyTemplate": "{\"prompt\": \"{{prompt}}\", \"max_tokens\": 100}",
  "resultPath": "choices[0].text"
}
```

### 无认证的公开 API
```json
{
  "method": "GET",
  "urlTemplate": "https://api.publicapis.org/entries?title={{keyword}}",
  "resultPath": "entries"
}
```
