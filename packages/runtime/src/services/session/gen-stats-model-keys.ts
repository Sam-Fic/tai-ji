/**
 * gen-stats-model-keys.ts — 生成指标的模型 key 命名空间展开层（纯函数族：无 IO、无时钟、
 * 无副作用）。
 *
 * 为什么需要这一层（2026-11-23 修复，根因 = 两套命名空间不互通）：
 * 采样按 assistant 消息自带的**物理**模型分桶（`provider/model`，pi 在虚拟模型选择下
 * 只有「本次请求」用物理模型——PS-100），而会话权威模型（`session.getState`
 * / state_changed / JSONL model_change）是**虚拟**路由 key（`aggregation/<routeId>`）。
 * 三处消费（current 匹配 / 窗口聚合 / 广播反向寻址）各自内联 `===` 字符串全等时，
 * 路由会话的 current 与窗口聚合全 null，前端按「空值不占位」裁决整钮不渲染——功能静默失效。
 *
 * 解法：读侧加一层「虚拟 key → 成员物理 key 集」展开，物理采样落盘零改动（虚拟 key 消息
 * 属 PS-101 路由失败通路——该类样本现接线管道不可达：适配层 totalTokens gate 把 failure
 * turn〔usage 全 0〕先于采样丢弃；gen-stats-service 对虚拟 key 的豁免分支为漂移防御）。
 * 三处统一走本模块同一纯函数，命名空间规则只有一个落点（防止再次三处各自内联漂移）。
 *
 * 边界与降级（逐条自述如下）：
 *   - 非 `aggregation/*` key 恒等返回自身（物理模型直连路径零变化，G3）；
 *   - 路由不存在 / 已删除 / 配置损坏返回 `[]`（store 已 quarantine）→ 恒等退化（指标回落
 *     null 而非抛错，不把配置域故障升级成指标域异常）；
 *   - 只展开一层：路由端点不允许引用另一条路由（`route_member_nested` 保存校验拒绝），
 *     故不做递归，也不为嵌套形态引入未定义语义；
 *   - 成员去重：同一 `provider/model` 出现在多个端点时只算一次（多端点同模型不重复计量）。
 *
 * 读取纪律：路由配置快照由调用方「每次操作读一次」后下钻传入（GenStatsService 的
 * `routeSnapshot()`），本模块不持缓存、不建文件监听（ADR-0190 / ADR-0122：禁时间与监视
 * 存储模拟实时）。
 */

import type { AggregationRoute } from '@taiji/shared'
import { aggregationRouteIdFromRef, isAggregationModelRef } from '@taiji/shared'

/** 路由配置快照读取端口（组合根注入 `providerExtrasStore.getAggregationRoutesSync`）。 */
export type ReadAggregationRoutes = () => readonly AggregationRoute[]

/**
 * 复合 model key → 该 key 计量归属的物理模型 key 集（一次操作内多次调用的纯函数）。
 *
 *  - 物理 key（非 `aggregation/` 前缀）→ `[自身]`（恒等）；
 *  - 路由 key 且路由存在 → 成员 `providerId/modelId` 去重集；
 *  - 路由不存在 / 无成员 / key 形态异常 → `[自身]`（降级为修复前行为）。
 *
 * 返回数组顺序 = 路由 members 声明顺序（调用方只做与顺序无关的并集/成员判定）。
 */
export function expandModelKeys(modelKey: string, routes: readonly AggregationRoute[]): readonly string[] {
  if (!isAggregationModelRef(modelKey)) return [modelKey]
  const routeId = aggregationRouteIdFromRef(modelKey)
  if (routeId === undefined) return [modelKey]
  const route = routes.find((candidate) => candidate.id === routeId)
  if (route === undefined) return [modelKey]
  const keys: string[] = []
  const seen = new Set<string>()
  for (const member of route.members) {
    if (member.providerId === '' || member.modelId === '') continue
    const key = `${member.providerId}/${member.modelId}`
    if (seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys.length === 0 ? [modelKey] : keys
}

/**
 * `ownerKey` 是否覆盖 `targetKey`（广播反向寻址判定：该 sid 的权威 key 是否应因本次
 * `targetKey` 的采样而收到帧）。
 *
 * 语义 = `targetKey ∈ expandModelKeys(ownerKey)`：物理 owner 只覆盖自身；路由 owner 覆盖
 * 全部端点成员。两侧不相等但同属一个路由时命中——这正是「路由会话收不到自己帧」的修复点。
 */
export function modelKeyCovers(
  ownerKey: string,
  targetKey: string,
  routes: readonly AggregationRoute[],
): boolean {
  if (ownerKey === targetKey) return true
  if (!isAggregationModelRef(ownerKey)) return false
  return expandModelKeys(ownerKey, routes).includes(targetKey)
}

/**
 * 两个 key 是否指向同一计量对象（current 槽归属判定：会话权威 key × 采样槽 key）。
 *
 * 对称形态 = `modelKeyCovers(a,b) || modelKeyCovers(b,a)`：
 *   - 会话权威 = 虚拟路由 key、槽 = 成员物理 key → 正向命中（主场景）；
 *   - 反向（槽 = 虚拟 key：pi 极少数通路把会话选择写进消息自身——路由失败 turn 的
 *     failureMessage 自带 `aggregation/<routeId>`，PS-101）也命中——漂移防御：该类样本
 *     现接线管道不可达（适配层 totalTokens gate 把 failure turn 先于采样丢弃，PS-101），
 *     保留反向命中以防 pi 未来 failure usage 非 0 时样本重新可达。
 *
 * 两侧都是物理 key 时退化为字符串全等（恒等展开），与修复前逐字一致。
 */
export function modelKeysRelated(
  a: string,
  b: string,
  routes: readonly AggregationRoute[],
): boolean {
  if (a === b) return true
  return modelKeyCovers(a, b, routes) || modelKeyCovers(b, a, routes)
}
