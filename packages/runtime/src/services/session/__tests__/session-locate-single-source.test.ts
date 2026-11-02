/**
 * 会话定位读链同源同参绑定（dmg-r1-9）。
 *
 * 背景（问题原形态）：两条会话定位读链曾各自持有一份「按 id 定位会话文件」的实装——
 * file-service.ts `resolveSessionContext` 磁盘段自己调 `scanPiSessions({ force: true })`
 * + find，session-state-query.ts `getState` 段 2 / 段 4 经注入缝调 infra 定位函数——
 * 同源纪律（重写 G11/M5 换源时两链必须同步替换）只由两侧注释承载，无机器绑定。
 *
 * 修复形态：磁盘段收敛为 infra 定位单函数 `findScannedSessionFileById`（返回值扩出
 * cwd，供纯读链取值），btw 布局段 `findBtwLineFileByLayout` 本就是单函数；两链都消费
 * 同一批单函数（冷读链经 deps 注入缝、纯读链直接 import，同一实装）。本文件把「两链
 * 同源同参」钉成对拍测试——任一链改走别的定位源 / 换函数 / 换参数，本文件即红。
 *
 * 判据：
 * - 同一 fixture 状态下，两条链都经同一批 infra 定位函数、以同一 sessionId 调用
 *   （调用留痕 = vi.mock 包一层，委托真实实装，定位行为不变）；
 * - 调用次序 = 各自链的判别顺序（磁盘段命中即止，不枚举 btw 存储树；两段 miss 后才
 *   布局兜底）；
 * - 两链定位结果自洽：纯读链给出的 filePath = 冷读链实际读取的文件（两个 fixture 文件
 *   携带不同模型记录，经 extractLatestModelFromJsonl 对拍可判别）。
 *
 * 组合差异（有意为之，不在本绑定范围）：冷读链多两段——btw 注册表判别（廉价内存读，
 * 沉在最前）与段 1 sessionMetaCache 全表遍历（零 IO）；纯读链无这两段，直接磁盘段。
 * 判别顺序依据见 session-state-query.ts getState 注释（dmg-r1-3）。本文件注入缝镜像
 * 生产投影接线（session-state-projection.ts 构造器），注册表判别恒 miss = 重启后的
 * 不在册线形态（布局兜底可达成）。
 */
import { findBtwLineFileByLayout, findBtwLineFileByPiSessionId, findCachedSessionFileById, findScannedSessionFileById } from '../../../infra/pi/session-file-locator.js';
import { _resetSessionMetaCacheForTest, extractLatestModelFromJsonl, invalidateScanDirCache } from '../../../infra/pi/session-file-utils.js';
import { resolveSessionContext } from '../../file-service.js';
import { SessionNotFoundError, SessionStateQuery, type SessionStateColdReadTrace } from '../session-state-query.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 调用留痕层：只包记录（委托真实实装），不改定位行为。两链都经模块导出绑定消费定位
// 函数（纯读链直接 import、冷读链经注入缝），故留痕覆盖两条链的内部调用。
vi.mock('../../../infra/pi/session-file-locator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/session-file-locator.js')>()
  return {
    ...actual,
    findScannedSessionFileById: vi.fn(actual.findScannedSessionFileById),
    findBtwLineFileByLayout: vi.fn(actual.findBtwLineFileByLayout),
  }
})

const scanSpy = vi.mocked(findScannedSessionFileById)
const layoutSpy = vi.mocked(findBtwLineFileByLayout)


const MAIN_SID = '019a1b2c-0000-7000-8000-000000000001'
const LINE_SID = '019a1b2c-0000-7000-8000-000000000002'
const UNKNOWN_SID = '019a1b2c-0000-7000-8000-000000000003'
const MAIN_MODEL = 'prov-main/model-main'
const LINE_MODEL = 'prov-line/model-line'


let dataDir: string
let workDir: string
let origDataDir: string | undefined
let mainFile: string
let lineFile: string


/** 写一份最小 session JSONL（header + session_info + model_change + thinking_level_change）。 */
function writeSessionFile(filePath: string, sid: string, cwd: string, provider: string, modelId: string, thinkingLevel: string): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, [
    JSON.stringify({ type: 'session', id: sid, cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'session_info', id: 's1' }),
    JSON.stringify({ type: 'model_change', id: 'mc1', parentId: 's1', provider, modelId, timestamp: '2026-01-01T00:00:01.000Z' }),
    JSON.stringify({ type: 'thinking_level_change', id: 'tl1', parentId: 'mc1', thinkingLevel, timestamp: '2026-01-01T00:00:02.000Z' }),
  ].join('\n') + '\n', 'utf8')
}


/** 冷读链装配（注入缝镜像生产投影接线：session-state-projection.ts 构造器）。 */
function makeQuery(): { query: SessionStateQuery; traces: SessionStateColdReadTrace[] } {
  const traces: SessionStateColdReadTrace[] = []
  const query = new SessionStateQuery({
    getClient: () => undefined,
    getReplicatedStates: () => undefined,
    locateMainSessionFileFromCache: (sid) => findCachedSessionFileById(sid),
    locateMainSessionFileFromDisk: (sid) => findScannedSessionFileById(sid),
    // 注册表判别恒 miss = 重启后的不在册线（lifecycle.sessions 无记录）→ 布局兜底可达成
    locateBtwLineFile: () => undefined,
    locateBtwLineFileByLayout: (sid) => findBtwLineFileByLayout(sid),
    onColdRead: (t) => traces.push(t),
  })
  return { query, traces }
}


