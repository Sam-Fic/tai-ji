/**
 * isObjectRootSchema 跨包双副本对拍测试（架构腐化审计 structured-output.md 候选 1
 * 的低风险防线补齐——注意这不是车道 B「共享叶子收敛」本体：两处副本仍在，本文件
 * 把此前仅靠 [同源锚定] 注释人肉维持的一致性程序化）。
 *
 * 双副本现状：
 * - 本包 src/execute.ts isObjectRootSchema（导出；注册期 {value} 包装与本文件
 *   execute 解包共用同一判定）；
 * - packages/subagent-core src/orchestration/agent-opts-resolver.ts 的模块私有副本
 *   （唯一导出消费方 formatSchemaInstruction——按根判定条件化 ASP 契约文案）。
 *
 * 对拍口径（行为级，两侧真实实现）：
 * - 本侧：import isObjectRootSchema 直接调用；
 * - subagent-core 侧：副本本身不可 import（模块私有），对拍其唯一导出消费方
 *   formatSchemaInstruction 的可观测行为——object 根输出「arguments 即 data」契约行，
 *   非 object 根输出「{value} 包装」契约行。文案选错行 = 模型按错误形态调用首调必败，
 *   故锁「本侧判定 ↔ 对端文案选行」一致即是锁两副本语义一致。
 *
 * import 通路说明：subagent-core 公共 barrel 不导出 formatSchemaInstruction，深路径
 * 又被其 exports（D5 定稿）收窄，包名深 import 不可达——按同目录
 * cross-package-contract.test.ts 既有先例走 workspace 相对路径动态 import 源码叶子，
 * 不经过包名解析（故 package.json 无需声明对端 devDependency），该通路仅在完整
 * workspace 内成立。**不可 skip**：对端叶子不可达时本文件直接 fail（错误含恢复
 * 动作）——workspace 内不可达 = 对端叶子布局漂移，需把新路径追加进本文件候选路径。
 * 与 cross-package-contract.test.ts ① 组（同名常量断言但带降级 skip）的关系：本文件
 * 是硬锁，共享叶子收敛（候选 1 车道 B）落地后两者一并收敛为「锁导入存在」。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isObjectRootSchema } from "../../src/execute.js";
import { SO_SCHEMA_SIZE_WARN_BYTES } from "../../src/index.js";

/** subagent-core agent-opts-resolver 叶子的导出面（本测试消费的子集）。 */
type AgentOptsResolverLeaf = {
	formatSchemaInstruction: (schema: Record<string, unknown>) => string;
}

/** pi-subagent-cli 常量叶子的导出面（零依赖纯常量）。 */
type CliConstantsLeaf = {
	SCHEMA_ENV_MAX_BYTES: number;
}

/** 对端叶子候选路径（相对本文件）。对端调整叶子布局时在此追加。 */
const CORE_LEAF = "../../../../../packages/subagent-core/src/orchestration/agent-opts-resolver.ts";
const CLI_CONSTANTS_LEAF = "../../../../../packages/pi-subagent-cli/src/constants.ts";

/** 动态 import 相对路径：file URL 绝对路径是稳定通路（裸相对 specifier 会被 Vite 相对项目根折叠，见同目录先例）。 */
async function dynamicImportRelative(spec: string): Promise<unknown> {
	const here = dirname(fileURLToPath(import.meta.url));
	return import(pathToFileURL(join(here, spec)).href);
}

