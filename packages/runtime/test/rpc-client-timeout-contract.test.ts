/**
 * rpc-client RPC 形态契约测试（业务 RPC 无墙钟超时，ADR-0122 / ADR-0190）。
 *
 * 读 rpc-client.ts 源码做文本断言——「业务方法签名与 sendCommand 调用点无超时注入」
 * 是源形态契约（架构红线：业务 RPC 不携带墙钟超时，防时间猜测机制回潮）。
 * 同步逻辑（文件进、断言出），符合单测层判据第 ① 档。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

describe('RL1 契约：业务 RPC 调用链无 timeout', () => {
  const rpcClientSource = readFileSync(
    fileURLToPath(new URL('../src/infra/pi/rpc-client.ts', import.meta.url)),
    'utf8',
  )

  it('sendCommand 公共签名两参（type, params），无 timeout 参数', () => {
    expect(rpcClientSource).toMatch(
      /sendCommand\(type: string, params: Record<string, unknown> = \{\}\): Promise<PiMessage>/,
    )
  })

  it('业务方法的 sendCommand 调用点全部无超时注入', () => {
    // this.sendCommand( 精确匹配：不误伤 this.sendCommandInternal(（内部通道）
    const callLines = rpcClientSource
      .split('\n')
      .filter((line) => line.includes('this.sendCommand('))
    expect(callLines.length).toBeGreaterThan(0) // 调用点在场（防断言目标为空）
    for (const line of callLines) {
      expect(line).not.toMatch(/timeout/i)
    }
  })

  it('rpc-client 无任何公开方法携带 timeoutMs 签名', () => {
    // 类方法签名行（2 空格缩进、非 private / 注释行）中不得出现 timeoutMs——
    // 探测变体 probeState 已随 ADR-0190 删除，公开面不设任何墙钟入口
    const publicSignatureLines = rpcClientSource
      .split('\n')
      .filter((line) => /^  (?!private\b|\/\/|\*)\w.*timeoutMs/.test(line))
    expect(publicSignatureLines).toHaveLength(0)
  })
})
