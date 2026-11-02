// src/execution/notify/notify-reconcile.ts
//
// 通知对账补投（completion-signal-delivery 设计 D5：subagent 域一次性终态通知的
// 补投载体 = record 终态事实源 + 维护链三入口，与 bash 域 pending-reconcile 同构
// 判据、不并入其实现——「主路径不发者排除」的排除位语义随域参数化）。
//
// 三重磁盘事实判据（bash 域 pending-reconcile 同构）：
//   候选 = record 收尾位命中 ∧ 排除位未命中 ∧ 送达痕迹未命中 ∧ 投递日志无该幂等键条目
//
// 候选状态位（isReconcileCandidateRecord，域侧单一落点）覆盖两形态：
//   - legacy closed 终态存量：idle ∧ closedReason 有值（isLegacyClosedSettled 命中
//     形态——close 归档提示的补投对象）；
//   - 轮终收尾 idle（永久会话两态模型的现行收尾位，canvas reviewer 等 one-shot 成员
//     的完成形态）：idle ∧ closedReason 无值 ∧ 停因非宿主中断/重开族（NEW_STOP_
//     REASONS 排除——取消轮不产生完成通知，重启打断/编排性关闭/reopen 同理，主路径
//     不发者排除与 V10 成因位同原理）。markRoundIdle 是该形态唯一写点（成功/失败轮
//     统一落 idle + 引擎停因），补投补的是该轮完成信号（payload 按终态形态构造、
//     outcome 经 deriveOutcome 单一权威派生——失败轮如实落 failed 文案，不谎报）。
//   送达痕迹判定分形态 + 世代匹配（F1-13 结论 A：epoch 透传后三通道全按世代判定，
//   旧世代在册条目不阻断新世代查询）：
//     - legacy closed 形态查裸键（notifyId/deliveryId——同 record 的轮次条目不得
//       阻断 close 归档提示补投；可达集内该形态恒世代 0，跨世代不适用）；
//     - 轮终收尾形态扩位到 record 级（details.id + details.epoch 世代匹配——主路径
//       轮次应答已送达 = 完成信号已在会话；按裸 id 无世代查询会命中旧世代条目，
//       reopen 后误阻断新世代完成信号）。键通道（notifyId/deliveryId）同样世代
//       匹配：世代 0 轮次键 `id:round` 与世代 e 终态键 `id:epoch` 存在字符串同形
//       （`x:1` 双义），只有条目侧世代字段（payload.epoch 透传）能消歧。
//   主路径 rejected 时条目未落盘、痕迹未命中，补投可达。跨边沿防重由投递日志幂等
//   键判重承担（补投键 = `id[:epoch]` 终态键，首轮补投受理后 outbox 条目使后续
//   边沿 journaled 按世代命中）。
//
// 两个排除位（D5 裁决，「主路径不发者排除」原理）：
//   排除位一（成因位，全 origin）：closedReason="cancelled" → 非候选。现行该成因
//   写点收敛于 settleWorkflowRecord 契约（全 workflow origin 前置）且 origin gate 对
//   workflow origin 回注全静默（notify-host toNotifyRecord 单漏斗）——主路径对
//   cancelled 成因不发任何通知（notifier buildLlmContent 的 cancelled 文案分支是旧
//   CAS 终态化时代遗留、现行无产生路径）；成因位按全 origin 落位还封住磁盘存量的
//   历史遗留形态（旧 CAS 时代取消对全部 background record 写 closed+cancelled、不限
//   origin，经 manifest 重建恢复 closedReason 且 binding 缺失时 origin 缺席——不在
//   排除位二覆盖内）。该形态三重判据会全命中误报候选，补投将投出主路径本就不发的
//   「Subagent … cancelled.」通知（V10 行为锁锁定对话流无的形态）。
//   排除位二（origin 位）：origin="workflow" 的终态 record 整体排除（cancelled 与 gc
//   皆然）——成员结果由脚本返回值承载、对父回合隐藏是 origin gate 的既有裁决；run
//   收尾通知由 subagent-workflow 域 wf-done 承载；无主路径同构 payload 可构造。
//   轮级停因（lastRound stopReason aborted）是轮应答文案输入、非判据输入——判据只
//   消费 record 终态；轮次通知（round 键）有下一轮边沿自然重发，不属补投对象
//   （设计范围外②）。
//
// 与 bash 域共享判据语义的载体关系：三重事实骨架与幂等键提取在
// base-tool-enhance background/notify-reconcile-judgement.ts 单源登记（u1 抽出）。
// core 是跨宿主包，extensions 层不可反向依赖（core/notify-ports.ts 文件头闭包红线：
// 依赖方向 core ← extensions），物理 import 不可达——本文件的骨架与收集器按同构
// 形态落位，真值组合与字段结构逐一锚定该单源；漂移防线 = 两域真值表测试
// （u3/u1 各自）+ 全量测试门对账。口径差异显式登记：本域幂等键提取用宽容口径
// （entry.data.id 直读 + payload.details.epoch 世代读取，见 collectJournaledDeliveryGenerations
// 注释），方向保守（误判无条目
// → 补投被 port 幂等吞并，无实害）。
//
// 入口形态（D5/D7② 三入口同构，编排互调本文件的唯一对账函数 runNotifyReconcileMaintenance）：
//   ① session_start——notify-host revive()（SubagentService.initSession 链内无条件调用）；
//   ② agent_settled——notify-host 装配期经 pi.on 订阅（回合收尾兜底边沿）；
//   ③ 切回补强（__taiji_bg_reconcile__）——pi 命令名全局唯一（base-tool-enhance 注册），
//     core 包内无触发源，生产接线 = 扩展侧经 Service 单例转发（SubagentService.
//     runNotifyReconcileMaintenance → NotifyHost.runReconcile）调本编排函数
//     （reason="resume"）；本包导出供自装配 source 的宿主直调，非生产接线通道。
//   编排对三入口完全一致（判据单一）；跨边沿双投由 port 幂等预检吞并（同键先到者
//   登记，rejected 时幂等键未登记——补投是该键首次有效投递）。

