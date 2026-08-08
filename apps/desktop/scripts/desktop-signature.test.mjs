import { describe, expect, test } from 'bun:test'
import { parseMacSignatureStable } from '../src/desktop-signature.ts'

describe('parseMacSignatureStable', () => {
  test('Developer ID 签名（有 TeamIdentifier）判定为稳定', () => {
    const output = [
      'Executable=/Applications/Lume.app/Contents/MacOS/Lume',
      'Identifier=com.lume.desktop',
      'Format=app bundle with Mach-O thin (arm64)',
      'CodeDirectory v=20500',
      'TeamIdentifier=ABCDE12345',
    ].join('\n')
    expect(parseMacSignatureStable(output)).toBe(true)
  })

  test('ad-hoc 签名（TeamIdentifier=not set）判定为不稳定', () => {
    const output = ['Identifier=com.lume.desktop', 'TeamIdentifier=not set'].join('\n')
    expect(parseMacSignatureStable(output)).toBe(false)
  })

  test('缺少 TeamIdentifier 行判定为不稳定', () => {
    expect(parseMacSignatureStable('Identifier=com.lume.desktop\nFormat=app bundle')).toBe(false)
  })

  test('空 TeamIdentifier 判定为不稳定', () => {
    expect(parseMacSignatureStable('TeamIdentifier=')).toBe(false)
  })

  test('可在 stderr/stdout 合并输出中定位 TeamIdentifier', () => {
    expect(parseMacSignatureStable('some noise\nTeamIdentifier=XYZ987\nmore output')).toBe(true)
  })
})
