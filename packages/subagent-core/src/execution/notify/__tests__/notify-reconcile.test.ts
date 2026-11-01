// src/execution/notify/__tests__/notify-reconcile.test.ts
//
// 通知对账补投（completion-signal-delivery u3）行为锁：
//   - RL8  notifyId 构造一致（补投路径与主路径对同 record 产出相同 id——构造漂移
//          会导致补投用错键 → 判重失效双投）；
//   - RL10 rejected 立即单次重提（deliver 计数恰 2 + fake timers 零句柄——与 bash
//          域同款单次形态）；
//   - RL9  warn 文案含 recovered by reconcile fallback（弱断言防文案回退）+ 按载荷
//          形态分流（轮次载荷不承诺补投——reconcileRecoveryHint）；
//   - RL14 三入口必触发（session_start / agent_settled / 切回 resume——mock 三边沿
//          各自触发、编排各被调用恰一次、入口来源可辨；漏挂任一入口即红）；
//   - D5   两排除位真值表（cancelled 全 origin 非候选 / workflow origin 终态整体
//          排除）+ 三重判据逐行（V10 的单测面承载）；
//   - D6① 补投 payload 与主路径同构造（closed 终态形态、round 置 undefined——轮次
//          id 不混入、totalRounds 文案轮次、collectKey 申报）；
//   - A4   轮终收尾 idle 候选（canvas reviewer one-shot 形态的完成信号补投——A4
//          熔断修复回归）：markRoundIdle 落盘形态（idle 无 closedReason）候选命中、
//          宿主中断/重开族排除、record 级送达痕迹防双投、跨边沿幂等。
//
// 测试方法：三重判据全部经注入替身消费（NotifyReconcileSource / DeliveryPortHandle
// 结构兼容 mock），零真进程零真磁盘；readSessionEntriesFromFile 的坏行容错用 tmpdir
// 自建自删文件覆盖（fs-guard 白名单内，毫秒级）。

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// 编排的入口来源 debug / 失败 warn——mock 掉防刷屏，同时供 RL14「入口来源可辨」断言。
vi.mock("../../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import {
  configureNotifyDomain,
  resetNotifyDomainForTests,
  type DeliveryPortHandle,
} from "../../../core/notify-ports.ts";
import { createNotifier, buildNotifyId, type BgNotifyRecord } from "../notifier.ts";
import {
  collectDeliveredNotifyIds,
  collectJournaledDeliveryIds,
  isExcludedReconcileRecord,
  isReconcileCandidateRecord,
  isReconcileNotifyCandidate,
  readSessionEntriesFromFile,
  runNotifyReconcileMaintenance,
  type NotifyReconcileSource,
  type ReconcileNotifyRecord,
} from "../notify-reconcile.ts";
import { createNotifyHost, type NotifyHostDeps } from "../notify-host.ts";

// ─── 替身构造 ────────────────────────────────────────────────────────────────

/** fake 投递端口（deliver 计数 / envelope 捕获 / 同 id 幂等吞 / 定点拒绝；rejectIds 含 "*" 时全部拒绝）。 */
function makeFakePort(options: { swallowIds?: Set<string>; rejectIds?: Set<string> } = {}) {
  const deliverCalls: {
    envelope: { id?: string; payload: { kind: string; customType: string; content: string; display: boolean; details?: unknown } };
    opts: { collectKey?: string[] } | undefined;
  }[] = [];
  const handle: DeliveryPortHandle = {
    deliver(envelope, opts) {
      deliverCalls.push({ envelope, opts });
      const id = envelope.id ?? "";
      if (options.rejectIds?.has(id) || options.rejectIds?.has("*")) {
        return { kind: "rejected", reason: "persist-failed (fake)" };
      }
      if (options.swallowIds?.has(id)) {
        return { kind: "swallowed", reason: "already-seen" };
      }
      return { kind: "accepted", id: envelope.id ?? "gen-id" };
    },
    flush: () => {},
  };
  return { handle, deliverCalls };
}

/** 对账 record 替身（legacy closed 终态形态——补投候选的磁盘读形态）。 */
const reconcileRecord = (id: string, extra: Partial<ReconcileNotifyRecord> = {}): ReconcileNotifyRecord => ({
  id,
  agent: "explorer",
  status: "idle",
  closedReason: "gc",
  startedAt: 1,
  endedAt: 2,
  result: "done",
  ...extra,
});