import * as fs from "node:fs";

import { getLogger } from "../../core/logger.ts";
import { isLegacyClosedSettled } from "../persistence/execution-record.ts";
import {
  foldRecordEvents,
  parseRecordEventFileLine,
  recordEventsPath,
  type RecordEvent,
} from "../persistence/record-events.ts";
import type { ClosedReason, ExecutionStatus, RecordOrigin, StopReason } from "../domain/record-types.ts";
import { NEW_STOP_REASONS } from "../domain/record-types.ts";
import { buildNotifyId, type BgNotifyRecord } from "./notifier.ts";

const logger = getLogger("subagents");

/**
 * 对账扫描的 record 上界（queries.collectRecords 的 limit 截断参数，生产装配消费）。
 * 会话内 record 数百级；limit 只是 slice（四源合并在截断前已完成），放大该值无
 * 扫描成本差异——取足够大常量防极端膨胀截断（截断尾部 = 最老 record 的 rejected
 * 补投永远排不进；全量扫描语义最干净，检查点结论见 runlog）。
 */
export const NOTIFY_RECONCILE_SCAN_LIMIT = 10_000;

/**
 * 对账侧 record 事实的结构子集（queries.collectRecords 返回的 SubagentRecord 天然
 * 满足；deps 注入形态使编排与 store 形态解耦，单测可造轻量替身）。
 *
 * epoch 字段由生产装配点补齐（resolveReconcileRecordEpoch：内存源 getMutable 直读，
 * 磁盘重建源读 record 事件流 fold）——SubagentRecord 公开面不携带该字段（notify 域
 * 自有投影类型承载，不扩散到 list 读模型）。前版「无 epoch 字段、键恒裸 id」的边界
 * 论证（「epoch>0 的 legacy closed 被 workflow origin 排除位封住」）只覆盖 legacy
 * closed 形态；A4 扩位新增的轮终收尾 idle 形态在 reopen 过的 record（epoch>0）上
 * 可达——补投键裸 id 与主路径 notifyClosed 对同 record 的 `id:epoch` 构造漂移
 * （RL8），且旧世代裸 id 条目在册会经送达痕迹通道误阻断新世代完成信号（F1-13）。
 */
export interface ReconcileNotifyRecord { // oe-exempt:20261101:wip:共享判据骨架先行，域侧第二实现随 u5 两域映射交付

