/**
 * network-proxy 校验/匹配语义跨包对拍测试（架构腐化审计 network-proxy.md 候选 1 的机器锁）。
 *
 * 语义 SSOT = packages/shared/src/network-proxy.ts；本扩展 src/config.ts、src/match.ts
 * 是 bundle 自包含复制体。此前两侧测试各自独立维护、互不 import（config.test.ts /
 * match.test.ts 与 shared 侧 network-proxy.test.ts 各自锁本侧），注释声称的「镜像锁定
 * 测试锁两侧行为一致」实际不存在——shared 侧语义变更不会使本包测试变红。
 *
 * 本测试照 retry-rules-validation-parity.test.ts 先例：import @taiji/shared 真实实现，
 * 同一输入矩阵分别喂两侧，断言双侧同判——校验含错误清单逐字一致（文案面向用户且
 * 含修复动作，两侧分叉 = 一侧的用户指引失效）。shared 侧调整语义 → 本测试红 →
 * 按提示同步本包复制体（以 shared 为准）。
 *
 * 签名说明：shared validateNetworkProxyConfig 参数已统一为 unknown（与扩展侧同款，
 * 运行时守卫本就按任意输入设计，类型级收窄统一、零运行时行为变化）。
 *
 * @taiji/shared 仅测试面消费（devDependencies + workspace 源直引，bundle 自包含
 * 不受影响）。单包环境未安装该 devDependency 时本文件 import 即失败（不 skip）——
 * 先补装 `@taiji/shared: workspace:*` 再跑。
 */
import { describe, expect, it } from "vitest";

import {
	DEFAULT_NETWORK_PROXY_CONFIG as SHARED_DEFAULT,
	matchesHostPattern as sharedMatchesHostPattern,
	normalizeHostname as sharedNormalizeHostname,
	validateNetworkProxyConfig as sharedValidateNetworkProxyConfig,
} from "@taiji/shared";

import {
	DEFAULT_NETWORK_PROXY_CONFIG,
	validateNetworkProxyConfig,
} from "../config.ts";
import { matchesHostPattern, normalizeHostname } from "../match.ts";

// ============================================================
// normalizeHostname：同输入双侧同出
// ============================================================

const HOSTNAME_MATRIX: string[] = [
	"api.anthropic.com",
	"API.Anthropic.COM",
	"api.anthropic.com.",
	"api.anthropic.com..",
	"LocalHost",
	"localhost",
	"xapi.openai.com",
	"127.0.0.1",
	"",
	".",
	"..",
	" api.anthropic.com",
	"api.anthropic.com ",
	"  ",
	"api.xn--wse.academy",
];

describe("normalizeHostname 双侧同判（归一化语义跨包对拍）", () => {
	it("矩阵逐条：本侧输出 === shared 侧输出", () => {
		for (const host of HOSTNAME_MATRIX) {
			expect(normalizeHostname(host), `host=${JSON.stringify(host)}`).toBe(sharedNormalizeHostname(host));
		}
	});

	it("锚定值抽查（防两侧同漂时对拍空转——shared 侧自身测试另有行为锁）", () => {
		expect(normalizeHostname("API.Anthropic.COM.")).toBe("api.anthropic.com");
		expect(normalizeHostname(" api.anthropic.com")).toBe(" api.anthropic.com");
		expect(normalizeHostname("")).toBe("");
	});
});

// ============================================================
// matchesHostPattern：真值表双侧同判
// ============================================================

const MATCH_MATRIX: { host: string; pattern: string }[] = [
	// 等于 / suffix 命中
	{ host: "api.anthropic.com", pattern: "api.anthropic.com" },
	{ host: "x.api.anthropic.com", pattern: "api.anthropic.com" },
	{ host: "api.anthropic.com", pattern: "anthropic.com" },
	// 点边界：无点前缀拼接不命中
	{ host: "xapi.anthropic.com", pattern: "api.anthropic.com" },
	// 恶意后缀不命中
	{ host: "api-anthropic.com.evil.com", pattern: "api-anthropic.com" },
	// 大小写 / 末尾点归一化后命中
	{ host: "X.API.Anthropic.COM.", pattern: "api.anthropic.com" },
	{ host: "api.anthropic.com", pattern: "API.Anthropic.COM." },
	// 空主机名 / 空 pattern / 纯点 pattern
	{ host: "", pattern: "api.anthropic.com" },
	{ host: "api.anthropic.com", pattern: "" },
	{ host: "api.anthropic.com", pattern: "." },
	{ host: "api.anthropic.com", pattern: ".." },
	// 带空白条目恒不命中（归一化不 trim，校验层显式拒绝）
	{ host: "api.anthropic.com", pattern: " api.anthropic.com" },
	{ host: " api.anthropic.com", pattern: "api.anthropic.com" },
	// pattern 比主机名长（suffix 反向不命中）
	{ host: "anthropic.com", pattern: "api.anthropic.com" },
	// IP 条目（noProxy 默认成员形态）
	{ host: "127.0.0.1", pattern: "127.0.0.1" },
	{ host: "localhost", pattern: "localhost" },
];

