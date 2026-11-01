// src/__tests__/delivery-port-assembly.test.ts —— 统一投递端口装配点行为锁
//（unified-delivery 波 2 前半，装配点 = base-tool-enhance 的 session_start；投递统一化
// 设计的现行登记处 = ADR-0074 与 docs/CONTEXT.md「统一投递（unified delivery，v3）」段）。
// 锁三类装配行为：
// ① session_start 触发端口装配且经进程级槽可达（getDeliveryPort）；
// ② 装配后端口是活的投递通路（deliver → pi.appendEntry outbox + pi.sendMessage
//   直达唯一队列——用真 deliver 链验证 host 接线正确，非仅槽非空）；
// ③ 重复 session_start 重绑（旧实例 dispose 拒收）+ 差集重放触发。
import { afterEach, describe, expect, it, vi } from "vitest";

const { createBashToolDefinitionMock, dataDirRef } = vi.hoisted(() => ({
	createBashToolDefinitionMock: vi.fn(),
	dataDirRef: { dir: "/tmp/bte-fake-agent-dir-delivery-port" },
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: createBashToolDefinitionMock,
	getAgentDir: () => dataDirRef.dir,
}));

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { _resetDeliveryPortForTest, getDeliveryPort } from "@zhushanwen/pi-delivery-port";
import { resetNotifyForTest } from "../background/notify.ts";
import { clearTaskStoreForTest } from "../background/task-store.ts";
import baseToolEnhanceExtension from "../index.ts";

function setupOfficialFactory(): void {
	// bash 同名 override 依赖官方工厂 mock（index.test.ts setupOfficialFactory 同款）；
	// 本文件只走 session_start 链，工厂 mock 仅为 registerTool 路径不炸。
	createBashToolDefinitionMock.mockReset();
	createBashToolDefinitionMock.mockReturnValue({
		name: "bash",
		label: "bash",
		description: "official",
		parameters: {},
		execute: vi.fn(),
	});
}

function createMockPi(entries: unknown[] = []) {
	return {
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		// pi 1.0.0 契约：on 返回退订函数（types.d.ts `): () => void`）——port dispose 兑现
		on: vi.fn(() => () => {}),
		// appendEntry 落 entries（真 pi 持久化 session JSONL 的 mock 对应——重放扫描读它）
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
		}),
		events: { emit: vi.fn(), on: vi.fn() },
		sendMessage: vi.fn(),
	};
}

function createMockCtx(entries: unknown[]): ExtensionContext {
	return {
		mode: "rpc",
		sessionManager: {
			getSessionId: () => "sess-1",
			getEntries: () => entries,
		},
		isIdle: () => true,
	} as unknown as ExtensionContext;
}

/** 从 mock pi 提取 session_start handler 并触发（startup reason）。 */
function fireSessionStart(pi: ReturnType<typeof createMockPi>, ctx: ExtensionContext): void {
	const call = pi.on.mock.calls.find((c) => c[0] === "session_start");
	expect(call).toBeDefined();
	(call![1] as (event: unknown, ctx: ExtensionContext) => unknown)(
		{ type: "session_start", reason: "startup" },
		ctx,
	);
}

describe("session_start 装配统一投递端口（unified-delivery 波 2 装配点；登记处见文件头）", () => {
	it("session_start 后端口经进程级槽可达", () => {
		setupOfficialFactory();
		const pi = createMockPi();
		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);
		expect(getDeliveryPort()).toBeUndefined(); // 装配前缺席

		fireSessionStart(pi, createMockCtx([]));
		expect(getDeliveryPort()).toBeDefined(); // 装配后可达
		_resetDeliveryPortForTest();
	});

	it("装配的端口是活的投递通路：deliver 落 outbox + sendMessage 直达唯一队列", () => {
		setupOfficialFactory();
		const pi = createMockPi();
		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);
		fireSessionStart(pi, createMockCtx([]));

		const port = getDeliveryPort()!;
		const receipt = port.deliver({
			id: "task-1:0",
			payload: { kind: "custom", customType: "workflow-result", content: "workflow done", display: true, details: { runId: "r-1" } },
		});
		expect(receipt).toEqual({ kind: "accepted", id: "task-1:0" });
		// 受理前落盘（经 pi.appendEntry 接线）
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"delivery-port-outbox",
			expect.objectContaining({ v: 2, id: "task-1:0", timing: "steer" }),
		);
		// 直达唯一队列（经 pi.sendMessage 接线，deliveryId 注入前写入 details）
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "workflow-result",
				details: expect.objectContaining({ deliveryId: "task-1:0" }),
			}),
			{ deliverAs: "steer", triggerTurn: true },
		);
		_resetDeliveryPortForTest();
	});

	it("重复 session_start 重绑：旧实例 dispose（deliver 拒收）、in-flight 条目交接预占不重投（A4 双投窗口封住）", () => {
		setupOfficialFactory();
		const entries: unknown[] = [];
		const pi = createMockPi(entries);
		baseToolEnhanceExtension(pi as unknown as ExtensionAPI);
		fireSessionStart(pi, createMockCtx(entries));

		const first = getDeliveryPort()!;
		// 落一条账（已出站——sendMessage 已交递，注入由 pi 侧异步完成；custom_message
		// 凭据未落。in-flight 交接预占后新实例 recover 不重投：消息 pi 必达在途，
		// 重放构成同条通知双投——A4 真机实证 recoveryReplays=1 + notify=2）
		first.deliver({ id: "w-1", payload: { kind: "custom", customType: "workflow-result", content: "x", display: true } });
		(pi.sendMessage as ReturnType<typeof vi.fn>).mockClear();

		// 新 session_start（同 entries——同 session 文件语义）：重绑 + recover
		fireSessionStart(pi, createMockCtx(entries));
		const second = getDeliveryPort()!;
		expect(second).not.toBe(first);
		expect(first.deliver({ id: "w-2", payload: { kind: "custom", customType: "workflow-result", content: "y", display: true } }).kind).toBe("rejected");
		// in-flight 预占：w-1 不重投；w-2 的 deliver 拒收也不产生注入（旧实例已销毁）
		expect(pi.sendMessage).not.toHaveBeenCalled();
		// 崩溃形态（无前驱交接）的重放恢复由 delivery-port 包测试承载（重绑交接 describe）
		_resetDeliveryPortForTest();
	});
});

afterEach(() => {
	_resetDeliveryPortForTest();
	resetNotifyForTest();
	clearTaskStoreForTest();
});