  readonly id: string;
  readonly agent: string;
  readonly model?: string;
  readonly result?: string;
  readonly error?: string;
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
  readonly sessionFile?: string;
  readonly patchFile?: string;
  /** 终态判定（isReconcileCandidateRecord 的状态位输入）。 */
  readonly status: ExecutionStatus;
  readonly closedReason?: ClosedReason;
  /**
   * 轮收尾停因（isReconcileCandidateRecord 的中断/重开族排除位输入；queries.
   * collectRecords 快照直读——内存源 recordToSubagent / 磁盘重建 projectFoldToLight
   * 均投影）。undefined = 被接管轮（promptDisposition=handled，无停因事实）或旧数据
   * ——非中断族，不排除。
   */
  readonly stopReason?: StopReason;
  /**
   * 轮终收条事实快照（结构子集 = SubagentListLastRound 的 result 位）。磁盘重建源
   * （重启后对账的主形态）不恢复顶层 result（fold 投影把轮终 result 放在收条帧
   * lastRound.result——record-store-rebuild lastRoundFromFold），本位是其读侧通道。
   */
  readonly lastRound?: { result?: string };
  readonly origin?: RecordOrigin;
  /** 收尾通知的轮次统计文案输入（notifyClosed 同款——round 置 undefined 后轮数改经此进文案）。 */
  readonly round?: number;
  /**
   * 世代（reopen 防撞维度，§3.2.3）：补投幂等键 `id[:epoch]` 构造与送达痕迹 /
   * 投递日志判据的世代匹配输入。undefined/0 = 世代 0（裸 id 旧格式，磁盘零迁移）。
   *
   * 数据源（生产装配 resolveReconcileRecordEpoch 单点提取）：内存源 ExecutionRecord.
   * epoch 直读；磁盘重建源读 `.events` 事件流 fold（record-bound / record-round-started
   * / record-reopened 三类帧携带 epoch，事件流是唯一事实源）。主 session entry 源与
   * manifest 源不携带该字段——两源只补「扫描缺员的 zcode record」与「重建失败
   * orphan」，这些形态 epoch 缺省按世代 0 语义退化 = 旧格式裸 id 键，行为与透传前
   * 一致（不引入新缺陷）。
   */
  readonly epoch?: number;
}

/**
 * 对账事实源（notify-host 生产装配注入；单测轻量替身）。
 */
export interface NotifyReconcileSource { // oe-exempt:20261101:wip:共享判据骨架先行，域侧第二实现随 u5 两域映射交付

  /** 全量 record（含终态、不过滤 origin——排除位在判据内落位，真值表逐行可测）。 */
  listReconcileRecords(): ReconcileNotifyRecord[];
  /** 当前会话 entries（送达痕迹 + 投递日志两事实源）。 */
  readSessionEntries(): unknown[];
}

/** 单次对账结果（日志 + 测试断言范围）。 */
export interface NotifyReconcileResult { // oe-exempt:20261101:wip:共享判据骨架先行，域侧第二实现随 u5 两域映射交付

  /** 扫描的 record 总数。 */
  scanned: number;
  /** 预检候选数（收尾位 ∧ 排除位未命中）。 */
  candidates: number;
  /** 补投已受理（deliver 返回 accepted/swallowed——swallowed = 幂等命中，已被更早通道送达）的 record id。 */
  redelivered: string[];
  /** 送达痕迹命中而跳过的 record id。 */
  skippedDelivered: string[];
  /** 投递日志条目命中而跳过的 record id。 */
  skippedJournaled: string[];
}

/**
 * 三重事实判据的输入（与 base-tool-enhance notify-reconcile-judgement 的
 * ReconcileNotifyFacts 同构——字段结构逐一锚定；跨包同构的载体关系见文件头）。
 */
export interface ReconcileNotifyFacts { // oe-exempt:20261101:wip:共享判据骨架先行，域侧第二实现随 u5 两域映射交付

  /** 事实一：record 收尾位命中（域事实源判定 = isReconcileCandidateRecord）。 */
  isTerminal: boolean;
  /** 排除位（两排除位的合取）：cancelled 成因（全 origin）∨ workflow origin。真 = 非候选。 */
  excludedByOrigin: boolean;
  /** 事实二：送达痕迹命中（会话 entries 已有该幂等键的通知条目）。 */
  delivered: boolean;
  /** 事实三：投递日志已含该幂等键条目（受理已发生——有条目未送达 = 差集重放职责）。 */
  journaled: boolean;
}

