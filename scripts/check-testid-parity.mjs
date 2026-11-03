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
 *   - spec 精确引用（[data-testid="X"] / getByTestId('X'|`X`)）：实现 exact 集含 X，
 *     或存在实现前缀 P 使 X.startsWith(P)（动态模板 `P${...}` 产出的族）
 *   - spec 前缀引用（[data-testid^="P"] / getByTestId(`P${...}`) / getByTestId(/^P...)）：
 *     存在实现前缀 P' 使 P'.startsWith(P)，或存在实现 exact E 使 E.startsWith(P)
 *   - 不可检测形态：getByTestId(变量)——引用目标运行时才确定，静态对账无法归属
 *     （现网实例 e2e/search-modal.spec.ts 的 opts.settleScopeTestId）。该形态不计入
 *     引用集、也不判红，其实现存在性由 spec 内的变量来源自行保证。
 *
 * 实现提取范围 = packages/renderer/src + packages/core/src + packages/ui/src +
 * packages/dom-core/src（桌面渲染链四源；mobile-renderer 独立壳，其组件不出现在
 * 桌面 e2e 的 DOM 中，纳入会掩盖桌面悬空）。**新增渲染链包（renderer 直接消费且
 * 产出 DOM）必须同步本段与 main 的 IMPL_ROOTS**——漏收的包其真实实现会被判悬空
 * （dom-core 曾漏收）。实现提取前剥注释（行注释 / 块注释 / 模板注释）——注释文本
 * 不是 DOM 实现。测试文件（__tests__ / *.test.ts / *.spec.ts）排除——测试桩里的
 * testid 不是 DOM 实现。
 *
 * 已知悬空登记（KNOWN_DANGLING）：引用已删 DOM 的历史 spec 引用，按设计 D13
 * 「悬空 e2e 随推树退役重建断言，不做修复」显式登记豁免（不静默吞）——登记项
 * 输出豁免标注但 exit 0；登记项恢复实现且 spec 引用仍在时报 stale 要求删行
 * （防豁免永久残留，同 oe-exempt 过期恢复拦截的先例语义）；spec 引用整个消失
 * （spec 被删）= 死登记，不强制清理——真实退役以重建断言为主形态。
 *
 * 用法：
 *   node scripts/check-testid-parity.mjs              # 对账仓库当前状态
 *   node scripts/check-testid-parity.mjs --root <dir> # 测试注入（fixture 树根）
 *
 * 退出码：0 对账通过 / 1 有悬空引用或 stale 登记项 / 2 输入错误（目录缺失、e2e 零 spec 等）
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TESTID_CHARS = "[a-zA-Z0-9_@.-]";

/**
 * 已知悬空登记表：key = testid，value = 退役条件。
 * 依据设计 D13（subagent-workflow-capability-architecture §3.3）：这些 spec 引用
 * 已删的托盘/工作区 DOM，随推树退役在 renderer 收敛波次（impl-plan u-m4 / M4-4
 * 「悬空 e2e 重建」）重建断言或删除引用 spec；届时删除对应登记行，对账器恢复拦截。
 */
const KNOWN_DANGLING = {
  // 原引用方 workflow-sidebar-sync / workflow-viz-overlay 两 mock spec 已随 tray-panel-interact
  // 交付删除（mock 层托盘 widget 区结构性不可达，证据链见 e2e-map E2E-MOCK-01 note）；
  // 协议 widget 行形态的重建位 = e2e/tray-entry-real.spec.ts（E2E-REAL-01），testid 不同源，
  // 两登记行保留为死登记（脚本头注约定：spec 整体删除 = 死登记不强制清理）。
  "tray-workflow-row": "引用已删托盘 workflow 行 DOM（原 workflow-sidebar-sync / workflow-viz-overlay spec，两 spec 已删）；协议 widget 行形态现由 e2e/tray-entry-real.spec.ts（E2E-REAL-01）承载，testid 不同源",
  "tray-workflow-slug": "引用已删托盘 workflow 行 DOM（原 workflow-sidebar-sync / workflow-viz-overlay spec，两 spec 已删）；协议 widget 行形态现由 e2e/tray-entry-real.spec.ts（E2E-REAL-01）承载，testid 不同源",
  "workspace-item": "引用已删工作区切换 DOM（workspace / workspace-real spec）；随推树退役重建或删除引用 spec",
  "action-default-session": "引用已删工作区动作菜单 DOM（workspace spec）；随推树退役重建或删除引用 spec",
  "action-open-dir": "引用已删工作区动作菜单 DOM（workspace spec）；随推树退役重建或删除引用 spec",
};

// ---------- 纯函数（scripts/__tests__/check-testid-parity.test.mjs 消费） ----------

/**
 * 剥去三类注释（模板注释 / 块注释 / 行注释），注释文本不是 DOM 实现。
 * 现网反例：PresetChip.vue 的 JSDoc 写了 `data-testid="preset-chip-replace-badge"`，
 * 真实现在模板里；不剥注释时 JSDoc 一行就足以让该 testid 判为「有实现」，模板实现
 * 被删也不报悬空（漏报）。行注释形态用负向 lookbehind 守卫，排除 `http://` 这类协议串。
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<![:\w])\/\/[^\n]*/g, "");
}

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
  const code = stripComments(src);
  for (const m of code.matchAll(new RegExp(`(?<!:)data-testid="(${TESTID_CHARS}+)"`, "g"))) {
    record(exact, m[1]);
  }
  for (const m of code.matchAll(new RegExp(`:?data-testid="?` + "`" + `(${TESTID_CHARS}+)\\$\\{`, "g"))) {
    record(prefix, m[1]);
  }
  for (const m of code.matchAll(new RegExp(`:data-testid="([^"\`]*)"`, "g"))) {
    for (const lit of m[1].matchAll(new RegExp(`'(${TESTID_CHARS}+)'`, "g"))) record(exact, lit[1]);
  }
  return { exact, prefix };
}