/** import 失败即 fail（不 skip）：错误含恢复动作，构成「错误 → 权威源 → 重试」闭环。 */
async function importOrThrow<T>(spec: string, what: string): Promise<T> {
	try {
		return (await dynamicImportRelative(spec)) as T;
	} catch (cause) {
		throw new Error(
			`[object-root-schema-parity] ${what} 不可达（${spec}）。`
			+ "跨包对拍经 workspace 相对路径动态 import 源码叶子，不经过包名解析，仅在完整"
			+ " workspace 内成立：请在完整 workspace 内重试；workspace 内不可达 = 对端叶子"
			+ "布局漂移，请把新路径追加进本文件候选路径。"
			+ `底层原因：${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
}

const agentOptsResolver = await importOrThrow<AgentOptsResolverLeaf>(CORE_LEAF, "subagent-core agent-opts-resolver 叶子");
const cliConstants = await importOrThrow<CliConstantsLeaf>(CLI_CONSTANTS_LEAF, "pi-subagent-cli constants 叶子");

// ── ASP 契约行的判定锚（agent-opts-resolver.ts formatSchemaInstruction 实文）──────

const OBJECT_ARGS_LINE = "Your call arguments ARE the result data itself";
const WRAPPER_ARGS_LINE = "The tool's single argument must be an object `{value: <data>}`";
const OBJECT_RULES_LINE = "with your result data as its arguments";
const WRAPPER_RULES_LINE = "with `{value: <your result data>}`";

// ============================================================
// 矩阵：根数据形态 × 期望判定（两侧副本的共同语义——draft-07 类型关键字按值形态适用）
// ============================================================

const ROOT_MATRIX: { label: string; schema: unknown; expected: boolean }[] = [
	// ── object 根：显式 type ──
	{ label: "type: object 裸形态", schema: { type: "object" }, expected: true },
	{ label: "type: object + properties", schema: { type: "object", properties: { name: { type: "string" } } }, expected: true },
	{ label: "type 数组含 object（nullable object）", schema: { type: ["object", "null"] }, expected: true },
	{ label: "type 数组含 object（混合序）", schema: { type: ["string", "object"] }, expected: true },
	// ── object 根：object 特有关键字（无 type 时按值形态适用）──
	{ label: "properties（无 type）", schema: { properties: { name: { type: "string" } } }, expected: true },
	{ label: "required", schema: { required: ["name"] }, expected: true },
	{ label: "patternProperties", schema: { patternProperties: { "^x": { type: "string" } } }, expected: true },
	{ label: "additionalProperties: false（最小 object-only schema，常见真实形态）", schema: { additionalProperties: false }, expected: true },
	{ label: "minProperties", schema: { minProperties: 1 }, expected: true },
	{ label: "maxProperties", schema: { maxProperties: 10 }, expected: true },
	{ label: "dependencies", schema: { dependencies: { a: ["b"] } }, expected: true },
	{ label: "dependentRequired", schema: { dependentRequired: { a: ["b"] } }, expected: true },
	{ label: "propertyNames", schema: { propertyNames: { pattern: "^x" } }, expected: true },
	// ── 非 object 根：显式非 object type ──
	{ label: "type: string", schema: { type: "string" }, expected: false },
	{ label: "type: number", schema: { type: "number" }, expected: false },
	{ label: "type: integer", schema: { type: "integer" }, expected: false },
	{ label: "type: boolean", schema: { type: "boolean" }, expected: false },
	{ label: "type: array + items", schema: { type: "array", items: { type: "string" } }, expected: false },
	{ label: "type 数组不含 object", schema: { type: ["string", "number"] }, expected: false },
	{ label: "type 大小写敏感（\"OBJECT\" 不识别）", schema: { type: "OBJECT" }, expected: false },
	// ── 非 object 根：组合根保真包装（{value} 可容纳任意成员类型）──
	{ label: "anyOf 组合根", schema: { anyOf: [{ type: "string" }, { type: "number" }] }, expected: false },
	{ label: "oneOf 组合根", schema: { oneOf: [{ type: "string" }, { type: "object" }] }, expected: false },
	{ label: "allOf 组合根", schema: { allOf: [{ type: "object" }, { minProperties: 1 }] }, expected: false },
	{ label: "$ref 根", schema: { $ref: "#/definitions/output" }, expected: false },
	{ label: "enum 根", schema: { enum: ["a", "b"] }, expected: false },
	// ── 非 object 根：非 object 特有关键字 / 无识别关键字 ──
	{ label: "items（无 type 的 array-only 形态）", schema: { items: { type: "string" } }, expected: false },
	{ label: "minItems / maxItems（array-only）", schema: { minItems: 1, maxItems: 5 }, expected: false },
	{ label: "minLength（string-only）", schema: { minLength: 1 }, expected: false },
	{ label: "纯注解关键字（description）", schema: { description: "output shape" }, expected: false },
	{ label: "空对象（无识别关键字）", schema: {}, expected: false },
	// ── 非 object 根：非 object JSON 值（防御形态，注册期包装为 {value}）──
	{ label: "boolean schema 根（true）", schema: true, expected: false },
	{ label: "boolean schema 根（false）", schema: false, expected: false },
	{ label: "number 字面量", schema: 42, expected: false },
	{ label: "string 字面量", schema: "not-a-schema", expected: false },
	{ label: "array 字面量", schema: [1, 2, 3], expected: false },
];

describe("isObjectRootSchema 本侧真值锚定（矩阵期望判定即现行为快照）", () => {
	it("矩阵逐条：本侧判定 === 期望", () => {
		for (const { label, schema, expected } of ROOT_MATRIX) {
			expect(isObjectRootSchema(schema), `[${label}]`).toBe(expected);
		}
	});

	it("null 根判非 object（formatSchemaInstruction 契约收 Record，null 非其消费形态，仅本侧断言）", () => {
		expect(isObjectRootSchema(null)).toBe(false);
	});
});

describe("双副本对拍：本侧判定 ↔ subagent-core ASP 契约文案选行（行为一致）", () => {
	it("矩阵逐条：object 根出「arguments 即 data」行、非 object 根出「{value} 包装」行（args 与 rules 两处文案同选）", () => {
		for (const { label, schema, expected } of ROOT_MATRIX) {
			const instruction = agentOptsResolver.formatSchemaInstruction(schema as Record<string, unknown>);
			expect(instruction.includes(OBJECT_ARGS_LINE), `[${label}] args 契约行应${expected ? "" : "不"}为 object 直传形态`).toBe(expected);
			expect(instruction.includes(WRAPPER_ARGS_LINE), `[${label}] args 契约行应${expected ? "不" : ""}为 {value} 包装形态`).toBe(!expected);
			expect(instruction.includes(OBJECT_RULES_LINE), `[${label}] rules 调用行应${expected ? "" : "不"}为 object 直传形态`).toBe(expected);
			expect(instruction.includes(WRAPPER_RULES_LINE), `[${label}] rules 调用行应${expected ? "不" : ""}为 {value} 包装形态`).toBe(!expected);
		}
	});

	it("schema 全文按原样嵌入 ASP（对端文案携带的 schema 与判定输入同一份）", () => {
		const schema = { type: "object", properties: { name: { type: "string" } } };
		const instruction = agentOptsResolver.formatSchemaInstruction(schema);
		expect(instruction).toContain(JSON.stringify(schema));
	});
});

// ============================================================
// 256KiB 契约常量对拍（SO 提示线 = SW 硬拒线，SO-DATA-4）
// ============================================================

describe("256KiB 契约常量对拍：SO_SCHEMA_SIZE_WARN_BYTES ↔ SCHEMA_ENV_MAX_BYTES", () => {
	it("两侧字节相等（提示线与硬拒线同值——分叉 = 超限 schema 在 SO 侧无提示或 SW 侧误拒）", () => {
		expect(cliConstants.SCHEMA_ENV_MAX_BYTES).toBe(SO_SCHEMA_SIZE_WARN_BYTES);
	});
});
