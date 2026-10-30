#!/usr/bin/env node
/**
 * check-testid-parity.mjs — e2e spec testid 引用 × renderer 实现对账器
 *
 * 红灯①「testid 对账器转正」（设计 D13 / impl-plan u-foundation F1-①）的固定检查入口：
 * e2e spec 引用的 data-testid 必须在 renderer 侧组件源码中有实现（静态属性 /
 * 动态模板前缀 / 动态绑定字面量三者任一），悬空引用即 exit 1——「spec 引用但
 * DOM 无实现」不再依赖人工发现（RL10：现状 4 个 spec 引用已删托盘/工作区 DOM
 * 悬空，靠 review 才发现）。
 *
 * 对账语义（单向：spec → 实现；实现未被 spec 引用不构成红灯——大量组件无 e2e
 * 覆盖是常态，不立反向义务）：
 *   - spec 精确引用（[data-testid="X"] / getByTestId('X')）：实现 exact 集含 X，
 *     或存在实现前缀 P 使 X.startsWith(P)（动态模板 `P${...}` 产出的族）
 *   - spec 前缀引用（[data-testid^="P"]）：存在实现前缀 P' 使 P'.startsWith(P)，
 *     或存在实现 exact E 使 E.startsWith(P)
 *
 * 实现提取范围 = packages/renderer/src + packages/core/src + packages/ui/src
 * （桌面渲染链三源；mobile-renderer 独立壳，其组件不出现在桌面 e2e 的 DOM 中，
 * 纳入会掩盖桌面悬空）。测试文件（__tests__ / *.test.ts / *.spec.ts）排除——
 * 测试桩里的 testid 不是 DOM 实现。
 *
 * 已知悬空登记（KNOWN_DANGLING）：引用已删 DOM 的历史 spec 引用，按设计 D13
 * 「悬空 e2e 随推树退役重建断言，不做修复」显式登记豁免（不静默吞）——登记项
 * 输出豁免标注但 exit 0；登记项实际恢复实现或引用消失后报 stale 要求删行
 * （防豁免永久残留，同 oe-exempt 过期恢复拦截的先例语义）。
 *
 * 用法：
 *   node scripts/check-testid-parity.mjs              # 对账仓库当前状态
 *   node scripts/check-testid-parity.mjs --root <dir> # 测试注入（fixture 树根）
 *
 * 退出码：0 对账通过 / 1 有悬空引用或 stale 登记项 / 2 输入错误（目录缺失等）
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TESTID_CHARS = "[a-zA-Z0-9_@.-]";

/**
 * 已知悬空登记表：key = testid，value = 退役条件。
 * 依据设计 D13（subagent-workflow-capability-architecture §3.3）：这些 spec 引用
 * 已删的托盘/工作区 DOM，随推树退役在 renderer 收敛波次（impl-plan u-m4 / M4-4
 * 「悬空 e2e 重建」）重建断言或删除引用 spec；届时删除对应登记行，对账器恢复拦截。
 */
const KNOWN_DANGLING = {
  "tray-workflow-row": "引用已删托盘 workflow 行 DOM（workflow-sidebar-sync / workflow-viz-overlay spec）；随推树退役在 u-m4 重建断言",
  "tray-workflow-slug": "引用已删托盘 workflow 行 DOM（workflow-sidebar-sync / workflow-viz-overlay spec）；随推树退役在 u-m4 重建断言",
  "workspace-item": "引用已删工作区切换 DOM（workspace / workspace-real spec）；随推树退役重建或删除引用 spec",
  "action-default-session": "引用已删工作区动作菜单 DOM（workspace spec）；随推树退役重建或删除引用 spec",
  "action-open-dir": "引用已删工作区动作菜单 DOM（workspace spec）；随推树退役重建或删除引用 spec",
};

// ---------- 纯函数（scripts/__tests__/check-testid-parity.test.mjs 消费） ----------

/**
 * 从源码文本提取 testid 实现。
 * 三形态：
 *   1. 静态属性 data-testid="X" → exact X（负向 lookbehind 排除 :data-testid 绑定）
 *   2. 动态模板 data-testid="`P${...}`"（含 : 绑定）→ 前缀 P（`${` 前静态段）
 *   3. 动态绑定 :data-testid="expr" 属性值内的单引号字面量 → exact（三元 / || 形态）
 * @returns {{exact: Map<string, string[]>, prefix: Map<string, string[]>}} testid → 实现文件清单
 */