/** 正则字面量可提取的静态前缀：仅接受 `^` 锚定形态（未锚定 = 子串匹配，无前缀语义），
 *  取到首个正则元字符前的字面段；无可提取字面前缀时返回空串（不记账）。 */
function regexLiteralPrefix(body) {
  if (!body.startsWith("^")) return "";
  let out = "";
  for (const ch of body.slice(1)) {
    if ("\\.+*?()[]{}|^$".includes(ch)) break;
    out += ch;
  }
  return out;
}

/**
 * 从 e2e spec 源码提取 testid 引用。
 * 形态：[data-testid="X"] 精确 / [data-testid^="P"] 前缀 / getByTestId('X'|`X`) 精确 /
 * getByTestId(`P${...}`) 模板前缀 / getByTestId(/^P.../) 正则前缀。
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
  // 无插值模板字面量 = 静态字面量（getByTestId(`X`) 语义等同 'X'）
  for (const m of src.matchAll(new RegExp("getByTestId\\(\\s*`(" + TESTID_CHARS + "+)`\\s*\\)", "g"))) record(exact, m[1]);
  // 含插值模板字面量 → `${` 前静态段进前缀桶（与实现侧动态模板前缀同思路）
  for (const m of src.matchAll(new RegExp("getByTestId\\(\\s*`(" + TESTID_CHARS + "+)\\$\\{", "g"))) record(prefix, m[1]);
  // 正则字面量 → 锚定后首个元字符前的字面前缀
  for (const m of src.matchAll(/getByTestId\(\s*\/((?:\\.|\[[^\]]*\]|[^/\\\n])+)\/[gimsuy]*\s*\)/g)) {
    const p = regexLiteralPrefix(m[1]);
    if (p) record(prefix, p);
  }
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

// main 职责拆两段：collectExtracts = 实现面与 spec 引用面共用的参数化收集壳
// （遍历 roots 逐文件跑 extract 并合并）；renderParityResult = 对账结果渲染与退出码
// （豁免登记打印、悬空/stale 两类 FAIL 输出、进程退出码裁决）。

/** [main 拆分] 遍历 roots 收集 testid 提取结果（实现面与 spec 引用面共用一壳）。
 *  extract(f, src) 返回 { exact, prefix }；返回 { extracts, fileCount }。 */
function collectExtracts(roots, listFiles, extract, repoRoot) {
  const extracts = { exact: new Map(), prefix: new Map() };
  let fileCount = 0;
  for (const r of roots) {
    for (const f of listFiles(repoRoot(r))) {
      fileCount++;
      mergeExtracts(extracts, extract(f, readFileSync(f, "utf8")));
    }
  }
  return { extracts, fileCount };
}

/** [main 拆分] 对账结果渲染与退出码：豁免登记打印、悬空/stale 两类 FAIL 输出。 */
function renderParityResult({ danglingExact, danglingPrefix, exempted, staleExemptions }) {
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

export function main(argv = process.argv.slice(2)) {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx !== -1 ? argv[rootIdx + 1] : ".";
  const repoRoot = (p) => join(root, p);

  const IMPL_ROOTS = ["packages/renderer/src", "packages/core/src", "packages/ui/src", "packages/dom-core/src"];
  const SPEC_ROOTS = ["e2e"];

  const missing = IMPL_ROOTS.filter((r) => !existsSync(repoRoot(r)));
  if (missing.length > 0) {
    console.error(`[check-testid-parity] 实现源目录缺失：${missing.join(", ")}`);
    console.error(`  恢复动作：在仓库根运行本脚本（或用 --root 指向含 ${IMPL_ROOTS[0]} 的树根）`);
    return 2;
  }

  // e2e 目录缺失不拦截会 fail-open：collectSpecFiles 静默返回空集，对账零命中恒 PASS
  const missingSpecRoots = SPEC_ROOTS.filter((r) => !existsSync(repoRoot(r)));
  if (missingSpecRoots.length > 0) {
    console.error(`[check-testid-parity] e2e spec 目录缺失：${missingSpecRoots.join(", ")}`);
    console.error(`  恢复动作：在仓库根运行本脚本（或用 --root 指向含 ${SPEC_ROOTS[0]}/ 的树根）`);
    return 2;
  }

  const { extracts: impls, fileCount: implFileCount } = collectExtracts(IMPL_ROOTS, collectSourceFiles, extractImpls, repoRoot);
  const { extracts: specRefs, fileCount: specFileCount } = collectExtracts(SPEC_ROOTS, collectSpecFiles, extractSpecRefs, repoRoot);

  // 目录存在但零 spec 文件与目录缺失同为 fail-open：对账零命中恒 PASS。按输入错误拦截
  if (specFileCount === 0) {
    console.error(`[check-testid-parity] e2e spec 目录下无 *.spec.ts 文件：${SPEC_ROOTS.join(", ")}`);
    console.error("  恢复动作：确认 e2e 测试文件已随分支提交（或用 --root 指向含 e2e/*.spec.ts 的树根）——");
    console.error("  零 spec 时对账恒 PASS 属 fail-open，不能当作通过。");
    return 2;
  }

  const result = parityCheck(specRefs, impls, KNOWN_DANGLING);

  console.log(
    `[check-testid-parity] 实现：${implFileCount} 文件（exact ${impls.exact.size} / 前缀 ${impls.prefix.size}）；` +
      `spec 引用：${specFileCount} 文件（exact ${specRefs.exact.size} / 前缀 ${specRefs.prefix.size}）`,
  );
  return renderParityResult(result);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(join(process.argv[1])).href;
if (isMain) process.exit(main());