/**
 * 三重事实判据（骨架真值组合：终态 ∧ 未排除 ∧ 无痕迹 ∧ 无日志条目）。
 * 本域对账编排（三入口共用）与补投终判经同一函数消费——判据演化不产生第二套真值逻辑。
 */
export function isReconcileNotifyCandidate(facts: ReconcileNotifyFacts): boolean {
  return facts.isTerminal && !facts.excludedByOrigin && !facts.delivered && !facts.journaled;
}

/**
 * 域侧排除位（D5 两排除位的单一落点）：
 *   成因位（全 origin）closedReason="cancelled" → 排除；origin="workflow" → 整体排除。
 * 其余 ClosedReason 成员（parent-shutdown / parent-fork / parent-new / user-close /
 * gc / disconnected）主路径均有现行终态通知产生路径（notifyClosed 收尾提示文案族），
 * 不在排除位内。
 */
export function isExcludedReconcileRecord(record: {
  closedReason?: ClosedReason;
  origin?: RecordOrigin;
}): boolean {
  return record.closedReason === "cancelled" || record.origin === "workflow";
}

/**
 * 候选状态位（三重判据事实一的域侧单一落点，两形态合取）：
 *   - legacy closed 终态存量：isLegacyClosedSettled（唯一权威谓词，idle ∧ closedReason
 *     有值）——close 归档提示的补投对象，语义不变；
 *   - 轮终收尾 idle：status="idle"（两态模型非活跃位直读——running 轮在途结构性非
 *     idle，即「回合已收尾且无活跃运行迹象」）∧ closedReason 无值 ∧ 停因非
 *     NEW_STOP_REASONS（宿主中断/重开族：interrupted / interrupted-by-restart /
 *     interrupted-by-parent / reopened——取消轮不产生完成通知（record-lifecycle
 *     cancelBackground 单点裁决），重启打断/编排性关闭/reopen 同不发完成通知，按
 *     「主路径不发者排除」原理排除，与成因位（V10）同原理不同落位）。
 *
 * stopReason 非中断/重开族（含 undefined：被接管轮无停因事实 / 旧数据）= 主路径有
 * 该轮应答形态（§3.3.7① 轮应答五分支覆盖），完成信号可经补投恢复。
 *
 * bash 域同构性：两域事实一都是「本域权威状态机的非活跃位直读」（bash = registry
 * 终态枚举；本域 = record 两态 idle 位 + 收尾停因排除位），排除位语义随域参数化
 * （骨架单源见文件头）；域间差异（任务终态 vs 回合收尾）由各自状态机承载，判据
 * 骨架消费方式一致。
 */
export function isReconcileCandidateRecord(record: {
  status: ExecutionStatus;
  closedReason?: ClosedReason;
  stopReason?: StopReason;
}): boolean {
  if (record.status !== "idle") return false;
  if (isLegacyClosedSettled(record)) return true;
  return !NEW_STOP_REASONS.includes(record.stopReason as (typeof NEW_STOP_REASONS)[number]);
}

/**
 * 通知条目的世代索引：幂等键或 record id → 已在册世代集合。
 *
 * 世代 = 条目 payload 的 epoch 字段（BgNotifyRecord 透传，notifier notify 物化）；
 * 缺席/0/非正数归世代 0——世代字段引入前的存量条目恒为世代 0 产物（epoch 是
 * reopen 防撞维度，世代>0 的 record 经主路径构造的 payload 恒携带该字段）。
 * 判据查询按世代命中（generationHit）：旧世代在册条目不阻断新世代查询（F1-13
 * 跨世代误阻断修复的判定基元）。
 */
export type NotifyGenerationIndex = Map<string, Set<number>>;

/** 条目世代读取（details.epoch 正数即世代；缺席/0/畸形归 0）。 */
function generationOf(fields: Record<string, unknown>): number {
  const epoch = fields.epoch;
  return typeof epoch === "number" && epoch > 0 ? epoch : 0;
}

/** 世代索引命中判定（key 在册且世代集合含查询世代）。 */
export function generationHit(index: NotifyGenerationIndex, key: string, epoch: number): boolean {
  return index.get(key)?.has(epoch) ?? false;
}

