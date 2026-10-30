/**
 * 配置体系（M4，设计文档 §3.5「配置文件」段 + §3.6「config 解析失败」行）。
 *
 * 委托 llm-shared loadConfig（mtime+size 读时刷新热重载，同 smart-context/permission
 * 范式）——【热重载契约】每次需要配置直接调 loadBaseToolEnhanceConfig，禁止上层
 * 闭包/手动缓存阻断读时刷新（同进程改文件不重启即生效）。
 *
 * normalize 原则（部分坏配置不拖垮可用性）：单键类型错/负数/0 → 该键回退默认 +
 * logger.warn，不整体拒载；文件整体解析失败/不存在 → 全默认值（工具照常工作），
 * warn 落日志并指向配置文件路径。
 */

import { getConfigPath as getLlmSharedConfigPath, loadConfig } from "@zhushanwen/pi-llm-shared";
import { isRecord, toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { DEFAULT_MAX_CONCURRENT_BACKGROUND } from "./background/spawn-background.ts";

const logger = getLogger("base-tool-enhance");

/** llm-shared 泛型 config 的包名（决定文件名 <dataDir>/config/base-tool-enhance-ext-config.json）。 */
const CONFIG_PKG = "base-tool-enhance";

const MS_PER_SECOND = 1000;
/** setTimeout 延迟上限（int32 ms）：timeout 配置换算毫秒后的 clamp 上限。 */
const INT32_MAX_MS = 2_147_483_647;

/**
 * idleBackgroundSec 默认值（秒）：正常工具调用分钟级、编译静默常见 1-5 分钟，10 分钟
 * 输出静默在交互会话已是强异常信号（设计 §4.2 量级依据）。
 */
export const DEFAULT_IDLE_BACKGROUND_SEC = 600;

export interface BaseToolEnhanceConfig {
	/** 用户正则（源字符串），追加到内置两组白名单之后（compile 在 force-patterns.ts）。 */
	forceBackgroundPatterns: string[];
	/** true = 关闭内置 force-test/force-longrun 两组，只用用户正则。 */
	disableBuiltinForcePatterns: boolean;
	/** null = 不注入（D4，pi 原生不限时）；数字 = 前台未填 timeout 时的默认秒数。 */
	foregroundTimeoutSeconds: number | null;
	/** null = 不注入；数字 = 后台未填 timeout 时的默认秒数。 */
	backgroundTimeoutSeconds: number | null;
	/**
	 * 空闲转后台阈值（秒）：前台命令输出静默满此值时转后台（不杀命令，只解除阻塞——
	 * 是「转后台阈值」不是超时）；null = 关闭（回落官方原生无限等待）。归一化取整为
	 * ≥1 整数（消费者 = 包装脚本 --idle 参数，只接受非负整数秒）。
	 */
	idleBackgroundSec: number | null;
	maxConcurrentBackground: number;
}

/** 默认配置（零配置状态：内置白名单两组全生效、双模式不注入 timeout、空闲转后台 600s、并发 8）。 */
export const DEFAULT_BASE_TOOL_ENHANCE_CONFIG: BaseToolEnhanceConfig = {
	forceBackgroundPatterns: [],
	disableBuiltinForcePatterns: false,
	foregroundTimeoutSeconds: null,
	backgroundTimeoutSeconds: null,
	idleBackgroundSec: DEFAULT_IDLE_BACKGROUND_SEC,
	// 单一来源：与 spawnBackgroundTask 的 opts.maxConcurrent 缺省同值（M2 常量）
	maxConcurrentBackground: DEFAULT_MAX_CONCURRENT_BACKGROUND,
};

/** 配置文件完整路径（诊断文案与测试用）。 */
export function getConfigFilePath(): string {
	return getLlmSharedConfigPath(CONFIG_PKG);
}

function describeValue(value: unknown): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function warnInvalid(key: string, value: unknown, fallback: string): void {
	// 可操作错误信息：指出键、实际值、回退结果与配置文件路径
	logger.warn(
		`Config key '${key}' invalid (got ${describeValue(value)}), falling back to ${fallback}. ` +
			`Fix or remove it in ${getLlmSharedConfigPath(CONFIG_PKG)}.`,
	);
}

/**
 * 秒类配置键归一化（timeout 双键与 idleBackgroundSec 共用）：undefined（未配置）→
 * fallback；null（显式 null）→ null；正有限数 → 原值；类型错/负数/0/非有限 → fallback
 * + warn；换算毫秒超 int32 上限 → clamp + warn。
 *
 * null 与 undefined 分流的理由：timeout 键默认即 null（不注入，D4），两落点合一无分叉；
 * idleBackgroundSec 默认 600，必须三分——undefined = 未配置（默认开启）、显式 null =
 * 用户关闭（透传，下游据此回落官方原生）、坏值 = 回退默认而非关闭（显式 null 是唯一
 * 关闭通道，坏值不得意外关闭机制）。
 */
function normalizeSecondsKey(raw: unknown, key: string, fallback: number | null): number | null {
	if (raw === undefined) return fallback;
	if (raw === null) return null;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
		const fallbackDesc = fallback === null ? "null (no timeout injection)" : `${fallback} (default)`;
		warnInvalid(key, raw, fallbackDesc);
		return fallback;
	}
	if (raw * MS_PER_SECOND > INT32_MAX_MS) {
		const clamped = INT32_MAX_MS / MS_PER_SECOND;
		logger.warn(
			`Config key '${key}' ${raw}s exceeds int32 ms limit, clamped to ${clamped}s ` +
				`(${getLlmSharedConfigPath(CONFIG_PKG)}).`,
		);
		return clamped;
	}
	return raw;
}