/** 轮终收尾替身（markRoundIdle 落盘形态——idle 无 closedReason，A4 canvas reviewer 形态）。 */
const roundSettledRecord = (id: string, extra: Partial<ReconcileNotifyRecord> = {}): ReconcileNotifyRecord =>
  reconcileRecord(id, { status: "idle", closedReason: undefined, stopReason: "stop", ...extra });

/** 静态对账事实源（records / entries 直给，调用计数可断言）。 */
function makeSource(records: ReconcileNotifyRecord[], entries: unknown[] = []) {
  return {
    listReconcileRecords: vi.fn(() => records),
    readSessionEntries: vi.fn(() => entries),
  };
}

/** 执行对账编排（默认 source 直给 + submitNotify 捕获）。 */
async function reconcile(
  source: NotifyReconcileSource,
  reason = "resume",
  submitted: BgNotifyRecord[] = [],
) {
  return runNotifyReconcileMaintenance({
    reason,
    source,
    notifyCustomType: "subagent-bg-notify",
    submitNotify: (record) => submitted.push(record),
  });
}

beforeEach(() => {
  resetNotifyDomainForTests();
});

afterEach(() => {
  resetNotifyDomainForTests();
  loggerMock.debug.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
});

// ─── RL8：notifyId 构造一致（补投与主路径同构造） ─────────────────────────────

describe("RL8 notifyId 构造一致（补投路径与主路径共用 buildNotifyId）", () => {
  it("同 record 经主路径 notify 与补投管道 submitNotify→notify 产出相同幂等键", async () => {
    const fake = makeFakePort();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    const notifier = createNotifier({
      sendMessage: () => {},
    });

    const record: BgNotifyRecord = {
      id: "bg-8",
      status: "closed",
      closedReason: "gc",
      agent: "explorer",
      result: "done",
      startedAt: 1,
      endedAt: 2,
    };
    // 主路径直投一次（基准键）。
    notifier.notify(record);
    const mainPathId = fake.deliverCalls[0]?.envelope.id;

    // 补投路径：编排构造的 payload 经同一 notifier 投出。
    const submitted: BgNotifyRecord[] = [];
    await reconcile(makeSource([reconcileRecord("bg-8")]), "resume", submitted);
    notifier.notify(submitted[0]!);
    const redeliveredId = fake.deliverCalls[1]?.envelope.id;

    expect(submitted).toHaveLength(1);
    expect(mainPathId).toBe("bg-8");
    expect(redeliveredId).toBe(mainPathId);
    notifier.dispose();
  });

  it("buildNotifyId 形态矩阵：id / id:round / id:epoch / id:epoch:round / dedupKey 覆盖", () => {
    expect(buildNotifyId({ id: "bg-x" })).toBe("bg-x");
    expect(buildNotifyId({ id: "bg-x", round: 3 })).toBe("bg-x:3");
    expect(buildNotifyId({ id: "bg-x", epoch: 2 })).toBe("bg-x:2");
    expect(buildNotifyId({ id: "bg-x", epoch: 2, round: 3 })).toBe("bg-x:2:3");
    expect(buildNotifyId({ id: "bg-x", epoch: 0, round: 1 })).toBe("bg-x:1"); // epoch=0 恒旧格式
    expect(buildNotifyId({ id: "bg-x", round: 1, dedupKey: "bg-x:1:drain-drop" })).toBe("bg-x:1:drain-drop");
  });

  it("补投键构造无轮次段（round 置 undefined——轮次 id 不混入，判据天然只构造终态键）", async () => {
    const fake = makeFakePort();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    const notifier = createNotifier({ sendMessage: () => {} });
    const submitted: BgNotifyRecord[] = [];
    // record 带 round（历史轮次计数）——补投键仍为裸 id（notifyClosed 同款）。
    await reconcile(makeSource([reconcileRecord("bg-rounds", { round: 4 })]), "resume", submitted);
    notifier.notify(submitted[0]!);
    expect(fake.deliverCalls[0]?.envelope.id).toBe("bg-rounds");
    expect(fake.deliverCalls[0]?.envelope.id).not.toContain(":4");
    notifier.dispose();
  });
});

// ─── RL10/RL9：rejected 立即单次重提（与 bash 域同款单次形态） ─────────────────

