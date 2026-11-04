// src/prompt-ack.ts
//
// [relay-spawn-transport §3.4.2 M2 / D3] prompt 送达回执 tracker（单级，per-run）。
//
// 语义锚点（pi@1.0.0 实装 + 设计 D3 用户裁决；机器登记 = docs/pi-semantics.json PS-81）：
//   pi 侧锚点（行号基于 pi@1.0.0；复核按符号名定位，探针 =
//   packages/runtime/src/infra/pi/__tests__/pi-semantics-bundle-2.test.ts）：
//   - `pi-coding-agent dist/modes/rpc/rpc-mode.js` `case "prompt"`（:298-313）：
//     `success(id, "prompt", { disposition })` 唯一发送点 = `session.prompt(...)` 的
//     `preflightResult` 回调内（先置 `preflightSucceeded = true`）；`.catch`（:308-312）
//     仅在 `!preflightSucceeded` 时 `output(error(id, "prompt", e.message))`——
//     受理后的异常不改写回执形状；
//   - `pi-coding-agent dist/core/agent-session.js` `prompt(text, options)`（:1487-1594）：
//     `preflightResult` 调用点全集 / disposition 值域 = `handled`（扩展命令接管 :1494 /
//     input handler 短路 :1504）/ `queued`（流式中排队 :1525）/ `started`（起轮前 :1594，
//     先于 `_runAgentPrompt`）——三态都是「pi 已受理」，pi 升级时此值域由 PS-81 探针复验。
//   taiji 侧（设计 D3 用户裁决 + [甲类裁决] 时间机制删除后终态）：
//   - **prompt response 是唯一成功回执**——`success === true`（`data.disposition` 可为
//     started / queued / handled，三者都表示 pi 已受理；`started` 不是唯一合法值）；
//   - **零输出判死已删**——原「写入后 30s 零 stdout → timeout」看门狗随时间机制
//     删除：prompt response 到达（acked/rejected）或通道死亡（lost）是仅有的结算
//     事实源，无时间上界；
//   - `success:false` → rejected（engine_prompt_rejected）——「已送达但被拒绝」
//     显式失败，立即结算；
//   - stdin 缺失/销毁、写入 EPIPE → failNow（lost）——立即失败；
//   - 不重试：prompt 可能已产生副作用，重试会重复执行；失败显式交给上层。
//
// 状态机：`pending → settled(kind) → disposed`。所有入口（dispatch / failNow）
// 只在 pending 态生效；settled/disposed 后一律 no-op（迟到 response 留痕
// 忽略——不重复 kill、不覆盖已有 failure、不产生未处理 rejection）。dispose 幂等，
// 挂 runSpawnOnce 的 finally（正常完成 / 异常 / 取消三路必经）。
//
// 诊断快照（pid / bytesWritten / stdoutBytes / stdoutBytesAfterPrompt /
// getStateAnswered + lastEventType）由 spawn-runner 闭包提供
// （`diagnostics()`），tracker 在 lost 时写结构化日志并把有界摘要拼进
// result.detail（→ outcome.error）。成功仍然只认 prompt response。

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

const logger = getLogger("session-runner");

/** settled 终态类别（设计 §3.4.2 PromptAckKind；timeout 已随零输出看门狗删除）。 */
export type PromptAckKind = "acked" | "rejected" | "lost";

/**
 * 结算结果（onFailure / runEnd.promptAckFailure 的载荷）。
 * detail 有界（pi error 文本与诊断摘要截断，见 {@link REJECTION_DETAIL_MAX_CHARS}）。
 */
export type PromptAckResult =
  | { kind: "acked"; disposition?: "started" | "queued" | "handled" }
  | { kind: "rejected"; detail: string }
  | { kind: "lost"; reason: "stdin-unavailable" | "epipe"; detail: string };

