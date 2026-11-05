// zcode-engine.abort-chain-mock.test.ts —— abort 链 / 收割等待的 mock 双轨单测（默认档）。
//
// 与集成门控 abort-dispose.test.ts（真 fake-appserver 子进程，TAIJI_TEST_INTEGRATION）
// 构成同一行为面的双轨：coverage gate 本地跑不开集成门控，时间机制删除后新增的
// abort 收尾行（stop 帧 → killChain → onClose 收割等待 → 终态合成）需 mock 形态
// 在默认档覆盖。conn/runtime 全 stub、白盒直达私有链路——零子进程、零墙钟等待。
// 行为保真（帧序 / 收割语义 / 不变量）由集成门控侧承载，本文件只覆盖分支接线。

import { describe, expect, it, vi } from "vitest";

import type { AgentEvent, AgentOutcome } from "@zhushanwen/subagent-engine-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerConnection } from "../connection.ts";
import type { RunContext } from "../port-types.ts";
import { SessionChannel } from "../session-channel.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";

// ── stub 设施 ──────────────────────────────────────────────────────────────

/** AppServerConnection 窄面 stub：alive 可变；onClose 回调手动触发（事件等待链的确定性收口）。 */
interface ConnStub {  // oe-exempt:20261105:test:mock 夹具契约面（stub 形状接口，单实现为测试常态）
  alive: boolean;
  request: (method: string, params?: unknown) => Promise<unknown>;
  post: (method: string, params?: unknown) => boolean;
  shutdown: () => Promise<void>;
  onClose: (handler: (reason: string) => void) => () => void;
  emitClose: (reason: string) => void;
}

function makeConnStub(overrides?: Partial<Pick<ConnStub, "alive" | "request">>): ConnStub {
  const closeHandlers = new Set<(reason: string) => void>();
  return {
    alive: overrides?.alive ?? true,
    request:
      overrides?.request ??
      vi.fn(async (_method: string, _params?: unknown) => {
        return {};
      }),
    post: vi.fn(() => true),
    shutdown: vi.fn(async () => {}),
    onClose: vi.fn((handler: (reason: string) => void) => {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    }),
    emitClose: (reason: string) => {
      for (const handler of [...closeHandlers]) handler(reason);
    },
  };
}

interface RuntimeStub {  // oe-exempt:20261105:test:mock 夹具契约面（stub 形状接口，单实现为测试常态）
  conn: ConnStub;
  channel: { dispose: ReturnType<typeof vi.fn> };
  activeSessions: Set<string>;
}

function makeRuntimeStub(conn: ConnStub): RuntimeStub {
  return { conn, channel: { dispose: vi.fn() }, activeSessions: new Set<string>() };
}

function makeEngine(): ZcodeEngine {
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => "/tmp/zcode-abort-chain-mock-data",
    // probe 用例需要存在的文件——本测试文件自身
    cliPath: new URL(import.meta.url).pathname,
  };
  return new ZcodeEngine(deps);
}

/** 白盒：私有 abort 链方法与 runtime 字段（private 仅类型层——现有测试同款先例）。 */
interface AbortChainPrivates {  // oe-exempt:20261105:test:mock 夹具契约面（stub 形状接口，单实现为测试常态）
  appserverRuntime: RuntimeStub | undefined;
  appServerAbortChain: (
    rt: RuntimeStub,
    turn: Promise<unknown>,
    getSessionId: () => string | undefined,
    sessionCreated: Promise<void>,
  ) => Promise<void>;
  awaitConnFinalized: (rt: RuntimeStub) => Promise<void>;
  shutdownRuntimeAndDisposeChannel: (rt: RuntimeStub) => Promise<void>;
  classifyAppServerTurnFailure: (
    err: unknown,
    ctx: RunContext,
    args: {
      rt: RuntimeStub;
      turn: Promise<unknown>;
      currentSessionId: () => string | undefined;
      sessionCreated: Promise<void>;
      retried: boolean | undefined;
    },
  ) => Promise<{ kind: string; abortMessage?: string }>;
  finalizeOutcome: (
    task: { worktree?: unknown },
    ctx: RunContext,
    final: { kind: "aborted"; output: { exitCode: number | null; stdoutText: string; stderrTail: string }; abortMessage?: string },
    usageAcc: { input: number; output: number; cacheRead: number; cacheWrite: number; has: boolean },
    startedAt: number,
  ) => AgentOutcome;
  applyAbortedOutcome: (
    outcome: AgentOutcome,
    final: { kind: "aborted"; output: { exitCode: number | null; stdoutText: string; stderrTail: string }; abortMessage?: string },
    emit: (event: AgentEvent) => void,
  ) => void;
}

