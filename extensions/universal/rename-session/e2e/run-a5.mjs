#!/usr/bin/env node
/**
 * A5 场景：挂死直报（hang provider）。
 *
 * 本地 node 起 accept 后不响应的 stub socket（startHangServer），标题 provider 指向它：
 * - models.json 新增独立 customProvider stub-hang（不动主 provider）
 * - settings.json enabledModels 追加 stub-hang/hang-model
 * - config/rename-session-ext-config.json 写 model ref 指向 stub
 * 主对话 --model mimo-v2.6-flash 不受影响。
 *
 * 实装语义（ADR-0122）：rename LLM 调用不设包内超时，挂死由 provider SDK/HTTP 层默认
 * 超时直报（OpenAI/Anthropic SDK 默认 10 分钟；undici fetch 介入时 headers 超时更短）。
 *
 * 断言：主 round 正常完成（turn_end stop）；rename LLM 调用挂死至 SDK/HTTP 层默认超时后
 * session JSONL 出现子串 `rename LLM call failed`（logger.warn(msg,{error}) 形态——error
 * 详情在 entry 的结构化 data 字段，message 本体不含冒号拼接；挂死路径 error 为空串 →
 * 归一为 unknown error，故只匹配该子串不匹配具体文案）；从 LLM request 到失败日志
 * ≥25s（区分挂死/超时路径与连接错误路径——后者毫秒级即失败）；无自动 session_info；
 * pi 存活（getState 正常响应）。等待上限 720s 覆盖 10 分钟级 SDK 默认超时。
 */

import {
	E2E_MODEL,
	LLM_REQUEST_MARKER,
	assert,
	parseJsonlEntries,
	runScenario,
	runStandalone,
	sleep,
	spawnPi,
	startHangServer,
} from "./harness.mjs";

const STUB_MODEL = "stub-hang/hang-model";

export async function runA5() {
	return runScenario("A5", async (log) => {
		const hang = await startHangServer();
		log(`stub hang server: 127.0.0.1:${hang.port}`);
		const pi = await spawnPi({
			tag: "a5",
			modelsJson: {
				providers: {
					"stub-hang": {
						name: "Stub Hang Provider",
						baseUrl: `http://127.0.0.1:${hang.port}/v1`,
						api: "openai-completions",
						apiKey: "stub-dummy",
						models: [
							{
								id: "hang-model",
								name: "Hang Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128_000,
								maxTokens: 4096,
							},
						],
					},
				},
			},
			enabledModels: [E2E_MODEL, STUB_MODEL],
			renameConfig: { model: { type: "ref", ref: STUB_MODEL } },
		});
		try {
			const stopEndP = pi.rpc.waitFor("turn_end", {
				timeoutMs: 120_000,
				filter: (ev) => ev?.message?.stopReason === "stop",
			});
			const settledP = pi.rpc.waitAgentSettled(120_000);
			await pi.rpc.prompt("1+1等于几？只回答数字");
			await stopEndP;
			await settledP;
			log("主 round 正常完成（turn_end stopReason=stop）");

			// rename LLM request 发出（指向 hang server）
			const llmReq = await pi.rpc.waitForSessionLog(LLM_REQUEST_MARKER, { timeoutMs: 30_000 });
			// 等挂死至 SDK/HTTP 层默认超时后的失败日志 entry（无包内超时（ADR-0122），
			// SDK 默认 10 分钟级 → 上限 720s 含余量；默认上限 45s 只够成功路径，须显式覆盖）
			const fail = await pi.rpc.waitForSessionLog("rename LLM call failed", { timeoutMs: 720_000 });
			const hangMs = fail.t - llmReq.t;
			assert(
				hangMs >= 25_000,
				`失败日志过早（LLM request 后 ${hangMs}ms < 25s，可能是连接错误路径而非挂死/超时路径）: ${fail.message}`,
			);
			log(`rename 挂死失败（LLM request 后 ${(hangMs / 1000).toFixed(1)}s）: ${fail.message}`);

			await sleep(600);
			const lines = await pi.readSessionLines();
			const infoCount = parseJsonlEntries(lines).filter((e) => e?.type === "session_info").length;
			assert(infoCount === 0, `出现 ${infoCount} 条自动 session_info（超时不应写入）`);

			// pi 存活：超时后 RPC 命令仍正常响应
			const st = await pi.rpc.getState();
			assert(st.success !== false && st.data, "超时后 get_state 无响应（pi 存活断言失败）");
			assert(pi.piAlive, "pi 进程已退出");
			log("pi 存活：超时后 get_state 正常响应");
		} finally {
			pi.cleanup();
			hang.close();
		}
	});
}

// ── 独立执行入口（node e2e/run-a5.mjs）──
runStandalone(import.meta.url, runA5);
