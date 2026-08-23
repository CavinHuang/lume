import { describe, expect, test } from 'bun:test'
import { CHUNK_BYTES, concatAudioBuffers, floatTo16BitPcm, splitChunk } from './voice-audio-utils'

describe('floatTo16BitPcm', () => {
  test('downsamples 48k to 16k by averaging and clamps to int16 range', () => {
    // 48 个 0.5 的样本 @48kHz → 16 个 0.5 的样本 @16kHz。
    const input = new Float32Array(48).fill(0.5)
    const pcm = new Int16Array(floatTo16BitPcm(input, 48000))
    expect(pcm.length).toBe(16)
    // setInt16 对 0.5*0x7fff=16383.5 截断为 16383。
    expect(pcm[0]).toBe(16383)
  })

  test('negative samples use the 0x8000 asymmetric range', () => {
    const input = new Float32Array(16).fill(-1)
    const pcm = new Int16Array(floatTo16BitPcm(input, 16000))
    expect(pcm[0]).toBe(-32768)
  })

  test('clips out-of-range floats before quantization', () => {
    const input = new Float32Array(16).fill(7)
    const pcm = new Int16Array(floatTo16BitPcm(input, 16000))
    expect(pcm[0]).toBe(32767)
  })

  test('empty input produces empty buffer', () => {
    expect(floatTo16BitPcm(new Float32Array(0), 48000).byteLength).toBe(0)
  })
})

describe('concatAudioBuffers + splitChunk', () => {
  test('split returns null chunk below threshold and slices above it', () => {
    const small = new ArrayBuffer(10)
    expect(splitChunk(small, CHUNK_BYTES)).toEqual({ chunk: null, rest: small })

    const big = new Uint8Array(CHUNK_BYTES + 4).fill(1).buffer
    const { chunk, rest } = splitChunk(big, CHUNK_BYTES)
    expect(chunk?.byteLength).toBe(CHUNK_BYTES)
    expect(rest.byteLength).toBe(4)
  })

  test('concat round-trips split parts to the original bytes', () => {
    const source = new Uint8Array(100)
    for (let i = 0; i < 100; i += 1) source[i] = i
    const first = source.buffer.slice(0, 60)
    const second = source.buffer.slice(60)
    const joined = new Uint8Array(concatAudioBuffers([first, second]))
    expect(joined.length).toBe(100)
    expect(joined[59]).toBe(59)
    expect(joined[60]).toBe(60)
  })
})
