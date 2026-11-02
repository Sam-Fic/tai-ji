/**
 * Workflow Extension — workflow 域通知生产
 *
 * notifyDone(pi, runId, run, notified) — run 完成时发 completion notification
 * （unified-delivery 波 2：经 pi 半区投递端口 port.deliver，C-ext-19 语义由 port
 * 投递日志 + notifyId 幂等 + 差集重放承接；port 缺席降级直发）。
 *
 * [D7 载荷扩展] 终局必达通知的不变量面：成功含结果摘要与产物指针、失败含
 * errorCode 与证据指针、取消亦通知——载荷 outcome/errorCode/resultSummary/
 * artifactsDir/eventsJournalPath（details 层，content 追加指针段）。
 *
 * 层归属：workflow 域（与 workflow-events.ts 同层；唯一生产消费方 =
 * workflow-events.ts。原名 interface/helpers.ts，2026-09-24 名实归位——内容自始
 * 是通知生产而非 interface 注册点杂项）。
 */

import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardStaleCtx, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import type { DeliveryEnvelope } from "@zhushanwen/pi-delivery-port";
import { getDeliveryPort } from "@zhushanwen/pi-delivery-port";

// bounded JSON pretty 序列化（IF13/#19，TC5/ES5）已下沉 core shared
// （u-core-atomic 逐字平移，输出与原本地实现字节一致；本地实现已删）。
import {
  boundedPrettySerialize,
  isTerminalDoneReason,
  RUN_EVENTS_SUFFIX,
  type RunOutcome,
} from "@zhushanwen/subagent-core";
import type { WorkflowRun } from "@zhushanwen/subagent-core";
import { runSettledOutcomeToDoneReason, type RunSettlementRecord } from "./jsonl-run-store.ts";

// 模块级 logger（与 session-lifecycle.ts / index.ts 同 component 名）
const logger = getLogger("subagents");