/**
 * idleBackgroundSec 归一化：normalizeSecondsKey 基础上向下取整（消费者 = 包装脚本
 * --idle 参数，bash 文本协议只接受非负整数秒——放行小数会使配置层值空间与执行层
 * 可接受值空间出现差集，差集配置下全部 A5 前台命令 exit 64 立即失败、机制整体
 * 断裂）。正小数 floor 后 <1 的（如 0.5）抬到 1：--idle 0 语义是「首轮监控即转
 * 后台」，不是亚秒阈值的合理近似。timeout 双键不取整——消费者是 pi 官方 timeout
 * 参数（数字秒，小数合法）。
 */
function normalizeIdleBackgroundSec(raw: unknown): number | null {
	const normalized = normalizeSecondsKey(raw, "idleBackgroundSec", DEFAULT_IDLE_BACKGROUND_SEC);
	return normalized === null ? null : Math.max(1, Math.floor(normalized));
}

/**
 * forceBackgroundPatterns 归一化：非数组 → 空 + warn；单条非字符串或 compile 失败 →
 * 仅丢弃该条 + warn（一条坏正则不让所有前台命令全挂），其余条目保留。
 */
function normalizeForceBackgroundPatterns(raw: unknown): string[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		warnInvalid("forceBackgroundPatterns", raw, "[] (no user patterns)");
		return [];
	}
	const valid: string[] = [];
	raw.forEach((item, index) => {
		if (typeof item !== "string") {
			warnInvalid(`forceBackgroundPatterns[${index}]`, item, "dropped");
			return;
		}
		try {
			new RegExp(item);
		} catch (err) {
			logger.warn(
				`Config key 'forceBackgroundPatterns[${index}]' is not a valid regex (${item}), dropped: ` +
					`${toErrorMessage(err)} (${getLlmSharedConfigPath(CONFIG_PKG)}).`,
			);
			return;
		}
		valid.push(item);
	});
	return valid;
}

function normalizeDisableBuiltinForcePatterns(raw: unknown): boolean {
	if (typeof raw === "boolean") return raw;
	if (raw !== undefined) warnInvalid("disableBuiltinForcePatterns", raw, "false");
	return false;
}

/** 正有限数取 floor（并发数语义为整数）；类型错/负数/0 → 默认 8 + warn。 */
function normalizeMaxConcurrentBackground(raw: unknown): number {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		return Math.floor(raw);
	}
	if (raw !== undefined) warnInvalid("maxConcurrentBackground", raw, String(DEFAULT_MAX_CONCURRENT_BACKGROUND));
	return DEFAULT_MAX_CONCURRENT_BACKGROUND;
}

/**
 * 单键归一化（永不 throw——llm-shared 只在文件整体解析失败时走 catch 回退，键级
 * 问题在这里就地消化）。未知键忽略（前向兼容）。
 */
export function normalizeBaseToolEnhanceConfig(raw: unknown): BaseToolEnhanceConfig {
	if (!isRecord(raw)) {
		if (raw !== undefined && raw !== null) {
			logger.warn(
				`Config root is not a JSON object (${describeValue(raw)}), using all defaults ` +
					`(${getLlmSharedConfigPath(CONFIG_PKG)}).`,
			);
		}
		return { ...DEFAULT_BASE_TOOL_ENHANCE_CONFIG };
	}
	return {
		forceBackgroundPatterns: normalizeForceBackgroundPatterns(raw.forceBackgroundPatterns),
		disableBuiltinForcePatterns: normalizeDisableBuiltinForcePatterns(raw.disableBuiltinForcePatterns),
		foregroundTimeoutSeconds: normalizeSecondsKey(raw.foregroundTimeoutSeconds, "foregroundTimeoutSeconds", null),
		backgroundTimeoutSeconds: normalizeSecondsKey(raw.backgroundTimeoutSeconds, "backgroundTimeoutSeconds", null),
		idleBackgroundSec: normalizeIdleBackgroundSec(raw.idleBackgroundSec),
		maxConcurrentBackground: normalizeMaxConcurrentBackground(raw.maxConcurrentBackground),
	};
}

/**
 * 加载配置（每次调用直接走 loadConfig 读时刷新——热重载契约，禁止上层缓存）。
 * 文件不存在 / 坏 JSON → 全默认值 + warn（§3.6：工具按默认值继续工作）。
 */
export function loadBaseToolEnhanceConfig(): BaseToolEnhanceConfig {
	return loadConfig(CONFIG_PKG, DEFAULT_BASE_TOOL_ENHANCE_CONFIG, normalizeBaseToolEnhanceConfig, (msg) => {
		logger.warn(msg);
	});
}