describe("RL10/RL9 rejected 处置阶梯①——立即单次重提", () => {
  function setup() {
    const rejectIds = new Set<string>();
    const fake = makeFakePort({ rejectIds });
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    const notifier = createNotifier({ sendMessage: () => {} });
    return {
      fake,
      notifier,
      rejectAll: () => rejectIds.add("*"),
      acceptAll: () => rejectIds.clear(),
    };
  }

  it("首投 rejected → 立即重提恰一次（deliver 计数恰 2），无定时器句柄残留", async () => {
    const { notifier, fake, rejectAll, acceptAll } = setup();
    vi.useFakeTimers();
    try {
      rejectAll();
      notifier.notify({ id: "bg-retry-1", status: "closed", agent: "a", startedAt: 1, endedAt: 2 });
      expect(fake.deliverCalls).toHaveLength(2);
      // 同 envelope 重提（同幂等键同 payload——「重提原 payload」语义）。
      expect(fake.deliverCalls[1]?.envelope).toEqual(fake.deliverCalls[0]?.envelope);
      // 重提完成即收：无定时器、无后台重试（RL10 的机器面）。
      expect(vi.getTimerCount()).toBe(0);
      // 放行后重查：不产生第三次投递（单次已花完）。
      acceptAll();
      expect(fake.deliverCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      notifier.dispose();
    }
  });

  it("重提仍 rejected → 单次后停止（无循环无队列）；重取缺席 → 停止不兜底直发", async () => {
    const { notifier, fake, rejectAll } = setup();
    rejectAll();
    notifier.notify({ id: "bg-retry-2", status: "closed", agent: "a", startedAt: 1, endedAt: 2 });
    expect(fake.deliverCalls).toHaveLength(2);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("single retry spent; recovered by reconcile fallback"),
      expect.objectContaining({ detail: expect.objectContaining({ notifyId: "bg-retry-2" }) }),
    );
    notifier.dispose();
  });

  it("重取缺席（端口槽重取时点返回 undefined）→ 跳过重提留 warn（缺席直发兜底不扩重提路径）", async () => {
    // 同步实现下「首投在位、重取缺席」是 mock 访问器两次调用返回不同值的竞态窗
    // 形态（session_start 重绑窗内首投旧实例、重取端口摘除——缺席语义与生产可达
    // 形态一致）。
    const rejectIds = new Set(["bg-retry-absent"]);
    const flaky = makeFakePort({ rejectIds });
    let portCalls = 0;
    configureNotifyDomain({ getDeliveryPort: () => (portCalls++ === 0 ? flaky.handle : undefined) });
    const notifier = createNotifier({ sendMessage: () => {} });
    notifier.notify({ id: "bg-retry-absent", status: "closed", agent: "a", startedAt: 1, endedAt: 2 });
    expect(flaky.deliverCalls).toHaveLength(1); // 仅首投 rejected——重提被缺席跳过
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("port absent on re-acquire"),
      expect.anything(),
    );
    // 缺席形态不落直发兜底（重提路径不扩缺席降级——恢复通道是对账边沿）。
    expect(flaky.deliverCalls).toHaveLength(1);
    notifier.dispose();
  });

  it("RL9 warn 文案含 recovered by reconcile fallback（不再宣称 lost）", async () => {
    const { notifier, fake, rejectAll } = setup();
    rejectAll();
    notifier.notify({ id: "bg-warn-copy", status: "closed", agent: "a", startedAt: 1, endedAt: 2 });
    const firstWarn = loggerMock.warn.mock.calls[0]?.[0] as string;
    expect(firstWarn).toContain("delivery port rejected notification");
    expect(firstWarn).toContain("recovered by reconcile fallback");
    expect(firstWarn).not.toContain("lost");
    expect(fake.deliverCalls).toHaveLength(2);
    notifier.dispose();
  });

  it("warn 文案按载荷形态分流：轮次载荷 rejected 不承诺 reconcile fallback（对账不补轮次键——恢复通道 = 下一轮边沿自然重发）", async () => {
    const { notifier, fake, rejectAll } = setup();
    rejectAll();
    notifier.notify({ id: "bg-warn-round", status: "running", round: 2, agent: "a", startedAt: 1, endedAt: 2 });
    expect(fake.deliverCalls).toHaveLength(2); // 首败 + 单次重提（处置阶梯不变）
    const warns = loggerMock.warn.mock.calls.map((c) => c[0] as string);
    expect(warns).toHaveLength(2);
    for (const text of warns) {
      expect(text).not.toContain("recovered by reconcile fallback");
      expect(text).toContain("resent naturally at the next round edge");
    }
    notifier.dispose();
  });
});

// ─── RL14：三入口必触发（session_start / agent_settled / 切回 resume） ─────────