/** 世代索引收键（单条 details 的一个键位——命中世代并入集合）。 */
function indexGenerationKey(index: NotifyGenerationIndex, key: unknown, gen: number): void {
  if (typeof key !== "string" || key === "") return;
  const set = index.get(key);
  if (set !== undefined) {
    set.add(gen);
    return;
  }
  index.set(key, new Set([gen]));
}

/**
 * 从会话 entries 提取已送达完成通知的幂等键世代索引（送达痕迹判据的事实源——
 * 键通道）。
 *
 * 判定通道两条，任一命中即收：details.notifyId（主路径 payload 携带，notifier notify
 * 物化）/ details.deliveryId（port 受理时统一写入 details 的送达凭据键——与
 * envelope.id 同值）。世代 = details.epoch（payload 透传）。刻意不用 content 文本
 * 兜底、不收 details.id（record id）：
 * content 内的 record id 文本会让轮次条目误命中终态键 → 漏补投。痕迹收集宁滥勿缺
 * （多收集 → 该键漏补投，方向保守——反向误判才产生双投）。
 *
 * 容错对齐 bash 域同款纪律：null/非对象元素跳过；只扫本域 customType 条目
 * （通知词表单源——与非本域条目互斥，调用方传 notifier NOTIFY_CUSTOM_TYPE）。
 */
export function collectDeliveredNotifyGenerations(
  entries: readonly unknown[],
  notifyCustomType: string,
): NotifyGenerationIndex {
  const index: NotifyGenerationIndex = new Map();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (entry.customType !== notifyCustomType) continue;
    const details = entry.details;
    if (details === null || typeof details !== "object") continue;
    const fields = details as Record<string, unknown>;
    const gen = generationOf(fields);
    indexGenerationKey(index, fields.notifyId, gen);
    indexGenerationKey(index, fields.deliveryId, gen);
  }
  return index;
}

/**
 * 从会话 entries 提取「已有完成通知条目在册」的 record id 世代索引（轮终收尾形态的
 * 送达痕迹通道，见文件头「送达痕迹判定分形态」段）。
 *
 * 背景：主路径对轮终收尾形态发的是轮次应答（幂等键 `id[:epoch]:round`），补投键是
 * `id[:epoch]` 终态键——裸键痕迹/投递日志对「主路径已送达」结构性不命中，无本通道时
 * 每个已完成成员会在对账边沿被重复补投。轮次应答条目的 details 携带一等 record id
 * （payload 展开，notifier notify 物化）+ 世代（payload.epoch 透传），按 (details.id,
 * details.epoch) 收集即按世代完整的痕迹——旧世代条目不阻断新世代查询（F1-13：reopen
 * 过的 record 世代 0 旧条目在册时，按裸 id 无世代查询会误阻断新世代完成信号）。
 *
 * 只对轮终收尾形态消费（legacy closed 候选维持裸键判定——同 record 的历史轮次条目
 * 不得阻断 close 归档提示补投，现行语义不变）。收集宁滥勿缺（多收集 → 漏补投，
 * 方向保守；反向误判才产生双投）。容错纪律与 collectDeliveredNotifyGenerations 同款。
 */
export function collectDeliveredRecordGenerations(
  entries: readonly unknown[],
  notifyCustomType: string,
): NotifyGenerationIndex {
  const index: NotifyGenerationIndex = new Map();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (entry.customType !== notifyCustomType) continue;
    const details = entry.details;
    if (details === null || typeof details !== "object") continue;
    const fields = details as Record<string, unknown>;
    indexGenerationKey(index, fields.id, generationOf(fields));
  }
  return index;
}

/**
 * 投递日志已登记幂等键的世代索引（事实三的事实源）。
 *
 * outbox 条目的 payload 是调用方业务原样（delivery-port journal schema v2——notify
 * 域 payload.details 即 BgNotifyRecord，epoch 字段透传），世代随条目可枚举；ack
 * 终局条目结构上只有 id（无世代字段）——归 wildcard 兜底位。
 */
