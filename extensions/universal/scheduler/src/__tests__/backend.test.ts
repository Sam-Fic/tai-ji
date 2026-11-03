import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import { PiSchedulerBackend } from '../backend.js'
import { SchedulerRuntime } from '../runtime.js'
import type { ScheduledTask } from '../types.js'

/** 构造 base task。 */
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'aaa',
    name: 'test',
    prompt: 'p',
    kind: 'recurring',
    schedule: { mode: 'interval', intervalMs: 60000 },
    enabled: true,
    createdAt: 0,
    nextRunAt: 100,
    runCount: 0,
    history: [],
    ...overrides,
  }
}

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-backend-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('MockSchedulerBackend', () => {
  it('records deliverDispatch calls', async () => {
    const backend = new MockSchedulerBackend()
    await backend.deliverDispatch(
      { content: 'hi', customType: 'pi-scheduler:dispatched', display: true },
      { deliverAs: 'steer', triggerTurn: true },
      'aaa:1000',
    )
    expect(backend.sentMessages).toHaveLength(1)
    expect(backend.sentMessages[0]!.msg).toEqual({
      content: 'hi',
      customType: 'pi-scheduler:dispatched',
      display: true,
    })
    expect(backend.sentMessages[0]!.opts).toEqual({ deliverAs: 'steer', triggerTurn: true })
    expect(backend.sentMessages[0]!.idempotencyKey).toBe('aaa:1000')
  })

  it('records persistTasks calls and throws injected persistError', () => {
    const backend = new MockSchedulerBackend()
    const tasks = [makeTask()]

    backend.persistTasks(tasks)
    expect(backend.persistedSnapshots).toHaveLength(1)
    expect(backend.persistedSnapshots[0]).toBe(tasks)

    // persistError 注入：persistTasks 抛该错（落盘失败语义——错误必须能传到调用栈供 runtime 捕获）
    backend.persistError = new Error('disk full')
    expect(() => backend.persistTasks(tasks)).toThrow('disk full')
  })

  it('now() returns injected nowValue or Date.now()', () => {
    const backend = new MockSchedulerBackend()
    expect(Math.abs(backend.now() - Date.now())).toBeLessThan(1000)
    backend.nowValue = 123456
    expect(backend.now()).toBe(123456)
  })

  // ── TC2：new SchedulerRuntime(mockBackend) 可注入单测，零 FS ──

  it('TC2: SchedulerRuntime with MockSchedulerBackend constructs and dispatches via mock', async () => {
    const backend = new MockSchedulerBackend()
    // 构造不抛错（无需 cwd/pi/store mock）
    const runtime = new SchedulerRuntime(backend)
    const task = await runtime.addTask('probe', { mode: 'interval', intervalMs: 60000 })
    expect(task).toBeDefined()
    // addTask 后全量快照落盘一次（mock 记录，零 FS）
    expect(backend.persistedSnapshots).toHaveLength(1)
    expect(backend.persistedSnapshots[0]!.map(t => t.id)).toEqual([task.id])

    await runtime.dispatchTask(task)

    // dispatch 消息走 mock backend，含 task.prompt
    expect(backend.sentMessages).toHaveLength(1)
    expect(backend.sentMessages[0]!.msg.content).toBe('probe')
    expect(backend.sentMessages[0]!.msg.customType).toBe('pi-scheduler:dispatched')
  })
})

// ── PiSchedulerBackend 真实 FS 行为（任务库快照读写；store 纯函数行为在
//    extension-protocol store.test.ts 全量覆盖，此处只测 backend 装配委托）──

describe('PiSchedulerBackend', () => {
  function makeBackend(sessionFile?: string): PiSchedulerBackend {
    const storePath = path.join(dir, 'w', 'sess-1.json')
    const ctx = {
      sessionManager: {
        getSessionFile: () => sessionFile,
      },
    }
    // pi 只在 port 缺席兜底路径用到 sendMessage；本组用例不触发 dispatch
    return new PiSchedulerBackend(ctx, { sendMessage: async () => {} }, storePath)
  }

  it('loadTasks：文件不存在 → 空任务集（新 session 正常路径）', () => {
    const backend = makeBackend()
    expect(backend.loadTasks()).toEqual([])
  })

  it('persistTasks → loadTasks 往返：任务集等值（sessionFile 冗余入快照）', () => {
    const backend = makeBackend('/sessions/s1.jsonl')
    const tasks = [makeTask(), makeTask({ id: 'bbb', pending: true })]
    backend.persistTasks(tasks)

    const loaded = backend.loadTasks()
    expect(loaded.map(t => t.id)).toEqual(['aaa', 'bbb'])
    expect(loaded[0]).toEqual(makeTask())
    // pending 运行时标记被写入口剥离
    expect(loaded[1]!.pending).toBeUndefined()

    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, 'w', 'sess-1.json'), 'utf-8'),
    ) as { sessionFile?: string }
    expect(raw.sessionFile).toBe('/sessions/s1.jsonl')
  })

  it('persistTasks：--no-session（sessionFile undefined）快照省略该字段', () => {
    const backend = makeBackend(undefined)
    backend.persistTasks([])
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, 'w', 'sess-1.json'), 'utf-8'),
    ) as Record<string, unknown>
    expect('sessionFile' in raw).toBe(false)
  })
})
