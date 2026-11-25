// [subagent-observability §3.3.8] run 终局成员交付结算派生：run 级 outcome 从成员
// 交付债结算集合派生（delivered/failed/cancelled 三态 + failedMembers[].cause 点拼 +
// 脚本层 partialMembers 事实提取）。终局写点在 terminal-actions.finalizeRun
// （settleMembersIntoFinalSettlement 是其合成链的一环）；本模块为纯派生面
// （无 IO / 无时钟），行为锁见 __tests__/member-settlement-derive.test.ts。
import { getLogger } from "../core/logger.ts";
import { isEngineErrorPassthroughCode, isEngineProtocolErrorCode } from "@zhushanwen/subagent-engine-sdk";

import type { AgentCall } from "./models/agent-call.ts";
import type { AgentResult } from "./models/types.ts";
import type { WorkflowRun } from "./models/workflow-run.ts";
import type { FailedMemberReport, PartialMemberReport, RunOutcome } from "./run-events.ts";
import type { RunSettlementRecord } from "./terminal-actions.ts";
import { IN_FLIGHT_CALL_CANCELLED_MSG } from "./worker-message-pump-constants.ts";

const logger = getLogger("subagents");

/** 畸形 partialMembers 条目 warn 留痕的 JSON 预览截断上限（行内日志体积护栏）。 */
const PARTIAL_MEMBER_JSON_PREVIEW_MAX_CHARS = 200;

/**
 * 被接管成员的结算 cause（[subagent-observability §3.3.8 P6 定稿]）：成员被接管
 * （promptDisposition=handled——引擎未执行本任务，prompt 被既有会话受理）是宿主/
 * 编排层事实，class=harness；kind=member_adopted 为 run-settled 帧 failedMembers[]
 * 通道的受控码（唯一产点 = 本模块派生）。不借用 agent.no_deliverable——设计明示
 * agent 未执行不指派 agent 责任。
 */
export const ADOPTED_MEMBER_CAUSE = "harness.member_adopted";

/**
 * 单成员结算形态（成员交付债的收敛面）：
 * - `delivered`：成功交付（done 且无 error）；
 * - `failed`：失败成员（done 且 result.error 非取消文案）——进 failedMembers[].cause；
 * - `cancelled`：「未交付且非失败」的成员——被 run 终局收尾的在途
 *   （IN_FLIGHT_CALL_CANCELLED_MSG）、被接管轮（promptDisposition=handled，引擎未
 *   执行本任务）、尚未 settled 的在途。不进失败成员（UC-16：取消不产生
 *   partially_succeeded），全部成员被接管的极端组合由 run 级派生单独立档（P6 定稿）。
 */
type MemberSettlement = "delivered" | "failed" | "cancelled";

/**
 * 失败 cause 的点拼（`"<class>.<kind>"`）：failure（FailureCause）优先；error 走
 * 引擎错误 wire 契约形态（`<code>: <detail>` 前缀）时，前缀命中 SDK 协议码词表或
 * engine_ 透传面才落 `engine.<code>`（guard 与 run-events extractFailedRunErrorCode
 * 同款——防自由文本错误泄漏进 cause 通道），形态命中但码不受控落 `engine.unknown`
 * （fail-visible 如实标注）；无契约形态 / 无 error = "unknown"（保守可诊断）。
 */
export function memberFailureCauseOf(result: AgentResult): string {
  if (result.failure !== undefined) {
    return `${result.failure.class}.${result.failure.kind}`;
  }
  const error = result.error;
  if (error !== undefined) {
    const sep = error.indexOf(": ");
    if (sep > 0) {
      const code = error.slice(0, sep);
      if (isEngineProtocolErrorCode(code) || isEngineErrorPassthroughCode(code)) {
        return `engine.${code}`;
      }
      return "engine.unknown";
    }
  }
  return "unknown";
}

/**
 * 成员集合 → 交付结算派生（[subagent-observability §3.3.8] run 级 outcome 从
 * 「result.error 有无」改为成员交付债结算集合的派生物）：
 * - 全部成功交付 → done；
 * - 存在失败且存在非失败 → partially_succeeded（第五值）；
 * - 全部失败 → failed；
 * - 全部成员被接管（cancelled 且 promptDisposition=handled）且零交付 → failed +
 *   逐成员被接管明细（P6 定稿：明细如实记录成员被接管，不借用 agent.no_deliverable）；
 * - 空成员集 → undefined（空成员集 = 脚本层判定，回落 DoneReason 路径）。
 *
 * 失败成员明细随派生产出（failedMembers[].cause 点拼）；cancelled 成员（UC-16
 * 取消收尾 / 被接管）不进失败明细——「未交付且非失败」按部分交付路径计，仅
 * 「全部成员被接管」组合例外（上方第四支，P6 定稿）。
 */