export interface JournaledDeliveryGenerations {
  /** outbox 条目的世代索引（payload.details.epoch 读取；details 缺席的非本域 payload 不入索引）。 */
  readonly generations: NotifyGenerationIndex;
  /**
   * 世代不可判定的条目 id（ack 终局 / outbox 载荷缺 details 的形态）。判定仅在
   * 该键完全无 outbox 世代记录时保守兜底命中（journaledGenerationHit）——outbox
   * 世代记录在场时以世代为准，wildcard 一票阻断会让跨世代消歧失效（同键的旧世代
   * ack 会重新遮住新世代查询，F1-13 修复失效）。
   */
  readonly wildcard: Set<string>;
}

/**
 * 投递日志世代判定：outbox 世代记录在场以世代为准；键完全无 outbox 记录时
 * wildcard（ack 终局 / 载荷缺 details）保守兜底——对齐现行「ack 并入是防御性
 * 冗余」的宽容口径（误判有条目 → 补投被 port 幂等吞并，无实害——方向保守）。
 */
export function journaledGenerationHit(
  journal: JournaledDeliveryGenerations,
  key: string,
  epoch: number,
): boolean {
  const gens = journal.generations.get(key);
  if (gens !== undefined) return gens.has(epoch);
  return journal.wildcard.has(key);
}

/**
 * 从会话 entries 提取投递日志已登记幂等键的世代索引（事实三的事实源）。
 *
 * 宽容口径（与 bash 域经 port 解析单点的实现存在形态分叉，登记见文件头）：outbox
 * 条目 data.id 直读 + payload.details.epoch 世代读取——受理成功必有 outbox 条目
 * （受理前落盘，append-only 契约）。ack 并入 wildcard 兜底位（同次遍历的防御性
 * 冗余，判定语义见 journaledGenerationHit）。v2 data.id 即幂等键；v1 存量的 data
 * 形态可能解析不出（误判「无条目」→ 补投 → port 幂等预检吞并，无实害——方向
 * 对齐「漏补投优于重复投」保守取向）。坏行/畸形 data 跳过。
 */
export function collectJournaledDeliveryGenerations(entries: readonly unknown[]): JournaledDeliveryGenerations {
  const generations: NotifyGenerationIndex = new Map();
  const wildcard = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    // outbox / ack 两类 entry 的 customType 由 port 落盘（本文件不 import port 包，
    // 按值锚定——port 侧词表漂移时本收集器退化为漏收（保守方向），由 port 幂等承接）。
    const customType = entry.customType;
    if (customType !== "delivery-port-outbox" && customType !== "delivery-port-ack") continue;
    const data = entry.data;
    if (data === null || typeof data !== "object") continue;
    const fields = data as Record<string, unknown>;
    const id = fields.id;
    if (typeof id !== "string" || id === "") continue;
    if (customType === "delivery-port-ack") {
      // ack 终局条目无世代字段（schema 只承载 id/outcome）——归兜底位。
      wildcard.add(id);
      continue;
    }
    // outbox：payload.details 携带调用方 payload 原样（notify 域 = BgNotifyRecord，
    // epoch 透传）；details 缺席/畸形（非本域 payload 形态）→ 兜底位（保守对齐
    // 现行「无条件收入即阻断」方向，不猜测世代）。
    const payload = fields.payload;
    const details =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>).details
        : undefined;
    if (details === null || typeof details !== "object") {
      wildcard.add(id);
      continue;
    }
    indexGenerationKey(generations, id, generationOf(details as Record<string, unknown>));
  }
  return { generations, wildcard };
}

/**
 * 从主 session 文件读取会话 entries（宽容口径：逐行 JSON.parse、坏行跳过、文件不可
 * 读返回空——对齐 registry-reconcile collectActiveRegisterEntries 的读侧纪律；落盘
 * 延迟窗口（首条对话消息前未 flush）内文件可能不存在，空读 = 本轮空跑，下一对账
 * 边沿重查）。
 */
export function readSessionEntriesFromFile(sessionFile: string | undefined): unknown[] {
  if (!sessionFile) return [];
  let content: string;
  try {
    content = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return [];
  }
  const entries: unknown[] = [];
  for (const line of content.split("\n")) {
    if (line === "") continue;
    try {
      entries.push(JSON.parse(line) as unknown);
    } catch {
      continue; // 坏行跳过（append 中途崩溃的截断行）
    }
  }
  return entries;
}

