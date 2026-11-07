/**
 * provider-config-helper 路由视图读取侧单测（provider-aggregation U1 读取半边）。
 *
 * 守护两个导出函数（本分支新增行的覆盖率缺口来源）：
 * - buildValidModelIndex：有效模型索引构建（catalog 候选 = authIds ∪ models.json catalog
 *   keys；custom 条目 = models.json 非 catalog 键，空 models 走 builtin 兜底分支）；
 * - readAggregationRoutes：routes 域读取入口（routes/scopedModels/orphanRefs/memberIssues/
 *   corrupted 一次带出；validModels 注入复用与现算双形态）。
 *
 * 装配同 provider-extras-store.test.ts 先例：真实文件型 store + mkdtemp 临时目录，
 * 零网络零进程。
 */
import { PiConfigStore } from '../../infra/pi/pi-config-store.js';
import { setModelsPath } from '../../infra/pi/pi-provider-store.js';
import { invalidateSettingsCache, setSettingsPath } from '../../infra/pi/pi-settings-store.js';
import type { AggregationRoute } from '@taiji/shared';
import { AGGREGATION_PROVIDER_ID, buildAggregationModelRef } from '@taiji/shared';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildValidModelIndex, readAggregationRoutes } from '../provider-config-helper.js';
import { TaijiProviderStore } from '../provider-extras-store.js';

let dir: string
let agentDir: string
let extrasPath: string
let extrasStore: TaijiProviderStore
let configStore: PiConfigStore

const cleanupDirs: string[] = []

function writeModelsJson(providers: Record<string, unknown>): void {
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }, null, 2))
}

/** 构造合法路由条目 fixture（形态同 shared aggregation.test.ts makeRoute）。 */
function makeRoute(overrides: Partial<AggregationRoute> = {}): AggregationRoute {
  return {
    id: 'glm-flash',
    name: 'GLM Flash',
    modelId: 'glm-flash',
    enabled: true,
    mode: 'advanced',
    members: [
      { id: 'ep-1', providerId: 'deepseek', modelId: 'deepseek-chat', type: 'none' },
    ],
    specials: [],
    ...overrides,
  }
}

/** 凭据 id 列举桩（buildValidModelIndex 只消费 listCredentialIds 一个成员）。 */
function authStorageStub(ids: string[]): { listCredentialIds: () => string[] } {
  return { listCredentialIds: () => ids }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-config-helper-route-view-'))
  cleanupDirs.push(dir)
  agentDir = join(dir, 'agent')
  mkdirSync(join(agentDir, 'config'), { recursive: true })
  process.env.TAIJI_AGENT_DATA_DIR = dir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  invalidateSettingsCache()
  extrasPath = join(agentDir, 'config', 'providers.json')
  extrasStore = new TaijiProviderStore(extrasPath)
  configStore = new PiConfigStore()
})