export function deriveRunOutcomeFromMembers(run: WorkflowRun): {
  outcome: RunOutcome;
  failedMembers?: FailedMemberReport[];
} | undefined {
  const calls = [...run.state.calls.values()];
  if (calls.length === 0) return undefined;
  let delivered = 0;
  let failed = 0;
  let adopted = 0;
  const failedMembers: FailedMemberReport[] = [];
  const adoptedMembers: FailedMemberReport[] = [];
  for (const call of calls) {
    const settlement = memberSettlementOf(call);
    if (settlement === "delivered") {
      delivered += 1;
      continue;
    }
    if (settlement === "failed") {
      failed += 1;
      // result 契约：done ⟹ result 已设置（AgentCall.markDone 前置）；防御分支
      // 不可达时按 unknown 出报告（不产半截成员行）。
      failedMembers.push({
        taskIndex: call.id,
        cause: call.result !== undefined ? memberFailureCauseOf(call.result) : "unknown",
      });
      continue;
    }
    // cancelled：被接管轮单独收集（仅「全部被接管」组合出明细——混合场景按
    // 「未交付且非失败」计，不进失败明细，P6 定稿）；closeOut 取消不计数。
    if (call.result?.promptDisposition === "handled") {
      adopted += 1;
      adoptedMembers.push({ taskIndex: call.id, cause: ADOPTED_MEMBER_CAUSE });
    }
  }
  if (failed === 0) {
    // 全部成员被接管且零交付（P6 定稿的极端组合）：任务从未执行，done 是谎报成功——
    // run 判 failed，明细如实逐成员携带被接管码。
    if (delivered === 0 && adopted === calls.length) {
      return { outcome: "failed", failedMembers: adoptedMembers };
    }
    return { outcome: "done" };
  }
  if (delivered === 0) {
    return { outcome: "failed", failedMembers };
  }
  return { outcome: "partially_succeeded", failedMembers };
}

/**
 * 单 call 的结算形态判定（IN_FLIGHT_CALL_CANCELLED_MSG = run 终局收尾写点的固定
 * 取消文案——closeOutInFlightCalls 收尾的成员判 cancelled 不判 failed，UC-16；
 * promptDisposition=handled = 被接管轮回执（回执层成功、引擎未执行）——同判
 * cancelled，§3.3.8 P6 定稿「未交付且非失败」）。
 */
export function memberSettlementOf(call: AgentCall): MemberSettlement {
  if (call.status !== "done") return "cancelled";
  const result = call.result;
  if (result === undefined) return "cancelled";
  if (result.promptDisposition === "handled") return "cancelled";
  if (result.error === undefined) return "delivered";
  return result.error === IN_FLIGHT_CALL_CANCELLED_MSG ? "cancelled" : "failed";
}

/**
 * [subagent-observability §3.3.10/UC-11] 脚本层部分交付事实提取：批量模板（batch/fan-out）交付校验
 * 在 worker 脚本内执行（§3.3.10「成员交付结算前校验」的模板侧落点），部分交付成员
 * 清单随脚本返回 outcome.partialMembers 传回宿主（run.state.scriptResult，handleReturn
 * 先于终局派生写点）。本函数把 unknown 形态的脚本产物收敛为结构化报告——逐条校验
 * （taskIndex 非负整数 + missing 字符串数组），畸形条目 warn 留痕后丢弃（fail-visible，
 * 不让脚本侧脏数据进终局帧）；全部畸形/载荷缺席 = undefined（无部分交付事实）。
 * 导出共享：run-member-view 成员行的交付校验缺口事实（§3.3.6 对齐）同源消费本解析。
 */
export function partialMembersFromScriptResult(scriptResult: unknown): PartialMemberReport[] | undefined {
  if (typeof scriptResult !== "object" || scriptResult === null) return undefined;
  const raw = (scriptResult as { partialMembers?: unknown }).partialMembers;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    logger.warn(
      `[workflow] scriptResult.partialMembers ignored: expected an array, got ${typeof raw}`,
    );
    return undefined;
  }
  const reports: PartialMemberReport[] = [];
  for (const item of raw) {
    const report = parsePartialMemberEntry(item);
    if (report === undefined) {
      logger.warn(
        `[workflow] scriptResult.partialMembers entry ignored (malformed): ` +
          `${JSON.stringify(item)?.slice(0, PARTIAL_MEMBER_JSON_PREVIEW_MAX_CHARS)}`,
      );
      continue;
    }
    reports.push(report);
  }
  return reports.length > 0 ? reports : undefined;
}

