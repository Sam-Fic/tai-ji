/**
 * default-model-aggregation.test（provider-aggregation A7/RL7 默认模型裁定源单测）。
 *
 * 断言面（RL7）：findValidDefaultModel 裁定源纳入路由条目后，settings.json 中的路由默认
 * 在两触发点（初始广播 config.defaults 经 getDefaultModel；spawn --model 同一裁定源）
 * 均原样存活（pass-through，wasFixed:false 不触发 auto-fix 写回）；路由不可用（删除/停用/
 * 扩展禁用，D9 ③）时 auto-fix 落首个可用物理模型；非 pass-through 场景（物理模型默认）
 * 行为回归不变。
 *
 * 环境：models/settings 路径重定向到 mkdtemp（fs-guard 白名单内），路由可用性判定经
 * initAggregationRouteAvailabilityCheck 注入（生产组合根同款装配形态）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findValidDefaultModel,
  getDefaultModel,
  initAggregationRouteAvailabilityCheck,
  setModelsPath,
} from '../pi-provider-store.js'
import { invalidateSettingsCache, readSettings, setSettingsPath } from '../pi-settings-store.js'

let dir: string
let agentDir: string

function writeModels(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}

function writeSettings(defaultProvider?: string, defaultModel?: string): void {
  const s: Record<string, unknown> = {}
  if (defaultProvider) s.defaultProvider = defaultProvider
  if (defaultModel) s.defaultModel = defaultModel
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(s, null, 2))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'default-model-aggregation-'))
  agentDir = join(dir, 'agent')
  mkdirSync(agentDir, { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  invalidateSettingsCache()
})

afterEach(() => {
  // 注入清理恢复 pass-through 缺省（跨文件不残留——模块级注入点的测试卫生）
  initAggregationRouteAvailabilityCheck(undefined)
  delete process.env.TAIJI_AGENT_DATA_DIR
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('default-model-aggregation（A7/RL7 默认模型裁定源）', () => {
  it('路由默认 + 注入判定可用 → pass-through 存活（wasFixed:false，settings 不被 auto-fix 改写）', () => {
    writeModels({ 'my-phys': { name: 'phys', apiKey: 'k', models: [{ id: 'm1' }] } })
    writeSettings('aggregation', 'glm-route')
    initAggregationRouteAvailabilityCheck((routeId) => routeId === 'glm-route')
    const r = findValidDefaultModel()
    expect(r.result).toEqual({ provider: 'aggregation', modelId: 'glm-route' })
    expect(r.wasFixed).toBe(false)
    // 初始广播触发点（getDefaultModel）：路由默认原样存活、不写回 settings.json
    expect(getDefaultModel()).toEqual({ provider: 'aggregation', modelId: 'glm-route' })
    expect(readSettings().defaultModel).toBe('glm-route')
  })

  it('路由默认 + 注入判定不可用（路由已删/停用）→ auto-fix 落首个可用物理模型', () => {
    writeModels({ 'my-phys': { name: 'phys', apiKey: 'k', models: [{ id: 'm1' }, { id: 'm2' }] } })
    writeSettings('aggregation', 'deleted-route')
    initAggregationRouteAvailabilityCheck(() => false)
    const r = findValidDefaultModel()
    expect(r.result).toEqual({ provider: 'my-phys', modelId: 'm1' })
    expect(r.wasFixed).toBe(true)
    // getDefaultModel 触发点：auto-fix 写回物理模型（默认不悬空指向路由条目，D9 ③）
    expect(getDefaultModel()).toEqual({ provider: 'my-phys', modelId: 'm1' })
    expect(readSettings().defaultProvider).toBe('my-phys')
  })

  it('路由默认 + 注入判定不可用（路由扩展禁用，D9 ③）→ 同样 auto-fix 落物理模型', () => {
    writeModels({ 'my-phys': { name: 'phys', apiKey: 'k', models: [{ id: 'm1' }] } })
    writeSettings('aggregation', 'glm-route')
    // 组合根装配形态：路由条目在但扩展被禁用 → 判定 false
    initAggregationRouteAvailabilityCheck(() => false)
    expect(findValidDefaultModel().result).toEqual({ provider: 'my-phys', modelId: 'm1' })
  })

  it('判定未注入（早期装配/测试）→ pass-through（fail-open，不误改写用户默认配置）', () => {
    writeModels({ 'my-phys': { name: 'phys', apiKey: 'k', models: [{ id: 'm1' }] } })
    writeSettings('aggregation', 'glm-route')
    // afterEach 已恢复 undefined 缺省；本用例显式不注入
    initAggregationRouteAvailabilityCheck(undefined)
    const r = findValidDefaultModel()
    expect(r.result).toEqual({ provider: 'aggregation', modelId: 'glm-route' })
    expect(r.wasFixed).toBe(false)
  })

  it('非 pass-through 回归：物理模型默认照常走既有主路径（有效直返 / 无效 auto-fix）', () => {
    writeModels({ 'my-phys': { name: 'phys', apiKey: 'k', models: [{ id: 'm1' }] } })
    writeSettings('my-phys', 'm1')
    initAggregationRouteAvailabilityCheck(() => true)
    // 有效物理默认直接返回（既有行为，注入器不改变非聚合分支）
    expect(findValidDefaultModel()).toEqual({
      result: { provider: 'my-phys', modelId: 'm1' },
      wasFixed: false,
    })
    // 无效物理默认（模型不在 provider 集内）照常 auto-fix 到该 provider 首个模型
    writeSettings('my-phys', 'ghost-model')
    const fixed = findValidDefaultModel()
    expect(fixed.result).toEqual({ provider: 'my-phys', modelId: 'm1' })
    expect(fixed.wasFixed).toBe(true)
  })
})