export function extractImpls(path, src) {
  const exact = new Map();
  const prefix = new Map();
  const record = (map, key) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(path);
  };
  for (const m of src.matchAll(new RegExp(`(?<!:)data-testid="(${TESTID_CHARS}+)"`, "g"))) {
    record(exact, m[1]);
  }
  for (const m of src.matchAll(new RegExp(`:?data-testid="?` + "`" + `(${TESTID_CHARS}+)\\$\\{`, "g"))) {
    record(prefix, m[1]);
  }
  for (const m of src.matchAll(new RegExp(`:data-testid="([^"\`]*)"`, "g"))) {
    for (const lit of m[1].matchAll(new RegExp(`'(${TESTID_CHARS}+)'`, "g"))) record(exact, lit[1]);
  }
  return { exact, prefix };
}

/**
 * 从 e2e spec 源码提取 testid 引用。
 * 形态：[data-testid="X"] 精确 / [data-testid^="P"] 前缀 / getByTestId('X') 精确。
 */
export function extractSpecRefs(path, src) {
  const exact = new Map();
  const prefix = new Map();
  const record = (map, key) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(path);
  };
  for (const m of src.matchAll(new RegExp(`\\[data-testid="(${TESTID_CHARS}+)"\\]`, "g"))) record(exact, m[1]);
  for (const m of src.matchAll(new RegExp(`getByTestId\\(['"](${TESTID_CHARS}+)['"]\\)`, "g"))) record(exact, m[1]);
  for (const m of src.matchAll(new RegExp(`\\[data-testid\\^="(${TESTID_CHARS}+)"\\]`, "g"))) record(prefix, m[1]);
  return { exact, prefix };
}

/** 合并多个提取结果（Map 累加，value 文件清单去重保序）。 */
export function mergeExtracts(into, from) {
  for (const key of from.exact.keys()) {
    if (!into.exact.has(key)) into.exact.set(key, []);
    for (const f of from.exact.get(key)) if (!into.exact.get(key).includes(f)) into.exact.get(key).push(f);
  }
  for (const key of from.prefix.keys()) {
    if (!into.prefix.has(key)) into.prefix.set(key, []);
    for (const f of from.prefix.get(key)) if (!into.prefix.get(key).includes(f)) into.prefix.get(key).push(f);
  }
  return into;
}

/** spec 精确引用是否被实现集合覆盖（exact 命中或动态前缀产出）。 */
export function exactCovered(ref, impls) {
  return impls.exact.has(ref) || [...impls.prefix.keys()].some((p) => ref.startsWith(p));
}

/** spec 前缀引用是否被实现集合覆盖（实现前缀或实现 exact 以引用前缀开头）。 */
export function prefixCovered(refPrefix, impls) {
  return (
    [...impls.prefix.keys()].some((p) => p.startsWith(refPrefix)) ||
    [...impls.exact.keys()].some((e) => e.startsWith(refPrefix))
  );
}

/**
 * 对账核心：spec 引用 × 实现集合 → 悬空清单（豁免项分桶 + stale 豁免检出）。
 * @returns {{danglingExact: Array, danglingPrefix: Array, exempted: Array, staleExemptions: string[]}}
 */
export function parityCheck(specRefs, impls, knownDangling = {}) {
  const danglingExact = [];
  const danglingPrefix = [];
  const exempted = [];
  for (const [ref, files] of specRefs.exact) {
    if (exactCovered(ref, impls)) continue;
    if (knownDangling[ref]) exempted.push({ testid: ref, kind: "exact", files, note: knownDangling[ref] });
    else danglingExact.push({ testid: ref, files });
  }
  for (const [ref, files] of specRefs.prefix) {
    if (prefixCovered(ref, impls)) continue;
    if (knownDangling[ref]) exempted.push({ testid: ref, kind: "prefix", files, note: knownDangling[ref] });
    else danglingPrefix.push({ testid: ref, files });
  }
  // stale 豁免：登记项仍有 spec 引用但已恢复实现 → 登记行应删除（重建断言的退役
  // 形态，强制清理防豁免永久残留）。登记项的 spec 引用整个消失（spec 被删）时
  // 登记行成无害死数据，不强制——真实退役以「重建断言」为主形态。
  const stillDangling = new Set([
    ...[...specRefs.exact.keys()].filter((r) => !exactCovered(r, impls)),
    ...[...specRefs.prefix.keys()].filter((r) => !prefixCovered(r, impls)),
  ]);
  const staleExemptions = Object.keys(knownDangling).filter(
    (k) => !stillDangling.has(k) && (specRefs.exact.has(k) || specRefs.prefix.has(k)),
  );
  return { danglingExact, danglingPrefix, exempted, staleExemptions };
}

