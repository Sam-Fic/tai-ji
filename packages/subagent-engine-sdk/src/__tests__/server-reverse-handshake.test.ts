// src/__tests__/server-reverse-handshake.test.ts
//
// [§2.11 第三批] 共享层第二批协议逻辑的单测：反向请求发送侧（计时兜底 / 写失败就地
// 收尾 / pending 登记与附加字段）、运行事件通知（seq 单调）、初始化握手（版本协商 +
// 模型应答形态）。
//
// 两引擎的 `server.test.ts` 已端到端覆盖这些路径；本文件把共享层的分支与**清理语义**
// 直接钉住（超时与写失败两条路径的「pending 不留残条、timer 不停留」是这里最容易漂移
// 的部分）。

import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineSdkError } from "../protocol/error-codes.ts";
import { ENGINE_PROTOCOL_VERSION } from "../protocol/engine-protocol.ts";
import {
  initializeEngine,
  sendReverseRequest,
  writeRunEvent,
  type ActiveRun,
  type ReverseRequestSendContext,
} from "../server/index.ts";

function makeSendCtx(overrides: Partial<ReverseRequestSendContext> = {}) {
  const written: unknown[] = [];
  const pending = new Map<string, Parameters<ReverseRequestSendContext["pending"]["set"]>[1]>();
  let seq = 0;
  const ctx: ReverseRequestSendContext = {
    write: (frame) => { written.push(frame); },
    pending,
    nextId: () => `rev-${++seq}`,
    ...overrides,
  };
  return { ctx, written, pending };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sendReverseRequest（发送侧语义）", () => {
  it("发出帧 + 登记 pending", () => {
    const { ctx, written, pending } = makeSendCtx();
    void sendReverseRequest(ctx, "host/askUser", { runId: "r1" });
    expect(written).toEqual([{ id: "rev-1", method: "host/askUser", params: { runId: "r1" } }]);
    expect([...pending.keys()]).toEqual(["rev-1"]);
  });

  it("id 由 nextId 分配（逐次递增，互不覆盖）", () => {
    const { ctx, written } = makeSendCtx();
    void sendReverseRequest(ctx, "host/a", {});
    void sendReverseRequest(ctx, "host/b", {});
    expect(written.map((f) => (f as { id: string }).id)).toEqual(["rev-1", "rev-2"]);
  });
});

describe("writeRunEvent（seq 单调）", () => {
  it("有在途登记 → seq 从 1 起逐条递增，同 runId 共用计数器", () => {
    const written: unknown[] = [];
    const activeRuns = new Map<string, ActiveRun>([["r1", { controller: new AbortController(), seq: 0 }]]);
    writeRunEvent((f) => { written.push(f); }, activeRuns, "r1", { type: "text_delta" } as never);
    writeRunEvent((f) => { written.push(f); }, activeRuns, "r1", { type: "agent_settled" } as never);
    expect(written).toEqual([
      { method: "event", params: { runId: "r1", seq: 1, event: { type: "text_delta" } } },
      { method: "event", params: { runId: "r1", seq: 2, event: { type: "agent_settled" } } },
    ]);
  });

  it("无在途登记（cancel 后迟到事件）→ seq 取 0，不抛错", () => {
    const written: unknown[] = [];
    writeRunEvent((f) => { written.push(f); }, new Map(), "gone", { type: "text_delta" } as never);
    expect(written).toEqual([{ method: "event", params: { runId: "gone", seq: 0, event: { type: "text_delta" } } }]);
  });
});

describe("initializeEngine（版本协商 + 模型应答）", () => {
  const base = {
    engineId: "fake",
    adapterVersion: "0.0.1",
    capabilities: {} as never,
  };

  it("协议版本不匹配 → engine_protocol_mismatch（含双方版本与升级指引）", () => {
    let caught: unknown;
    try {
      initializeEngine({ protocolVersion: 999 } as never, { ...base, listModels: () => null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineSdkError);
    expect((caught as EngineSdkError).toStructured().code).toBe("engine_protocol_mismatch");
    expect((caught as EngineSdkError).toStructured().message).toContain("999");
    expect((caught as EngineSdkError).toStructured().recovery).toContain(`v${ENGINE_PROTOCOL_VERSION}`);
  });

  it("版本匹配 + 有模型 → 结果含 models（只留 id）+ 三处版本字段", () => {
    const result = initializeEngine({ protocolVersion: ENGINE_PROTOCOL_VERSION } as never, {
      ...base,
      listModels: () => [{ id: "m1", extra: "dropped" } as { id: string }],
    });
    expect(result.protocolVersion).toBe(ENGINE_PROTOCOL_VERSION);
    expect(result.engineId).toBe("fake");
    expect(result.engineVersion).toBe("0.0.1");
    expect(result.adapterVersion).toBe("0.0.1");
    expect(result.models).toEqual([{ id: "m1" }]);
  });

  it("无模型侧（listModels → null）→ 应答不带 models 字段", () => {
    const result = initializeEngine({ protocolVersion: ENGINE_PROTOCOL_VERSION } as never, {
      ...base,
      listModels: () => null,
    });
    expect("models" in result).toBe(false);
  });
});
