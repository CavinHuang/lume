import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { buildAuthHeaders, parseServerMessage } from './voice-asr-service'

/** 构造一帧服务端响应：header(4) [+sequence(4)] + payloadSize(4) + payload。 */
function buildServerFrame(options: {
  messageType?: number
  flags?: number
  serialization?: number
  compression?: number
  sequence?: number
  payload: Buffer
}): Buffer {
  const flags = options.flags ?? 0b0000
  const header = Buffer.from([
    0x11, // (version 1)<<4 | headerSize 1（单位 4 字节）
    ((options.messageType ?? 0b1001) << 4) | flags,
    ((options.serialization ?? 0b0001) << 4) | (options.compression ?? 0b0001),
    0x00,
  ])
  const parts: Buffer[] = [header]
  if (options.sequence !== undefined) {
    const seq = Buffer.alloc(4)
    seq.writeUInt32BE(options.sequence)
    parts.push(seq)
  }
  const size = Buffer.alloc(4)
  size.writeUInt32BE(options.payload.length)
  parts.push(size, options.payload)
  return Buffer.concat(parts)
}

/** 服务端错误帧：header(4) + code(4) + messageSize(4) + message（无 payloadSize 前置）。 */
function buildServerErrorFrame(code: number, message: string): Buffer {
  const messageBuffer = Buffer.from(message, 'utf-8')
  const header = Buffer.from([0x11, 0xf0, 0x00, 0x00])
  const codeBuffer = Buffer.alloc(4)
  codeBuffer.writeUInt32BE(code)
  const sizeBuffer = Buffer.alloc(4)
  sizeBuffer.writeUInt32BE(messageBuffer.length)
  return Buffer.concat([header, codeBuffer, sizeBuffer, messageBuffer])
}

function jsonPayload(value: unknown, compress = true): Buffer {
  const raw = Buffer.from(JSON.stringify(value), 'utf-8')
  return compress ? gzipSync(raw) : raw
}

describe('parseServerMessage', () => {
  test('parses gzipped full response with text payload', () => {
    const frame = buildServerFrame({ flags: 0b0011, sequence: 1, payload: jsonPayload({ result: { text: '你好世界' } }) })
    expect(parseServerMessage(frame)).toEqual({ text: '你好世界', isFinal: true })
  })

  test('non-last flag without definite utterance is not final', () => {
    const frame = buildServerFrame({ flags: 0b0001, sequence: 1, payload: jsonPayload({ result: { text: '部分结果' } }) })
    expect(parseServerMessage(frame)).toEqual({ text: '部分结果', isFinal: false })
  })

  test('definite utterance marks final', () => {
    const frame = buildServerFrame({
      payload: jsonPayload({ result: { utterances: [{ text: '完成', definite: true }] } }),
    })
    expect(parseServerMessage(frame)).toEqual({ text: '完成', isFinal: true })
  })

  test('result array picks highest-confidence candidate instead of concatenating', () => {
    const frame = buildServerFrame({
      payload: jsonPayload({
        result: [
          { text: '低置信', confidence: 0.2 },
          { text: '高置信', confidence: 0.9 },
        ],
      }),
    })
    expect(parseServerMessage(frame)?.text).toBe('高置信')
  })

  test('server error frame surfaces code and message as final', () => {
    const frame = buildServerErrorFrame(45000001, 'invalid auth')
    const parsed = parseServerMessage(frame)
    expect(parsed?.isFinal).toBe(true)
    expect(parsed?.text).toContain('45000001')
    expect(parsed?.text).toContain('invalid auth')
  })

  test('uncompressed payload is honored when compression flag is none', () => {
    const frame = buildServerFrame({ compression: 0, payload: jsonPayload({ result: { text: 'plain' } }, false) })
    expect(parseServerMessage(frame)?.text).toBe('plain')
  })

  test('returns null for truncated or non-response frames', () => {
    expect(parseServerMessage(Buffer.from([0x10]))).toBeNull()
    const audioAck = buildServerFrame({ messageType: 0b1011, payload: jsonPayload({}) })
    expect(parseServerMessage(audioAck)).toBeNull()
  })

  test('buildAuthHeaders maps credentials to protocol headers', () => {
    const headers = buildAuthHeaders({ appId: 'a', accessToken: 't', resourceId: 'r', language: '', customHotwords: '', outputMode: 'lume-input' })
    expect(headers['X-Api-App-Key']).toBe('a')
    expect(headers['X-Api-Access-Key']).toBe('t')
    expect(headers['X-Api-Resource-Id']).toBe('r')
    expect(headers['X-Api-Connect-Id']).toBeTruthy()
  })
})
