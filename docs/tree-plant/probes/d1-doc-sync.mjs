/**
 * D1（枝 docs-sync）：文档同步静态对账。
 *
 * 验证交付的文档面与代码行为一致（旧措辞清场 + 新语义登记）：
 * ① route-matrix.md：总则 5 改写为「重试透传与终局 failover」、新增「重试与 failover」章；
 * ② domain-model.md：模型路由概念条目的重试排除表述 → burnt 软避让 + 透传语义；
 * ③ SKILL.md：能力描述与两张表的旧措辞同步；
 * ④ 旧致命文案「上一端点失败且无其他可用端点」与「retry-excluded」在 extensions/ 与
 *    domain-model.md 清零（唯一合法残留 = 本探针自身的断言串与 tree-plant 工作文档）；
 * ⑤  routes schema 零新键：T1-T6 探针配置（全既有 schema 键）经实装
 *    parseAggregationRoutesSection 解析 ok——新行为不需要新配置项（目标 G3）。
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checker } from "./lib/harness.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const read = rel => readFileSync(join(REPO_ROOT, rel), "utf8");

const REMOVED_ERROR_TEXT = "上一端点失败且无其他可用端点";

let exitCode = 0;
try {
	const c = checker("D1 文档同步对账");

	// ① route-matrix.md
	const matrix = read("docs/design/provider-aggregation-route-matrix.md");
	c.check(matrix.includes("重试与 failover"), "route-matrix.md 含「重试与 failover」章");
	c.check(matrix.includes("burnt"), "route-matrix.md 登记 burnt 语义");
	c.check(matrix.includes("透传"), "route-matrix.md 登记 retry 透传语义");
	c.check(!matrix.includes("上一失败端点本次排除"), "route-matrix.md 总则 5 旧措辞已改写");
	c.check(!matrix.includes("retry-excluded"), "route-matrix.md 无 retry-excluded 残留");

	// ② domain-model.md
	const domain = read("docs/domain-model.md");
	c.check(domain.includes("burnt"), "domain-model.md 登记 burnt 软避让");
	c.check(!domain.includes("重试排除作为选择层排除仍先行生效"), "domain-model.md 旧重试排除表述已替换");
	c.check(!domain.includes(REMOVED_ERROR_TEXT), "domain-model.md 无旧致命文案");

	// ③ SKILL.md
	const skill = read("extensions/universal/provider-aggregation/skills/provider-aggregation-ext-config/SKILL.md");
	c.check(skill.includes("透传") || skill.includes("failover"), "SKILL.md 登记透传/failover 语义");
	c.check(!skill.includes("上一失败端点本轮排除"), "SKILL.md 故障契约表旧措辞已替换");
	c.check(!skill.includes(REMOVED_ERROR_TEXT), "SKILL.md 无旧致命文案");

	// ④ 扩展源码零残留
	const { readdirSync, statSync } = await import("node:fs");
	const walk = dir => {
		const out = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) out.push(...walk(p));
			else if (/\.(ts|md)$/.test(entry.name)) out.push(p);
		}
		return out;
	};
	const extDir = join(REPO_ROOT, "extensions/universal/provider-aggregation");
	for (const file of walk(extDir)) {
		const text = readFileSync(file, "utf8");
		const rel = file.slice(REPO_ROOT.length + 1);
		c.check(!text.includes("retry-excluded"), `${rel} 无 retry-excluded 残留`);
		c.check(!text.includes(REMOVED_ERROR_TEXT), `${rel} 无旧致命文案`);
	}

	// ⑤ routes schema 零新键：探针配置（全既有键）过实装解析
	const { parseAggregationRoutesSection } = await import(
		join(REPO_ROOT, "packages/extension-protocol/src/aggregation.ts")
	);
	const probeRoutes = [{
		id: "route-dual",
		name: "双端点",
		modelId: "route-dual",
		enabled: true,
		mode: "advanced",
		members: [
			{ id: "m1", providerId: "fault-a", modelId: "fault-a-model", type: "none" },
			{ id: "m2", providerId: "fault-b", modelId: "fault-b-model", type: "none" },
		],
		specials: [],
	}];
	const parsed = parseAggregationRoutesSection({ routes: { version: 1, routes: probeRoutes } });
	c.check(parsed.ok === true, `探针路由配置（零新键）过实装 schema 解析（实际 ${parsed.ok ? "ok" : parsed.reason}）`);
	if (!c.done()) exitCode = 1;
} catch (err) {
	console.error(`✗ D1 异常：${err?.stack ?? err}`);
	exitCode = 1;
}
process.exit(exitCode);
