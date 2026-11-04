/**
 * Goal 扩展语义常量
 *
 * 所有数字的含义都通过命名自解释，避免 magic number。
 */

// ── 时间换算 ────────────────────────────────────────

export const SECONDS_PER_MINUTE = 60;
export const MS_PER_SECOND = 1000;

// ── 预算比例阈值 (0-1) ──────────────────────────────

export const BUDGET_RATIO_HIGH = 0.9;            // 90% — 触发预警/收尾 steering
export const BUDGET_RATIO_LOW = 0.7;             // 70% — 触发提醒
export const CONTEXT_USAGE_RATIO_LIMIT = 0.85;   // 85% — 上下文空间不足阈值

// ── 长度/数量上限 ───────────────────────────────────

export const UPDATE_PREFIX_LENGTH = 7;        // "update ".length
export const SHORT_ID_LENGTH = 8;             // goalId 截取前 8 字符作短标识（GUI 显示 fallback）

// ── 百分比换算因子 ──────────────────────────────────

export const PERCENT_FACTOR = 100;

// ── TUI 显示 ────────────────────────────────────────

export const PROGRESS_BAR_DEFAULT_WIDTH = 10;
export const OBJECTIVE_DISPLAY_LIMIT = 80;
export const OBJECTIVE_TRUNCATE_KEEP = 77; // DISPLAY_LIMIT - 3 for "..."
export const TOKEN_K_THRESHOLD = 1000;     // token 数 ≥ 此值时缩写为 k 单位（12000 → 12k）

// ── 上限 ─────────────────────────────────────────────

export const MAX_HISTORY_ENTRIES = 20;			// goal-history entry GC 上限