function priv(engine: ZcodeEngine): AbortChainPrivates {
  return engine as unknown as AbortChainPrivates;
}

function makeCtx(signal?: AbortSignal): RunContext {
  return { taskId: "sa-mock", ...(signal ? { signal } : {}) } as RunContext;
}

// ── 用例 ──────────────────────────────────────────────────────────────────

describe("zcode-engine abort 链 mock 双轨（默认档）", () => {
  it("probe：engineVersion 恒空串（--version 版本探测已随时间机制删除——二进制好坏由 run 后实际退出/握手链兜底报错）", async () => {
    const engine = makeEngine();
    const report = await engine.probe();
    expect(report.engineVersion).toBe("");
    expect(report.ok).toBe(true); // cliPath 指向本测试文件（存在且是文件）
  });

  it("awaitConnFinalized：连接已死立即返回（不订阅）；存活时等 onClose 广播收口（纯事件等待，无墙钟兜底）", async () => {
    const engine = makeEngine();
    const dead = makeRuntimeStub(makeConnStub({ alive: false }));
    await priv(engine).awaitConnFinalized(dead);
    expect(dead.conn.onClose).not.toHaveBeenCalled();

    const live = makeRuntimeStub(makeConnStub({ alive: true }));
    const waiting = priv(engine).awaitConnFinalized(live);
    await Promise.resolve();
    expect(live.conn.onClose).toHaveBeenCalledTimes(1);
    live.conn.emitClose("killed");
    await waiting; // onClose 触发即 resolve——不挂死
  });

  it("appServerAbortChain：会话未建立 → 跳过 stop 直落杀链（shutdown + onClose 收割等待）——create 竞态形态", async () => {
    const engine = makeEngine();
    const conn = makeConnStub();
    const rt = makeRuntimeStub(conn);
    const chain = priv(engine).appServerAbortChain(rt, Promise.resolve(), () => undefined, Promise.resolve());
    await Promise.resolve();
    expect(conn.request).not.toHaveBeenCalled(); // 无会话即无在途任务可止损
    rt.conn.emitClose("killed");
    await chain;
    expect(conn.shutdown).toHaveBeenCalledTimes(1);
    expect(rt.channel.dispose).not.toHaveBeenCalled(); // abort 链不退订 channel（区别于 dispose 路径）
  });

  it("appServerAbortChain：连接已死（alive=false）→ 零动作收尾（u-z2：不惰性拉起无人使用的新进程）", async () => {
    const engine = makeEngine();
    const conn = makeConnStub({ alive: false });
    const rt = makeRuntimeStub(conn);
    await priv(engine).appServerAbortChain(rt, Promise.resolve(), () => "sess_x", Promise.resolve());
    expect(conn.request).not.toHaveBeenCalled(); // 不发 stop
    expect(conn.shutdown).not.toHaveBeenCalled(); // 不再杀链——进程已死即已收割
    expect(conn.onClose).not.toHaveBeenCalled();
  });

  it("appServerAbortChain：stop 帧发出 → 杀链收割等待 onClose 终局（abort 终局语义 = 进程收割确认完成）", async () => {
    const engine = makeEngine();
    const conn = makeConnStub();
    const rt = makeRuntimeStub(conn);
    const chain = priv(engine).appServerAbortChain(rt, Promise.resolve(), () => "sess_x", Promise.resolve());
    await vi.waitFor(() => expect(conn.request).toHaveBeenCalledWith("session/stop", { sessionId: "sess_x" }));
    // 杀链在 stop 应答 settle 后启动（shutdown → onClose 订阅）——订阅建立后才触发收割收口
    await vi.waitFor(() => expect(conn.onClose).toHaveBeenCalledTimes(1));
    expect(conn.shutdown).toHaveBeenCalledTimes(1); // stop 应答已 settle，杀链已启动
    rt.conn.emitClose("killed");
    await chain;
    expect(conn.onClose).toHaveBeenCalledTimes(1); // awaitConnFinalized 的收割等待订阅
  });

  it("appServerAbortChain：stop 帧失败不阻断杀链（catch 后继续 killChain）", async () => {
    const engine = makeEngine();
    const conn = makeConnStub({
      request: vi.fn(async () => {
        throw new Error("busy session");
      }),
    });
    const rt = makeRuntimeStub(conn);
    const chain = priv(engine).appServerAbortChain(rt, Promise.resolve(), () => "sess_x", Promise.resolve());
    // request reject → catch → killChain：等收割等待订阅建立后再触发收口
    await vi.waitFor(() => expect(conn.onClose).toHaveBeenCalledTimes(1));
    rt.conn.emitClose("killed");
    await chain; // 不 reject——stop 失败仅 debug 记录，继续走杀链
    expect(conn.shutdown).toHaveBeenCalledTimes(1);
  });

  it("shutdownRuntimeAndDisposeChannel：shutdown → onClose 收割 → channel.dispose（R5 竞态修复：退订前等 failAllTurns 先执行）", async () => {
    const engine = makeEngine();
    const conn = makeConnStub();
    const rt = makeRuntimeStub(conn);
    const disposing = priv(engine).shutdownRuntimeAndDisposeChannel(rt);
    await Promise.resolve();
    expect(rt.channel.dispose).not.toHaveBeenCalled(); // 收割未发生不退订
    rt.conn.emitClose("killed");
    await disposing;
    expect(conn.shutdown).toHaveBeenCalledTimes(1);
    expect(rt.channel.dispose).toHaveBeenCalledTimes(1);
  });

  it("dispose：在途会话 close 帧全量 fire → 杀链收割 → channel 退订；二次 dispose 幂等零动作", async () => {
    const engine = makeEngine();
    const conn = makeConnStub();
    const rt = makeRuntimeStub(conn);
    rt.activeSessions.add("sess_a");
    rt.activeSessions.add("sess_b");
    priv(engine).appserverRuntime = rt;

    const disposing = engine.dispose();
    // close 帧先于杀链（D6①：对面来不及处理即被杀的形态禁止）
    expect(conn.post).toHaveBeenCalledWith("session/close", { sessionId: "sess_a" });
    expect(conn.post).toHaveBeenCalledWith("session/close", { sessionId: "sess_b" });
    rt.conn.emitClose("killed");
    await disposing;
    expect(conn.shutdown).toHaveBeenCalledTimes(1);
    expect(rt.channel.dispose).toHaveBeenCalledTimes(1);

    // 幂等：runtime 取走即置空，二次调用零副作用
    await engine.dispose();
    expect(conn.shutdown).toHaveBeenCalledTimes(1);
  });

  it("classifyAppServerTurnFailure：signal 已 aborted → aborted 终态（D3 消息串：session/stop → killChain 收割）", async () => {
    const engine = makeEngine();
    const controller = new AbortController();
    controller.abort();
    const conn = makeConnStub();
    const rt = makeRuntimeStub(conn);
    const result = await priv(engine).classifyAppServerTurnFailure(new Error("mid-turn"), makeCtx(controller.signal), {
      rt,
      turn: Promise.resolve(),
      currentSessionId: () => "sess_x",
      sessionCreated: Promise.resolve(),
      retried: false,
    });
    expect(result.kind).toBe("aborted");
    expect(result.abortMessage).toContain("engine_run_failed");
    expect(result.abortMessage).toContain("session/stop");
    expect(result.abortMessage).toContain("killChain");
  });

  it("applyAbortedOutcome：abortMessage 透传；缺省合成携 stdout 尾；error 事件可达；exitCode=null（不留僵尸）", () => {
    const engine = makeEngine();
    const base = { engineId: "zcode", content: "", durationMs: 0 } as AgentOutcome;

    // 缺省合成：abortMessage 缺席 → 中止文案 + 输出尾部
    const synthesized = { ...base };
    const events: AgentEvent[] = [];
    priv(engine).applyAbortedOutcome(
      synthesized,
      { kind: "aborted", output: { exitCode: null, stdoutText: "stdout-tail-sample", stderrTail: "" } },
      (e) => events.push(e),
    );
    expect(synthesized.exitCode).toBeNull();
    expect(synthesized.error).toContain("app-server abort 链收尾");
    expect(synthesized.error).toContain("stdout-tail-sample");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");

    // 透传：abortMessage 在场（D3 链形态描述）→ 原样使用，不拼 stdout 尾
    const passthrough = { ...base };
    priv(engine).applyAbortedOutcome(
      passthrough,
      {
        kind: "aborted",
        output: { exitCode: null, stdoutText: "unused", stderrTail: "" },
        abortMessage: "engine_run_failed: zcode 任务被中止（D3 链形态描述）",
      },
      () => {},
    );
    expect(passthrough.error).toBe("engine_run_failed: zcode 任务被中止（D3 链形态描述）");
    expect(passthrough.error).not.toContain("unused");
  });

  it("finalizeOutcome：aborted 分支 → applyAbortedOutcome（exitCode=null + error 事件 + 中止合成文案）", () => {
    const engine = makeEngine();
    const events: AgentEvent[] = [];
    const ctx = { taskId: "sa-mock", onEvent: (e: AgentEvent) => events.push(e) } as RunContext;
    const outcome = priv(engine).finalizeOutcome(
      {},
      ctx,
      { kind: "aborted", output: { exitCode: null, stdoutText: "tail-bytes", stderrTail: "" } },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false },
      Date.now(),
    );
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain("app-server abort 链收尾");
    expect(outcome.error).toContain("tail-bytes");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
  });

  it("finalizeOutcome：aborted 携 abortMessage → 透传原样（不拼 stdout 尾）", () => {
    const engine = makeEngine();
    const events: AgentEvent[] = [];
    const ctx = { taskId: "sa-mock", onEvent: (e: AgentEvent) => events.push(e) } as RunContext;
    const outcome = priv(engine).finalizeOutcome(
      {},
      ctx,
      {
        kind: "aborted",
        output: { exitCode: null, stdoutText: "unused", stderrTail: "" },
        abortMessage: "engine_run_failed: zcode 任务被中止（D3 链形态描述）",
      },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false },
      Date.now(),
    );
    expect(outcome.error).toBe("engine_run_failed: zcode 任务被中止（D3 链形态描述）");
    expect(outcome.error).not.toContain("unused");
    expect(events).toHaveLength(1);
  });
});