/**
 * 单 record 世代提取（生产装配点 listReconcileRecords 的逐条映射用——ReconcileNotifyRecord.
 * epoch 的唯一填充通道，F1-13 结论 A）。
 *
 * 提取序：内存源优先（store.getMutable 返回的 ExecutionRecord.epoch 直读——运行时
 * 权威值，零 fs 成本）；磁盘重建源读 `.events` 事件流 fold（record-bound /
 * record-round-started / record-reopened 三类帧携带 epoch，行解析与 fold 语义单源
 * 复用 record-events 导出原语——RecordEventsWriteFace.foldOf 的同义装载组合）。
 *
 * 缺席语义（恒返回 undefined = 世代 0）：内存未命中且 recordsDir 缺席（纯内存测试
 * 形态）/ 事件文件不可读（ENOENT / 权限）——对齐 readSessionEntriesFromFile 的宽容
 * 读侧纪律，键退化为旧格式裸 id（透传前行为），不抛不阻塞对账。
 */
export function resolveReconcileRecordEpoch(
  id: string,
  deps: {
    /** 内存源世代查询（store.getMutable(id)?.epoch 闭包——调用方装配）。 */
    memoryEpochOf: (id: string) => number | undefined;
    /** recordsDir 晚绑定取值（`.events` 文件目录，与 manifest 同源）。 */
    recordsDir: () => string | undefined;
  },
): number | undefined {
  const memory = deps.memoryEpochOf(id);
  if (memory !== undefined) return memory;
  const dir = deps.recordsDir();
  if (dir === undefined) return undefined;
  let content: string;
  try {
    content = fs.readFileSync(recordEventsPath(dir, id), "utf8");
  } catch {
    return undefined;
  }
  const events: RecordEvent[] = [];
  for (const line of content.split("\n")) {
    const event = parseRecordEventFileLine(line);
    if (event !== undefined) events.push(event); // 空行/头行/坏行跳过（u0 行解析器内消化）
  }
  return foldRecordEvents(events).epoch;
}

/**
 * 通知对账编排（三入口唯一入口；同步——fs 读 + deliver 同步受理，session_start 链
 * 内毫秒级）。幂等：重复执行时已补投键有投递日志条目/送达痕迹抵消，判据不再命中。
 *
 * 成本下界（设计检查点登记）：预检先行短路——record 收尾位量级扫描（会话内 record
 * 数，light 头部扫描 + per-file 缓存）先行，无候选不触 entries 全读取。
 *
 * 失败吞掉记 warn（对账/补投失败无害：候选三判据仍命中，下一对账边沿幂等重查）——
 * 调用方（notify-host 两入口 / 扩展侧切回接线）不需自行 try-catch。
 */
