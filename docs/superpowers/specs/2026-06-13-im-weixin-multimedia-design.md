# IM Weixin Multimedia Messages

Date: 2026-06-13
Status: Approved for implementation planning
Scope: Full multimedia support for the Weixin IM channel — inbound parsing and outbound sending of images, voice, files, and videos

## Summary

Extend the existing Weixin IM integration (Phase 1: text only) to support all multimedia message types. Inbound images, voice messages, files, and videos will be parsed from OpenClaw's `item_list` protocol and delivered to the Lume agent as structured content items. Outbound media sending will follow the official OpenClaw CDN upload flow: AES-128-ECB encrypt → `getuploadurl` → CDN upload → `sendmessage` with media items.

The design uses a Content Items pattern (`ImMessageContent` union type) that maps naturally to OpenClaw's `item_list` structure, keeping the existing text path fully backward-compatible while enabling clean extension to new media types.

## References

- Phase 1 design: `docs/superpowers/specs/2026-05-24-im-weixin-integration-design.md`
- Tencent OpenClaw Weixin types: `https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts`
- Tencent OpenClaw Weixin send: `https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/send.ts`
- Tencent OpenClaw Weixin CDN upload: `https://github.com/Tencent/openclaw-weixin/blob/main/src/cdn/upload.ts`
- Agent message attachments design: `docs/superpowers/specs/2026-05-18-agent-message-attachments-design.md`

## Goals

- Parse all inbound OpenClaw `item_list` types (image, voice, file, video) into structured `ImMessageContent` items.
- Deliver inbound images as multimodal input to the agent (model vision), voice via `text` field (speech-to-text), files and videos as metadata descriptions.
- Send outbound images, files, and videos through the OpenClaw CDN upload pipeline with AES-128-ECB encryption.
- Extend the existing `send_im_message` tool to support `image_url` and `file_path` parameters alongside text.
- Keep the existing text-only path fully backward-compatible — no changes to pure-text behavior.
- Implement CDN encryption natively in sidecar using `node:crypto` (no external dependencies).

## Non-Goals

- Do not support outbound voice messages (inbound voice text is sufficient for now).
- Do not implement thumbnail upload (`no_need_thumb: true`) to keep the upload flow simple.
- Do not add `sendtyping` or `getconfig` endpoints (those are separate Phase 2 items).
- Do not change the `ImProvider` type or add new providers.
- Do not implement media caching/persistence beyond the current session.

## Chosen Approach: Content Items Pattern

Introduce an `ImMessageContent` discriminated union type that maps to OpenClaw's `item_list` entries. Messages carry a `contents: ImMessageContent[]` array alongside the existing `text: string` field (which becomes a convenience accessor for the first text content item).

### Why not inline extension (Approach A)?

Adding optional media fields directly to existing message types leads to type bloat and requires `if/else` branching at every consumer. It also doesn't match OpenClaw's multi-item `item_list` model.

### Why not dual pipeline (Approach C)?

Maintaining two parallel message processing pipelines creates code duplication and makes it harder to handle messages that contain both text and media items. A single unified pipeline with structured content items is simpler and more correct.

## Type System

### ImMessageContent Union

Located in `packages/shared/src/types/im.ts`:

```ts
export type ImMessageContent =
  | ImTextContent
  | ImImageContent
  | ImVoiceContent
  | ImFileContent
  | ImVideoContent;

export interface ImTextContent {
  type: "text";
  text: string;
}

export interface ImImageContent {
  type: "image";
  /** Directly accessible image URL (downloaded/decrypted from CDN or direct link) */
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

export interface ImVoiceContent {
  type: "voice";
  /** Speech-to-text result from WeChat */
  text?: string;
  /** Duration in milliseconds */
  playtime?: number;
}

export interface ImFileContent {
  type: "file";
  fileName: string;
  fileSize: number;
  md5?: string;
  downloadUrl?: string;
}

export interface ImVideoContent {
  type: "video";
  thumbnailUrl?: string;
  playLength?: number;
  fileSize?: number;
}
```

### Modified Types

**`OpenClawWeixinInboundMessage`** (in `openclaw-weixin-api.ts`):

```ts
export interface OpenClawWeixinInboundMessage {
  peerId: string;
  peerKind: ImPeerKind;
  senderId?: string;
  text: string;                        // Retained for backward compat (first ImTextContent.text)
  contents: ImMessageContent[];        // NEW: structured content items
  peerName?: string;
  contextToken?: string;
  messageId?: string;
}
```

**`InboundImRouteMessage`** (in `im-message-router.ts`):

```ts
export interface InboundImRouteMessage {
  // ...existing fields unchanged
  text: string;                        // Retained
  contents: ImMessageContent[];        // NEW
}
```

### CDN Types (sidecar-internal)

