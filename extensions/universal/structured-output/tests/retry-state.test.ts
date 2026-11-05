// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run tests/retry-state.test.ts
//
// WorkflowGate steer 侧转移表单测（M4-TC-2 / IF-7）——直接构造 export 的类并驱动方法，
// 断言字段精确值。steer 决策不经返回值表达——turn_end 时刻由装配层检查链按状态字段
// 推导。
//
// 与 workflow-hook 的检查关系：onTurnEnd() 只在「判定要 steer 且发送成功」时被调用
//（toolUse/超上限/成功短路/发送失败均不调），本测试在状态机层模拟该契约。

import { describe, expect, it } from "vitest";

import { WorkflowGate } from "../src/loop-gate.js";

describe("WorkflowGate steer-side transition table (IF-7)", () => {
	it("① 成功短路：onToolExecEnd(false) → soSucceededEver=true，onTurnEnd 不翻转", () => {
		const s = new WorkflowGate();
		s.onToolExecEnd(false);
		expect(s.soCallCount).toBe(1);
		expect(s.soSucceededEver).toBe(true);
		expect(s.hookRetryCount).toBe(0);
		expect(s.lastSchemaError).toBeNull();

		// onTurnEnd 只重置计数/累计重试，不翻转成功终态（成功短路是终态）
		s.onTurnEnd();
		expect(s.soSucceededEver).toBe(true);
		expect(s.soCallCount).toBe(0);
		expect(s.hookRetryCount).toBe(1);
	});

	it("② 未调用 steer：上一 turn 失败 steer 后 soCallCount=0 → calledButFailed=false（MUST call 文案分支依据）", () => {
		const s = new WorkflowGate();
		// 上一 turn 失败并 steer（onToolExecEnd + onTurnEnd）后，本 turn 未调用任何工具。
		// onTurnEnd 无条件清零 soCallCount——状态机层无法观察新 turn 是否调用了工具，
		// 此序列即 steer 后状态，是 hook 下一 turn_end 判定 calledButFailed=false 走
		// MUST call 分支（而非 FAILED validation 分支）的前置。
		s.onToolExecEnd(true, "err");
		s.onTurnEnd();
		// workflow-hook 的 calledButFailed = soCallCount > 0；0 次调用 → MUST call 分支
		expect(s.soCallCount).toBe(0);
		const calledButFailed = s.soCallCount > 0;
		expect(calledButFailed).toBe(false);
		expect(s.hookRetryCount).toBe(1);
		expect(s.soSucceededEver).toBe(false);
		expect(s.lastSchemaError).toBeNull();
	});

	it("③ 失败 steer：onToolExecEnd(true, err) → onTurnEnd() → 计数归零/重试++/错误清空", () => {
		const s = new WorkflowGate();
		s.onToolExecEnd(true, "Schema validation failed: /count must be number");
		expect(s.lastSchemaError).toBe("Schema validation failed: /count must be number");
		expect(s.soSucceededEver).toBe(false);

		s.onTurnEnd();
		expect(s.soCallCount).toBe(0);
		expect(s.hookRetryCount).toBe(1);
		expect(s.lastSchemaError).toBeNull();
		expect(s.soSucceededEver).toBe(false);
	});

	it("④ 超上限放弃：hookRetryCount≥MAX 时不调 onTurnEnd → lastSchemaError 保留", () => {
		const s = new WorkflowGate();
		// 两次「失败 → steer」循环后 hookRetryCount 达到 MAX_HOOK_RETRIES=2
	//（常量定义见 src/workflow-hook.ts）。状态机自身不感知上限，
	// 检查责任在 hook 层（shouldSkipSteer 的 hookRetryCount >= MAX_HOOK_RETRIES
	// 直接 return，不调 onTurnEnd）。集成层真实验证见 characterization-hook.test.ts
	// ③「3 轮失败恰 2 次 steer」，本单测只验证状态机自身状态转移契约。
		s.onToolExecEnd(true, "err1");
		s.onTurnEnd();
		s.onToolExecEnd(true, "err2");
		s.onTurnEnd();
		expect(s.hookRetryCount).toBe(2);

		// 第 3 轮失败：hook 检查 return（不调 onTurnEnd）→ turn 自然结束不 steer，
		// 最近错误与计数保留（超上限放弃路径的状态快照）。
		s.onToolExecEnd(true, "last error text");
		expect(s.lastSchemaError).toBe("last error text");
		expect(s.soCallCount).toBe(1);
		expect(s.hookRetryCount).toBe(2);
	});

	it("⑤ toolUse 不干预：检查不调 onTurnEnd → soCallCount 保留", () => {
		const s = new WorkflowGate();
		s.onToolExecEnd(true, "err");
		// workflow-hook 检查：stopReason=toolUse 直接 return（不调 onTurnEnd），
		// 故 soCallCount 累计到下一 turn（characterization ① 的行为基础）
		expect(s.soCallCount).toBe(1);
		expect(s.lastSchemaError).toBe("err");
		expect(s.hookRetryCount).toBe(0);
	});

	it("⑥ 多 turn 重置：steer 后下一 turn 计数归零，失败再次累计", () => {
		const s = new WorkflowGate();
		s.onToolExecEnd(true, "err1");
		s.onTurnEnd(); // turn 1 steer 后
		expect(s.soCallCount).toBe(0);
		expect(s.hookRetryCount).toBe(1);

		s.onToolExecEnd(true, "err2"); // turn 2 再次失败
		expect(s.soCallCount).toBe(1);
		expect(s.lastSchemaError).toBe("err2");
		expect(s.hookRetryCount).toBe(1);
	});
});