// ============================================================
// 杀链收尾邻接面（mock 双轨补缺）：connection.shutdown（杀链 promise 赋值分支）
// 与 SessionChannel.resumeSession（session/resume 读通道）。
// ============================================================

describe("connection / session-channel 杀链邻接面（mock 双轨）", () => {
  it("AppServerConnection.shutdown：无先行杀链时对活进程发 SIGTERM+SIGKILL 背靠背（同步发出后即 resolve）", async () => {
    const conn = new AppServerConnection({
      cliPath: fileURLToPath(new URL(import.meta.url)),
      cwd: os.tmpdir(),
      env: {},
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "zcode-conn-shutdown-")),
      stderrLogPath: path.join(os.tmpdir(), "zcode-conn-shutdown-stderr.log"),
    });
    const fakeChild = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
      once: vi.fn(),
    };
    (conn as unknown as { child: unknown }).child = fakeChild;
    await conn.shutdown(); // 杀链同步发出、promise 即刻 settle——无等待升级窗
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGKILL");
    // 幂等：二次 shutdown 复用同一杀链 promise，不重复发信号
    await conn.shutdown();
    expect(fakeChild.kill).toHaveBeenCalledTimes(2);
  });

  it("SessionChannel.resumeSession：session/resume 帧键集精确（sessionId 单键）", async () => {
    // stub conn 只取 SessionChannel 构造与 resumeSession 消费的窄面（onNotification/
    // onClose/request）——不触真实连接（resume 走 conn.request 会惰性 spawn 真进程）
    const request = vi.fn(async (_method: string, _params?: unknown) => ({ messages: [] }));
    const connStub = {
      onNotification: vi.fn(() => () => {}),
      onClose: vi.fn(() => () => {}),
      request,
    };
    const channel = new SessionChannel(connStub as unknown as AppServerConnection);
    await channel.resumeSession("sess_resume");
    expect(request).toHaveBeenCalledWith("session/resume", { sessionId: "sess_resume" });
  });
});