/** 诊断五元组 + 活性快照（spawn-runner 闭包装配；值都是确定性计数/置位，非推测）。 */
export type PromptAckDiagnostics = {
  pid?: number;
  /** stdin 已写字节（stdin-writer onBytesWritten 计数）。 */
  bytesWritten: number;
  /** 子进程 stdout 总字节（chunk 层计数，含 prompt 前的握手应答与未成行字节）。 */
  stdoutBytes: number;
  /** prompt 写入后的 stdout 字节（chunk 层计数，含未成行字节——零输出判定的直接证据）。 */
  stdoutBytesAfterPrompt: number;
  /** get_state response 是否已应答（success 与否都算——证明 stdout 活着）。 */
  getStateAnswered: boolean;
  /** 最近一次 SdkEvent 的 type（pump event 分支更新）。 */
  lastEventType?: string;
}

/** prompt 回执 tracker 句柄（pump 持有分发、spawn-runner 持有装配）。 */
export type PromptAckTracker = {
  /**
   * 登记本次 run 的 prompt response id（迟到 response 留痕匹配用）。
   * 只在「确实会尝试写入」时调用（stdin 不可用时调用方不登记——D3）。
   */
  register(id: string): void;
  /**
   * response 帧分发（pump 的 response 分支逐帧调用）。只有 `command === "prompt"`
   * 且 id 匹配已登记 id 的帧才结算；settled/disposed 后迟到 response 留痕忽略。
   */
  dispatch(
    id: string | undefined,
    command: string,
    success: boolean,
    data: unknown,
    error?: string,
  ): void;
  /** 立即失败（stdin 不可用 / EPIPE）：settle(lost) + onFailure。已 settle 后 no-op。 */
  failNow(reason: "stdin-unavailable" | "epipe", detail: string): void;
  /** 幂等清理：清登记表、标记 disposed（runSpawnOnce finally 必达）。 */
  dispose(): void;
}

/** pi error 文本进 detail 的截断长度（rejected detail 有界——outcome.error 不爆）。 */
const REJECTION_DETAIL_MAX_CHARS = 500;

/** pi rejected 文本截断（有界，防超长错误文案进终态）。 */
function boundDetail(text: string): string {
  return text.length <= REJECTION_DETAIL_MAX_CHARS
    ? text
    : `${text.slice(0, REJECTION_DETAIL_MAX_CHARS)}…(+${text.length - REJECTION_DETAIL_MAX_CHARS} chars)`;
}

/** 诊断快照 → 有界单行摘要（lost 时拼进 detail 与结构化日志）。 */
function formatDiagnostics(d: PromptAckDiagnostics): string {
  return (
    `pid=${d.pid ?? "-"} bytesWritten=${d.bytesWritten} stdoutBytes=${d.stdoutBytes} ` +
    `stdoutBytesAfterPrompt=${d.stdoutBytesAfterPrompt} ` +
    `getStateAnswered=${d.getStateAnswered} lastEventType=${d.lastEventType ?? "-"}`
  );
}

/** disposition 值域收窄（data.disposition 字段；未知形状 → undefined，不影响 acked 判定）。 */
function extractDisposition(data: unknown): "started" | "queued" | "handled" | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const v = (data as Record<string, unknown>)["disposition"];
  return v === "started" || v === "queued" || v === "handled" ? v : undefined;
}

/**
 * 创建 per-run 的 prompt 回执 tracker（设计 §3.4.2 契约）。装配见 spawn-runner
 * runSpawnOnce：`onFailure` = 记录 runEnd.promptAckFailure + killChild（SIGKILL
 * 直杀，run 以失败 outcome 收尾）；`diagnostics` = 闭包读 pump/写侧计数。
 */