afterEach(() => {
  delete process.env.TAIJI_AGENT_DATA_DIR
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('buildValidModelIndex', () => {
  it('catalog 候选：authIds 注入的 catalog id + models.json catalog 键都进索引', () => {
    writeModelsJson({
      // catalog 键（deepseek 在 builtin-providers.json，isCatalogProvider 命中）带 override 模型
      deepseek: { name: 'DeepSeek', models: [{ id: 'deepseek-chat' }] },
      // 非 catalog 键（custom）走第二循环
      'my-gateway': { name: 'My Gateway', models: [{ id: 'm1' }, { id: 'm2' }] },
    })
    const index = buildValidModelIndex(configStore, authStorageStub(['anthropic']))
    // authIds 侧候选（anthropic 为 builtin catalog id；测试环境无快照/overlay，模型集允许为空集）
    expect(index.get('anthropic')).toBeInstanceOf(Set)
    // models.json catalog 键候选：合并视图 + override 模型
    expect(index.get('deepseek')?.has('deepseek-chat')).toBe(true)
    // custom 条目：models.json 用户模型进集合
    expect(index.get('my-gateway')?.has('m1')).toBe(true)
    expect(index.get('my-gateway')?.has('m2')).toBe(true)
  })

  it('custom 条目 models 为空：builtin 兜底分支执行（非 builtin id 得空集，不抛错）', () => {
    writeModelsJson({ 'bare-gateway': { name: 'Bare' } })
    const index = buildValidModelIndex(configStore)
    expect(index.get('bare-gateway')).toBeInstanceOf(Set)
    expect(index.get('bare-gateway')?.size).toBe(0)
  })

  it('authStorage 未传：authIds 退化为空集（读路径不要求凭据通道）', () => {
    writeModelsJson({ 'solo-gateway': { name: 'Solo', models: [{ id: 'solo-m' }] } })
    const index = buildValidModelIndex(configStore)
    expect(index.get('solo-gateway')?.has('solo-m')).toBe(true)
    expect(index.has('anthropic')).toBe(false)
  })
})

describe('readAggregationRoutes', () => {
  it('正常路径：routes/scopedModels/orphanRefs/memberIssues 一次带出（悬空端点两类标记）', async () => {
    writeModelsJson({
      deepseek: { name: 'DeepSeek', models: [{ id: 'deepseek-chat' }] },
    })
    const validRoute = makeRoute()
    const danglingProviderRoute = makeRoute({
      id: 'ghost-provider-route',
      modelId: 'ghost-provider-route',
      members: [{ id: 'ep-2', providerId: 'deleted-provider', modelId: 'any-model', type: 'none' }],
    })
    const danglingModelRoute = makeRoute({
      id: 'ghost-model-route',
      modelId: 'ghost-model-route',
      members: [{ id: 'ep-3', providerId: 'deepseek', modelId: 'removed-model', type: 'none' }],
    })
    await extrasStore.modifyAggregationRoutes(() => [validRoute, danglingProviderRoute, danglingModelRoute])
    await extrasStore.modifyScopedModels((current) => [
      ...current,
      buildAggregationModelRef('glm-flash'),
      `${AGGREGATION_PROVIDER_ID}/ghost-route`,
    ])

    const result = readAggregationRoutes(configStore, extrasStore, { authStorage: authStorageStub([]) })
    expect(result.routes).toHaveLength(3)
    expect(result.scopedModels).toContain(buildAggregationModelRef('glm-flash'))
    // 失效引用：聚合保留 id 段但解析不到路由定义（有效引用不算 orphan）
    expect(result.orphanRefs).toEqual([`${AGGREGATION_PROVIDER_ID}/ghost-route`])
    // 悬空端点两类：provider 不在索引 / 模型不在其集合
    expect(result.memberIssues).toContainEqual({
      routeId: 'ghost-provider-route',
      memberIndex: 0,
      memberRef: 'deleted-provider/any-model',
      reason: 'provider-deleted',
    })
    expect(result.memberIssues).toContainEqual({
      routeId: 'ghost-model-route',
      memberIndex: 0,
      memberRef: 'deepseek/removed-model',
      reason: 'model-removed',
    })
    expect(result.corrupted).toBe(false)
    expect(result.corruptedFilePath).toBeUndefined()
  })

  it('validModels 注入复用：options.validModels 优先于现算（保存/读取同一索引防漂移形态）', async () => {
    await extrasStore.modifyAggregationRoutes(() => [makeRoute()])
    // 注入的索引不含 deepseek → 端点判悬空（证明用了注入索引而非现算）
    const injected = new Map<string, ReadonlySet<string>>([['only-injected', new Set(['x'])]])
    const result = readAggregationRoutes(configStore, extrasStore, { validModels: injected })
    expect(result.memberIssues).toContainEqual({
      routeId: 'glm-flash',
      memberIndex: 0,
      memberRef: 'deepseek/deepseek-chat',
      reason: 'provider-deleted',
    })
  })

  it('corrupted：extras 文件损坏被隔离 → corrupted=true + 隔离副本路径呈报', () => {
    writeFileSync(extrasPath, '{ not valid json', 'utf-8')
    const result = readAggregationRoutes(configStore, extrasStore)
    expect(result.corrupted).toBe(true)
    expect(result.corruptedFilePath).toBeDefined()
    expect(result.corruptedFilePath).toContain('.corrupt-')
    // 隔离后路由域按空继续（读路径不中断）
    expect(result.routes).toEqual([])
  })
})