/** 单条部分交付条目校验（taskIndex 非负整数 + missing 字符串数组；畸形返回 undefined 由调用方 warn 留痕丢弃）。 */
function parsePartialMemberEntry(item: unknown): PartialMemberReport | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const taskIndex = (item as { taskIndex?: unknown }).taskIndex;
  const missing = (item as { missing?: unknown }).missing;
  if (
    typeof taskIndex !== "number" || !Number.isInteger(taskIndex) || taskIndex < 0 ||
    !Array.isArray(missing) || missing.some((m) => typeof m !== "string")
  ) {
    return undefined;
  }
  return { taskIndex, missing: missing as string[] };
}

/**
 * 脚本层失败结论提取（workflow 模板族失败终态约定：一律 `return {status:"failed", ...}`
 * 而不 throw——pr-lifecycle 模板注释明文，dev-merge-gates 同型）。
 *
 * 为什么需要：脚本 return 失败结论时 worker 正常收尾 → run 级 outcome 恒 "done"
 * （2026-11-25 dev-merge-gates 事故：gates FAIL 详情齐全地写在返回载荷里，run 终态
 * 却显示 completed——托盘画绿勾、通知写 "done (completed)"、页面与 runtime 全部
 * 感知不到失败，失败仅存于 Script Result 段正文）。本函数把该结论提为可判事实，
 * 由 settleMembersIntoFinalSettlement 升格 run 终态（done → failed）。
 *
 * 返回简短 reason（failedStep 优先，回落固定标记）；非失败结论/缺载荷 → undefined。
 * 只认 status === "failed" 字面：review-fix-loop（terminated 词表）/ merge
 * （needs-human/released 等）不用本约定，不受影响。
 */
export function scriptFailureVerdictOf(scriptResult: unknown): string | undefined {
  if (typeof scriptResult !== "object" || scriptResult === null) return undefined;
  if ((scriptResult as { status?: unknown }).status !== "failed") return undefined;
  const failedStep = (scriptResult as { failedStep?: unknown }).failedStep;
  if (typeof failedStep === "string" && failedStep.trim() !== "") return failedStep.trim();
  return "script-verdict";
}

/**
 * 脚本层失败结论 → run 终局改档（done → failed）：在 settleMembersIntoFinalSettlement
 * **之后**调用（成员派生只认成员集合，会把脚本结论洗回 done——2026-11-25
 * dev-merge-gates 事故：gates FAIL 详情齐全地写在返回载荷里，run 终态却显示
 * completed，托盘画绿勾、通知写 "done (completed)"，页面与 runtime 全部感知不到
 * 失败，失败仅存于 Script Result 段正文）。
 *
 * 只对非失败终局改档：failed（脚本 throw / budget_limited 等更强形态）/ cancelled /
 * time_limited 等 run 级终局族不动；done 与 partially_succeeded（成员派生升格）都可被
 * 脚本失败结论压回 failed——脚本自身的失败裁决强于成员集合聚合（成员部分成功不构成
 * 「失败被感知」：partially_succeeded 在条目/托盘同显非 clean，但结论级失败必须是
 * failed，否则 dev-merge-gates 类「 gates FAIL + 个别成员成功」组合又漂成部分成功）。
 * failed 之上的成员失败明细（failedMembers）原样保留——失败结论 + 成员明细同帧更信息量。
 * reason 携 failedStep 短标记（条目/托盘归因），失败全文仍随 scriptResult 进通知。
 */
export function escalateScriptFailureVerdict(run: WorkflowRun, record: RunSettlementRecord): RunSettlementRecord {
  if (record.outcome !== "done" && record.outcome !== "partially_succeeded") return record;
  const verdict = scriptFailureVerdictOf(run.state.scriptResult);
  if (verdict === undefined) return record;
  return { ...record, outcome: "failed", reason: verdict };
}

