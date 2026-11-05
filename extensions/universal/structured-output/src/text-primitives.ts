/**
 * 有界化纯文本原语 — workflow-hook 的共享叶节点（零依赖、无副作用）。
 *
 * 导出复用勿复制（审查项#1）：新调用方一律 import 本模块，禁止拷贝实现。
 */

/**
 * steer 回灌错误块截断上限（workflow-hook 消费；审查项#1：pi-ai validation.js 的
 * 实参回显无截断，大 payload 失败时单份 steer ≈11K chars）。截断保留首部 = 错误类型
 * + 靠前字段名；完整 schema 形状由 reminder 内 schemaJson 全文另行完整携带，不依赖
 * 错误块。
 */
export const STEER_ERROR_MAX_CHARS = 500;

/**
 * 截断到 max 字符（超出追加 "..."）——有界化原语，勿复制（审查项#1：导出复用）。
 * max 必显式传入（当前唯一调用方传 STEER_ERROR_MAX_CHARS）——不设默认值，
 * 防止新调用方静默绑错语义。
 */
export function truncateText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}...`;
}

/**
 * 从 tool 执行结果里提取错误文本。
 *
 * Pi 框架在参数层校验失败（immediate 路径）与 execute 抛错时，均构造
 * `{ content: [{ type: "text", text }] }` 塞进 result.content[0].text
 * （agent-loop.js createErrorToolResult；SDK 事件结构里没有独立 errorMessage 字段，
 * 错误文本只能从 result.content 里取）。workflow-hook 取 steer 回灌文本。
 * 这里防御性取多种结构，取不到就返回 undefined（调用方降级为通用提示）。
 */
export function extractToolErrorText(result: unknown): string | undefined {
	// 常见结构：{ content: [{ type: "text", text: "..." }] }
	if (typeof result === "object" && result !== null) {
		const content = (result as Record<string, unknown>).content;
		if (Array.isArray(content)) {
			for (const item of content) {
				if (typeof item === "object" && item !== null) {
					const text = (item as Record<string, unknown>).text;
					if (typeof text === "string" && text.length > 0) return text;
				}
			}
		}
		// 兜底：某些 tool 直接塞 { error: "..." }
		const err = (result as Record<string, unknown>).error;
		if (typeof err === "string" && err.length > 0) return err;
	}
	return undefined;
}