describe("RL14 三入口必触发（编排互调同一对账函数，漏挂任一入口即红）", () => {
  function makePi() {
    const settledHandlers: (() => void)[] = [];
    return {
      settledHandlers,
      pi: {
        appendEntry: () => {},
        events: { emit: () => {} },
        sendMessage: () => {},
        on: vi.fn((_event: "agent_settled", handler: () => void) => {
          settledHandlers.push(handler);
        }),
      },
    };
  }

  function makeHostDeps(
    source: NotifyReconcileSource | undefined,
    pi: ReturnType<typeof makePi>["pi"],
  ): NotifyHostDeps {
    return {
      getPi: () => pi,
      getIsIdle: () => undefined,
      ...(source ? { getReconcileSource: () => source } : {}),
    };
  }

  it("① session_start：revive() 触发对账恰一次（含 agent_settled 订阅落位）", async () => {
    const source = makeSource([reconcileRecord("bg-entry-1")]);
    const { pi } = makePi();
    const host = createNotifyHost(makeHostDeps(source, pi));

    host.revive();
    // 编排 async——确定性完成信号：listReconcileRecords 调用即已进入编排。
    expect(source.listReconcileRecords).toHaveBeenCalledTimes(1);
    // 订阅落位恰一次（revive 内，构造期 pi 为 null 的约束下只能在注入后订阅）。
    expect(pi.on).toHaveBeenCalledTimes(1);
    expect(pi.on).toHaveBeenCalledWith("agent_settled", expect.any(Function));
  });

  it("② agent_settled：pi 边沿触发对账恰一次；per-pi 实例恰一订阅、session 替换后新实例重新注册恰一次", async () => {
    const source = makeSource([reconcileRecord("bg-entry-2")]);
    const first = makePi();
    const second = makePi();
    // pi 引用可变（session 替换语义——getPi 惰性闭包返回当前实例）。
    let currentPi = first.pi;
    const host = createNotifyHost({
      getPi: () => currentPi,
      getIsIdle: () => undefined,
      getReconcileSource: () => source,
    });

    host.revive();
    expect(first.settledHandlers).toHaveLength(1);
    expect(source.listReconcileRecords).toHaveBeenCalledTimes(1); // ①入口同批触发
    // 同一 pi 实例重复 revive（同 session 重复 initSession）不重复订阅。
    host.revive();
    expect(first.pi.on).toHaveBeenCalledTimes(1);
    expect(first.settledHandlers).toHaveLength(1);
    expect(source.listReconcileRecords).toHaveBeenCalledTimes(2); // 对账随边沿幂等重查

    // 边沿触发（②入口——回合收尾）。
    source.listReconcileRecords.mockClear();
    first.settledHandlers[0]!();
    expect(source.listReconcileRecords).toHaveBeenCalledTimes(1);
    expect(loggerMock.debug).toHaveBeenCalledWith(
      "notify reconcile dispatch",
      expect.objectContaining({ detail: expect.objectContaining({ reason: "agent_settled" }) }),
    );

    // session 替换：新 pi 实例经 revive 重新注册恰一次；旧 handler 挂在旧实例上
    // （pi 侧 eventBus 随实例重建——RL13 同款构造性防累积，此处断言注册面）。
    currentPi = second.pi;
    host.revive();
    expect(second.pi.on).toHaveBeenCalledTimes(1);
    expect(second.settledHandlers).toHaveLength(1);
    // 新实例 handler 同样驱动同一对账函数（编排单一）。
    source.listReconcileRecords.mockClear();
    second.settledHandlers[0]!();
    expect(source.listReconcileRecords).toHaveBeenCalledTimes(1);
  });

  it("③ 切回（resume）：包导出编排被扩展侧调用即触发补投（入口来源可辨）", async () => {
    const source = makeSource([reconcileRecord("bg-entry-3")]);
    const submitted: BgNotifyRecord[] = [];
    const result = await reconcile(source, "resume", submitted);
    expect(source.listReconcileRecords).toHaveBeenCalledTimes(1);
    expect(result.redelivered).toEqual(["bg-entry-3"]);
    expect(loggerMock.debug).toHaveBeenCalledWith(
      "notify reconcile dispatch",
      expect.objectContaining({ detail: expect.objectContaining({ reason: "resume" }) }),
    );
  });

  // [A5 product-bug 修复回归] 入口③生产接线面 = 装配实例转发通道：扩展侧经
  // SubagentService.runNotifyReconcileMaintenance → NotifyHost.runReconcile（本用例
  // 锁 host 公开面）。与包导出直调（③）的区别在事实源/补投出口取自 host 装配——
  // 扩展侧无法直构 deps，漏挂本通道 = A5 组 a 零补投的缺陷形态。
  it("③' 切回（resume）转发通道：NotifyHost.runReconcile 外部触发恰一次、reason 透传（V4b 入口③生产接线面）", async () => {
    const source = makeSource([reconcileRecord("bg-entry-3b")]);
    const { pi } = makePi();
    const host = createNotifyHost(makeHostDeps(source, pi));

    // revive（入口①）先行落位；mockClear 后单测入口③通道本身。
    host.revive();
    source.listReconcileRecords.mockClear();
    host.runReconcile("resume");
    // 恰一次 + 入口来源可辨（RL14——与内部两入口同编排、同 reason 透传）。
    expect(source.listReconcileRecords).toHaveBeenCalledTimes(1);
    expect(loggerMock.debug).toHaveBeenCalledWith(
      "notify reconcile dispatch",
      expect.objectContaining({ detail: expect.objectContaining({ reason: "resume" }) }),
    );
  });

  it("③'' 切回转发通道同样受预检短路护栏约束：无候选不触 entries 全读取", async () => {
    const source = makeSource([
      reconcileRecord("bg-live-3c", { status: "running", closedReason: undefined }),
    ]);
    const { pi } = makePi();
    const host = createNotifyHost(makeHostDeps(source, pi));

    host.revive();
    source.listReconcileRecords.mockClear();
    source.readSessionEntries.mockClear();
    host.runReconcile("resume");
    // 编排已进入（records 扫描发生），但无候选短路——entries 全读取不发生。
    expect(source.listReconcileRecords).toHaveBeenCalledTimes(1);
    expect(source.readSessionEntries).not.toHaveBeenCalled();
  });

  it("事实源缺席（deps 未注入 getReconcileSource）→ 对账不挂（缺席 debug 留痕一次，行为兼容既有构造方）", () => {
    const { pi } = makePi();
    const host = createNotifyHost(makeHostDeps(undefined, pi));
    host.revive();
    expect(loggerMock.debug).toHaveBeenCalledWith(
      expect.stringContaining("reconcile source not wired"),
    );
  });
});

