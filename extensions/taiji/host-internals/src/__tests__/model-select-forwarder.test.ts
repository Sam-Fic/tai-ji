/**
 * model-select-forwarder SDK 契约测试（agent-ext.test.ts 同款 Proxy 假体模式）。
 *
 * pi 用 Proxy 假体：捕获 model_select handler 注册与 sendMessage 落点。
 * 锚定切换转发行为（模块头注释的过河契约）：
 * - 真实切换（previous 不同模型）→ 发一条隐藏 custom message（display:false，
 *   customType = taiji:model-select），details 带 provider/modelId + previous 字段
 *   （previous 在场时）+ source（字符串形态时），options.triggerTurn = false
 * - next.id === ""（清除选择形态）→ 不发
 * - previous 与 next 同 provider 同 id（setModel 幂等回调）→ 不发
 * - previous undefined（会话首选）→ details 不带 previous 字段
 *
 * 运行：cd extensions/taiji/host-internals && npx vitest run
 */
import { describe, it, expect } from "vitest";

import type {
  ExtensionAPI,
  ModelSelectEvent,
} from "@earendil-works/pi-coding-agent";

import { MODEL_SELECT_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";

import { registerModelSelectForwarder } from "../model-select-forwarder.js";

type RecordedSend = {
  message: {
    customType: string;
    content: string;
    display: boolean;
    details: unknown;
  };
  options: { triggerTurn: boolean } | undefined;
}

type ForwarderHarness = {
  pi: ExtensionAPI;
  sends: RecordedSend[];
  /** 触发已注册的 model_select handler */
  emit(event: ModelSelectEvent): unknown;
}

function createHarness(): ForwarderHarness {
  const sends: RecordedSend[] = [];
  let handler: ((event: ModelSelectEvent) => unknown) | undefined;
  const pi = new Proxy<ExtensionAPI>({} as ExtensionAPI, {
    get(_target: unknown, prop: string | symbol): unknown {
      if (prop === "on") {
        return (
          event: string,
          fn: (event: ModelSelectEvent) => unknown,
        ): (() => void) => {
          if (event === "model_select") handler = fn;
          return (): void => undefined;
        };
      }
      if (prop === "sendMessage") {
        return (message: RecordedSend["message"], options?: RecordedSend["options"]): void => {
          sends.push({ message, options });
        };
      }
      return (): void => undefined;
    },
  });
  registerModelSelectForwarder(pi);
  return {
    pi,
    sends,
    emit(event) {
      if (handler === undefined) throw new Error("model_select handler not registered");
      return handler(event);
    },
  };
}

function makeModel(id: string, provider = "anthropic"): { id: string; provider: string } {
  return { id, provider };
}

describe("model-select-forwarder 切换转发契约", () => {
  it("真实切换（previous 不同模型）→ 发隐藏 custom message（display:false + details 双模型字段 + triggerTurn:false）", () => {
    const h = createHarness();
    h.emit({
      type: "model_select",
      model: makeModel("glm-5.3"),
      previousModel: makeModel("kimi-coding"),
      source: "set",
    });

    expect(h.sends).toHaveLength(1);
    const send = h.sends[0];
    if (!send) throw new Error("unreachable");
    expect(send.message.customType).toBe(MODEL_SELECT_CUSTOM_TYPE);
    expect(send.message.content).toBe("");
    expect(send.message.display).toBe(false);
    expect(send.message.details).toEqual({
      provider: "anthropic",
      modelId: "glm-5.3",
      previousProvider: "anthropic",
      previousModelId: "kimi-coding",
      source: "set",
    });
    expect(send.options).toEqual({ triggerTurn: false });
  });

  it("跨 provider 切换 → 不误判幂等（previous provider 与 id 有一处不同即发）", () => {
    const h = createHarness();
    h.emit({
      type: "model_select",
      model: makeModel("glm-5.3", "zhipu"),
      previousModel: makeModel("glm-5.3", "anthropic"),
      source: "cycle",
    });

    expect(h.sends).toHaveLength(1);
    const details = h.sends[0]?.message.details as Record<string, unknown>;
    expect(details.provider).toBe("zhipu");
    expect(details.previousProvider).toBe("anthropic");
  });

  it("next.id === ''（清除选择形态）→ 不发", () => {
    const h = createHarness();
    h.emit({
      type: "model_select",
      model: makeModel(""),
      previousModel: makeModel("kimi-coding"),
      source: "set",
    });

    expect(h.sends).toHaveLength(0);
  });

  it("previous 同 provider 同 id（setModel 幂等回调）→ 不发", () => {
    const h = createHarness();
    h.emit({
      type: "model_select",
      model: makeModel("glm-5.3"),
      previousModel: makeModel("glm-5.3"),
      source: "restore",
    });

    expect(h.sends).toHaveLength(0);
  });

  it("previous undefined（会话首选）→ 发，details 不带 previous 字段", () => {
    const h = createHarness();
    h.emit({
      type: "model_select",
      model: makeModel("glm-5.3"),
      previousModel: undefined,
      source: "set",
    });

    expect(h.sends).toHaveLength(1);
    const details = h.sends[0]?.message.details as Record<string, unknown>;
    expect(details).toEqual({ provider: "anthropic", modelId: "glm-5.3", source: "set" });
    expect("previousProvider" in details).toBe(false);
    expect("previousModelId" in details).toBe(false);
  });

  it("source 非字符串形态 → 发，details 不带 source 字段", () => {
    const h = createHarness();
    h.emit({
      type: "model_select",
      model: makeModel("glm-5.3"),
      previousModel: makeModel("kimi-coding"),
      source: undefined as unknown as ModelSelectEvent["source"],
    });

    expect(h.sends).toHaveLength(1);
    const details = h.sends[0]?.message.details as Record<string, unknown>;
    expect("source" in details).toBe(false);
  });
});
