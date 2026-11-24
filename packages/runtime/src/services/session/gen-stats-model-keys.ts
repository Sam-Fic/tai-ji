/**
 * gen-stats-model-keys.ts — gen-stats 模型 key 命名空间展开层（provider-aggregation 虚拟路由适配）。
 *
 * 失配形态（prod 实机证据见 fact-check A20/A21）：采样按 assistant 消息自带**物理**
 * `provider/model` 落盘（gen-stats-service recordSample），而会话权威 modelKey 在路由
 * 会话是**虚拟** `aggregation/<routeId>`——pi 只让本次请求用物理模型、会话状态留虚拟模型
 * （agent-session.js isVirtualModel 分支，逐字引文锚点 = node_modules/@earendil-works/
 * pi-coding-agent/dist/core/agent-session.js:445-447：「The selection stays in agent state;
 * only this request uses the routed model」，版本经 npm ls 核对 = 1.0.0）。current 匹配 /
 * 窗口聚合 / 广播反向寻址三处若按字符串
 * 全等，路由会话恒失配：帧值全 null，前端「无值不占位」裁决整钮不渲染。
 *
 * 本模块 = 三处失配的统一解法：「虚拟 key → 成员物理 key 集」展开 + 复合 key 切分规则的
 * 单一持有者。纯函数、零 IO、零时钟、零副作用——路由配置快照由调用方每操作读一次传入
 * （不建 TTL 缓存 / 文件 watcher，ADR-0190 禁时间推测与监视存储模拟实时；**同一次同步
 * 操作内**的跨组去重由调用方备忘录完成，见 broadcastModel）。读放大量级（每操作 1 次
 * providers.json + 每聚合 3N 次成员文件同步读）与代价登记见 design.md 非功能表。
 *
 * 退化语义（显式，api.md 同款）：非虚拟 key 恒等返回自身；虚拟 key 解析不到路由定义
 * （快照为空 = 配置缺失/损坏已被 store quarantine / 路由此刻不存在 / 成员展开为空）→ 恒等
 * 退化——指标回落 null 而非抛错，配置域故障不升级成指标域异常（config 域呈报归 store
 * quarantine 通道，指标域不二次爆炸）。
 *
 * 成员过滤（prune F1/F6）：providers.json 的 members[].providerId/modelId 只有「非空
 * 字符串」一道类型级校验（extension-protocol hasNonEmptyRefFields）——本次改动第一次把
 * 用户可编辑配置文本变成复合 key 与文件路径的生产者，故在产 key 后过滤不满足
 * splitModelKey 可逆不变量的成员（providerId 含 '/' / 复合 key round-trip 不等 / 端点
 * 指向聚合保留 id 的嵌套路由），跳过该成员而非抛错（与悬空成员天然忽略同语义）。
 */

import { AGGREGATION_PROVIDER_ID, aggregationRouteIdFromRef } from '@taiji/shared'
import type { AggregationRoute } from '@taiji/shared'
import { parseModelSelector } from '@zhushanwen/subagent-core'

/**
 * modelKey → (provider, model)。modelKey 统一为复合 id `${provider}/${model}`：
 * 与 state_changed payload.modelId、switchModel 生效值读回（'provider/id'）同构；
 * 取首个 '/' 切分（provider id 不含 '/'；model id 含 '/' 时剩余段整体归 model，
 * 两侧生产方拼接规则一致 → 复合 key 可逆）。无 '/'（理论不可达，防御）→ 整体作 model。
 *
 * 可逆性不变量（prune F1）：pi AssistantMessage 的 provider/model 由上游保证满足
 * 「provider 无 '/'」（锚点 = pi 规范形 `${model.provider}/${model.id}` + 首 '/' 切分，
 * dist/core/model-resolver.js:83/321-328）；路由成员字段由用户配置产生、不满足该保证——expandModelKeys 的
 * 成员过滤以本函数的 round-trip 为判据（见 isExpandableMember）。
 */
export function splitModelKey(modelKey: string): { provider: string; model: string } {
  // 切分规则单点 = core 的 parseModelSelector（首 '/' 切分；model 侧可含 '/'）。
  const { provider, id } = parseModelSelector(modelKey)
  return { provider, model: id }
}

