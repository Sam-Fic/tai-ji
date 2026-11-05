/**
 * 入口态 fail-fast 断言（Interface tool 层共用的两条入口契约）。
 *
 * 文案逐字与既有实现一致（行为契约，改动即换用户的纠错路径）。
 *
 * 层归属：Shared（无 Pi 依赖，仅 SLUG_MAX_LENGTH 一个既有单源）。
 *（原 assertEntryTimeBudget / MAX_TIMER_DELAY_MS 依赖已随 workflow run 级时间预算
 * 机制删除。）
 */

import { SLUG_MAX_LENGTH } from "./run-vocabulary.ts";

/**
 * tokens 预算入口断言（tool 入口的 tokens 字段是 Type.Number 直通，无 schema 下界）。
 *
 * 负值会被 Budget 的 `maxTokens > 0` 不变式静默升格为 unlimited（isExceeded/remaining
 * 的检查语义——见 orchestration/models/budget.ts），显式设了预算却被忽略，在入口拦截。
 * undefined = 未设预算（unlimited），放行；0 沿用既有语义（= unlimited）不在此拒。
 *
 * @throws Error 当 tokens 为负值
 */
export function assertEntryTokenBudget(tokens: number | undefined): void {
  if (tokens !== undefined && tokens < 0) {
    throw new Error(
      `tokens budget ${tokens} is negative. ` +
        `Retry with a positive "tokens", or omit it for unlimited.`,
    );
  }
}

/**
 * slug 长度入口断言（schema maxLength 是第一道关卡，本函数是运行时第二道）。
 *
 * `examples` 由调用方给出（两个 tool 既有文案各自保留示例词——逐字不变），
 * 只影响文案尾巴，不影响判定。
 *
 * @throws Error 当 slug 非 undefined 且长度超出 SLUG_MAX_LENGTH
 */
export function assertSlugWithinLimit(
  slug: string | undefined,
  examples: readonly [string, string],
): void {
  if (slug !== undefined && slug.length > SLUG_MAX_LENGTH) {
    throw new Error(
      `slug exceeds ${SLUG_MAX_LENGTH} chars (got ${slug.length}). ` +
        `Shorten to a kebab-case label, e.g. "${examples[0]}", "${examples[1]}".`,
    );
  }
}