// ─── D5 两排除位 + 三重判据真值表（V10 的单测面承载） ─────────────────────────

describe("D5 排除位真值表 + 三重判据逐行（防误补投）", () => {
  it("成因位全 origin：closed+cancelled 对 tool / workflow 两 origin 均非候选", async () => {
    const submitted: BgNotifyRecord[] = [];
    const result = await reconcile(
      makeSource([
        reconcileRecord("bg-cancel-tool", { closedReason: "cancelled" }),
        reconcileRecord("bg-cancel-wf", { closedReason: "cancelled", origin: "workflow" }),
      ]),
      "resume",
      submitted,
    );
    expect(result.candidates).toBe(0);
    expect(submitted).toHaveLength(0);
    // 排除位单一落点直测（判据函数本体）。
    expect(isExcludedReconcileRecord({ closedReason: "cancelled" })).toBe(true);
    expect(isExcludedReconcileRecord({ closedReason: "cancelled", origin: "workflow" })).toBe(true);
    expect(isExcludedReconcileRecord({ closedReason: "gc", origin: undefined })).toBe(false);
  });

  it("origin 位：workflow origin 终态 record 整体排除（cancelled 与 gc 皆然）", async () => {
    const submitted: BgNotifyRecord[] = [];
    const result = await reconcile(
      makeSource([
        reconcileRecord("bg-wf-gc", { origin: "workflow" }),
        reconcileRecord("bg-wf-cancel", { origin: "workflow", closedReason: "cancelled" }),
      ]),
      "resume",
      submitted,
    );
    expect(result.candidates).toBe(0);
    expect(submitted).toHaveLength(0);
  });

  it("非排除位成因（parent-shutdown / user-close / disconnected）均候选", async () => {
    const submitted: BgNotifyRecord[] = [];
    const result = await reconcile(
      makeSource([
        reconcileRecord("bg-ps", { closedReason: "parent-shutdown" }),
        reconcileRecord("bg-uc", { closedReason: "user-close" }),
        reconcileRecord("bg-dc", { closedReason: "disconnected" }),
      ]),
      "resume",
      submitted,
    );
    expect(result.candidates).toBe(3);
    expect(result.redelivered).toEqual(["bg-ps", "bg-uc", "bg-dc"]);
  });

  it("running 非候选（轮在途——两态模型活跃位结构性排除）", async () => {
    const submitted: BgNotifyRecord[] = [];
    const result = await reconcile(
      makeSource([
        reconcileRecord("bg-running", { status: "running", closedReason: undefined }),
      ]),
      "resume",
      submitted,
    );
    expect(result.candidates).toBe(0);
    expect(submitted).toHaveLength(0);
  });

  it("事实二/三命中非候选：送达痕迹 / 投递日志条目各自阻断（跳过分流可辨）", async () => {
    const record = reconcileRecord("bg-hit");
    const submitted: BgNotifyRecord[] = [];
    const result = await reconcile(
      makeSource(
        [record],
        [
          { customType: "subagent-bg-notify", content: "x", details: { notifyId: "bg-hit" } },
          { customType: "delivery-port-outbox", data: { id: "bg-hit-2" } },
        ],
      ),
      "resume",
      submitted,
    );
    expect(result.skippedDelivered).toEqual(["bg-hit"]);
    expect(submitted).toHaveLength(0);
  });

  it("预检短路：无候选不触 entries 全读取（agent_settled 高频边沿成本下界）", async () => {
    const source = makeSource([reconcileRecord("bg-live", { status: "running", closedReason: undefined })]);
    await reconcile(source);
    expect(source.readSessionEntries).not.toHaveBeenCalled();
  });

  it("判据骨架真值组合直测（与 bash 域骨架同构的逐一锚定）", () => {
    expect(isReconcileNotifyCandidate({ isTerminal: true, excludedByOrigin: false, delivered: false, journaled: false })).toBe(true);
    expect(isReconcileNotifyCandidate({ isTerminal: false, excludedByOrigin: false, delivered: false, journaled: false })).toBe(false);
    expect(isReconcileNotifyCandidate({ isTerminal: true, excludedByOrigin: true, delivered: false, journaled: false })).toBe(false);
    expect(isReconcileNotifyCandidate({ isTerminal: true, excludedByOrigin: false, delivered: true, journaled: false })).toBe(false);
    expect(isReconcileNotifyCandidate({ isTerminal: true, excludedByOrigin: false, delivered: false, journaled: true })).toBe(false);
  });
});