/** 成员 ref → 物理复合 key（与 splitModelKey 的切分规则同构拼接）。 */
function memberKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/**
 * 成员是否可安全展开为复合 key（prune F1/F6 过滤判据，三条全过才收）：
 * ① providerId 非空且不含 '/'——splitModelKey 的首 '/' 切分把 provider 段定义为
 *    「第一个 '/' 前的全部」，providerId 含 '/' 的成员会别名到别的 (provider, model)；
 * ② 复合 key round-trip 可逆——挡住 modelId 带 `:thinkingLevel` 选择器后缀等会被
 *    parseModelSelector 剥离/改写的形态（'faux/glm:xhigh' → 'faux/glm' ≠ 原 key）；
 * ③ providerId ≠ AGGREGATION_PROVIDER_ID——读侧不消费嵌套路由端点（写侧
 *    validateAggregationRouteUpsert 早已拒，读侧对齐同一谓词）。
 */
function isExpandableMember(providerId: string, modelId: string): boolean {
  if (providerId === '' || modelId === '') return false
  if (providerId.includes('/')) return false
  if (providerId === AGGREGATION_PROVIDER_ID) return false
  const key = memberKey(providerId, modelId)
  const { provider, model } = splitModelKey(key)
  return memberKey(provider, model) === key
}

/**
 * modelKey → 读取/匹配/寻址用的物理 key 集（保序去重）：
 * - 非虚拟 key（物理 `provider/model`）→ `[modelKey]`（恒等，直连会话零回归）；
 * - 虚拟 key（`aggregation/<routeId>`，ref 格式 SSOT = shared buildAggregationModelRef）
 *   → 该路由 members 的 `<providerId>/<modelId>` 集（不可展开成员跳过，见 isExpandableMember）；
 * - 解析不到路由定义 / 展开后为空 → `[modelKey]`（恒等退化；不返回空集——空集会让调用方
 *   「无文件可读」与「无路由定义」两种语义混淆，恒等保降级链逐字不变）。
 *
 * 匹配键 = `route.id`（虚拟模型 ref 由 buildAggregationModelRef(route.id) 生成，
 * route-orchestration.ts:69 与 virtual-model-definitions.ts:64 同键；modelId 字段当前
 * 恒与 id 同值生成，不作为匹配键）。
 */
export function expandModelKeys(modelKey: string, routes: readonly AggregationRoute[]): string[] {
  const routeId = aggregationRouteIdFromRef(modelKey)
  if (routeId === undefined) return [modelKey]
  const route = routes.find((r) => r.id === routeId)
  if (route === undefined) return [modelKey]
  // Set 去重（保序）：同 provider+model 重复成员只留一个 key——防并集双算与同文件重复读
  const keys = new Set<string>()
  for (const member of route.members) {
    if (!isExpandableMember(member.providerId, member.modelId)) continue
    keys.add(memberKey(member.providerId, member.modelId))
  }
  return keys.size > 0 ? [...keys] : [modelKey]
}

/**
 * 成员读取计划（MF-1）：key 集 → 按**解析文件路径**去重后的 (key, filePath) 序列（保序）。
 *
 * 为什么需要：不同成员 key 可能别名到**同一文件**——safeModelFileName 的 raw 串 =
 * `${provider}__${model}` 拼接 + sha256，`('faux','x__y')` 与 `('faux__x','y')` 恒同文件。
 * expandModelKeys 的 Set 按 key 字符串去重覆盖不到文件名层别名；并集读若按 key 逐个 merge，
 * 同一份日记录会二次进窗口（样本量翻倍——分布口径对精确翻倍不敏感故帧上不可观测，但属
 * 概念性双算，且任何未来暴露计数/权重的度量都会被扭曲）。pathOf 注入使判据可单测锁死。
 */
export function planMemberReads(
  keys: readonly string[],
  pathOf: (provider: string, model: string) => string,
): Array<{ key: string; filePath: string }> {
  const plan: Array<{ key: string; filePath: string }> = []
  const seen = new Set<string>()
  for (const key of keys) {
    const { provider, model } = splitModelKey(key)
    const filePath = pathOf(provider, model)
    if (seen.has(filePath)) continue
    seen.add(filePath)
    plan.push({ key, filePath })
  }
  return plan
}