New file `apps/sidecar/src/services/im/weixin/openclaw-weixin-media-types.ts`:

```ts
export const WeixinUploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export interface WeixinUploadedMedia {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;       // hex-encoded 16-byte AES key
  fileSize: number;             // plaintext size
  fileSizeCiphertext: number;   // AES-128-ECB padded size
}
```

## New Modules

### File Layout

```
apps/sidecar/src/services/im/
├── weixin/
│   ├── openclaw-weixin-api.ts            # [MODIFY] inbound parsing + outbound media methods
│   ├── openclaw-weixin-cdn.ts            # [NEW] AES-128-ECB encryption + CDN upload
│   └── openclaw-weixin-media-types.ts    # [NEW] CDN/media protocol types
├── im-send-service.ts                    # [MODIFY] add sendBoundImMediaMessage
├── im-message-router.ts                  # [MODIFY] pass contents to agent
└── im-media-resolver.ts                  # [NEW] download/decrypt inbound images
```

## Inbound Flow

### Parsing item_list

In `openclaw-weixin-api.ts`, extend `parseInboundMessage` to call a new `extractContents()` function:

```ts
function extractContents(update: Record<string, unknown>): ImMessageContent[] {
  const items = [
    ...(Array.isArray(update.item_list) ? update.item_list : []),
    ...(Array.isArray(update.items) ? update.items : []),
  ];

  if (items.length === 0) {
    const directText = extractText(update);
    return directText ? [{ type: "text", text: directText }] : [];
  }

  return items.map(item => {
    const record = asRecord(item);
    switch (record.type) {
      case 1: return extractTextContent(record);
      case 2: return extractImageContent(record);
      case 3: return extractVoiceContent(record);
      case 4: return extractFileContent(record);
      case 5: return extractVideoContent(record);
      default:  return { type: "text" as const, text: `[不支持的消息类型: ${record.type}]` };
    }
  });
}
```

Each extractor reads the corresponding `*_item` field from the item:

- `extractImageContent`: reads `image_item.media.full_url` (or `image_item.url`), `thumb_media`, dimensions
- `extractVoiceContent`: reads `voice_item.text`, `voice_item.playtime`
- `extractFileContent`: reads `file_item.file_name`, `file_item.len`, `file_item.md5`
- `extractVideoContent`: reads `video_item.media`, `video_item.play_length`, `video_item.video_size`

### Media Resolver

New module `im-media-resolver.ts`:

```ts
export async function resolveMediaContents(
  contents: ImMessageContent[],
  options?: { fetchImpl?: FetchLike }
): Promise<ImMessageContent[]> {
  return Promise.all(contents.map(content => {
    if (content.type === "image" && content.url) {
      return resolveImageContent(content, options);
    }
    return content;
  }));
}
```

For images, the resolver downloads the CDN-referenced image and returns an `ImImageContent` with a directly accessible URL. The downloaded image is stored in a temp directory and the `url` field points to the local file path (e.g. `file:///tmp/lume-media/xxx.jpg`). If download fails, the content is replaced with a text placeholder `[图片: 下载失败]`.

> **Note:** OpenClaw inbound images may reference CDN resources via `encrypt_query_param` + `aes_key` (encrypted) or `full_url` (direct download). The resolver first tries `full_url`; if absent, it uses `encrypt_query_param` with the account's CDN base URL. Decryption is not needed for inbound display — the `full_url` or CDN URL provides the raw image directly.

### Agent Input Formatting

The message router passes `contents` to the agent alongside the text:

- Images: URL passed as multimodal input if model supports vision
- Voice: `voice_item.text` used as message text (WeChat provides speech-to-text)
- Files: metadata description `[文件: filename (size)]`
- Videos: metadata description `[视频 (duration)]`

## Outbound Flow

### CDN Upload Pipeline

New module `openclaw-weixin-cdn.ts` implements the full upload pipeline:

1. **Compute file info**: `rawsize`, `rawfilemd5` (MD5 hash), `filesize` (AES-128-ECB padded size)
2. **Generate keys**: random `filekey` (16 bytes hex) and `aeskey` (16 bytes)
3. **Get upload URL**: `POST /ilink/bot/getuploadurl` with filekey, media_type, to_user_id, rawsize, rawfilemd5, filesize, aeskey
4. **Encrypt**: AES-128-ECB with PKCS7 padding using `node:crypto`
5. **Upload to CDN**: POST encrypted data to `upload_full_url` (preferred). If `upload_full_url` is empty, fall back to the account's `baseUrl` as CDN base with `upload_param` as query string
6. **Return**: `downloadEncryptedQueryParam` from CDN response

```ts
export async function uploadMediaToWeixinCdn(input: {
  fileData: Buffer;
  fileName: string;
  mediaType: 1 | 2 | 3 | 4;
  toUserId: string;
  account: OpenClawWeixinAccountAuth;
  fetchImpl?: FetchLike;
}): Promise<WeixinUploadedMedia>;
```