// ─── 轮终收尾 idle 候选（A4 熔断修复回归：canvas reviewer one-shot 完成信号补投） ──

describe("轮终收尾 idle 候选（markRoundIdle 形态——A4 缺陷回归锁）", () => {
  it("候选命中：canvas reviewer one-shot 形态（idle 无 closedReason + 引擎停因 stop）→ 补投恰 1 条（裸 id 终态键 + collectKey 申报 + details 带 result）", async () => {
    const fake = makeFakePort();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    const notifier = createNotifier({ sendMessage: () => {} });
    const submitted: BgNotifyRecord[] = [];
    const result = await reconcile(
      makeSource([roundSettledRecord("sa-one-shot", { agent: "canvas-reviewer", result: "CANARY" })]),
      "session_start",
      submitted,
    );
    expect(result.candidates).toBe(1);
    expect(result.redelivered).toEqual(["sa-one-shot"]);
    // 补投经主路径管道：幂等键 = 裸 id（id[:epoch] 形态，round 不混入）、collectKey
    // 申报 [record.id]（collect_results 可收取）、details 携带 notifyId 与轮终 result。
    notifier.notify(submitted[0]!);
    expect(fake.deliverCalls).toHaveLength(1);
    expect(fake.deliverCalls[0]?.envelope.id).toBe("sa-one-shot");
    expect(fake.deliverCalls[0]?.opts).toEqual({ collectKey: ["sa-one-shot"] });
    const details = fake.deliverCalls[0]?.envelope.payload.details as Record<string, unknown>;
    expect(details.notifyId).toBe("sa-one-shot");
    expect(details.result).toBe("CANARY");
    expect(details.agent).toBe("canvas-reviewer");
    notifier.dispose();
  });

  it("失败轮形态如实派生：stopReason=error + error 有值 → 补投 outcome=failed（deriveOutcome 单一权威，不谎报 completed）", async () => {
    const fake = makeFakePort();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    const notifier = createNotifier({ sendMessage: () => {} });
    const submitted: BgNotifyRecord[] = [];
    await reconcile(
      makeSource([roundSettledRecord("sa-failed-round", { stopReason: "error", error: "engine boom" })]),
      "agent_settled",
      submitted,
    );
    expect(submitted).toHaveLength(1);
    notifier.notify(submitted[0]!);
    const details = fake.deliverCalls[0]?.envelope.payload.details as Record<string, unknown>;
    expect(details.outcome).toBe("failed");
    expect(String(fake.deliverCalls[0]?.envelope.payload.content)).toContain("engine boom");
    notifier.dispose();
  });

  it("宿主中断/重开族排除（V10 同族——取消轮不产生完成通知，主路径不发者不补投）：interrupted / interrupted-by-restart / interrupted-by-parent / reopened 全部非候选", async () => {
    const submitted: BgNotifyRecord[] = [];
    const result = await reconcile(
      makeSource([
        roundSettledRecord("bg-cancel-round", { stopReason: "interrupted" }),
        roundSettledRecord("bg-restart-round", { stopReason: "interrupted-by-restart" }),
        roundSettledRecord("bg-parent-round", { stopReason: "interrupted-by-parent" }),
        roundSettledRecord("bg-reopen-round", { stopReason: "reopened" }),
      ]),
      "resume",
      submitted,
    );
    expect(result.candidates).toBe(0);
    expect(submitted).toHaveLength(0);
    // 判据函数直测（域侧单一落点）。
    expect(isReconcileCandidateRecord({ status: "running" })).toBe(false);
    expect(isReconcileCandidateRecord({ status: "idle", closedReason: "gc" })).toBe(true);
    expect(isReconcileCandidateRecord({ status: "idle", stopReason: "stop" })).toBe(true);
    expect(isReconcileCandidateRecord({ status: "idle" })).toBe(true); // 被接管轮无停因事实
    expect(isReconcileCandidateRecord({ status: "idle", stopReason: "interrupted" })).toBe(false);
    expect(isReconcileCandidateRecord({ status: "idle", stopReason: "reopened" })).toBe(false);
  });

  it("origin 位对轮终收尾形态同样生效：workflow origin 的轮终 idle 整体排除", async () => {
    const submitted: BgNotifyRecord[] = [];
    const result = await reconcile(
      makeSource([roundSettledRecord("bg-wf-round", { origin: "workflow" })]),
      "resume",
      submitted,
    );
    expect(result.candidates).toBe(0);
    expect(submitted).toHaveLength(0);
  });

  it("防双投：主路径轮次应答已送达（details.id 记录级痕迹）→ 补投被阻断（裸键查询对轮次键不可见，record 级通道承接）", async () => {
    const submitted: BgNotifyRecord[] = [];
    const result = await reconcile(
      makeSource(
        [roundSettledRecord("sa-delivered")],
        [
          // 主路径轮次应答条目形态：notifyId/deliveryId 均为轮次键（id:round），
          // details.id 携带一等 record id。
          {
            customType: "subagent-bg-notify",
            content: "round reply",
            details: { id: "sa-delivered", notifyId: "sa-delivered:1", deliveryId: "sa-delivered:1" },
          },
        ],
      ),
      "agent_settled",
      submitted,
    );
    expect(result.candidates).toBe(1);
    expect(result.skippedDelivered).toEqual(["sa-delivered"]);
    expect(submitted).toHaveLength(0);
  });

  it("跨边沿幂等：首轮补投受理后（投递日志裸 id 条目在册）→ 二次对账零第二条", async () => {
    const submitted: BgNotifyRecord[] = [];
    const source = makeSource(
      [roundSettledRecord("sa-idem")],
      [{ customType: "delivery-port-outbox", data: { id: "sa-idem" } }],
    );
    const first = await reconcile(source, "session_start", submitted);
    expect(first.redelivered).toEqual([]);
    const second = await reconcile(source, "agent_settled", submitted);
    expect(second.skippedJournaled).toEqual(["sa-idem"]);
    expect(submitted).toHaveLength(0);
  });
});

