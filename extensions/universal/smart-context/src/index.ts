/**
 * @zhushanwen/pi-smart-context 入口：事件接线 + 门控。
 *
 * - session_start：session 级闭包状态重建（规范 Session 隔离：熔断计数不跨 session）
 *   + fired 档位从 session entries 重建（D15：reload/进程重启同 session 不重复提醒）
 *   + 会话替换类启动取消进行中后台压缩任务（D3 第一层，new/resume/fork）
 * - subagent 进程（R6）：不注册工具、不提醒（宁缺勿污）
 * - session_before_compact：双模式接管（compact-handler）
 * - session_compact：重置提醒 fired（D3，与后台落盘成功回调共用 resetFiredThresholds）
 *   + 后台任务被抢先取消（D3 第一层——后台路径自身落盘不发该事件，收到即代表其他压缩
 *   抢先落盘）
 * - session_shutdown：后台任务取消（D3 第一层）
 * - session_tree：仅观测告警（D3 rejected：会话内回退不破坏压缩正确性，不取消）
 * - agent_settled：后台压缩自动触发（D4：触发线/互斥/门控/独立熔断判定内聚 manager）
 *   + 越档检查 + marker 持久化（D15）+ nextTurn 投递一次性提醒（D3/D4①）
 * - registerCompactContextTool：注入 background 契约（U5——工具路径与自动触发共享
 *   互斥容器；工具纯触发化后无异步回调，isCtxStale 过渡字段退役）
 * - 后台压缩落盘段 stale ctx 防线（C-pi-17）：manager 的 isCtxStale 注入位由本文件的
 *   稳定间接层供给，经续段钩子转交 persistBackgroundCompaction——落盘段跨 await 持有
 *   ctx，session 替换窗口内放弃落盘回报 dropped（会话态失效类放弃，不递增熔断计数）
 * - 后台任务终局：完成/失败通知经 nextTurn 投递（U5/D6——validated 完成、失败不静默，
 *   熔断达到阈值并入该条通知；cancelled 事件取消不发）；通知投递失败由 compact-handler
 *   的 settle 内吞留痕，不改写压缩成败事实
 * - 后台压缩落盘信号（C1 分界行实时化）：persistBackgroundCompaction 成功的事实点
 *   （onPersisted 回调）经 sendCompactionPersistSignal 发 custom message（display:false、
 *   {triggerTurn:false} 无 deliverAs，空闲时立即 append）——taiji runtime 分诊命中后取
 *   compaction entry 合成对话流分界行帧，分界行不再只能重开可见
 * - model_select：跨界通知 + downshift 提醒（D5/D4①）
 *
 * 通知投递路径（D4①，delivery-ownership-kernel）：四类通知全部经 notices.ts 的
 * sendSmartContextNotice 走 nextTurn（随下一次 prompt 注入、不自起 run）——通知 run 不再
 * 抢占用户消息投递跑道。手动触发失败回执（start-failed/busy）走即时投递（见 notices.ts
 * sendSmartContextImmediateNotice）。后台压缩全程不掐 turn（C2 后手动压缩不经 pi 同步
 * compact 链，进行中回合不受影响），无「被压缩掐断的 turn」需续跑兜底。
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { guardStaleCtx, isSubagentProcess, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { setPiHandle } from "@zhushanwen/pi-extension-logger";

import {
	createBackgroundCompactionManager,
	createBackgroundCompactionState,
	createBeforeCompactHandler,
	createTakeoverState,
	debugLog,
	persistBackgroundCompaction,
	type AfterGenerationHook,
	type BackgroundCompactionState,
	type TakeoverState,
} from "./compact-handler.js";
import {
	sendSmartContextImmediateNotice,
	sendSmartContextNotice,
	buildCompactBusyNotice,
	buildCompactCompleteNotice,
	buildCompactFailureNotice,
	buildCompactStartFailureNotice,
	sendCompactionPersistSignal,
} from "./notices.js";
import { buildDownshiftNotice, buildSwitchNotice, buildThresholdReminder } from "./reminder.js";
import { registerCompactContextTool } from "./tool.js";
import {
	countCompactions,
	deriveFiredThresholds,
	estimateTextTokens,
	findCrossedThresholds,
	FIRED_ENTRY_CUSTOM_TYPE,
	getCurrentModelId,
	isGatingActive,
	loadSmartContextConfig,
	type EntryLike,
} from "./pure.js";
import type { BackgroundTaskSettlement } from "./compact-handler.js";

/** session 级闭包状态（规范：模块级仅工厂函数，状态在 session_start 重建）。 */
interface SessionState {
	takeover: TakeoverState;
	/** 后台压缩任务状态（U2：进行中互斥 + 独立熔断计数）。 */
	background: BackgroundCompactionState;
	/** 已提醒档位（token 值为键；session_compact 清空，D3）。 */
	firedThresholds: Set<number>;
	/** fired 是否已从 session entries seed 过（D15：每次状态重建恰好 seed 一次）。 */
	firedSeeded: boolean;
}