import { WORKFLOW_RESULT_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";

// ── 常量 ─────────────────────────────────────────────────────

const MAX_RESULT_LENGTH = 8000;

/** [D7] details.resultSummary 的截断上限（成功时的结果短摘要；全文摘要走 content
 *  的 Script Result 段 bounded 8000，载荷字段是消费方可编程读取的短形态）。 */
const MAX_RESULT_SUMMARY_LENGTH = 500;

/** 写账失败 error 留痕的 content 摘要截断长度（诊断定位用，非消费契约）。 */
const RECORD_FAIL_CONTENT_PREVIEW_LENGTH = 200;

/**
 * [D7] 事件 journal 文件名（run store 旁，artifactsDir 内）：`<runId>.record.jsonl`
 * （runId 即 generateRunId 的 wf- 前缀产物；后缀随 core RUN_EVENTS_SUFFIX 改名，
 * 历史 .events.jsonl = 旧写入方实体，设计 D5 的渲染名 wf-<id>.events.jsonl 即该
 * 旧形态；实值经 core barrel 单源 RUN_EVENTS_SUFFIX，core 命名变更时编译期同步）。
 */
function runEventsJournalPath(artifactsDir: string, runId: string): string {
  return join(artifactsDir, `${runId}${RUN_EVENTS_SUFFIX}`);
}

/**
 * notifyDone 幂等键前缀（[u9] 承袭，对齐 C-ext-19）。键形态
 * `wf-done:<runId>`——一个 run 的收尾通知只投递一次（port.deliver 受理 →
 * details-id 回执逐条处理完毕（关闭） → 断连/重启经投递日志 session_start 差集重放，幂等键去重
 * 不双投递）。前缀惯例承接 collect 时代 `sync-batch:` 的「通道语义前缀 + 天然
 * 唯一标识」形态；导出供测试构造回执 entry 与投递日志断言复用同键。
 */
export const WORKFLOW_DONE_NOTIFY_ID_PREFIX = "wf-done:";

// workflow 收尾通知的送达 customType 经 extension-protocol 单源
// （WORKFLOW_RESULT_CUSTOM_TYPE，与 shared/runtime/core 消费侧同源）：runtime
// event-interpreter 按该类型识别 run 完成并驱动 W18 workflow-record 失效信号
// （session.workflows 增量广播），taiji 完成通知 display 覆写 SSOT
// （COMPLETE_NOTIFY_CUSTOM_TYPES）亦按它收录——不可复用 subagent-bg-notify 通道。
// 等值/单源锁 = src/__tests__/contract.notify-custom-types.test.ts。

/**
 * notifiedRunIds 去重窗口大小。
 *
 * 最近该数量的已通知 runId 可去重，更旧挤出后不再去重——runId 全局唯一
 * （wf-<Date.now>-<rand>），旧 id 重现概率为零，语义无损。
 */
export const MAX_NOTIFIED_RUN_IDS = 1000;

// [D7] run 终局 outcome + DoneReason 派生：经 jsonl-run-store 的联合判别单点
//（[W2/V1 D1 第 7 行] 载荷源换终局记录——outcome/errorCode 帧直取、DoneReason
// 联合派生；原 extractFailureErrorCode 重提取链废弃——它与 core 帧生产链
// finalRunErrorCodeOf 值域本就不同，换源后通知码与 journal 码同源同值）。
// 漂移信号 = journal run-settled 帧出现词表外值时 core 自有用例先红。

/**
 * notifyDone 的 details 结构（通过 pi.sendMessage 透传给前端）。
 *
 * 抽取为显式接口替代裸 Record<string, unknown>。
 * 模块私有（原 export 已删）：无跨文件消费者，测试经 notifyDone 公共入口
 * 观察并内联类型。
 */
interface WorkflowNotifyDetails { // oe-exempt:20260929:framework:workflow/record 协议契约类型——ports 类型契约先行、单实现常态（dev-0.10.5 已验收代码 merge 带入）
  runId: string;
  name: string;
  status: string;
  reason: string | undefined;
  traceLength: number;
  /**
   * [u9] 幂等键（`wf-done:<runId>`）——回执匹配键（port 投递日志扫
   * 送达 custom_message entry 的 details.notifyId 判定为已关闭）。携带在 details 不进
   * 文案（G4 字节锁定不受影响）。
   */
  notifyId: string;
  /**
   * [D7] 终局 outcome 三态（completed/failed/cancelled）——脚本层失败
   * （review-failure = outcome:completed + 脚本返回失败结论）与 run 自身怎么死的
   * （outcome:failed）在通知侧可区分（D5 终态双维度语义）。
   */
  outcome: RunOutcome;
  /**
   * [D7] 失败时的结构化码（最后失败 ask 的 failureKind；无失败帧的 run 级死法
   * 缺省——见 extractFailureErrorCode）。completed/cancelled 恒缺省。
   */
  errorCode?: string;
  /**
   * [D7] 成功时的结果短摘要（scriptResult bounded 截断；全文走 content 的
   * Script Result 段）。
   */
  resultSummary?: string;
  /**
   * [D7] 产物目录指针：run 持久化产物所在目录绝对路径
   * （`<root>/<rootSid>/workflow/runs/`——journal/manifest 同目录；调用方经
   * onRunDone 桥注入，旧调用缺省 undefined）。
   */
  artifactsDir?: string;
  /**
   * [D7] 事件 journal 指针（`<artifactsDir>/wf-<runId>.record.jsonl`）——终局
   * 证据的入口载荷（D5-3 诊断引用写入 journal 记录的消费方）。
   */
  eventsJournalPath?: string;
  /**
   * [subagent-observability §3.3.8] 失败成员结算明细（终局帧同源透传：taskIndex +
   * `"<class>.<kind>"` 点拼 cause，如 `provider.rate_limited`；无失败成员的终局
   * 恒缺省）。类型经 RunSettlementRecord 索引访问——形状单源在 core
   * settlementRecordOfRunSettledFrame。
   */
  failedMembers?: RunSettlementRecord["failedMembers"];
  /**
   * [subagent-observability §3.3.8/u5] 部分交付成员明细（终局帧同源透传：
   * taskIndex + 未满足 deliverable 清单；无部分交付的终局恒缺省）。
   */
  partialMembers?: RunSettlementRecord["partialMembers"];
}

/**
 * workflow 到达 done 终态时发送完成通知。
 *
 * [unified-delivery 波 2] 结果语义通知经 pi 半区投递端口 port.deliver（C-ext-19
 * 语义由 port 内包：受理前落投递日志 + notifyId 幂等键 + details-id 送达凭据 +
 * session_start 差集重放——relay 瞬断/断连重启不再丢通知；送达 customType 保持
 * "workflow-result"，W18 workflow-record 失效信号前提）。port 缺席时（装配异常
 * 窗口，生产不可达常态）降级为 fire-once 直发（at-most-once；triggerTurn 单通道）。
 *
 * **内存去重**：notifiedRunIds Set 由调用方（factory/extension instance）持有，
 * 同 runId 的重复收尾回调拦截（跨 session_shutdown 等边界防重复）；标记在 port
 * 受理（accepted/swallowed）后落下。**已知丢失情形（如实登记）**：port rejected
 * （persist-failed 等）= 受理未发生、投递日志未落，而 notifyDone 的唯一调用点
 * onRunDone 每终态恰好一次、port 差集重放无源可读——该终局通知**永久丢失**，仅
 * error 日志留痕（含 notifyId/content 摘要，供事后手工补偿）。持久层幂等由
 * notifyId 幂等键承接（内存窗口挤出 / 重启后的重复仍被 port 判重吞）。
 *
 * @param pi ExtensionAPI（仅降级路径直发用）
 * @param runId run 标识
 * @param run WorkflowRun 聚合根（读 spec.scriptName + trace + scriptResult；status/reason/outcome 载荷源 = 终局记录 settlement——[W2/V1 D1 第 7 行] 换源，不读两态机字段）
 * @param notifiedRunIds 去重 Set（调用方持有，scope 到 factory 实例）
 * @param artifactsDir [D7] 产物目录指针（`<root>/<rootSid>/workflow/runs/`，onRunDone
 *   桥注入；缺省 undefined = 旧调用兼容，载荷与文案指针段双双省略）
 * @returns 是否已受理投递（true = accepted/swallowed / 降级直发成功 / stale 终态 /
 *   幂等早退；false = 主投与单次重提均 rejected——受理未发生，**窗口未标**，调用方
 *   不 track，对账边沿补投可达。语义细则见 deliverDoneNotify 注释）
 */
/**
 * notifyDone 构建面（content + details 一次成型）。
 *
 * [W2/V1 D1 第 7 行] 载荷源换源：status 串 / reason / outcome / errorCode 全部
 * 取终局记录（settlement——与 run-settled 帧同源），不再读两态机字段（I2 失效
 * 窗口：活体写点删除后 state.reason 恒 undefined，原 I2 兜底载荷恒退 completed
 * 假成功——显式换源后删除）。trace/scriptResult 仍读聚合（非两态机字段）。
 *
 * content 段顺序：标题行 →（终止性原因非正常完成时）防偷懒收尾指令 →
 * （有 scriptResult 时）Script Result 段 → Agent Trace 段 →（artifactsDir 有时）
 * Artifacts 指针段。
 */
export function buildDoneNotifyContent(
  run: WorkflowRun,
  runId: string,
  artifactsDir: string | undefined,
  settlement: RunSettlementRecord,
): { content: string; eventsJournalPath: string | undefined } {
  const traceNodes = run.state.trace.toArray();
  const name = run.spec.scriptName;
  const reason = runSettledOutcomeToDoneReason(settlement.outcome, settlement.errorCode);
  const status = `done (${reason})`;

  // 构建消息内容
  const parts: string[] = [];
  parts.push(`Workflow '${name}' done: ${status}`);

  // 终止性原因（非正常完成）追加防偷懒收尾指令——budget/time 耗尽或 abort 不是任务完成，
  // 模型可能把 "done" 当成功汇报（F3 偷懒完成）。收尾三步骤与 turn-limiter WRAP_UP_MESSAGE 对齐。
  // 判定经 core isTerminalDoneReason 单源（穷举 switch，DoneReason 新增成员 tsc 强制归类），
  // 输入 = 派生 DoneReason（载荷源换源后与原 state.reason 判据逐值等价——细分恢复使
  // 预算/超时终局不误命中/漏命中）。
  if (isTerminalDoneReason(reason)) {
    parts.push("");
    parts.push(
      "This is NOT task completion. Summarize what was DONE and VERIFIED, list what remains " +
        "NOT DONE, and give the user the single most important next step.",
    );
  }

  if (run.state.scriptResult !== undefined && run.state.scriptResult !== null) {
    // M10: scriptResult 来自 worker 脚本返回值（用户可控），可能含循环引用导致 JSON.stringify 抛 TypeError
    // IF13(#19)：bounded 序列化（只生成会被保留的前缀；BigInt/循环引用整体回退
    // String(x) 与旧实现整串 catch 同款）——≤8000 与旧全量 pretty 逐字节一致，
    // >8000 与 .slice(0,8000)+标记 逐字节一致（等价测试锚定）
    const truncated = boundedPrettySerialize(run.state.scriptResult, MAX_RESULT_LENGTH);
    parts.push("");
    parts.push("--- Script Result ---");
    parts.push(truncated);
  }

  parts.push("");
  parts.push("--- Agent Trace ---");
  // [subagent-observability §3.3.8] 成员结清事实随行呈现：failed 成员追加点拼
  // cause、部分交付成员追加 missing 清单（终局帧同源）；无成员明细的终局行形态
  // 不变（content 逐字节锚不受影响）。
  const failedCauseOf = new Map(
    (settlement.failedMembers ?? []).map((m) => [m.taskIndex, m.cause] as const),
  );
  const partialMissingOf = new Map(
    (settlement.partialMembers ?? []).map((m) => [m.taskIndex, m.missing] as const),
  );
  for (const node of traceNodes) {
    let line = `[${node.stepIndex}] ${node.agent}: ${node.status}`;
    const cause = failedCauseOf.get(node.stepIndex);
    if (cause !== undefined) line += ` (${cause})`;
    const missing = partialMissingOf.get(node.stepIndex);
    if (missing !== undefined && missing.length > 0) {
      line += ` (partial: missing ${missing.join(", ")})`;
    }
    parts.push(line);
  }

  // [D7] 产物指针段（主 agent 可操作的下一步入口：结果/证据在哪）。artifactsDir
  // 缺省（旧调用兼容）整段省略，content 字节与既有形态一致。
  const eventsJournalPath =
    artifactsDir !== undefined ? runEventsJournalPath(artifactsDir, runId) : undefined;
  if (artifactsDir !== undefined && eventsJournalPath !== undefined) {
    parts.push("");
    parts.push("--- Artifacts ---");
    parts.push(`Artifacts dir: ${artifactsDir}`);
    parts.push(`Events journal: ${eventsJournalPath}`);
  }

  return { content: parts.join("\n"), eventsJournalPath };
}

/**
 * notifyDone 的 details 构建面（baseDetails 成型）。
 *
 * 送达通道保持 "workflow-result"（runtime W18 失效信号 + taiji display 覆写 SSOT
 * 按该类型识别；迁移不改变消息类型与文案字节，只改变投递可靠性机制）。
 */
export function buildDoneNotifyDetails(
  run: WorkflowRun,
  runId: string,
  artifactsDir: string | undefined,
  eventsJournalPath: string | undefined,
  settlement: RunSettlementRecord,
): WorkflowNotifyDetails {
  const traceNodes = run.state.trace.toArray();
  const name = run.spec.scriptName;
  const reason = runSettledOutcomeToDoneReason(settlement.outcome, settlement.errorCode);
  const baseDetails: WorkflowNotifyDetails = {
    runId,
    name,
    status: "done",
    reason,
    traceLength: traceNodes.length,
    notifyId: `${WORKFLOW_DONE_NOTIFY_ID_PREFIX}${runId}`,
    // [W2/V1 D1 第 7 行] 终局必达载荷：outcome/errorCode 帧直取（与 run-settled
    // 帧同源——漂移判据 = core run-events 注释的「通知 outcome ≡ 帧 outcome」；
    // 换源后 engine 协议码族与 'unknown' 首次进入通知 errorCode 值域，消费方容忍
    // 已核对：bg-notify-render 不消费 errorCode，真实消费方按扩张值域透传）。
    outcome: settlement.outcome,
  };
  if (settlement.errorCode !== undefined) {
    baseDetails.errorCode = settlement.errorCode;
  }
  // [subagent-observability §3.3.8] 成员结算明细帧同源透传（无明细的终局恒缺省，
  // 与帧缺省形态一致；消费方按扩张字段透传——errorCode 扩值域同款先例）。
  if (settlement.failedMembers !== undefined) {
    baseDetails.failedMembers = settlement.failedMembers;
  }
  if (settlement.partialMembers !== undefined) {
    baseDetails.partialMembers = settlement.partialMembers;
  }
  if (settlement.outcome === "done" && run.state.scriptResult !== undefined && run.state.scriptResult !== null) {
    baseDetails.resultSummary = boundedPrettySerialize(run.state.scriptResult, MAX_RESULT_SUMMARY_LENGTH);
  }
  if (artifactsDir !== undefined && eventsJournalPath !== undefined) {
    baseDetails.artifactsDir = artifactsDir;
    baseDetails.eventsJournalPath = eventsJournalPath;
  }

  return baseDetails;
}

/**
 * notifyDone 投递侧：pi 半区投递端口 port.deliver 主投（受理前落投递日志 +
 * details-id 送达凭据 + notifyId 幂等 + session_start 差集重放，端口侧内包；
 * workflow-result 外部通道逐条不合批——port 批组隔离原生承载）。
 *
 * rejected 处置阶梯（completion-signal-delivery D1/D8①）：deliver rejected
 * （disposed / persist-failed 等——幂等键未登记、受理未发生）当场 getDeliveryPort()
 * 重取当前实例单次重提原 envelope（一次投递尝试的同步收尾动作，非重试循环非
 * 定时器——ADR-0122 红线不越界，RL10 同锁：重提 rejected 或重取 undefined 即停，
 * 无第三次投递、无定时器句柄）；重提仍失败恢复责任移交对账边沿的事实判据兜底
 * （notify-reconcile 编排，error 文案带 recovered 指引——RL9/RL11 同族）。
 * 重提 accepted/swallowed 与主投受理同语义：标记 notifiedRunIds 去重窗口。
 *
 * port 缺席时（装配异常窗口，生产不可达常态）降级为 fire-once 直发（at-most-once；
 * triggerTurn 单通道）。
 *
 * **内存去重**：notifiedRunIds Set 由调用方（factory/extension instance）持有，
 * 同 runId 的重复收尾回调拦截（跨 session_shutdown 等边界防重复）；标记只在
 * **投递受理后**落下（accepted/swallowed / 降级直发成功 / stale 终态）。
 * **rejected = 受理未发生，不标窗口**（A15 缺陷修复）：rejected 的恢复通道 =
 * 对账边沿事实判据（notify-reconcile：run journal/manifest 终态事实），其补投
 * 出口重新走本函数——若 rejected 时标了窗口，补投会被幂等早退静默吞掉（受理
 * 假象：对账日志照打、消息从未出站）。调用方（runSettledEffects）按本函数返回
 * 值决定是否补标窗口（与 notifyDone 内部 track 同一语义，双写幂等）。
 * 持久层幂等由 notifyId 幂等键承接（内存窗口挤出 / 重启后的重复仍被 port 判重吞）。
 *
 * @returns 是否已受理投递（true = accepted/swallowed / 降级直发成功 / stale 终态 /
 *   幂等早退——窗口已含即已通知语义；false = 主投与单次重提均 rejected，受理未
 *   发生，窗口不标，对账边沿恢复）。
 */
function deliverDoneNotify(
  pi: ExtensionAPI,
  runId: string,
  notifiedRunIds: Set<string>,
  content: string,
  details: WorkflowNotifyDetails,
): boolean {
  const port = getDeliveryPort();
  if (port) {
    const envelope = buildDoneNotifyEnvelope(runId, content, details);
    const result = port.deliver(envelope, doneNotifyCollectOption(runId));
    if (result.kind === "rejected") {
      // 首败留痕（修复信号）+ 处置阶梯①接线（D8①）：立即单次重提。
      logger.warn(
        "workflow completion notify rejected by delivery port; retrying once via re-acquired port, recovered by reconcile fallback if the retry fails too",
        { runId, notifyId: details.notifyId, reason: result.reason },
      );
      return retryDeliverDoneNotifyOnce(runId, notifiedRunIds, envelope, details);
    }
    trackNotifiedRunId(notifiedRunIds, runId);
    return true;
  }

  // 降级：port 缺席（base-tool-enhance session_start 装配异常 / 版本混装窗口——
  // 生产不可达常态，warn 即修复信号）→ fire-once 直发（at-most-once）。
  // triggerTurn 单通道；stale ctx 防御（crash-resilience D1 / ext-guards 审计
  // §7 blockers#1 收尾）：session 替换窗口触碰 stale pi 命中 assertActive（PS-30）
  // 即无人接 rejection 崩 pi（E1 同机制）。stale 静默降级（完成通知不投递，用户可从
  // session 历史 / 工具结果看到 workflow 结果，判定见 stale-ctx-audit.md §4），非
  // stale 错误原样上抛（检查不吞真实 bug）。去重标记在实际发送**之后**落下：非
  // stale 瞬态发送失败（同步抛错上抛）后进程内仍可重试（去重不阻断）；stale 分支由
  // onStale 补标记保持现语义——stale = 通知对旧 session 已无意义，不重试。
  logger.warn(
    "delivery port not bound - workflow completion notify falls back to direct-send (at-most-once; check base-tool-enhance session_start bindDeliveryPort wiring)",
    { runId, notifyId: details.notifyId },
  );
  let delivered = false;
  guardStaleCtx(
    () => {
      const sent = pi.sendMessage(
        {
          customType: WORKFLOW_RESULT_CUSTOM_TYPE,
          content,
          display: true,
          details,
        },
        { triggerTurn: true },
      );
      trackNotifiedRunId(notifiedRunIds, runId);
      delivered = true;
      return sent;
    },
    {
      label: "subagent-workflow:notifyDone",
      onStale: (error) => {
        trackNotifiedRunId(notifiedRunIds, runId);
        delivered = true;
        logger.warn("workflow completion notify delivery skipped (stale ctx)", {
          runId,
          error: toErrorMessage(error),
        });
      },
    },
  );
  return delivered;
}

/**
 * [D7] 收尾通知 envelope（主投与单次重提共用同一构造——重提原 payload 语义；
 * 原 deliverDoneNotify 内联字面量提出，投递拒绝重提时同键同载荷原样重投）。
 */
function buildDoneNotifyEnvelope(
  runId: string,
  content: string,
  details: WorkflowNotifyDetails,
): DeliveryEnvelope {
  return {
    payload: {
      kind: "custom",
      customType: WORKFLOW_RESULT_CUSTOM_TYPE,
      content,
      display: true,
      details,
    },
    id: details.notifyId,
  };
}

/** collectKey 债权申报（result-collect 设计 §3.4）：workflow 域键 = runId。 */
function doneNotifyCollectOption(runId: string): { collectKey: string[] } {
  return { collectKey: [runId] };
}

/**
 * 立即单次重提（D8①，与 bash 域 retryDeliverOnce 同款单次形态——RL10 同锁）：
 * getDeliveryPort() 重取当前实例（session_start 重绑后即新实例）、重提原 envelope
 * （同幂等键——rejected 条目幂等键未登记，重提合法，delivery-port types 既有
 * 契约）。单次不循环：重提 rejected 或重取 undefined 均直接返回（RL10 的两处
 * 停止位），无定时器、无重试队列、无第三次投递；重提受理则与主投受理同语义
 * 标记去重窗口。重取缺席不扩直发降级（缺席直发只属主路径缺席形态），恢复通道
 * = 对账边沿事实判据。
 *
 * @returns 重提是否受理（true = accepted/swallowed，窗口已标；false = rejected /
 *   port 缺席，窗口不标——对账边沿恢复，见 deliverDoneNotify 返回值注释）。
 */
function retryDeliverDoneNotifyOnce(
  runId: string,
  notifiedRunIds: Set<string>,
  envelope: DeliveryEnvelope,
  details: WorkflowNotifyDetails,
): boolean {
  const retryPort = getDeliveryPort();
  if (retryPort === undefined) {
    logger.warn(
      "workflow completion notify retry skipped: delivery port absent on re-acquire; recovered by reconcile fallback",
      { runId, notifyId: details.notifyId },
    );
    return false;
  }
  const retryReceipt = retryPort.deliver(envelope, doneNotifyCollectOption(runId));
  if (retryReceipt.kind === "rejected") {
    // 单次重提仍 rejected（转换窗旧实例在位 / 持久写失败）：即停报警（RL11——
    // 持久成因不静默重试，error 留痕带恢复指引；环境修复/进程恢复后的送达由
    // 对账边沿的事实判据自动承接（notify-reconcile：run journal/manifest 终态
    // 事实），判据不区分成因。窗口不标：受理未发生，标了会堵死对账补投出口
    // （A15 缺陷形态——notifyDone 幂等早退静默吞补投）。
    logger.error(
      "workflow completion notify retry rejected after the single re-acquire attempt; single retry spent, recovered by reconcile fallback (session_start / agent_settled edge)",
      {
        runId,
        notifyId: details.notifyId,
        reason: retryReceipt.reason,
        contentPreview: envelope.payload.content.slice(0, RECORD_FAIL_CONTENT_PREVIEW_LENGTH),
      },
    );
    return false;
  }
  // 重提受理（accepted/swallowed）：与主投受理同语义，标记去重窗口。
  logger.debug("workflow completion notify retry accepted via re-acquired port", {
    runId,
    notifyId: details.notifyId,
  });
  trackNotifiedRunId(notifiedRunIds, runId);
  return true;
}

export function notifyDone(
  pi: ExtensionAPI,
  runId: string,
  run: WorkflowRun,
  notifiedRunIds: Set<string>,
  artifactsDir: string | undefined,
  settlement: RunSettlementRecord,
): boolean {
  // 幂等早退 = 已通知语义（窗口已含 runId）：返回 true（调用方按受理处理，
  // 补 track 是幂等 no-op）——false 只保留给「rejected 受理未发生」。
  if (notifiedRunIds.has(runId)) return true;
  const { content, eventsJournalPath } = buildDoneNotifyContent(run, runId, artifactsDir, settlement);
  const details = buildDoneNotifyDetails(run, runId, artifactsDir, eventsJournalPath, settlement);
  return deliverDoneNotify(pi, runId, notifiedRunIds, content, details);
}

/**
 * 把 runId 纳入 notifiedRunIds 去重窗口，超 cap 时删最旧（契约 W3C2）。
 *
 * 职责拆分：**去重判定**留在 notifyDone 的 has 读（本体零改动），
 * 本函数只持**有界化**职责——返回 void，不引入双重去重判定语义。
 *
 * 语义：
 * - 幂等 add：Set.add 对已存在元素不改变其迭代位置（重复 track 同一 id，
 *   其「最旧」地位不变）。
 * - FIFO 有界：Set 迭代序=插入序，超 cap 时删迭代器首元素=最旧。
 *   被挤出窗口的旧 id 再经 notifyDone：内存层放行后由投递日志 notifyId 幂等兜底
 *   （[u9] port 按 id 判重——生产环境 port 已装配时不会重发；port 缺席降级环境
 *   才会重新直发，runId 全局唯一，旧 id 重现概率为零，该边界由 W3TC12 单测
 *   在降级形态下固定）。
 *
 * 调用点：notifyDone 内部（port 受理后 + 降级直发受理/stale 后）+ workflow-events
 * onRunDone 回调（notifyDone 之后，幂等二次添加）。port.deliver rejected 不抛错也
 * 不标记（notifyDone 内 error 留痕后直接返回）。notifyDone 抛出（非 stale 发送失败等）
 * 时内外都不标记——进程内的重复收尾回调不被去重阻断（防御形态；port.deliver
 * rejected 的已知丢失情形登记见 notifyDone 注释）。
 *
 * @param notifiedRunIds 去重 Set（调用方持有，scope 到 factory 实例）
 * @param runId run 标识
 * @param cap 窗口大小（默认 MAX_NOTIFIED_RUN_IDS）
 */
export function trackNotifiedRunId(
  notifiedRunIds: Set<string>,
  runId: string,
  cap: number = MAX_NOTIFIED_RUN_IDS,
): void {
  notifiedRunIds.add(runId);
  while (notifiedRunIds.size > cap) {
    const oldest = notifiedRunIds.values().next().value;
    if (oldest === undefined) break;
    notifiedRunIds.delete(oldest);
  }
}