// ---------- 文件收集 ----------

/** 递归收集源码文件（.vue/.ts，排除 __tests__ / fixtures / *.test.ts / *.spec.ts / node_modules）。 */
export function collectSourceFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root).sort()) {
    if (name === "node_modules" || name === "__tests__" || name === "__fixtures__" || name === "fixtures") continue;
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collectSourceFiles(p));
    else if (/\.(vue|ts)$/.test(name) && !/\.(test|spec)\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** 收集 e2e spec 文件（*.spec.ts，递归含 visual/ 等子目录）。 */
export function collectSpecFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collectSpecFiles(p));
    else if (/\.spec\.ts$/.test(name)) out.push(p);
  }
  return out;
}

// ---------- main ----------

export function main(argv = process.argv.slice(2)) {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx !== -1 ? argv[rootIdx + 1] : ".";
  const repoRoot = (p) => join(root, p);

  const IMPL_ROOTS = ["packages/renderer/src", "packages/core/src", "packages/ui/src"];
  const SPEC_ROOTS = ["e2e"];

  const missing = IMPL_ROOTS.filter((r) => !existsSync(repoRoot(r)));
  if (missing.length > 0) {
    console.error(`[check-testid-parity] 实现源目录缺失：${missing.join(", ")}`);
    console.error(`  恢复动作：在仓库根运行本脚本（或用 --root 指向含 ${IMPL_ROOTS[0]} 的树根）`);
    return 2;
  }

  const impls = { exact: new Map(), prefix: new Map() };
  let implFileCount = 0;
  for (const r of IMPL_ROOTS) {
    for (const f of collectSourceFiles(repoRoot(r))) {
      implFileCount++;
      mergeExtracts(impls, extractImpls(f, readFileSync(f, "utf8")));
    }
  }
  const specRefs = { exact: new Map(), prefix: new Map() };
  let specFileCount = 0;
  for (const r of SPEC_ROOTS) {
    for (const f of collectSpecFiles(repoRoot(r))) {
      specFileCount++;
      const refs = extractSpecRefs(f, readFileSync(f, "utf8"));
      mergeExtracts(specRefs, { exact: refs.exact, prefix: refs.prefix });
    }
  }

  const { danglingExact, danglingPrefix, exempted, staleExemptions } = parityCheck(specRefs, impls, KNOWN_DANGLING);

  console.log(
    `[check-testid-parity] 实现：${implFileCount} 文件（exact ${impls.exact.size} / 前缀 ${impls.prefix.size}）；` +
      `spec 引用：${specFileCount} 文件（exact ${specRefs.exact.size} / 前缀 ${specRefs.prefix.size}）`,
  );

  let failed = 0;
  if (exempted.length > 0) {
    console.log(`\n已知悬空（登记豁免，${exempted.length} 项——不判红，退役条件见登记）：`);
    for (const e of exempted) console.log(`  - ${e.testid}（${e.kind}）← ${[...new Set(e.files)].join(", ")}`);
  }
  if (danglingExact.length > 0 || danglingPrefix.length > 0) {
    failed = 1;
    console.error(`\n[check-testid-parity] FAIL：spec 引用的 testid 在 renderer 实现中悬空：`);
    for (const d of danglingExact) console.error(`  - ${d.testid} ← ${[...new Set(d.files)].join(", ")}`);
    for (const d of danglingPrefix) console.error(`  - （前缀）${d.testid} ← ${[...new Set(d.files)].join(", ")}`);
    console.error("  恢复动作：在 renderer 组件补 data-testid 实现，或修正 spec 引用；确属已删 DOM 的历史 spec，");
    console.error("  在本脚本 KNOWN_DANGLING 登记表加行（带退役条件）——禁止无登记静默悬空。");
  }
  if (staleExemptions.length > 0) {
    failed = 1;
    console.error(`\n[check-testid-parity] FAIL：KNOWN_DANGLING 登记项已不再悬空，须删除登记行：`);
    for (const k of staleExemptions) console.error(`  - ${k}`);
    console.error("  恢复动作：删除 scripts/check-testid-parity.mjs 中对应 KNOWN_DANGLING 行（对账器已恢复对该项的拦截）。");
  }
  if (failed === 0) console.log("[check-testid-parity] PASS：spec testid 引用全部有实现（豁免项除外）");
  return failed;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) process.exit(main());
