import { beforeEach, describe, expect, it } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import { SchedulerRuntime } from '../runtime.js'
import { SchedulerService } from '../service.js'
import { handleSchedule } from '../tool.js'

/**
 * schedule tool 直建流覆盖（触发反转，scheduler-redesign 方案 B 2026-10-30 裁决）：
 * 预校验 throw（不创建）/ abort → cancelled result（不创建）/ 会话模式不参与（rpc 与 print
 * 行为一致，直建）/ kind/name/expires/model 透传入 entry 快照 / 不再有「未经确认」附注。
 *
 * 交互/协议错误分支（channel-error / non-json / echo）随交互迁入命令路径，覆盖见
 * commands-form.test.ts（原本文件三条错误分支用例迁移目标）。表单预填草稿构造
 * （models 注入）见 interaction.test.ts。
 */

function makeService(): { service: SchedulerService; backend: MockSchedulerBackend } {
  const backend = new MockSchedulerBackend()
  return { service: new SchedulerService(new SchedulerRuntime(backend), () => backend.now()), backend }
}

describe('schedule tool 直建流', () => {
  let service: SchedulerService
  let backend: MockSchedulerBackend

  beforeEach(() => {
    const s = makeService()
    service = s.service
    backend = s.backend
  })

  // ── 预校验（参数合法性是模型可自修复的错误，先于任何副作用 throw） ──

  it('预校验：prompt 空 → throw 且未创建', async () => {
    await expect(handleSchedule(service, { prompt: '', schedule: '5m' }, undefined))
      .rejects.toThrow('prompt must not be empty')
    expect(backend.persistedSnapshots).toHaveLength(0)
  })

  it('预校验：schedule 非法（ISO 时间戳不可解析）→ throw 且未创建', async () => {
    await expect(
      handleSchedule(service, { prompt: 'x', schedule: '2026-09-19T09:00:00' }, undefined),
    ).rejects.toThrow('unrecognized schedule')
    expect(backend.persistedSnapshots).toHaveLength(0)
  })

  // ── 直建：会话模式不再参与（无 ctx 参数 ⇒ rpc/tui/json/print 同一路径） ──

  it('直建：参数直接创建，result 不再附注「未经确认」', async () => {
    const result = await handleSchedule(
      service,
      { prompt: 'check build', schedule: '5m', model: 'prov-a/m1' },
      undefined,
    )

    const text = result.content[0]!.text
    expect(text).toContain('Task "check build"')
    expect(text).not.toContain('Created without user confirmation')
    const created = backend.persistedTasks?.[0]
    expect(created?.model).toBe('prov-a/m1')
  })

  // ── abort：取消语义（正常返回，不 throw），不创建 ──

  it('abort：signal 已中止 → cancelled result 且未创建', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await handleSchedule(service, { prompt: 'x', schedule: '5m' }, controller.signal)

    expect(result.details).toEqual({ cancelled: true })
    expect(result.content[0]!.text).toContain('The task was NOT created')
    expect(result.content[0]!.text).toContain('Do not assume a configuration and do not retry')
    expect(backend.persistedSnapshots).toHaveLength(0)
  })

  // ── 参数透传：kind / name / expires / model 全部落到 entry 快照 ──

  it('参数透传：kind=once + name 入 upsert 快照；expires 对 recurring 生效（once 忽略）', async () => {
    await handleSchedule(
      service,
      { prompt: 'p', schedule: '10s', kind: 'once', name: 'my task', expires: '30d' },
      undefined,
    )

    const onceCreated = backend.persistedTasks?.[0]
    expect(onceCreated?.kind).toBe('once')
    expect(onceCreated?.name).toBe('my task')
    // once 触发即删：expires 语义不适用（runtime 忽略）——这是既有语义，非本单元改动
    expect(onceCreated?.expiresAt).toBeUndefined()

    await handleSchedule(service, { prompt: 'q', schedule: '1d', expires: '30d' }, undefined)
    const recurringCreated = backend.persistedTasks?.find(t => t.prompt === 'q')
    expect(recurringCreated?.expiresAt).not.toBeUndefined()
  })
})

// ── model 字段族持久化（U2 领地：types.ts + runtime.addTask 构造段） ──

describe('model 字段族落盘', () => {
  it('addTask 透传 options.model 进 task；缺省 = undefined（跟随会话当前模型）', async () => {
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend)

    const withModel = await runtime.addTask('p1', { mode: 'interval', intervalMs: 60000 }, { model: 'prov-a/m1' })
    const withoutModel = await runtime.addTask('p2', { mode: 'interval', intervalMs: 60000 })

    expect(withModel.model).toBe('prov-a/m1')
    expect(withoutModel.model).toBeUndefined()
  })

  it('快照落盘 model 保真：persistTasks 收到的任务集含 model 字段（漏字段 = 恢复丢失的反向验证）', async () => {
    const backend = new MockSchedulerBackend()
    const runtime = new SchedulerRuntime(backend)

    const withModel = await runtime.addTask('p1', { mode: 'interval', intervalMs: 60000 }, { model: 'prov-a/m1' })

    const persisted = backend.persistedTasks?.find(t => t.id === withModel.id)
    expect(persisted?.model).toBe('prov-a/m1')
  })
})
