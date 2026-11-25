/**
 * gen-stats-service 成员读兜底单测（prune F2/card-04：readMemberUnion 单成员读抛错 →
 * warn 后按空跳过，recordSample/onModelSwitched 热路径不炸）。
 *
 * 为什么独立文件：本文件需要 vi.mock 存储模块强制 readDayRecords 抛错（真实 fs 形态全部被
 * readDayRecords 内部 catch 降级，构造不出抛错面），与主测试文件的真实存储 fixture 互斥。
 *
 * 数据目录红线（TEST-STRATEGY / fs-guard）：mkdtemp + TAIJI_AGENT_DATA_DIR 注入——mock 只
 * 替 readDayRecords，writeDayRecords/路径族是真实实现，落盘目标必须落 tmp。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/gen-stats-service-member-read.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage } from '@taiji/shared'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { ISessionService } from '../../../interfaces.js'

// 存储模块 mock：readDayRecords 可编程抛错；聚合族/路径族/写族用真实实现（importOriginal 保底）
vi.mock('../gen-stats-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gen-stats-store.js')>()
  return {
    ...actual,
    readDayRecords: vi.fn(() => ({})),
  }
})

const { GenStatsService } = await import('../gen-stats-service.js')
const store = await import('../gen-stats-store.js')

const readDayRecordsMock = vi.mocked(store.readDayRecords)

const NORMAL_SAMPLE = {
  outputTokens: 100,
  durationMs: 2000,
  ttftMs: null,
  model: 'faux-1',
  provider: 'faux',
  input: 500,
  cacheRead: 300,
  cacheWrite: 100,
}

function routeFixture(id: string, members: Array<[string, string]>) {
  return {
    id, name: id, modelId: id, enabled: true, mode: 'simple' as const,
    members: members.map(([providerId, modelId], i) => ({ id: `m${i}`, providerId, modelId, type: 'none' as const })),
    specials: [],
  }
}

let dataDir: string
let prevDataDirEnv: string | undefined

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'taiji-gen-stats-member-read-'))
  prevDataDirEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = dataDir
  readDayRecordsMock.mockReset()
  readDayRecordsMock.mockReturnValue({})
})

afterEach(() => {
  if (prevDataDirEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = prevDataDirEnv
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  vi.restoreAllMocks()
})

function makeService(routes: ReturnType<typeof routeFixture>[]) {
  const published: Array<{ sid: string; msg: ServerMessage }> = []
  const service = new GenStatsService({
    publish: (sid, msg) => published.push({ sid, msg }),
    pm: { getClient: vi.fn(() => undefined) } as unknown as IProcessManager,
    sessionService: { setOnSessionDestroyed: vi.fn(), getSession: vi.fn(() => undefined) } as unknown as ISessionService,
    readRoutes: () => routes,
  })
  return { service, published }
}

describe('readMemberUnion 单成员读抛错兜底（prune F2/card-04）', () => {
  it('非采样成员读抛错 → warn 后按空跳过：recordSample 不炸、广播帧仍可达、current 命中采样成员', () => {
    // 采样成员 faux-1 读正常（→ 落盘成功 → fresh 非空 → 广播发生）；非采样成员 faux-1-b 读抛错
    readDayRecordsMock.mockImplementation((filePath: string) => {
      if (filePath.includes('faux-1-b')) throw new Error('boom: member b unreadable')
      return {}
    })
    const { service, published } = makeService([routeFixture('route-b', [['faux', 'faux-1'], ['faux', 'faux-1-b']])])
    service.onModelSwitched('s1', 'aggregation/route-b')
    published.length = 0

    expect(() => {
      service.recordSample('s1', { ...NORMAL_SAMPLE })
    }).not.toThrow()

    // 坏成员按空跳过，帧仍推给路由会话；current 来自实际采样的成员（faux-1）
    const frames = published.filter((p) => p.sid === 's1')
    expect(frames).toHaveLength(1)
    const frame = frames[0]!.msg.payload as { model?: string; speed?: { current?: number | null } }
    expect(frame.model).toBe('aggregation/route-b')
    expect(frame.speed?.current).toBe(50)
  })

  it('全部成员读抛错 → onModelSwitched 的 frameFor 路径同样不炸（聚合全 null 帧）', () => {
    readDayRecordsMock.mockImplementation(() => {
      throw new Error('boom: storage layer exploded')
    })
    const { service, published } = makeService([routeFixture('route-a', [['faux', 'faux-1']])])

    expect(() => {
      service.onModelSwitched('s1', 'aggregation/route-a')
    }).not.toThrow()

    expect(published).toHaveLength(1)
    const frame = published[0]!.msg.payload as { model?: string; speed?: { current?: number | null } }
    expect(frame.model).toBe('aggregation/route-a')
    expect(frame.speed?.current).toBeNull() // 无本会话样本（切换帧），无回落
  })
})