/** session 级状态唯一构造点（初始态与 session_start 重建同源，新增字段不落两处）。 */
function createSessionState(): SessionState {
	return {
		takeover: createTakeoverState(),
		background: createBackgroundCompactionState(),
		firedThresholds: new Set(),
		firedSeeded: false,
	};
}

// G1 代际检测（crash-resilience D1，同 scheduler/src/index.ts 的模块级代数计数器范式）：
// 必须声明在模块级而非 factory 体内——pi 每次 session 替换（newSession/fork/switchSession）
// 都重跑 extension factory 函数体（extensionCache 只缓存 factory 函数对象），闭包级声明
// 每次重跑即重置，各代的 isCtxStale 恒 false。模块级声明下 extensionCache 命中期间共享
// 同一模块绑定，计数器跨 factory 重跑保留递增：新代 session_start 递增后，旧代闭包捕获
// 的代数从此小于模块值 → isCtxStale 生效。残余盲区（显式 reload 触发 jiti 重新 import
// 产生全新模块环境）由 guardStaleCtx 的 STALE_CTX_MARKER 文案兜底分诊覆盖（PS-30 门禁）。
let sessionGeneration = 0;

/**
 * pi-smart-context extension 工厂函数。
 *
 * agent 自决上下文压缩：compact_context 工具 + 双模式接管生成（same-model kv-cache /
 * cross-model 廉价模型）+ 3 档阈值提醒 + 排除模型门控与切换通知。
 */