// ─── 补投 payload / 受理形态（D6①） ─────────────────────────────────────────

describe("补投 payload 与受理形态（D6①：补投的是主路径本要发的那条通知）", () => {
  it("payload = notifyClosed 同款 closed 终态形态（round 置 undefined、totalRounds 文案轮次、诊断字段透传）", async () => {
    const submitted: BgNotifyRecord[] = [];
    await reconcile(
      makeSource([
        reconcileRecord("bg-payload", {
          round: 4,
          agent: "fixer",
          model: "glm-4.7",
          error: undefined,
          sessionFile: "/tmp/bg-payload.jsonl",
          patchFile: "/tmp/bg-payload.patch",
        }),
      ]),
      "resume",
      submitted,
    );
    expect(submitted).toHaveLength(1);
    const payload = submitted[0]!;
    expect(payload.status).toBe("closed");
    expect(payload.round).toBeUndefined(); // 终态键（与轮次通知键区分）
    expect(payload.totalRounds).toBe(4); // 轮数改经文案字段
    expect(payload.closedReason).toBe("gc");
    expect(payload.sessionFile).toBe("/tmp/bg-payload.jsonl");
    expect(payload.patchFile).toBe("/tmp/bg-payload.patch");
  });

  it("补投经主路径管道受理：collectKey 申报 [record.id]、details 携带 notifyId（GUI pane 消费依赖）", async () => {
    const fake = makeFakePort();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    const notifier = createNotifier({ sendMessage: () => {} });
    const submitted: BgNotifyRecord[] = [];
    await reconcile(makeSource([reconcileRecord("bg-collect")]), "resume", submitted);
    notifier.notify(submitted[0]!);

    expect(fake.deliverCalls).toHaveLength(1);
    expect(fake.deliverCalls[0]?.opts).toEqual({ collectKey: ["bg-collect"] });
    const details = fake.deliverCalls[0]?.envelope.payload.details as Record<string, unknown>;
    expect(details.notifyId).toBe("bg-collect");
    expect(details.outcome).toBeDefined(); // outcome 物化（deriveOutcome 单一权威）
    notifier.dispose();
  });

  it("幂等吞并形态：deliver swallowed 记入 redelivered（跨边沿幂等——已受理即不再补）", async () => {
    const fake = makeFakePort({ swallowIds: new Set(["bg-swallowed"]) });
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    const notifier = createNotifier({ sendMessage: () => {} });
    const submitted: BgNotifyRecord[] = [];
    await reconcile(makeSource([reconcileRecord("bg-swallowed")]), "resume", submitted);
    notifier.notify(submitted[0]!);
    // swallowed = 该键已被更早通道受理——编排侧本轮视为已补投受理（port 判重承接跨边沿）。
    expect(submitted).toHaveLength(1);
    notifier.dispose();
  });

  it("送达痕迹双通道：details.notifyId 与 details.deliveryId 任一命中即判已送达", () => {
    const ids = collectDeliveredNotifyIds(
      [
        { customType: "subagent-bg-notify", content: "a", details: { notifyId: "k-notify" } },
        { customType: "subagent-bg-notify", content: "b", details: { deliveryId: "k-delivery" } },
        { customType: "other-type", details: { notifyId: "k-other" } }, // 非本域条目不收
        { customType: "subagent-bg-notify", content: "c" }, // 无 details 跳过
      ],
      "subagent-bg-notify",
    );
    expect(ids).toEqual(new Set(["k-notify", "k-delivery"]));
  });

  it("投递日志宽容口径：outbox / ack 的 data.id 直读即收；畸形跳过", () => {
    const ids = collectJournaledDeliveryIds([
      { customType: "delivery-port-outbox", data: { id: "j-outbox" } },
      { customType: "delivery-port-ack", data: { id: "j-ack" } },
      { customType: "delivery-port-outbox", data: null },
      { customType: "delivery-port-outbox" },
      { customType: "delivery-port-outbox", data: { id: 42 } },
    ]);
    expect(ids).toEqual(new Set(["j-outbox", "j-ack"]));
  });
});

// ─── entries 文件读取（宽容口径容错） ────────────────────────────────────────

describe("readSessionEntriesFromFile（坏行跳过 / 缺文件空读）", () => {
  it("逐行 JSON 解析、坏行跳过；文件不可读返回空数组", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "taiji-notify-reconcile-"));
    try {
      const file = join(dir, "session.jsonl");
      const good = { customType: "delivery-port-outbox", data: { id: "j1" } };
      fs.writeFileSync(
        file,
        `${JSON.stringify(good)}\n{broken-json\n\n${JSON.stringify({ customType: "x" })}\n`,
        "utf-8",
      );
      const entries = readSessionEntriesFromFile(file);
      expect(entries).toHaveLength(2);
      expect(readSessionEntriesFromFile(join(dir, "missing.jsonl"))).toEqual([]);
      expect(readSessionEntriesFromFile(undefined)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
