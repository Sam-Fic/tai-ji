/**
 * gen-stats-model-keys 单元测试（2026-11-23 路由命名空间修复，设计见
 * /tmp/genstats-agg-route/docs/design.md 与 fact-check A1/A3/A4/A5/A15/A16）。
 *
 * 覆盖点：
 * - `expandModelKeys`：物理 key 恒等 / 单成员路由 / 多成员路由 / 成员去重 / 路由不存在回落
 *   恒等 / 无成员回落恒等 / 空 provider·modelId 跳过 / id 前缀相近不误匹配；
 * - `modelKeyCovers`：物理 owner 只覆盖自身 / 路由 owner 覆盖成员 / 不相干 key 不覆盖；
 * - `modelKeysRelated`：双向（槽存虚拟 key 的反向命中）/ 物理对物理退化为全等。
 *
 * 纯函数层：零 IO、零时钟、零数据目录依赖（fs-guard 红线与本文件无关）。
 */
import { describe, expect, it } from 'vitest'
import type { AggregationRoute } from '@taiji/shared'
import { expandModelKeys, modelKeyCovers, modelKeysRelated } from '../gen-stats-model-keys.js'

/** 最小合法路由 fixture（只填展开层消费的字段，其余按 schema 给默认值） */
function makeRoute(id: string, members: Array<[providerId: string, modelId: string]>): AggregationRoute {
  return {
    id,
    name: id,
    modelId: id,
    enabled: true,
    mode: 'simple',
    members: members.map(([providerId, modelId], index) => ({
      id: `m${index}`,
      providerId,
      modelId,
      type: 'none',
    })),
    specials: [],
  }
}

const ROUTES: readonly AggregationRoute[] = [
  makeRoute('glm-flash', [['zai-coding-cn', 'glm-5.3-flash']]),
  makeRoute('deepseek-flash', [['opendesign', 'deepseek-v4.1-flash']]),
  makeRoute('dual', [
    ['zai-coding-cn', 'glm-5.3'],
    ['opendesign', 'deepseek-v4.1-flash'],
    ['zai-coding-cn', 'glm-5.3'], // 重复成员：去重
  ]),
]

describe('expandModelKeys（虚拟 key → 成员物理 key 集）', () => {
  it('物理 key（非 aggregation 前缀）恒等返回自身', () => {
    expect(expandModelKeys('zai-coding-cn/glm-5.3-flash', ROUTES)).toEqual(['zai-coding-cn/glm-5.3-flash'])
    expect(expandModelKeys('faux/faux-1', ROUTES)).toEqual(['faux/faux-1'])
  })

  it('单成员路由展开为该成员物理 key', () => {
    expect(expandModelKeys('aggregation/glm-flash', ROUTES)).toEqual(['zai-coding-cn/glm-5.3-flash'])
    expect(expandModelKeys('aggregation/deepseek-flash', ROUTES)).toEqual(['opendesign/deepseek-v4.1-flash'])
  })

  it('多成员路由展开为全部成员（保持声明顺序 + 重复成员去重）', () => {
    expect(expandModelKeys('aggregation/dual', ROUTES)).toEqual([
      'zai-coding-cn/glm-5.3',
      'opendesign/deepseek-v4.1-flash',
    ])
  })

  it('路由不存在（已删除 / 配置损坏返回 []）→ 恒等退化，行为与修复前一致', () => {
    expect(expandModelKeys('aggregation/deleted-route', ROUTES)).toEqual(['aggregation/deleted-route'])
    expect(expandModelKeys('aggregation/glm-flash', [])).toEqual(['aggregation/glm-flash'])
  })

  it('路由存在但无可用成员（空数组 / 成员字段空串）→ 恒等退化', () => {
    const empty: readonly AggregationRoute[] = [makeRoute('empty', [])]
    expect(expandModelKeys('aggregation/empty', empty)).toEqual(['aggregation/empty'])

    const broken = [makeRoute('broken', [['', 'mdl']])]
    expect(expandModelKeys('aggregation/broken', broken)).toEqual(['aggregation/broken'])
  })

  it('provider 段相近的前缀不误匹配（只认 aggregation/ 前缀）', () => {
    expect(expandModelKeys('aggregation-like/route', ROUTES)).toEqual(['aggregation-like/route'])
    expect(expandModelKeys('aggregation/', ROUTES)).toEqual(['aggregation/'])
  })
})

describe('modelKeyCovers（广播反向寻址判定）', () => {
  it('物理 owner 只覆盖自身成员 key', () => {
    expect(modelKeyCovers('zai-coding-cn/glm-5.3-flash', 'zai-coding-cn/glm-5.3-flash', ROUTES)).toBe(true)
    expect(modelKeyCovers('zai-coding-cn/glm-5.3-flash', 'zai-coding-cn/glm-5.3', ROUTES)).toBe(false)
  })

  it('路由 owner 覆盖名下每个成员（多端点路由的任一成员采样都能推到该 sid）', () => {
    expect(modelKeyCovers('aggregation/dual', 'zai-coding-cn/glm-5.3', ROUTES)).toBe(true)
    expect(modelKeyCovers('aggregation/dual', 'opendesign/deepseek-v4.1-flash', ROUTES)).toBe(true)
    expect(modelKeyCovers('aggregation/dual', 'unrelated/model', ROUTES)).toBe(false)
  })

  it('路由 owner 不覆盖其他路由的成员（路由隔离）', () => {
    expect(modelKeyCovers('aggregation/glm-flash', 'opendesign/deepseek-v4.1-flash', ROUTES)).toBe(false)
  })

  it('路由不存在时退化为字符串全等（配置缺失不误推帧）', () => {
    expect(modelKeyCovers('aggregation/deleted', 'zai-coding-cn/glm-5.3', [])).toBe(false)
    expect(modelKeyCovers('aggregation/deleted', 'aggregation/deleted', [])).toBe(true)
  })
})

describe('modelKeysRelated（current 槽归属判定）', () => {
  it('会话权威 = 虚拟 key、槽 = 成员物理 key → 命中（主修复场景）', () => {
    expect(modelKeysRelated('aggregation/deepseek-flash', 'opendesign/deepseek-v4.1-flash', ROUTES)).toBe(true)
  })

  it('反向：槽存虚拟 key、会话权威是物理 key（pi 少量通路）→ 命中', () => {
    expect(modelKeysRelated('opendesign/deepseek-v4.1-flash', 'aggregation/deepseek-flash', ROUTES)).toBe(true)
  })

  it('物理对物理：退化为字符串全等（无关物理模型不串台）', () => {
    expect(modelKeysRelated('zai-coding-cn/glm-5.3', 'zai-coding-cn/glm-5.3', ROUTES)).toBe(true)
    expect(modelKeysRelated('zai-coding-cn/glm-5.3', 'zai-coding-cn/glm-5.3-flash', ROUTES)).toBe(false)
  })

  it('不同路由 / 路由与其非成员物理模型 → 不命中', () => {
    expect(modelKeysRelated('aggregation/glm-flash', 'aggregation/dual', ROUTES)).toBe(false)
    expect(modelKeysRelated('aggregation/glm-flash', 'opendesign/deepseek-v4.1-flash', ROUTES)).toBe(false)
  })
})
