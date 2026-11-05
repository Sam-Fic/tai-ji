/**
 * Goal 运行时组合状态类型 — engine 层共享类型定义
 *
 * 零 Pi 依赖。
 *
 * 仅 token 维度预算（time budget 已移除）。预警 flag 为 token 70/90 两个独立 flag。
 */

// ── Goal 状态枚举 ────────────────────────────────────

export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "complete"
	| "budget_limited"
	| "cancelled";

export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
	"complete",
	"budget_limited",
	"cancelled",
]);

// ── 预算配置 ────────────────────────────────────────

export interface BudgetConfig {
	tokenBudget?: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {};

// ── 运行时状态（也是持久化格式）─────────────────────

export interface GoalRuntimeState {
	goalId: string;
	objective: string;
	/**
	 * 成功标准——如何验证 objective 已达成。与 objective 成对存储、注入、展示。
	 *
	 * 由 goal_control create 时 AI 自行推导（思考真实目标后定义可检查的完成条件），
	 * 非用户手写。complete 的 evidence 必须对照本字段逐条验证。
	 *
	 * 结构化为条件数组 string[]（1~8 条、每条单行短条件）。
	 * 旧持久化数据可能为 string（单条自由文本），deserialize 自动迁移为 string[]。
	 * optional：旧持久化数据无此字段，向后兼容（deserialize 可选解析，prompt 缺失时省略段）。
	 */
	successCriteria?: string[];
	/**
	 * AI 生成的短标识（kebab-case 风格），仅用于 widget 状态栏标题与 history。
	 * 不注入 prompt（prompt 仍读 objective，保证方向感）。
	 * 由 goal_control create 时 AI 提供；/goal 命令路径走提示词触发器由 AI toolcall 生成。
	 * optional：旧持久化数据无此字段，widget fallback 到 objective 截断。
	 */
	slug?: string;
	status: GoalStatus;
	tokensUsed: number;
	timeStartedAt: number;
	timeUsedSeconds: number;
	budget: BudgetConfig;
	budgetLimitSteeringSent: boolean;
	lastBlockerReason: string | null;
	// token 维度预警 flag（time budget 已移除，仅 token 70/90 两个 flag）
	tokenWarning70Sent: boolean;
	tokenWarning90Sent: boolean;
	lastTurnTokensUsed: number;
	currentTurnIndex: number;
	// ── defer 记账（随 state 持久化）──
	/** defer 通知去重锚：最近一次 defer 时的活跃 pending id 集合（排序后快照）。 */
	lastDeferredPendingIds: string[];
}