/** 链 A（纯读）的扫描会把 meta 填进 sessionMetaCache；清掉让链 B 的段 1 miss、落到段 2。 */
function resetColdCaches(): void {
  _resetSessionMetaCacheForTest()
  invalidateScanDirCache()
}


beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'locate-single-source-'))
  workDir = mkdtempSync(join(tmpdir(), 'locate-single-source-work-'))
  origDataDir = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = dataDir
  resetColdCaches()
  scanSpy.mockClear()
  layoutSpy.mockClear()
  // 主会话落 pi sessions 扫描面（<agentDir>/sessions/，未迁移形态顶层文件）
  mainFile = join(dataDir, 'agent', 'sessions', `${MAIN_SID}.jsonl`)
  writeSessionFile(mainFile, MAIN_SID, workDir, 'prov-main', 'model-main', 'high')
  // btw 线落存储树布局（<dataDir>/ext-sessions/<mainSid>/btw/，构造性不在扫描面）
  lineFile = join(dataDir, 'ext-sessions', MAIN_SID, 'btw', `${LINE_SID}.jsonl`)
  writeSessionFile(lineFile, LINE_SID, workDir, 'prov-line', 'model-line', 'low')
})


afterEach(() => {
  if (origDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = origDataDir
  resetColdCaches()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})


describe('会话定位读链同源同参绑定（dmg-r1-9）', () => {
  it('磁盘段：两链经同一 scan 定位函数、同参；磁盘命中即止，两链都不枚举 btw 存储树', async () => {
    // 链 A（纯读）：file-service resolveSessionContext
    const resA = resolveSessionContext(MAIN_SID, () => undefined)
    expect(resA.kind).toBe('disk')
    if (resA.kind !== 'disk') throw new Error('unreachable: 磁盘段未命中')
    expect(resA.filePath).toBe(mainFile)
    expect(resA.cwd).toBe(workDir) // cwd 经单函数返回值透出（彼链不做自己的 scan+find）

    resetColdCaches()

    // 链 B（冷读）：SessionStateQuery.getState
    const { query, traces } = makeQuery()
    const state = await query.getState(MAIN_SID)
    expect(state).toEqual({ sessionId: MAIN_SID, modelId: MAIN_MODEL, thinkingLevel: 'high' })
    expect(traces[0]).toMatchObject({ source: 'disk-scan', found: true })

    // 对拍：冷读链读到的文件 = 纯读链定位到的同一个文件（两 fixture 文件模型记录不同，
    // 读错文件这里就会红）
    expect(extractLatestModelFromJsonl(resA.filePath)).toEqual({ modelId: MAIN_MODEL, thinkingLevel: 'high' })

    // 同源同参：两链都以同一 sessionId 调同一 scan 定位函数，各一次
    expect(scanSpy.mock.calls).toEqual([[MAIN_SID], [MAIN_SID]])
    // 磁盘段命中即止：两链都不枚举 btw 存储树（布局兜底沉到最后）
    expect(layoutSpy).not.toHaveBeenCalled()
  })

  it('btw 布局段：两链经同一布局定位函数、同参（重启后不在册线，两段 miss 后兜底）', async () => {
    // 布局单函数寻址锚（先于两链调用取，取的是共享实装的解析结果）
    expect(findBtwLineFileByPiSessionId(LINE_SID)).toBe(lineFile)

    // 链 A（纯读）：扫描面 miss + 布局命中 → btw-line 判别形态
    const resA = resolveSessionContext(LINE_SID, () => undefined)
    expect(resA).toEqual({ kind: 'btw-line' })

    resetColdCaches()

    // 链 B（冷读）：注册表 miss → 段 1 miss → 段 2 miss → 布局兜底命中
    const { query, traces } = makeQuery()
    const state = await query.getState(LINE_SID)
    expect(state).toEqual({ sessionId: LINE_SID, modelId: LINE_MODEL, thinkingLevel: 'low' })
    expect(traces[0]).toMatchObject({ source: 'btw-registry', found: true })

    // 对拍：冷读链读到的文件 = 布局单函数寻址到的同一个文件
    expect(extractLatestModelFromJsonl(lineFile)).toEqual({ modelId: LINE_MODEL, thinkingLevel: 'low' })

    // 同源同参：两链都先 scan（miss）后 layout（命中），同一 sessionId、次序一致
    expect(scanSpy.mock.calls).toEqual([[LINE_SID], [LINE_SID]])
    expect(layoutSpy.mock.calls).toEqual([[LINE_SID], [LINE_SID]])
  })

  it('全 miss：两链经同两个定位函数、同参，终局一致（not-found / SESSION_NOT_FOUND）', async () => {
    const resA = resolveSessionContext(UNKNOWN_SID, () => undefined)
    expect(resA).toEqual({ kind: 'not-found' })

    resetColdCaches()

    const { query } = makeQuery()
    await expect(query.getState(UNKNOWN_SID)).rejects.toBeInstanceOf(SessionNotFoundError)

    expect(scanSpy.mock.calls).toEqual([[UNKNOWN_SID], [UNKNOWN_SID]])
    expect(layoutSpy.mock.calls).toEqual([[UNKNOWN_SID], [UNKNOWN_SID]])
  })
})
