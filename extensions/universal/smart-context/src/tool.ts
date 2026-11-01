/**
 * compact_context 工具（D6 + §3.5 接口契约；U4 纯触发化——§3.1 入口矩阵①）。
 *
 * execute 流程：门控校验（D5 拒绝态，V7 现状文案）→ 阈值保护（D6 低 tokens 拒绝）→
 * 后台任务触发（经 deps.background 注入的共享后台任务管理器能力）→ 立即返回成功回执
 * （GL1：不等待摘要生成；压缩执行期对话零阻塞零掐断——不触碰 ctx.compact /
 * AgentSession 压缩路径，旧路径掐断进行中回合的 abort 副作用随之消失）。
 * 已有后台任务进行中时返回「后台压缩进行中」的幂等成功回执（不是错误；RL1 单态互斥）。
 * 压缩生成→校验→落盘由后台任务自管（compact-handler.ts 后台任务管理器）；
 * 完成/失败通知经 nextTurn 注入（U5 接线）。
 *
 * deps.background 是生产接线契约（BackgroundCompactionControls）：注册点注入与
 * agent_settled 自动触发共享同一 session 级互斥容器的查询/启动能力（RL1）；
 * 未注入 = 接线缺失，execute 在门控与阈值检查后 fail-fast（不撒谎回执、不静默降级）。
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { renderCompactContextResult } from "./render-result.js";
import {
	checkToolThresholdGuard,
	countCompactions,
	getCurrentModelId,
	isGatingActive,
	loadSmartContextConfig,
	pickMode,
	type EntryLike,
} from "./pure.js";

/** 工具参数 schema（顶层 Type.Object，OpenAI 兼容红线）。 */
const CompactContextParams = Type.Object(
	{
		custom_instructions: Type.Optional(
			Type.String({
				description:
					"给摘要生成器的指引：哪些信息必须在摘要中保留（如文件修改意图、关键决策、验证结果），哪些可以丢弃（如中间调试过程）",
			}),
		),
	},
	{ additionalProperties: false },
);

/** 工具 details（renderResult 数据源，规范：不依赖 content 文本解析）。 */
export interface CompactContextDetails {
	/** 启动时的模式判定（cross-model 时为配置的压缩模型 ref）。 */
	mode: string;
	compactModel: string;
	compactionCount: number;
	/** 收起态一行摘要（buildCompactContextSummary 产出；GUI 收起态与 TUI 折叠态共用）。 */
	summary?: string;
}

/**
 * 后台压缩任务依赖（U4 工具路径接线契约；U5 起由 index.ts 注册点注入生产实装）。
 *
 * 注入的实现必须与 agent_settled 自动触发共享同一 session 级互斥容器
 * （RL1：同一时刻至多一个后台压缩任务在执行），即 compact-handler.ts
 * createBackgroundCompactionManager 所用 BackgroundCompactionState 的能力面。
 */
export interface BackgroundCompactionControls {
	/** 互斥查询：当前 session 是否有进行中的后台压缩任务（空闲⇄进行中单态判定）。 */
	isActive: () => boolean;
	/**
	 * 启动后台压缩任务（工具路径 = 显式请求：不做触发线（D4 ratio×窗口）与独立熔断
	 * （SI5）判定——两者仅约束 agent_settled 自动触发入口）。
	 * 返回 true = 已启动；false = 已有任务进行中（isActive 与本调用之间竞态窗口的
	 * 兜底判定，调用方按互斥幂等处理）——false 是唯一的互斥语义，非互斥原因不可启动
	 * （门控拒绝 / 压缩接口探测失败 / 无可压内容）由实现抛错上浮（诚实失败，不谎报幂等）。
	 * 生成结果不经本调用返回（触发即返回）：完成/失败经通知通道送达（U5）。
	 */
	start: (ctx: ExtensionContext, customInstructions?: string) => boolean;
}

/**
 * 收起态一行摘要（GUI 收起态与 TUI 折叠态共用，经 details.summary 渲染）。
 * 压缩在后台执行：工具返回时任务刚启动，收起态/历史态语义 = 「后台压缩已启动」；
 * 「已完成」语义由完成通知承载（U5/D6），比例数据走完成通知不进本摘要。
 */
export function buildCompactContextSummary(): string {
	return "后台压缩已启动";
}

/** 工具描述（§3.5：三条件自查引导；条件即纪律，无第三层复述）。压缩在后台执行（U4 纯触发化）。 */
const TOOL_DESCRIPTION =
	"压缩当前会话上下文（释放早期对话占用的 token；压缩由配置的模型执行，不会切换你的主模型）。" +
	"压缩在后台进行：调用后立即返回，生成期间你可以继续任何工作，完成后的结果消息会送达会话。" +
	"仅在同时满足以下条件时调用：1) 当前任务的一个阶段已完成并验证（如一批文件改完、测试通过）；" +
	"2) 后续工作不再依赖将被压缩的早期细节；3) 上下文已超过提醒阈值（你会收到 [smart-context 提示]）。";