/**
 * [subagent-observability §3.3.8] run 终局吸收成员交付：在 DoneReason 合成记录上
 * 叠加成员集合派生。两级优先序（run 级终局优先于成员集合派生）：
 * - run 自身终局族：budget_limited/time_limited/cancelled（UC-16：取消不产生
 *   partially_succeeded）不被覆盖；
 * - 脚本层失败（run.state.error 有值——worker error / replay mismatch / 脚本 throw，
 *   harness 系统层失败）维持 failed 裁决不被改档；成员明细按形态分流：全部成员已
 *   终局时失败明细照常进帧（批量模板全败 throw 是模板显式的终局上报），存在未终局
 *   成员时成员无责、维持抑制（见函数体内分流注释）。
 * - completed / 无 state.error 的 failed 才做成员 outcome 派生——成员失败传导 run
 *   终局（行为反转登记：现状成员失败完全不传导）。脚本吞掉成员失败的正常收尾
 *   （批量模板 allSettled 语义）在此升格 partially_succeeded/failed（场景 2 主场景）。
 * 空成员集回落原合成（脚本层判定）。settling 中双终局竞窗由状态机 terminal ×
 * 任意 fail-fast 承担（先到事实者胜）；interrupted 非终局不派生（resume 后再派生）。
 *
 * [subagent-observability §3.3.8/§3.3.10 联动] 部分交付支：产物契约校验事实在
 * worker 脚本侧产出（§3.3.10 模板侧落点），经 run.state.scriptResult.partialMembers
 * 接入本结算——存在部分交付事实时 run-settled 帧携带 partialMembers（明细：
 * [{taskIndex, missing[]}]，部分交付成员不进 failedMembers、无 cause），派生 outcome
 * 为 done 时升格 partially_succeeded（「无失败但存在部分交付」聚合规则支）。
 * [2026-11-25 失败可感知性] 脚本层失败结论支：脚本 return {status:"failed"}（模板族
 * 失败终态约定，不 throw）时 done → failed 升格（先于成员派生与部分交付支）——缺此环
 * 时脚本层失败在 run 终态不可见（completed 假成功），详见 scriptFailureVerdictOf。
 */
export function settleMembersIntoFinalSettlement(run: WorkflowRun, record: RunSettlementRecord): RunSettlementRecord {
  if (record.outcome !== "done" && record.outcome !== "failed") return record;
  // budget_limited 是 run 级终局码（dispatchFinalRunSettle 恒等映射，run-vocabulary
  // 注释明示「为什么此刻被判终局」的 harness 系统层裁决）——与 cancelled/time_limited
  // 同入优先族，不被成员集合覆盖。
  if (record.errorCode === "budget_limited") return record;
  const derived = deriveRunOutcomeFromMembers(run);
  if (derived === undefined) return record;
  // 脚本层失败（run.state.error——worker error / replay mismatch / 脚本 throw，harness
  // 系统层失败）两形态分流（终局派生写点先于 closeOutInFlightCalls——未终局成员在本
  // 判定位仍无 result，两形态结构性可分）：
  // - 全部成员已终局（有 result）：成员失败事实真实在案（批量模板全败 throw 是模板
  //   显式的终局上报形态），失败明细照常进终局帧；run 级 outcome 维持脚本层 failed
  //   裁决，不被成员派生改档（harness 系统层失败优先于成员集合聚合）。
  // - 存在未终局成员（worker 崩溃 / replay mismatch）：失败归 harness 系统层，成员无责
  //   ——维持抑制，不产半截成员明细。
  if (run.state.error !== undefined) {
    if (!allMemberCallsSettled(run)) return record;
    if (derived.failedMembers === undefined || derived.failedMembers.length === 0) return record;
    return { ...record, failedMembers: derived.failedMembers };
  }
  const partialMembers = partialMembersFromScriptResult(run.state.scriptResult);
  return {
    ...record,
    // 「无失败但存在部分交付 → partially_succeeded」（§3.3.8 聚合规则第四支）——
    // done 升格；failed/partially_succeeded 派生形态不被部分交付事实改档。
    outcome: derived.outcome === "done" && partialMembers !== undefined
      ? "partially_succeeded"
      : derived.outcome,
    ...(derived.failedMembers !== undefined && derived.failedMembers.length > 0
      ? { failedMembers: derived.failedMembers }
      : {}),
    ...(partialMembers !== undefined ? { partialMembers } : {}),
  };
}

/** 全部成员 call 已终局（有 result——done ⟹ result 契约；空成员集 = 未终局，
 *  脚本层失败维持「成员无责」抑制）。脚本层失败两形态分流的判定位。 */
function allMemberCallsSettled(run: WorkflowRun): boolean {
  const calls = [...run.state.calls.values()];
  return calls.length > 0 && calls.every((call) => call.result !== undefined);
}