describe("matchesHostPattern 双侧同判（suffix 点边界真值表跨包对拍）", () => {
	it("矩阵逐条：本侧输出 === shared 侧输出", () => {
		for (const { host, pattern } of MATCH_MATRIX) {
			expect(
				matchesHostPattern(host, pattern),
				`host=${JSON.stringify(host)}, pattern=${JSON.stringify(pattern)}`,
			).toBe(sharedMatchesHostPattern(host, pattern));
		}
	});

	it("锚定值抽查（点边界与恶意后缀是安全语义，两侧同漂也不许双双失守）", () => {
		expect(matchesHostPattern("xapi.anthropic.com", "api.anthropic.com")).toBe(false);
		expect(matchesHostPattern("api-anthropic.com.evil.com", "api-anthropic.com")).toBe(false);
		expect(matchesHostPattern("x.api.anthropic.com", "api.anthropic.com")).toBe(true);
	});
});

// ============================================================
// validateNetworkProxyConfig：同输入双侧同判（含错误清单逐字一致）
// ============================================================

/** 合法基座（每次浅拷贝，矩阵条目间无共享可变状态）。 */
function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		enabled: true,
		proxy: { protocol: "http", host: "127.0.0.1", port: 7890, username: "", password: "" },
		noProxy: ["localhost"],
		rules: ["api.anthropic.com"],
		ipv4Only: [],
		...overrides,
	};
}

/**
 * 单输入双侧对拍：同一配置喂两侧 validateNetworkProxyConfig，断言
 * ① ok 同判；② 都拒绝时错误清单逐字一致（含条目顺序——顺序也是用户可见形态）。
 */
function expectSameValidation(label: string, config: unknown): void {
	const sharedResult = sharedValidateNetworkProxyConfig(config);
	const extResult = validateNetworkProxyConfig(config);
	expect(extResult.ok, `[${label}] ok 双侧同判`).toBe(sharedResult.ok);
	if (!sharedResult.ok && !extResult.ok) {
		expect(extResult.errors, `[${label}] 错误清单逐字一致`).toEqual(sharedResult.errors);
	}
}