/**
 * 注册 compact_context 工具。
 *
 * gatingProbe/usageProbe/getEntries/background 为依赖注入（单测 mock 点）：
 * - gatingProbe(ctx) → { active, modelId }（生产实现：现场读配置判定）
 * - usageProbe(ctx) → { tokens, contextWindow }（生产实现：ctx.getContextUsage()）
 * - getEntries(ctx) → 条目列表（生产实现：ctx.sessionManager.getEntries()）
 * - background：后台任务互斥查询与启动（BackgroundCompactionControls 契约；
 *   U5 起 index.ts 注册点注入生产实装，与自动触发共享互斥容器）
 */
export function registerCompactContextTool(
	pi: ExtensionAPI,
	deps?: {
		gatingProbe?: (ctx: ExtensionContext) => { active: boolean; modelId: string };
		usageProbe?: (ctx: ExtensionContext) => { tokens: number | null; contextWindow: number };
		getEntries?: (ctx: ExtensionContext) => ReadonlyArray<EntryLike>;
		/**
		 * 后台压缩任务依赖（BackgroundCompactionControls 契约）。未注入 = 生产接线
		 * 缺失：execute 在门控与阈值检查后抛「后台压缩未接线」错误（fail-fast）。
		 */
		background?: BackgroundCompactionControls;
	},
): void {
	const probeGating =
		deps?.gatingProbe ??
		((ctx: ExtensionContext) => {
			const config = loadSmartContextConfig();
			const modelId = getCurrentModelId(ctx.model);
			return { active: isGatingActive(config, modelId), modelId };
		});
	const probeUsage =
		deps?.usageProbe ??
		((ctx: ExtensionContext) => {
			const usage = ctx.getContextUsage();
			return {
				tokens: usage?.tokens ?? null,
				contextWindow: usage?.contextWindow ?? 0,
			};
		});
	const getEntries =
		deps?.getEntries ??
		((ctx: ExtensionContext) => ctx.sessionManager.getEntries() as ReadonlyArray<EntryLike>);

	pi.registerTool({
		name: "compact_context",
		label: "compact_context",
		description: TOOL_DESCRIPTION,
		parameters: CompactContextParams,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			// D5 门控现场校验（配置热改即时生效，不依赖注册时机；V7：拒绝回现状文案）
			const gating = probeGating(ctx);
			const config = loadSmartContextConfig();
			if (!gating.active) {
				const reason = config.enabled
					? `当前模型 ${gating.modelId} 已配置为排除（smart-context excludedModels），压缩工具不可用。可在 taiji 设置页或 smart-context-ext-config skill 中调整。`
					: `smart-context 已禁用。可在 taiji 设置页开启，或经 smart-context-ext-config skill 修改配置。`;
				throw new Error(reason);
			}

			// D6 阈值保护（含 null 分支；A9：现状文案不动）
			const usage = probeUsage(ctx);
			const guardMessage = checkToolThresholdGuard(config.reminderThresholds, usage.tokens);
			if (guardMessage !== null) {
				throw new Error(guardMessage);
			}

			// 后台任务依赖（接线契约）：未注入 = 生产接线缺失 → fail-fast。接线上线前
			// 的窗口期工具显式不可用，不撒谎回执、不静默降级
			const background = deps?.background;
			if (!background) {
				throw new Error(
					"compact_context 后台压缩未接线：工具注册点缺少 background 依赖注入（BackgroundCompactionControls）。" +
						"请在 smart-context 扩展注册处注入与自动触发共享互斥容器的查询/启动接口。",
				);
			}

			const compactionCount = countCompactions(getEntries(ctx));
			const mode = pickMode(config, gating.modelId);
			const customInstructions =
				typeof params.custom_instructions === "string" && params.custom_instructions.trim() !== ""
					? params.custom_instructions
					: undefined;

			// U4 纯触发化：启动后台任务立即回执（GL1 不等待摘要生成）。互斥幂等（RL1）：
			// 已进行中不再启动，返回成功回执而非错误——isActive 与 start 之间的竞态由
			// start 返回 false 兜底，同样按幂等处理
			const started = !background.isActive() && background.start(ctx, customInstructions);
			if (!started) {
				return {
					content: [
						{
							type: "text",
							text: "后台压缩进行中，本次请求已并入该任务，无需重复触发。压缩在后台进行，你可以继续任何工作；完成后会收到一条结果消息。",
						},
					],
					details: {
						mode,
						compactModel: mode === "cross-model" ? config.compactModel.ref : gating.modelId,
						// 无新任务启动，压缩序号不变
						compactionCount,
						summary: buildCompactContextSummary(),
					} satisfies CompactContextDetails,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `压缩已启动（${mode === "same-model" ? "same-model 模式，KV 缓存优化" : `cross-model 模式，使用 ${config.compactModel.ref}`}）。压缩在后台进行，你可以继续任何工作；完成后会收到一条结果消息。`,
					},
				],
				details: {
					mode,
					compactModel: mode === "cross-model" ? config.compactModel.ref : gating.modelId,
					compactionCount: compactionCount + 1,
					summary: buildCompactContextSummary(),
				} satisfies CompactContextDetails,
			};
		},

		renderResult(result: unknown, options: { expanded: boolean }, theme: Theme) {
			return renderCompactContextResult(result, options, theme);
		},
	});
}