export default function smartContextExtension(pi: ExtensionAPI): void {
	// 日志通道注入（extension-logger 两阶段初始化：工厂拿 pi → setPiHandle）
	setPiHandle(pi);

	// R6：subagent 子进程不注册工具、不提醒（宁缺勿污；TAIJI_AGENT_SUBAGENT 标记——
	// ext-guards isSubagentProcess，ext-simplify-17 D4 重锚）
	if (isSubagentProcess()) {
		debugLog("subagent process detected, staying inert");
		return;
	}

	// session 级状态（session_start 重建闭包；模块级引用仅指向当前 session 的容器）
	let state: SessionState = createSessionState();

	// G1 代际比对闭包（isCtxStale）：session_start 装配本代比对（读实时模块级代数），
	// 供下方事件回调的 guardStaleCtx 前置检查使用（工具侧消费已随 U4 纯触发化退役——
	// 见工具注册点注释）——stale 分诊不依赖 pi 错误文案。首个 session_start 前无
	// session，恒 false 为安全默认。
	let isCtxStale: () => boolean = () => false;

	/**
	 * fired 档位 seed（D15）：从 session entries 重建已提醒档位。
	 *
	 * reload 会重跑 factory（+ jiti 重新 import）清零闭包/模块态，且 pi 发的 session_start
	 * reason 是 `startup`（见 pure.ts FIRED_ENTRY_CUSTOM_TYPE 注释）——只能从 session 自身
	 * 的 marker entry 恢复。`firedSeeded` 保证每次状态重建只 seed 一次（settle 热路径不重复扫 entries）。
	 *
	 * ctx 可能缺 sessionManager（测试 / 极早期窗口）→ 逐层降级为空集，不阻断提醒链路。
	 */
	const seedFiredThresholds = (ctx: ExtensionContext): void => {
		if (state.firedSeeded) return;
		state.firedSeeded = true;
		try {
			const entries = ctx.sessionManager.getEntries() as ReadonlyArray<EntryLike>;
			state.firedThresholds = deriveFiredThresholds(entries);
			if (state.firedThresholds.size > 0) {
				debugLog(`fired thresholds restored from session entries: ${[...state.firedThresholds].join(",")}`);
			}
		} catch (error) {
			// 恢复失败降级为空集（最坏结果 = 同档多提醒一次，不阻断主流程）
			debugLog(`fired thresholds restore failed: ${toErrorMessage(error)}`);
		}
	};

	/**
	 * compaction 计数读取（D13-12 降智提示判据）：entries 读取异常 → 0。
	 * 拆函数是为了不走同一条 try：提醒投递本身不依赖 entries（marker 写入 / 静默注入都能成），
	 * 降智提示只是附加行——读失败不得把整条提醒一起拆掉。
	 */
	const readCompactionCount = (ctx: ExtensionContext): number => {
		try {
			return countCompactions(ctx.sessionManager.getEntries() as ReadonlyArray<EntryLike>);
		} catch (error) {
			debugLog(`compaction count read failed: ${toErrorMessage(error)}`);
			return 0;
		}
	};

	// ── 后台压缩任务管理（U2：触发判定/互斥/独立熔断/事件取消；U3：续段落盘 + 膨胀段共享读取）──
	// getState 读当前代容器（state.background），manager 自身跨代存活无需重建。
	// 落盘续段（U3/D3 第二层/D2/D6）：三项兜底校验 + appendCompaction 直调，落盘成功回调
	// 清 firedThresholds（D6 档位重置补偿，与 session_compact 监听共用 resetFiredThresholds），
	// 收缩校验失败回调写共享膨胀段集合（与同步路径同段不重试同源）。续段跨 await 持有 ctx，
	// 经下方 isCurrentCtxStale 注入位接 C-pi-17 stale 防线（落盘段内 guardStaleCtx 分诊）。
	const resetFiredThresholds = (): void => {
		state.firedThresholds.clear();
	};
	const backgroundAfterGeneration: AfterGenerationHook = (result, snapshot, ctx, isCtxStale) =>
		persistBackgroundCompaction(
			ctx,
			result,
			snapshot,
			{
				onPersisted: (entryId) => {
					resetFiredThresholds();
					debugLog(`fired thresholds reset after background compaction (sessionId=${snapshot.sessionId})`);
					// C1 分界行实时化：落盘信号挂在「落盘成功」事实点（本回调在 appendCompaction
					// 成功后的同一同步帧内、guardStaleCtx 之中，非 stale 由外层保证），不在终局
					// 回调点（settle 已跨 await 且不带 entryId）。发送失败由 sendCompactionPersistSignal
					// 内吞留痕（上抛会把已落盘的压缩改记失败，见该函数注释）。
					sendCompactionPersistSignal(pi, entryId);
				},
				onInflated: (firstKeptEntryId) => {
					state.takeover.inflatedSegments.add(firstKeptEntryId);
				},
			},
			isCtxStale,
		);

	// ── 后台压缩终局通知（U5：D6 补偿的呈现半边）──
	// 每个终局点恰一条通知（cancelled 事件取消不发——D3 取消非失败）：validated → 完成
	// 通知（压缩前后 token 数与模式）；inflated/dropped/empty/error → 失败通知不静默，
	// 熔断达到阈值时文案附加「自动触发已暂停」。压缩后 token 口径：estimatedTokensAfter
	// （pi 原生可填）优先，缺省按「压缩前 − 被压段 + 摘要」估算（chars/4 口径与收缩校验
	// 同源）。异步收尾时 session 可能已替换——guardStaleCtx 分诊，stale 静默降级。本回调
	// 抛错（非 stale 的上抛语义）由 compact-handler 的 settle 内吞留痕：通知失败不得把已
	// validated 的压缩改记失败并无谓递增熔断计数。
	const onBackgroundSettled = (settlement: BackgroundTaskSettlement): void => {
		if (settlement.outcome === "validated") {
			const result = settlement.result;
			if (!result) {
				debugLog(`compact complete settlement missing result (sessionId=${settlement.sessionId})`);
				return;
			}
			const shadowed = settlement.shadowedTokens ?? 0;
			const tokensAfter =
				result.estimatedTokensAfter ?? Math.max(0, result.tokensBefore - shadowed + estimateTextTokens(result.summary));
			const text = buildCompactCompleteNotice({
				mode: settlement.mode,
				tokensBefore: result.tokensBefore,
				tokensAfter,
			});
			debugLog(`compact complete notice queued (sessionId=${settlement.sessionId} tokens=${result.tokensBefore}->${tokensAfter})`);
			guardStaleCtx(() => {
				sendSmartContextNotice(pi, text, "compact-complete");
			}, {
				isCtxStale,
				label: "smart-context:compact-complete-notice",
				onStale: (error) => debugLog(`compact complete notice skipped (stale ctx): ${toErrorMessage(error)}`),
			});
			return;
		}
		const text = buildCompactFailureNotice({
			outcome: settlement.outcome,
			droppedReason: settlement.droppedReason,
			error: settlement.error,
			failureStreak: settlement.failureStreak,
			circuitBreakerOpen: settlement.circuitBreakerOpen,
		});
		debugLog(`compact failure notice queued (sessionId=${settlement.sessionId} outcome=${settlement.outcome})`);
		guardStaleCtx(() => {
			sendSmartContextNotice(pi, text, "compact-failed");
		}, {
			isCtxStale,
			label: "smart-context:compact-failed-notice",
			onStale: (error) => debugLog(`compact failure notice skipped (stale ctx): ${toErrorMessage(error)}`),
		});
	};

	// 代际检查的稳定间接层（C-pi-17 注入位）：isCtxStale 在 session_start 被重赋值（本代
	// 比对），而 manager 在 factory 体内创建、早于首个 session_start——直接传引用会把初始
	// 的 () => false 冻结成永不 stale，故经箭头读实时绑定（与事件回调内 isCtxStale 的 live
	// 读取同语义）。
	const isCurrentCtxStale = (): boolean => isCtxStale();

	const background = createBackgroundCompactionManager(
		pi,
		() => state.background,
		loadSmartContextConfig,
		backgroundAfterGeneration,
		() => state.takeover.inflatedSegments,
		onBackgroundSettled,
		isCurrentCtxStale,
	);

	pi.on("session_start", (event, ctx) => {
		// D3 第一层（SI4）：new/resume/fork = 会话替换，进行中后台任务立即取消放弃结果
		// （必须在重建 state 前 abort——否则旧任务失控跑完白花生成费用）；startup/reload
		// 不取消（startup 时任务不存在；reload 使扩展工厂重跑、内存态自清）
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			background.cancelActive(`session_start(${event.reason})`);
		}
		// 先递增模块级代数再装配：自此同模块环境内所有前代闭包的 isCtxStale 返回 true
		sessionGeneration += 1;
		const myGeneration = sessionGeneration;
		isCtxStale = () => sessionGeneration !== myGeneration;
		state = createSessionState();
		seedFiredThresholds(ctx);
	});

	// session_shutdown（D3 第一层）：扩展运行时因退出/reload/会话替换被拆除前到达——有任务即取消
	pi.on("session_shutdown", (event) => {
		background.cancelActive(`session_shutdown(${event.reason})`);
	});

	// session_tree（D3 rejected 论证）：会话内回退不产生语义错位（回退不取消，取消只浪费
	// 已花生成费用）——仅观测告警
	pi.on("session_tree", () => {
		if (state.background.active) {
			debugLog("session_tree during background compaction: keeping task (rollback does not invalidate snapshot)");
		}
	});

	// ── 压缩生成接管（D1/D12）──
	const beforeCompact = createBeforeCompactHandler(
		pi,
		() => state.takeover,
		loadSmartContextConfig,
	);
	pi.on("session_before_compact", beforeCompact);

	// ── 压缩完成：重置提醒档位（D3）+ 后台任务被抢先取消（D3 第一层）──
	// 后台路径自身落盘不发 session_compact（UD6：appendCompaction 纯追加无事件），
	// 收到该事件必是其他压缩（同步接管/手动/原生兜底）抢先落盘；档位清空与后台落盘成功
	// 回调共用 resetFiredThresholds（D6 补偿共用化）
	pi.on("session_compact", (_event, _ctx) => {
		background.cancelActive("session_compact");
		resetFiredThresholds();
	});

	// ── 工具注册（常驻，不可用态由 execute 运行时校验拒绝，D5）──
	// background 注入（U5 接线残项落地）：isActive/startForTool 与 agent_settled 自动触发
	// 共享同一 session 级互斥容器（RL1），工具路径跳过触发线与独立熔断（SI5）。
	// 工具已无异步回调（U4 纯触发化），旧 isCtxStale 过渡字段随注入一并退役——代际
	// 分诊仅剩事件回调内的 guardStaleCtx 消费（闭包内读变量绑定，天然 live）。
	registerCompactContextTool(pi, {
		background: { isActive: background.isActive, start: background.startForTool },
	});

	// ── 手动触发入口（C2 /compact 后台化）：GUI 手动 /compact 的扩展侧命令 ──
	// taiji runtime 收到 session.compactBackground RPC 后经 client.prompt fire-and-forget
	// 发 `/__taiji_compact__ <encoded>`（先例 __taiji_bg_reconcile__，session-service）。
	// `__` 双下划线前缀 = 内部命令（前端 internal-command-filter 过滤不显示）；命令同步
	// 执行、不进模型、无 turn（pi agent-session _tryExecuteExtensionCommand）。
	// args 编码契约（与 runtime 发送侧成对）：runtime 侧 encodeURIComponent(customInstructions)
	// 后拼在命令名后（percent 编码无空格/换行，args = 首空格后原样余串可逆还原；空串 =
	// 未携带，pi 切分语义 PS-63 实锚 agent-session.js:1604-1608）。
	// 回执路径三分：启动成功不发通知（GUI 提示由 runtime reply → renderer toast 承载，
	// 不双投）；false = 后台任务进行中，幂等回执经即时通知通道投递（口径与 compact_context
	// 工具 busy 回执一致）；抛错 = 非互斥失败（门控拒绝/探测失败/无可压内容），失败文案经
	// 即时通知通道投递后不再重抛——重抛只进 pi emitError 日志、用户不可见，通知才是用户
	// 可达的失败呈现（发送失败由投递函数内吞留痕，与其他通知同语义）。两条回执走即时
	// 形态（sendSmartContextImmediateNotice）：承载的是用户刚敲的 /compact 的即时失败
	// 事实，nextTurn 的 pending 队列会把它推迟到用户下一条消息后才可见——失败提示与
	// 触发动作脱钩，且 renderer 受理 toast（「后台压缩已启动」）已先行，延迟到达 = 假成功
	// 观感；即时形态空闲即达，与受理 toast 形成「受理≠成功、失败独立可见」的完整回执链。
	pi.registerCommand("__taiji_compact__", {
		description:
			"Internal: start a background compaction on demand (taiji runtime manual /compact trigger; args = encodeURIComponent(customInstructions), empty = none)",
		handler: async (args: string, _ctx: ExtensionCommandContext) => {
			let customInstructions: string | undefined;
			if (args.trim() !== "") {
				try {
					customInstructions = decodeURIComponent(args.trim());
				} catch (error) {
					debugLog(`__taiji_compact__ args decode failed: ${toErrorMessage(error)}`);
					sendSmartContextImmediateNotice(
						pi,
						buildCompactStartFailureNotice(`压缩指引参数解码失败（预期百分号编码）：${toErrorMessage(error)}`),
						"compact-start-failed",
					);
					return;
				}
			}
			let started = false;
			try {
				started = background.startForTool(_ctx, customInstructions, "manual");
			} catch (error) {
				debugLog(`__taiji_compact__ start failed: ${toErrorMessage(error)}`);
				sendSmartContextImmediateNotice(pi, buildCompactStartFailureNotice(toErrorMessage(error)), "compact-start-failed");
				return;
			}
			if (!started) {
				debugLog("__taiji_compact__ busy: background compaction already running (idempotent receipt)");
				sendSmartContextImmediateNotice(pi, buildCompactBusyNotice(), "compact-busy");
			}
		},
	});

	// ── 阈值提醒（D3/D4）：agent_settled 越档检查 + marker 持久化 + nextTurn 一次性投递 ──
	pi.on("agent_settled", (_event, ctx) => {
		// 后台压缩自动触发（D4）：门控/互斥/独立熔断/触发线/准备数据组装判定全部内聚
		// maybeStart，与下方提醒链路相互独立（触发即后台执行，不阻塞本回调）
		background.maybeStart(ctx);

		const config = loadSmartContextConfig();
		const modelId = getCurrentModelId(ctx.model);
		if (!isGatingActive(config, modelId)) return;

		// D15 兜底 seed：session_start 未送达本代实例（reload 后先 settle 后 start 的窗口）时补上
		seedFiredThresholds(ctx);

		const usage = ctx.getContextUsage();
		if (!usage) return; // pi 观察级 R7（旧编号，见 compact-handler.ts 头注消歧）：tokens 可能 null（压缩后首响应前）——findCrossedThresholds 容错
		const crossed = findCrossedThresholds(config.reminderThresholds, usage.tokens, state.firedThresholds);
		if (crossed.length === 0) return;

		for (const t of crossed) state.firedThresholds.add(t);
		const compactionCount = readCompactionCount(ctx);
		const message = buildThresholdReminder(crossed, usage.tokens ?? 0, usage.contextWindow, compactionCount);
		debugLog(`reminder fired: tiers=${crossed.join(",")} tokens=${usage.tokens}`);
		// D15：marker 落 session entries（先写，fire-once 语义优先于投递）——下次
		// reload/进程重启从这里重建 fired，同一档不再重复提醒。
		guardStaleCtx(() => {
			pi.appendEntry(FIRED_ENTRY_CUSTOM_TYPE, { tiers: crossed, tokens: usage.tokens ?? 0 });
		}, {
			isCtxStale,
			label: "smart-context:fired-marker",
			onStale: (error) => debugLog(`fired marker skipped (stale ctx): ${toErrorMessage(error)}`),
		});
		// D4①：nextTurn（随下一次 prompt 作为 custom role 上下文注入，不自起 run）——原 followUp
		// 会在 agent 空闲后自起一个提醒 run，与用户消息同抢 prompt 跑道（故事 C 的三重放大器之一）。
		// 防循环：crossed 全部已标记 fired，marker 与提醒触发的 settled 不会重复发。
		// 事件回调内直接调用捕获的 pi——session 替换窗口可能 stale（crash-resilience D1
		// 普查接入点），检查 stale 静默降级（不杀 pi 进程），非 stale 错误原样上抛。
		guardStaleCtx(() => {
			sendSmartContextNotice(pi, message, "threshold-reminder");
		}, {
			isCtxStale,
			label: "smart-context:threshold-reminder",
			onStale: (error) => debugLog(`threshold reminder delivery skipped (stale ctx): ${toErrorMessage(error)}`),
		});
	});

	// ── 模型切换：跨界通知 + downshift 提醒（D5，仅跨界时注入一次）──
	// event 类型由 on() 重载上下文推导为 SDK ModelSelectEvent（不在包根导出，省略标注）
	pi.on("model_select", (event, ctx) => {
		const config = loadSmartContextConfig();
		const modelId = getCurrentModelId(event.model);
		const previousModelId = getCurrentModelId(event.previousModel);
		if (modelId === "" || modelId === previousModelId) return;

		const nowExcluded = config.excludedModels.includes(modelId);
		const wasExcluded = config.excludedModels.includes(previousModelId);

		// 跨越排除边界：注入一条可用性变化通知（同边界内切换静默）
		if (config.enabled && nowExcluded !== wasExcluded) {
			const notice = buildSwitchNotice(nowExcluded ? "unavailable" : "available", modelId);
			debugLog(`switch notice: ${nowExcluded ? "unavailable" : "available"} (${modelId})`);
			// 状态通知（非紧急）：triggerTurn:false 不唤醒轮次——LLM 在下一轮自然看到并自行
			// 调整（compact 工具 execute 有运行时门控校验兜底），不为通知烧一整轮全量上下文。
			// session 替换窗口可能 stale（D1 普查接入点）——检查 stale 静默降级
			guardStaleCtx(() => {
				sendSmartContextNotice(pi, notice, "model-switch");
			}, {
				isCtxStale,
				label: "smart-context:switch-notice",
				onStale: (error) => debugLog(`switch notice delivery skipped (stale ctx): ${toErrorMessage(error)}`),
			});
			return;
		}

		// downshift 检测：切到更小窗口模型且将触线 → 建议先压缩（不阻止切换）
		const usage = ctx.getContextUsage();
		const downshift = buildDownshiftNotice(
			usage?.tokens ?? null,
			event.previousModel?.contextWindow,
			event.model?.contextWindow,
		);
		if (downshift && isGatingActive(config, modelId)) {
			debugLog("downshift notice fired");
			// "建议"非紧急（同 S1 裁决）：triggerTurn:false 不唤醒轮次，用户继续对话时
			// LLM 自行决策是否先压缩。session 替换窗口可能 stale（D1 普查接入点）——检查 stale 静默降级
			guardStaleCtx(() => {
				sendSmartContextNotice(pi, downshift, "model-downshift");
			}, {
				isCtxStale,
				label: "smart-context:downshift-notice",
				onStale: (error) => debugLog(`downshift notice delivery skipped (stale ctx): ${toErrorMessage(error)}`),
			});
		}
	});
}