export function createPromptAckTracker(opts: {
  recordId: string;
  diagnostics: () => PromptAckDiagnostics;
  onFailure: (result: PromptAckResult) => void;
  /**
   * [subagent-observability §3.3.1 P6] disposition=handled 接管信号回调（acked 结算后
   * 触发一次）：handled =「本条 prompt 未启动任何 run」（pi 1.0.0 官方语义——handled
   * 在 isStreaming 检查前短路、不进 _runAgentPrompt，而 agent_settled 只在该函数
   * finally 发射 → 零终态事件、exitPromise 无 resolve 通路 = 挂起形态）。调用方在
   * 此跑 P6 结算分派（结算门 → 事件位预筛 → get_state isStreaming 主判据 →
   * 立即轮终/继续等）。缺省 = 无 P6 消费（既有装配兼容）。
   */
  onHandled?: () => void;
}): PromptAckTracker {
  const { recordId, diagnostics, onFailure } = opts;

  let state: "pending" | "settled" | "disposed" = "pending";
  let pendingId: string | undefined;

  const settle = (result: PromptAckResult): void => {
    // 先置 settled 再触发 onFailure（设计：failNow 先 settle 再触发——
    // onFailure 内的 killChild → close → 后续回调看到的已是终态，不重入）。
    // pendingId 保留到 dispose：settled 态下仅供迟到 response 的留痕匹配用
    //（pending 分支有 state 门，不会被误结算）。
    state = "settled";
    if (result.kind !== "acked") onFailure(result);
  };

  /** 迟到 response 留痕（不重复 kill、不覆盖已有 failure、不产生未处理 rejection）。 */
  const warnLatePromptResponse = (id: string | undefined, command: string): void => {
    if (state !== "disposed" && command === "prompt" && id !== undefined && id === pendingId) {
      logger.warn(
        `[prompt-ack] ${recordId} late prompt response after settle (ignored): id=${id}`,
      );
    }
  };

  /** acked 日志：started / queued / handled 都是「pi 已受理」（D3 不采用只认 started）。 */
  const logPromptAcked = (disposition: "started" | "queued" | "handled" | undefined): void => {
    logger.debug(
      `[prompt-ack] ${recordId} prompt acked` +
        `${disposition !== undefined ? ` (disposition=${disposition})` : ""}`,
    );
  };

  /** rejected 文案：pi error 文本缺失时回落固定文案，统一走有界截断。 */
  const rejectionDetail = (error: string | undefined): string => {
    return boundDetail(error !== undefined && error !== "" ? error : "(no error text from pi)");
  };

  return {
    register(id) {
      if (state !== "pending") {
        logger.warn(`[prompt-ack] ${recordId} register after ${state} (ignored): id=${id}`);
        return;
      }
      if (pendingId !== undefined) {
        // 每 run 只有一次 prompt 投递；重复登记是装配错误，响亮留痕后以最新为准
        logger.warn(`[prompt-ack] ${recordId} duplicate register (replacing): old=${pendingId} new=${id}`);
      }
      pendingId = id;
    },

    dispatch(id, command, success, data, error) {
      if (state !== "pending") {
        // 迟到的 response：留痕忽略（不重复 kill、不覆盖已有 failure、不产生未处理 rejection）
        warnLatePromptResponse(id, command);
        return;
      }
      if (command !== "prompt") return;
      if (id === undefined || id !== pendingId) return;
      if (success) {
        const disposition = extractDisposition(data);
        logPromptAcked(disposition);
        settle({ kind: "acked", ...(disposition !== undefined ? { disposition } : {}) });
        // [subagent-observability §3.3.1 P6] handled = 执行从未启动的接管信号：
        // settle（回执层已结）之后触发 P6 结算分派——零终态事件挂起的唯一修复点。
        if (disposition === "handled") opts.onHandled?.();
        return;
      }
      const detail = rejectionDetail(error);
      logger.warn(`[prompt-ack] ${recordId} prompt rejected by pi: ${detail}`);
      settle({ kind: "rejected", detail });
    },

    failNow(reason, detail) {
      if (state !== "pending") return;
      const d = diagnostics();
      const bound = boundDetail(detail);
      const summary =
        `${reason}: ${bound}; diagnostics: ${formatDiagnostics(d)}`;
      logger.warn(`[prompt-ack] ${recordId} prompt delivery lost (failNow): ${summary}`);
      settle({ kind: "lost", reason, detail: summary });
    },

    dispose() {
      if (state === "disposed") return; // 幂等
      state = "disposed";
      pendingId = undefined;
    },
  };
}