const VALIDATION_MATRIX: { label: string; config: unknown }[] = [
	// ── 合法形态 ──
	{ label: "全字段合法", config: validConfig() },
	{ label: "socks5 协议 + 成对凭据", config: validConfig({ proxy: { protocol: "socks5", host: "p.example.com", port: 1080, username: "u", password: "p" } }) },
	{ label: "ipv4Only 缺省（旧配置文件向后兼容形态）", config: (() => { const c = validConfig(); delete c.ipv4Only; return c; })() },
	{ label: "空清单 + 禁用态（DEFAULT 形态）", config: { enabled: false, proxy: { protocol: "http", host: "127.0.0.1", port: 7890, username: "", password: "" }, noProxy: ["localhost", "127.0.0.1"], rules: [], ipv4Only: [] } },
	{ label: "重复条目不报错（匹配天然幂等）", config: validConfig({ rules: ["a.com", "a.com"] }) },
	// ── 顶层对象性 ──
	{ label: "null", config: null },
	{ label: "数组", config: [validConfig()] },
	{ label: "字符串", config: "{}" },
	{ label: "数字", config: 42 },
	// ── enabled ──
	{ label: "enabled 缺省", config: (() => { const c = validConfig(); delete c.enabled; return c; })() },
	{ label: "enabled 非布尔", config: validConfig({ enabled: "yes" }) },
	// ── proxy ──
	{ label: "proxy 缺省", config: (() => { const c = validConfig(); delete c.proxy; return c; })() },
	{ label: "proxy null", config: validConfig({ proxy: null }) },
	{ label: "proxy 数组", config: validConfig({ proxy: ["http"] }) },
	{ label: "协议词表外", config: validConfig({ proxy: { protocol: "socks4", host: "127.0.0.1", port: 7890, username: "", password: "" } }) },
	{ label: "协议非字符串", config: validConfig({ proxy: { protocol: 1, host: "127.0.0.1", port: 7890, username: "", password: "" } }) },
	{ label: "host 空串", config: validConfig({ proxy: { protocol: "http", host: "", port: 7890, username: "", password: "" } }) },
	{ label: "host 纯空白", config: validConfig({ proxy: { protocol: "http", host: "   ", port: 7890, username: "", password: "" } }) },
	{ label: "host 非字符串", config: validConfig({ proxy: { protocol: "http", host: 80, port: 7890, username: "", password: "" } }) },
	{ label: "端口 0", config: validConfig({ proxy: { protocol: "http", host: "127.0.0.1", port: 0, username: "", password: "" } }) },
	{ label: "端口 65536", config: validConfig({ proxy: { protocol: "http", host: "127.0.0.1", port: 65536, username: "", password: "" } }) },
	{ label: "端口小数", config: validConfig({ proxy: { protocol: "http", host: "127.0.0.1", port: 7890.5, username: "", password: "" } }) },
	{ label: "端口字符串", config: validConfig({ proxy: { protocol: "http", host: "127.0.0.1", port: "7890", username: "", password: "" } }) },
	{ label: "凭据非文本", config: validConfig({ proxy: { protocol: "http", host: "127.0.0.1", port: 7890, username: 1, password: "" } }) },
	{ label: "凭据单边（有用户名无密码）", config: validConfig({ proxy: { protocol: "http", host: "127.0.0.1", port: 7890, username: "u", password: "" } }) },
	{ label: "凭据单边（无用户名有密码）", config: validConfig({ proxy: { protocol: "http", host: "127.0.0.1", port: 7890, username: "", password: "p" } }) },
	// ── noProxy / rules 条目 ──
	{ label: "noProxy 非数组", config: validConfig({ noProxy: "localhost" }) },
	{ label: "noProxy 空串条目", config: validConfig({ noProxy: [""] }) },
	{ label: "noProxy 纯空白条目", config: validConfig({ noProxy: ["  "] }) },
	{ label: "noProxy 非字符串条目", config: validConfig({ noProxy: [123] }) },
	{ label: "rules 含空白字符条目", config: validConfig({ rules: ["api.anthropic.com "] }) },
	{ label: "rules 非数组", config: validConfig({ rules: {} }) },
	// ── ipv4Only ──
	{ label: "ipv4Only 非数组（显式声明非法形态才报错）", config: validConfig({ ipv4Only: "example.com" }) },
	{ label: "ipv4Only 空串条目", config: validConfig({ ipv4Only: [""] }) },
	{ label: "ipv4Only 含空白条目", config: validConfig({ ipv4Only: [" example.com"] }) },
	// ── 多错误并存（锁收集顺序）──
	{ label: "多字段同时非法（enabled + proxy + noProxy + rules + ipv4Only）", config: { enabled: 1, proxy: null, noProxy: "x", rules: [""], ipv4Only: 3 } },
];

describe("validateNetworkProxyConfig 双侧同判（同输入矩阵跨包对拍）", () => {
	it("矩阵逐条：ok 同判 + 拒绝时错误清单逐字一致", () => {
		for (const { label, config } of VALIDATION_MATRIX) {
			expectSameValidation(label, config);
		}
	});

	it("锚定值抽查：合法最小形态两侧都 ok、顶层非对象两侧都拒", () => {
		expect(validateNetworkProxyConfig(validConfig())).toEqual({ ok: true });
		expect(sharedValidateNetworkProxyConfig(validConfig())).toEqual({ ok: true });
		expect(validateNetworkProxyConfig(null).ok).toBe(false);
		expect(sharedValidateNetworkProxyConfig(null).ok).toBe(false);
	});
});

// ============================================================
// DEFAULT_NETWORK_PROXY_CONFIG：两侧深相等
// ============================================================

describe("DEFAULT_NETWORK_PROXY_CONFIG 双侧深相等（默认面起点一致）", () => {
	it("本侧 DEFAULT === shared 侧 DEFAULT", () => {
		expect(DEFAULT_NETWORK_PROXY_CONFIG).toEqual(SHARED_DEFAULT);
	});
});