### AES-128-ECB Encryption

```ts
function aesEcbEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  const padLen = 16 - (plaintext.length % 16);
  const padded = Buffer.alloc(plaintext.length + padLen, padLen);
  plaintext.copy(padded);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}
```

### Sending Media Items

Extend `OpenClawWeixinApi` with three new methods: `sendImage`, `sendVideo`, `sendFile`.

Each follows the same pattern:
1. If caption text is provided, send a TEXT item first (separate `sendmessage` request)
2. Send the media item (separate `sendmessage` request)

Media item structures match the Tencent OpenClaw protocol:

**Image (type 2):**
```json
{
  "type": 2,
  "image_item": {
    "media": {
      "encrypt_query_param": "<downloadEncryptedQueryParam>",
      "aes_key": "<base64-encoded aeskey>",
      "encrypt_type": 1
    },
    "mid_size": <fileSizeCiphertext>
  }
}
```

**Video (type 5):**
```json
{
  "type": 5,
  "video_item": {
    "media": {
      "encrypt_query_param": "<downloadEncryptedQueryParam>",
      "aes_key": "<base64-encoded aeskey>",
      "encrypt_type": 1
    },
    "video_size": <fileSizeCiphertext>
  }
}
```

**File (type 4):**
```json
{
  "type": 4,
  "file_item": {
    "media": {
      "encrypt_query_param": "<downloadEncryptedQueryParam>",
      "aes_key": "<base64-encoded aeskey>",
      "encrypt_type": 1
    },
    "file_name": "<fileName>",
    "len": "<fileSize as string>"
  }
}
```

### Send Service Extension

```ts
export interface SendBoundImMediaInput {
  binding: ImThreadBinding;
  mediaType: "image" | "video" | "file";
  fileData: Buffer;
  fileName: string;
  caption?: string;
}

export async function sendBoundImMediaMessage(
  input: SendBoundImMediaInput
): Promise<{ ok: true }>;
```

## Agent Tool Extension

### send_im_message Schema

```ts
{
  name: "send_im_message",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text message or caption for media." },
      image_url: { type: "string", description: "URL of an image to send." },
      file_path: { type: "string", description: "Local file path to send as attachment." }
    },
    oneOf: [
      { required: ["text"] },
      { required: ["image_url"] },
      { required: ["file_path"] }
    ]
  }
}
```

### Execution Logic

- `text` only: existing text path (no behavior change)
- `image_url`: download image → CDN upload → `sendImage`
- `file_path`: read file → CDN upload → `sendFile`
- `text` + `image_url`/`file_path`: text sent as caption before the media item

## Message Router Changes

The `routeInboundImMessage` function passes `contents` to the agent thread:

```ts
await sendMessage({
  threadId: binding.threadId,
  userMessage: userMessageForMessage(message),
  mediaContents: message.contents.filter(c => c.type !== "text"),
  // ...existing fields
});
```

`AgentSendInput` gains an optional `mediaContents` field. When it contains `ImImageContent`, the image URL is passed as multimodal input to the model.

## Error Handling

| Scenario | Strategy |
|----------|----------|
| CDN upload fails | Retry once, then fall back to text message ("图片/文件发送失败") |
| `getuploadurl` returns empty URL | Throw error, do not fall back |
| Inbound image download/decrypt fails | Replace with `[图片: 下载失败]` text placeholder, do not block message flow |
| Unsupported item type | Replace with `[不支持的消息类型: X]` text content |
| File too large (>25MB) | Reject send and return error to agent |
| CDN auth expired | Handled by existing auth error detection (same as text) |

## Tests

| Module | Test Focus |
|--------|------------|
| `openclaw-weixin-api.ts` | Parse each item type → correct `ImMessageContent`; sendImage/sendFile/sendVideo request body format; mixed text+media items |
| `openclaw-weixin-cdn.ts` | AES-128-ECB encryption correctness (known plaintext → expected ciphertext); CDN upload with mocked fetch; getuploadurl request parameters |
| `im-media-resolver.ts` | Image URL resolution; download failure graceful degradation |
| `im-send-service.ts` | `sendBoundImMediaMessage` full flow with mocked CDN upload |
| `create-im-tools.ts` | Text-only path unchanged; image_url path; file_path path; rejects unbound threads; rejects when no valid input |
| `im-message-router.ts` | Contents correctly passed to agent; image as multimodal input; voice/file/video metadata descriptions |

## Rollout

This is Phase 2 of the Weixin IM integration (Phase 1: text only, completed). Implementation delivers both inbound and outbound multimedia in a single chunk.

Phase 3 (future): Feishu/Telegram adapters, typing indicator, per-account routing.
