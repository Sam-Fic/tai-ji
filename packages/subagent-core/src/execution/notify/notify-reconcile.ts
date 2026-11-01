// src/execution/notify/notify-reconcile.ts
//
// 通知对账补投（completion-signal-delivery 设计 D5：subagent 域一次性终态通知的
// 补投载体 = record 终态事实源 + 维护链三入口，与 bash 域 pending-reconcile 同构
// 判据、不并入其实现——「主路径不发者排除」的排除位语义随域参数化）。
//
// 三重磁盘事实判据（bash 域 pending-reconcile 同构）：
//   候选 = record 已终态 ∧ 排除位未命中 ∧ 送达痕迹未命中 ∧ 投递日志无该幂等键条目
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
// （entry.data.id 直读，见 collectJournaledDeliveryIds 注释），方向保守（误判无条目
// → 补投被 port 幂等吞并，无实害）。
//
// 入口形态（D5/D7② 三入口同构，编排互调本文件的唯一对账函数 runNotifyReconcileMaintenance）：
//   ① session_start——notify-host revive()（SubagentService.initSession 链内无条件调用）；
//   ② agent_settled——notify-host 装配期经 pi.on 订阅（回合收尾兜底边沿）；
//   ③ 切回补强（__taiji_bg_reconcile__）——pi 命令名全局唯一（base-tool-enhance 注册），
//     core 包内无触发源，生产接线 = 扩展侧/壳侧调包导出的同一编排函数（reason="resume"）。
//   编排对三入口完全一致（判据单一）；跨边沿双投由 port 幂等预检吞并（同键先到者
//   登记，rejected 时幂等键未登记——补投是该键首次有效投递）。

import * as fs from "node:fs";

import { getLogger } from "../../core/logger.ts";
import { isLegacyClosedSettled } from "../persistence/execution-record.ts";
import type { ClosedReason, ExecutionStatus, RecordOrigin } from "../domain/record-types.ts";
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
 * 无 epoch 字段（SubagentRecord 公开面不携带）——键构造按 epoch 缺省（裸 id 形态）。
 * 边界锚定：可达候选集上不构成键漂移——「epoch>0 的 legacy closed」现行唯一写点 =
 * settleWorkflowRecord 契约（全 workflow origin 前置）被排除位二封住；历史 CAS 时代
 * record 无 epoch（epoch 与 reopen/binding 同批后引入，旧数据早于该批机制——D5
 * 证据链「binding 缺失/旧数据无 binding 时 origin 缺席」自证）。
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
  /** 终态判定（isLegacyClosedSettled 的状态位输入）。 */
  readonly status: ExecutionStatus;
  readonly closedReason?: ClosedReason;
  readonly origin?: RecordOrigin;
  /** 收尾通知的轮次统计文案输入（notifyClosed 同款——round 置 undefined 后轮数改经此进文案）。 */
  readonly round?: number;
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
  /** 预检候选数（终态 ∧ 排除位未命中）。 */
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

  /** 事实一：record 已终态（域事实源判定 = isLegacyClosedSettled）。 */
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
 * 从会话 entries 提取已送达完成通知的幂等键集合（送达痕迹判据的事实源）。
 *
 * 判定通道两条，任一命中即收：details.notifyId（主路径 payload 携带，notifier notify
 * 物化）/ details.deliveryId（port 受理时统一写入 details 的送达凭据键——与
 * envelope.id 同值）。刻意不用 content 文本兜底、不收 details.id（record id）：
 * content 内的 record id 文本会让轮次条目误命中终态键 → 漏补投。痕迹收集宁滥勿缺
 * （多收集 → 该键漏补投，方向保守——反向误判才产生双投）。
 *
 * 容错对齐 bash 域同款纪律：null/非对象元素跳过；只扫本域 customType 条目
 * （通知词表单源——与非本域条目互斥，调用方传 notifier NOTIFY_CUSTOM_TYPE）。
 */
export function collectDeliveredNotifyIds(entries: readonly unknown[], notifyCustomType: string): Set<string> {
  const ids = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (entry.customType !== notifyCustomType) continue;
    const details = entry.details;
    if (details === null || typeof details !== "object") continue;
    const fields = details as Record<string, unknown>;
    const notifyId = fields.notifyId;
    if (typeof notifyId === "string" && notifyId !== "") ids.add(notifyId);
    const deliveryId = fields.deliveryId;
    if (typeof deliveryId === "string" && deliveryId !== "") ids.add(deliveryId);
  }
  return ids;
}