export async function runNotifyReconcileMaintenance(deps: {
  /** 入口来源（session_start / resume / agent_settled / 扩展侧自定义）——入口来源日志可辨（RL14）。 */
  reason: string;
  source: NotifyReconcileSource;
  /** 本域通知 customType（词表单源 = notifier NOTIFY_CUSTOM_TYPE 的透传）。 */
  notifyCustomType: string;
  /** 补投出口：closed 终态载荷直发（notify-host 装配 = notifier.notify 直通——补投
   *  与主路径共用同一投递管道与幂等键构造，RL8 构造一致由此构造性成立）。 */
  submitNotify: (record: BgNotifyRecord) => void;
}): Promise<NotifyReconcileResult> {
  const result: NotifyReconcileResult = {
    scanned: 0,
    candidates: 0,
    redelivered: [],
    skippedDelivered: [],
    skippedJournaled: [],
  };
  // 入口无条件 debug 日志（RL14 入口来源可辨；对齐 bash 域编排的 S6 同款形态）。
  logger.debug("notify reconcile dispatch", { detail: { reason: deps.reason } });
  try {
    const records = deps.source.listReconcileRecords();
    result.scanned = records.length;
    // 预检：收尾位 ∧ 排除位未命中（内存过滤，不触 entries）。排除位真值在预检内
    // 判定（isExcludedReconcileRecord 单一落点），终判对已预检候选只查两磁盘事实
    // 集合——判据函数本体（isReconcileNotifyCandidate）在终判消费，真值表逐行可测。
    const candidates = records.filter((r) => isReconcileCandidateRecord(r) && !isExcludedReconcileRecord(r));
    result.candidates = candidates.length;
    if (candidates.length === 0) return result;

    const entries = deps.source.readSessionEntries();
    const delivered = collectDeliveredNotifyGenerations(entries, deps.notifyCustomType);
    const deliveredRecordGens = collectDeliveredRecordGenerations(entries, deps.notifyCustomType);
    const journaled = collectJournaledDeliveryGenerations(entries);

    for (const record of candidates) {
      // 补投幂等键 = 主路径同构造的终态键（round 置 undefined——轮次 id 不混入；
      // epoch 透传 = record 当前世代，`id[:epoch]` 形态与主路径 notifyClosed 对同
      // record 的构造一致（RL8——F1-13 结论 A：裸 id 恒定构造在 reopen record 的
      // 轮终收尾形态上与主路径漂移）。buildNotifyId 单一导出。
      const recordEpoch = record.epoch ?? 0;
      const notifyId = buildNotifyId({ id: record.id, epoch: record.epoch, round: undefined });
      // 送达痕迹分形态（见文件头）：legacy closed 形态查裸键；轮终收尾形态扩位到
      // record 级（details.id + 世代匹配——主路径轮次应答已送达即完成信号在册，
      // 阻断重复补投）。三通道全按世代命中：旧世代在册条目不阻断新世代查询
      // （世代 0 轮次键 `id:round` 与世代 e 终态键 `id:epoch` 存在字符串同形，
      // 只有条目侧世代字段能消歧）。
      const roundSettledIdle = record.status === "idle" && record.closedReason === undefined;
      const facts: ReconcileNotifyFacts = {
        isTerminal: isReconcileCandidateRecord(record),
        excludedByOrigin: isExcludedReconcileRecord(record),
        delivered:
          generationHit(delivered, notifyId, recordEpoch) ||
          (roundSettledIdle && generationHit(deliveredRecordGens, record.id, recordEpoch)),
        journaled: journaledGenerationHit(journaled, notifyId, recordEpoch),
      };
      if (!isReconcileNotifyCandidate(facts)) {
        if (facts.delivered) result.skippedDelivered.push(record.id);
        if (facts.journaled) result.skippedJournaled.push(record.id);
        continue;
      }
      // 补投 payload = notifyClosed 同款 closed 终态形态（D6①：补投的是该 record 的
      // 完成信号——legacy closed 形态即主路径本要发的那条通知；轮终收尾形态为该轮
      // 完成信号的终态载体，outcome 经 deriveOutcome 单一权威派生，失败轮如实落
      // failed 文案）：round 置 undefined（与轮次通知键区分，终态不被判重吞）、轮数
      // 改经 totalRounds 进文案、epoch 透传（payload.epoch 经 notifier notify 再次
      // 构造 notifyId——与上方判据键同源，且送达条目 details 携带世代供后续对账
      // 边沿按世代判定；缺失会使本轮补投条目退化为裸 id 旧格式，下一边沿判据查
      // `id:epoch` 不命中 → 重复补投）；content 构造由主路径 notify() 内部完成
      //（deriveOutcome 单一权威兜底——补投不自行派生第二套文案）。
      const payload: BgNotifyRecord = {
        id: record.id,
        status: "closed",
        closedReason: record.closedReason,
        agent: record.agent,
        model: record.model,
        // 轮终 result：内存源顶层直读；磁盘重建源顶层不恢复（fold 投影在收条帧）——
        // lastRound.result 摘要锚回落（截断语义随收条帧，全文走 transcript 指针行）。
        result: record.result ?? record.lastRound?.result,
        error: record.error,
        startedAt: record.startedAt,
        endedAt: record.endedAt ?? undefined,
        patchFile: record.patchFile,
        sessionFile: record.sessionFile,
        round: undefined,
        ...(record.round != null ? { totalRounds: record.round } : {}),
        ...(record.epoch != null ? { epoch: record.epoch } : {}),
      };
      deps.submitNotify(payload);
      result.redelivered.push(record.id);
      logger.debug("notify reconcile redelivered terminal notification via delivery port", {
        detail: { reason: deps.reason, recordId: record.id, notifyId },
      });
    }
  } catch (err) {
    logger.warn("notify reconcile failed; candidates retried at next reconcile edge", {
      detail: { reason: deps.reason, err: err instanceof Error ? err.message : String(err) },
    });
  }
  return result;
}
