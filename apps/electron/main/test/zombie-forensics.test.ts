/**
 * zombie 取证单测（liveness 判据分级 2026-11-03）。
 *
 * collectZombieForensics 是 best-effort 死因取证：sample 抓栈（darwin）+ 进程表
 * 快照落 crash-journal 同目录。单测注入 run stub（免起真子进程）+ 临时目录，
 * 覆盖：成功落盘 / 单步失败降级（杀链不被阻塞）/ 全失败不抛错。
 *
 * 运行：cd apps/electron && npx vitest run main/test/zombie-forensics.test.ts
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectZombieForensics } from '../supervisor/zombie-forensics.js'

const tempDirs: string[] = []
const REAL_PLATFORM = process.platform

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zombie-forensics-test-'))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  // sample 抓栈分支按 process.platform === 'darwin' 门控（zombie-forensics.ts），
  // 本组用例都是 darwin 形态断言——不钉平台时 linux CI 上该分支结构性不可达。
  // 桩法沿用 orchestrator.test.ts / preloaded-update.test.ts 既有惯例。
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

describe('collectZombieForensics（假死进程死因取证）', () => {
  it('darwin：sample 抓栈 + ps 进程表快照均落盘，返回两文件路径', async () => {
    const dir = makeTempDir()
    const calls: Array<{ cmd: string; args: string[]; timeoutMs: number }> = []
    const result = await collectZombieForensics(43101, {
      dir,
      run: async (cmd, args, timeoutMs) => {
        calls.push({ cmd, args, timeoutMs })
        // 模拟 sample -file 的真行为：调用栈写进 -file 目标（stdout 仅进度行）
        if (cmd === 'sample') {
          const { writeFileSync } = await import('node:fs')
          writeFileSync(args[3], 'Call graph:\n    1000 thread_...  start\n', 'utf8')
        }
        return { stdout: 'PID PPID STAT COMMAND\n43101 1 S node runtime\n' }
      },
    })

    const sampleCall = calls.find((c) => c.cmd === 'sample')
    expect(sampleCall, 'sample 被调用（darwin）').toBeDefined()
    expect(sampleCall?.args.slice(0, 2)).toEqual(['43101', '3']) // pid + 3s 采样时长
    expect(sampleCall?.args[2]).toBe('-file')
    const psCall = calls.find((c) => c.cmd === 'ps')
    expect(psCall?.args).toEqual(['-axo', 'pid,ppid,stat,etime,%cpu,%mem,command'])
    // execFile 硬超时兜底（取证有界，不把杀链拖成无界等待）
    expect(sampleCall?.timeoutMs).toBe(15_000)
    expect(psCall?.timeoutMs).toBe(15_000)

    expect(result.callstackFile, '调用栈文件路径返回').toContain('zombie-43101-')
    expect(result.procTableFile, '进程表文件路径返回').toContain('proctable.txt')
    expect(existsSync(result.callstackFile ?? ''), 'sample -file 目标在场（sample 直接写文件）').toBe(true)
    expect(readFileSync(result.procTableFile ?? '', 'utf8')).toContain('43101')
    expect(result.errors).toEqual([])
  })

  it('sample 失败 → callstackFile=null + errors 留档，ps 仍完成（杀链不被阻塞）', async () => {
    const dir = makeTempDir()
    const result = await collectZombieForensics(43102, {
      dir,
      run: async (cmd) => {
        if (cmd === 'sample') throw new Error('sample: command failed')
        return { stdout: 'PID PPID\n' }
      },
    })
    expect(result.callstackFile).toBeNull()
    expect(result.procTableFile).not.toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('sample')
  })

  it('进程表采集失败 → procTableFile=null + errors 留档，不抛错', async () => {
    const dir = makeTempDir()
    const result = await collectZombieForensics(43103, {
      dir,
      run: async () => {
        throw new Error('ps: broken')
      },
    })
    expect(result.procTableFile).toBeNull()
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
    // darwin 上 sample 同样失败（同一 run stub）；两步失败都只降级留档
    expect(result.callstackFile).toBeNull()
  })
})