/**
 * 从会话 entries 提取投递日志已登记的幂等键集合（事实三的事实源）。
 *
 * 宽容口径（与 bash 域经 port 解析单点的实现存在形态分叉，登记见文件头）：outbox /
 * ack 两类条目的 data.id 直读即收——受理成功必有 outbox 条目（受理前落盘，
 * append-only 契约），ack 并入是同次遍历的防御性冗余。v2 data.id 即幂等键；v1 存量
 * 的 data 形态可能解析不出（误判「无条目」→ 补投 → port 幂等预检吞并，无实害——
 * 方向对齐「漏补投优于重复投」保守取向）。坏行/畸形 data 跳过。
 */
export function collectJournaledDeliveryIds(entries: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    // outbox / ack 两类 entry 的 customType 由 port 落盘（本文件不 import port 包，
    // 按值锚定——port 侧词表漂移时本收集器退化为漏收（保守方向），由 port 幂等承接）。
    const customType = entry.customType;
    if (customType !== "delivery-port-outbox" && customType !== "delivery-port-ack") continue;
    const data = entry.data;
    if (data === null || typeof data !== "object") continue;
    const id = (data as Record<string, unknown>).id;
    if (typeof id === "string" && id !== "") ids.add(id);
  }
  return ids;
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
 * 通知对账编排（三入口唯一入口；同步——fs 读 + deliver 同步受理，session_start 链
 * 内毫秒级）。幂等：重复执行时已补投键有投递日志条目/送达痕迹抵消，判据不再命中。
 *
 * 成本下界（设计检查点登记）：预检先行短路——record 终态量级扫描（会话内 record
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
    // 预检：终态 ∧ 排除位未命中（内存过滤，不触 entries）。排除位真值在预检内
    // 判定（isExcludedReconcileRecord 单一落点），终判对已预检候选只查两磁盘事实
    // 集合——判据函数本体（isReconcileNotifyCandidate）在终判消费，真值表逐行可测。
    const candidates = records.filter((r) => isLegacyClosedSettled(r) && !isExcludedReconcileRecord(r));
    result.candidates = candidates.length;
    if (candidates.length === 0) return result;

    const entries = deps.source.readSessionEntries();
    const delivered = collectDeliveredNotifyIds(entries, deps.notifyCustomType);
    const journaled = collectJournaledDeliveryIds(entries);

    for (const record of candidates) {
      // 补投幂等键 = 主路径同构造的终态键（round 置 undefined——轮次 id 不混入；
      // epoch 缺省边界见 ReconcileNotifyRecord 注释）。buildNotifyId 单一导出，
      // 与主路径 notify() 同一构造（RL8）。
      const notifyId = buildNotifyId({ id: record.id, epoch: undefined, round: undefined });
      const facts: ReconcileNotifyFacts = {
        isTerminal: isLegacyClosedSettled(record),
        excludedByOrigin: isExcludedReconcileRecord(record),
        delivered: delivered.has(notifyId),
        journaled: journaled.has(notifyId),
      };
      if (!isReconcileNotifyCandidate(facts)) {
        if (facts.delivered) result.skippedDelivered.push(record.id);
        if (facts.journaled) result.skippedJournaled.push(record.id);
        continue;
      }
      // 补投 payload = notifyClosed 同款 closed 终态形态（D6①：补投的就是主路径本要
      // 发的那条通知）：round 置 undefined（与轮次通知键区分，终态不被判重吞）、轮数
      // 改经 totalRounds 进文案；outcome 物化与 content 构造由主路径 notify() 内部
      // 完成（deriveOutcome 单一权威兜底——补投不自行派生第二套文案）。
      const payload: BgNotifyRecord = {
        id: record.id,
        status: "closed",
        closedReason: record.closedReason,
        agent: record.agent,
        model: record.model,
        result: record.result,
        error: record.error,
        startedAt: record.startedAt,
        endedAt: record.endedAt ?? undefined,
        patchFile: record.patchFile,
        sessionFile: record.sessionFile,
        round: undefined,
        ...(record.round != null ? { totalRounds: record.round } : {}),
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
