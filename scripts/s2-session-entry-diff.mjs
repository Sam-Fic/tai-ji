#!/usr/bin/env node
/**
 * s2-session-entry-diff.mjs — S2 判据的会话 JSONL 条目增量白名单工具。
 *
 * 用途（设计 §4.1 S2 通过标准 / impl-plan u-m0 M0-6）：
 *   对同一会话文件的两个时点做增量 diff，按「主 session JSONL 条目类型基线清单」
 *   判定增量条目是否为白名单外类型。A2（启动即可见与宿主文件表面不变）两时点与
 *   M3-5（新派发后子会话文件无执行类 pending 条目）判据直接消费；工具本体随 u-m0
 *   交付，u-m3 波次零工具构建。
 *
 * 白名单单源（硬约束）：白名单唯一载体 = packages/shared/src/execution/
 * main-session-entry-baseline.json；本工具**运行时直读**该文件，工具侧零内嵌副本
 * （清单更新即判定口径同步更新，无第二份）。校准即改该清单本身。
 *
 * 判定语义：
 *   - 规则按声明顺序匹配，首条命中生效；
 *   - verdict=allow 且 allowIn 含当前 scope → 放行；否则违规（scope_not_allowed）；
 *   - verdict=forbid → 违规（forbidden）；
 *   - 无规则命中 → unknown（按清单 unknownPolicy 判违规：先更新清单再判定）。
 *
 * 增量算法：JSONL 追加写文件。以 entry.id 为指纹（无 id 的行用原始文本指纹），
 * before 指纹多重集扣除后剩余的 after 条目 = 增量（容忍文件被重写/重排的边界形态）。
 *
 * 退出码：0 = 增量全部放行；1 = 存在违规（forbid / scope / unknown / 畸形行）；
 * 2 = 输入错误（缺文件、清单不可读/结构非法、参数错误、自检失败）。
 *
 * 用法：
 *   node scripts/s2-session-entry-diff.mjs --before <old.jsonl> --after <new.jsonl> [--scope main|child] [--baseline <path>] [--json]
 *   node scripts/s2-session-entry-diff.mjs --self-check
 *   node scripts/s2-session-entry-diff.mjs --help
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

/** 白名单单源路径（清单本体在 shared 契约族内；prose 文档只引用该路径）。 */
export const DEFAULT_BASELINE_PATH = path.join(
  REPO_ROOT,
  "packages",
  "shared",
  "src",
  "execution",
  "main-session-entry-baseline.json",
);

const SCOPE_MAIN = "main";
const SCOPE_CHILD = "child";
const VALID_SCOPES = new Set([SCOPE_MAIN, SCOPE_CHILD]);
const MATCH_KEYS = new Set(["entryType", "customType", "customTypePrefix", "customTypeSuffix", "dataType"]);

function asArray(value) {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * dataType 推导图：部分注销类条目只带 {id, reason, status}、无 type 字段，单行无法判定
 * 域归属；用同文件所有「data.id + data.type」条目的映射补齐（before + after 一起建图，
 * 覆盖「注册在 before、注销在增量」的常态）。推导失败保持 undefined → 走 unknown。
 *
 * 通用实现（不登记任何条目类型字面量）：映射键 = data.id，值 = data.type；规则侧只声明
 * 期望的 dataType，工具不知道也不关心具体是哪个 customType。
 */
function buildDataTypeMap(lines) {
  const map = new Map();
  for (const line of lines) {
    const data = isPlainObject(line.entry) ? line.entry.data : undefined;
    if (!isPlainObject(data)) continue;
    const id = typeof data.id === "string" ? data.id : undefined;
    const type = typeof data.type === "string" ? data.type : undefined;
    if (id !== undefined && type !== undefined) map.set(id, type);
  }
  return map;
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(
      `[s2-session-entry-diff] ${label} 读取失败：${filePath}（${err instanceof Error ? err.message : String(err)}）；` +
        "恢复动作：确认路径存在且为合法 JSON（白名单单源 = packages/shared/src/execution/main-session-entry-baseline.json）",
    );
  }
}

/**
 * 结构校验（fail-closed：清单不可信时不产出绿）。
 * 返回错误清单；空数组 = 合法。
 */
export function validateBaseline(baseline) {
  const errors = [];
  if (!isPlainObject(baseline)) return ["清单根必须是对象"];
  if (typeof baseline.schemaVersion !== "number") errors.push("schemaVersion 必须是数字");
  if (!isPlainObject(baseline.categories)) errors.push("categories 必须是对象");
  if (!Array.isArray(baseline.rules) || baseline.rules.length === 0) errors.push("rules 必须是非空数组");
  if (!isPlainObject(baseline.unknownPolicy) || baseline.unknownPolicy.verdict !== "violation") {
    errors.push("unknownPolicy.verdict 必须是 violation（白名单外条目按违规处理）");
  }

  const categories = isPlainObject(baseline.categories) ? Object.keys(baseline.categories) : [];
  const seenIds = new Set();
  for (const [index, rule] of (Array.isArray(baseline.rules) ? baseline.rules : []).entries()) {
    const where = `rules[${index}]`;
    if (!isPlainObject(rule)) {
      errors.push(`${where} 必须是对象`);
      continue;
    }
    if (typeof rule.id !== "string" || !rule.id) errors.push(`${where}.id 必须是非空字符串`);
    else if (seenIds.has(rule.id)) errors.push(`${where}.id 重复：${rule.id}`);
    else seenIds.add(rule.id);
    if (!categories.includes(rule.category)) errors.push(`${where}.category 未在 categories 登记：${rule.category}`);
    if (rule.verdict !== "allow" && rule.verdict !== "forbid") errors.push(`${where}.verdict 必须是 allow/forbid`);
    if (!Array.isArray(rule.allowIn) || rule.allowIn.some((scope) => !VALID_SCOPES.has(scope))) {
      errors.push(`${where}.allowIn 必须是 main/child 数组`);
    }
    if (typeof rule.source !== "string" || !rule.source) errors.push(`${where}.source 必须是非空字符串`);
    if (typeof rule.note !== "string" || !rule.note) errors.push(`${where}.note 必须是非空字符串`);
    if (!isPlainObject(rule.match)) {
      errors.push(`${where}.match 必须是对象`);
      continue;
    }
    const matchKeys = Object.keys(rule.match).filter((key) => MATCH_KEYS.has(key));
    if (matchKeys.length === 0) errors.push(`${where}.match 至少要有一个受支持条件（${[...MATCH_KEYS].join("/")}）`);
    for (const key of Object.keys(rule.match)) {
      if (!MATCH_KEYS.has(key)) errors.push(`${where}.match.${key} 不是受支持条件`);
    }
  }
  return errors;
}

export function loadBaseline(baselinePath = DEFAULT_BASELINE_PATH) {
  const baseline = readJsonFile(baselinePath, "白名单清单");
  const errors = validateBaseline(baseline);
  if (errors.length > 0) {
    throw new Error(
      `[s2-session-entry-diff] 白名单清单结构非法（${baselinePath}）：\n  - ${errors.join("\n  - ")}\n` +
        "恢复动作：按清单头 _comment 与 scripts/s2-session-entry-diff.mjs 头注释修正清单；清单是唯一载体，禁止在工具侧补副本",
    );
  }
  return baseline;
}

/** 单行 JSONL 解析（空行跳过；畸形行保留 parseError 供判定为违规）。 */
export function parseSessionFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `[s2-session-entry-diff] 会话文件读取失败：${filePath}（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  const lines = [];
  for (const [index, raw] of text.split("\n").entries()) {
    if (raw.trim() === "") continue;
    try {
      lines.push({ lineNo: index + 1, raw, entry: JSON.parse(raw), parseError: undefined });
    } catch (err) {
      lines.push({
        lineNo: index + 1,
        raw,
        entry: undefined,
        parseError: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return lines;
}

function fingerprintOf(line) {
  if (isPlainObject(line.entry) && typeof line.entry.id === "string" && line.entry.id) {
    return `id:${line.entry.id}`;
  }
  return `raw:${line.raw}`;
}

/** 增量 = after 中扣除 before 指纹多重集后剩余的条目（保持 after 顺序）。 */
export function diffSessionLines(beforeLines, afterLines) {
  const beforeCounts = new Map();
  for (const line of beforeLines) {
    const key = fingerprintOf(line);
    beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
  }
  const increments = [];
  for (const line of afterLines) {
    const key = fingerprintOf(line);
    const remaining = beforeCounts.get(key) ?? 0;
    if (remaining > 0) {
      beforeCounts.set(key, remaining - 1);
      continue;
    }
    increments.push(line);
  }
  return increments;
}

export function entryMatchesRule(entry, rule, dataTypeById = undefined) {
  const match = rule.match ?? {};
  const entryType = isPlainObject(entry) && typeof entry.type === "string" ? entry.type : undefined;
  const expectedEntryTypes = asArray(match.entryType);
  if (expectedEntryTypes !== undefined && !expectedEntryTypes.includes(entryType)) return false;

  const customType = isPlainObject(entry) && typeof entry.customType === "string" ? entry.customType : undefined;
  if (match.customType !== undefined && customType !== match.customType) return false;
  if (match.customTypePrefix !== undefined && !(customType?.startsWith(match.customTypePrefix) ?? false)) return false;
  if (match.customTypeSuffix !== undefined && !(customType?.endsWith(match.customTypeSuffix) ?? false)) return false;

  if (match.dataType !== undefined) {
    const data = isPlainObject(entry) ? entry.data : undefined;
    let dataType = isPlainObject(data) && typeof data.type === "string" ? data.type : undefined;
    if (dataType === undefined && isPlainObject(data) && typeof data.id === "string" && dataTypeById !== undefined) {
      dataType = dataTypeById.get(data.id);
    }
    if (!(asArray(match.dataType) ?? []).includes(dataType)) return false;
  }
  return true;
}

/**
 * 分类单条条目：返回 verdict（allow/forbid/unknown）+ 命中规则 + 原因。
 * 首条匹配规则生效；forbid 或 scope 不允许都归违规。
 */
export function classifyEntry(entry, baseline, scope, dataTypeById = undefined) {
  for (const rule of baseline.rules) {
    if (!entryMatchesRule(entry, rule, dataTypeById)) continue;
    const allowedScopes = asArray(rule.allowIn) ?? [];
    if (rule.verdict === "allow" && allowedScopes.includes(scope)) {
      return { verdict: "allow", ruleId: rule.id, category: rule.category, reason: "allowed" };
    }
    if (rule.verdict === "allow") {
      return { verdict: "forbid", ruleId: rule.id, category: rule.category, reason: "scope_not_allowed" };
    }
    return { verdict: "forbid", ruleId: rule.id, category: rule.category, reason: "forbidden" };
  }
  return {
    verdict: "unknown",
    ruleId: undefined,
    category: undefined,
    reason: baseline.unknownPolicy?.reason ?? "no_rule_matched",
  };
}

function entryDigest(entry) {
  if (!isPlainObject(entry)) return { type: undefined, customType: undefined };
  return {
    type: typeof entry.type === "string" ? entry.type : undefined,
    customType: typeof entry.customType === "string" ? entry.customType : undefined,
  };
}

/** 评估两时点增量（返回结构化报告；ok=false 表示存在违规）。 */
export function evaluateSessionDiff({ beforePath, afterPath, scope, baselinePath }) {
  const baseline = loadBaseline(baselinePath);
  const beforeLines = parseSessionFile(beforePath);
  const afterLines = parseSessionFile(afterPath);
  const increments = diffSessionLines(beforeLines, afterLines);
  const dataTypeById = buildDataTypeMap([...beforeLines, ...afterLines]);
  const findings = [];
  const counts = { allow: 0, forbid: 0, unknown: 0 };

  for (const line of increments) {
    const digest = entryDigest(line.entry);
    if (line.parseError !== undefined) {
      findings.push({
        lineNo: line.lineNo,
        ...digest,
        verdict: "forbid",
        ruleId: undefined,
        category: undefined,
        reason: `malformed_line: ${line.parseError}`,
      });
      counts.forbid += 1;
      continue;
    }
    const classification = classifyEntry(line.entry, baseline, scope, dataTypeById);
    counts[classification.verdict] += 1;
    findings.push({ lineNo: line.lineNo, ...digest, ...classification });
  }

  const violations = findings.filter((finding) => finding.verdict !== "allow");
  return {
    ok: violations.length === 0,
    scope,
    baselinePath,
    beforeEntries: beforeLines.length,
    afterEntries: afterLines.length,
    incrementCount: increments.length,
    counts,
    findings,
    violations,
  };
}

function formatFinding(finding) {
  const typePart = `type=${finding.type ?? "?"}`;
  const customPart = finding.customType === undefined ? "" : ` customType=${finding.customType}`;
  const rulePart = finding.ruleId === undefined ? "rule=<none>" : `rule=${finding.ruleId}`;
  const categoryPart = finding.category === undefined ? "" : ` category=${finding.category}`;
  return `  [line ${finding.lineNo}] ${typePart}${customPart} ${rulePart}${categoryPart} reason=${finding.reason}`;
}

function printReport(report) {
  console.log(
    `[s2-session-entry-diff] scope=${report.scope} baseline=${report.baselinePath}\n` +
      `  before=${report.beforeEntries} 行 / after=${report.afterEntries} 行 / 增量=${report.incrementCount} 条\n` +
      `  allow=${report.counts.allow} forbid=${report.counts.forbid} unknown=${report.counts.unknown}`,
  );
  for (const finding of report.findings) console.log(formatFinding(finding));
  console.log(report.ok ? "[s2-session-entry-diff] PASS（增量全部在白名单内）" : `[s2-session-entry-diff] FAIL（${report.violations.length} 条违规）`);
}

function synthesizeEntryForRule(rule) {
  const match = rule.match ?? {};
  const entryType = asArray(match.entryType)?.[0];
  if (entryType === undefined) return undefined;
  if (entryType !== "custom") return { type: entryType };
  let customType;
  if (typeof match.customType === "string") customType = match.customType;
  else if (typeof match.customTypePrefix === "string") customType = `${match.customTypePrefix}__self_check__`;
  else if (typeof match.customTypeSuffix === "string") customType = `__self_check__${match.customTypeSuffix}`;
  else customType = "__self_check_custom__";
  const dataType = asArray(match.dataType)?.[0];
  return { type: "custom", customType, ...(dataType === undefined ? {} : { data: { type: dataType } }) };
}

function selfCheck(baselinePath = DEFAULT_BASELINE_PATH) {
  const failures = [];
  const check = (name, condition, detail) => {
    if (!condition) failures.push(`${name}${detail ? `：${detail}` : ""}`);
    console.log(`  [${condition ? "PASS" : "FAIL"}] ${name}${condition || !detail ? "" : ` — ${detail}`}`);
  };

  let baseline;
  try {
    baseline = loadBaseline(baselinePath);
  } catch (err) {
    console.error(`[s2-session-entry-diff] self-check 无法加载白名单清单（${baselinePath}）：${err instanceof Error ? err.message : String(err)}`);
    console.error("  恢复动作：核对清单文件存在与 JSON 结构（单源路径见 --help），或用 --baseline 指定可用清单后重跑。");
    return 2;
  }
  check("白名单清单结构合法且可运行时加载", true);

  const allowRule = baseline.rules.find(
    (rule) => rule.verdict === "allow" && rule.allowIn.includes(SCOPE_MAIN) && synthesizeEntryForRule(rule) !== undefined,
  );
  const forbidRule = baseline.rules.find(
    (rule) => rule.verdict === "forbid" && synthesizeEntryForRule(rule) !== undefined,
  );
  check("清单同时含可合成的 allow / forbid 规则", Boolean(allowRule && forbidRule));

  if (allowRule) {
    const entry = synthesizeEntryForRule(allowRule);
    const result = classifyEntry(entry, baseline, SCOPE_MAIN);
    check(`allow 规则生效（${allowRule.id}）`, result.verdict === "allow", JSON.stringify(result));
  }
  if (forbidRule) {
    const entry = synthesizeEntryForRule(forbidRule);
    const result = classifyEntry(entry, baseline, SCOPE_MAIN);
    check(`forbid 规则生效（${forbidRule.id}）`, result.verdict === "forbid", JSON.stringify(result));
  }

  const unknownEntry = { type: "custom", customType: "__s2_self_check_unknown_custom_type__" };
  check("白名单外条目判 unknown", classifyEntry(unknownEntry, baseline, SCOPE_MAIN).verdict === "unknown");

  const scopeBaseline = {
    schemaVersion: 1,
    categories: { probe: "self-check scope 探针分类" },
    unknownPolicy: { verdict: "violation" },
    rules: [
      {
        id: "self-check-scope-probe",
        match: { entryType: "custom", customType: "__s2_self_check_scope__" },
        category: "probe",
        verdict: "allow",
        allowIn: [SCOPE_MAIN],
        source: "self-check",
        note: "自检探针：main-only 放行规则",
      },
    ],
  };
  const scopeEntry = { type: "custom", customType: "__s2_self_check_scope__" };
  check("main-only 规则在主 session 放行", classifyEntry(scopeEntry, scopeBaseline, SCOPE_MAIN).verdict === "allow");
  const childScopeResult = classifyEntry(scopeEntry, scopeBaseline, SCOPE_CHILD);
  check(
    "main-only 规则在 child 判 scope_not_allowed",
    childScopeResult.verdict === "forbid" && childScopeResult.reason === "scope_not_allowed",
    JSON.stringify(childScopeResult),
  );

  const probeEntry = { type: "custom", customType: "__s2_self_check_probe__" };
  const probeBaseline = {
    schemaVersion: 1,
    categories: { probe: "self-check 探针分类" },
    unknownPolicy: { verdict: "violation" },
    rules: [
      {
        id: "self-check-probe",
        match: { entryType: "custom", customType: "__s2_self_check_probe__" },
        category: "probe",
        verdict: "allow",
        allowIn: [SCOPE_MAIN, SCOPE_CHILD],
        source: "self-check",
        note: "自检探针：证明分类由清单驱动（工具侧零内嵌副本）",
      },
    ],
  };
  check("同一探针条目在替换清单下判 allow（证明运行时读清单）", classifyEntry(probeEntry, probeBaseline, SCOPE_MAIN).verdict === "allow");
  check("同一探针条目在真实清单下判 unknown（无内嵌放行副本）", classifyEntry(probeEntry, baseline, SCOPE_MAIN).verdict === "unknown");

  if (allowRule && forbidRule) {
    const allowedEntry = synthesizeEntryForRule(allowRule);
    const forbiddenEntry = synthesizeEntryForRule(forbidRule);
    const beforeEntry = allowedEntry;
    const beforeLines = [{ lineNo: 1, raw: JSON.stringify(beforeEntry), entry: beforeEntry, parseError: undefined }];
    const afterLines = [
      ...beforeLines,
      { lineNo: 2, raw: JSON.stringify(allowedEntry), entry: allowedEntry, parseError: undefined },
      { lineNo: 3, raw: JSON.stringify(forbiddenEntry), entry: forbiddenEntry, parseError: undefined },
    ];
    const increments = diffSessionLines(beforeLines, afterLines);
    check("两时点增量算法只返回新增行", increments.length === 2, `actual=${increments.length}`);
    const verdicts = increments.map((line) => classifyEntry(line.entry, baseline, SCOPE_MAIN).verdict);
    check("增量分类按清单逐条判定", verdicts.includes("allow") && verdicts.includes("forbid"), JSON.stringify(verdicts));
  }

  const malformed = [
    { lineNo: 1, raw: "not-json", entry: undefined, parseError: "Unexpected token" },
  ];
  check("畸形行单独可判定（不作为放行）", diffSessionLines([], malformed).length === 1);

  if (failures.length > 0) {
    console.error(`[s2-session-entry-diff] self-check FAIL（${failures.length} 项）`);
    return 2;
  }
  console.log("[s2-session-entry-diff] self-check PASS");
  return 0;
}

function printHelp() {
  console.log(
    [
      "用法：",
      "  node scripts/s2-session-entry-diff.mjs --before <old.jsonl> --after <new.jsonl> [--scope main|child] [--baseline <path>] [--json]",
      "  node scripts/s2-session-entry-diff.mjs --self-check",
      "  node scripts/s2-session-entry-diff.mjs --help",
      "",
      `白名单单源：${DEFAULT_BASELINE_PATH}`,
      "退出码：0=增量全部放行 / 1=存在违规 / 2=输入错误或自检失败",
    ].join("\n"),
  );
}

const VALUE_FLAGS = new Set(["--before", "--after", "--scope", "--baseline"]);
const BOOLEAN_FLAGS = new Set(["--json", "--self-check", "--help"]);

/** 参数解析（fail-visible：未知参数 / 缺取值一律退出码 2，不静默落到默认行为）。 */
export function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--") || (!VALUE_FLAGS.has(arg) && !BOOLEAN_FLAGS.has(arg))) {
      return { values, flags, error: `未知参数：${arg}` };
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { values, flags, error: `${arg} 缺少取值` };
      values[arg] = value;
      index += 1;
    } else {
      flags.add(arg);
    }
  }
  return { values, flags, error: undefined };
}

export function main(argv) {
  if (argv.length === 0) {
    printHelp();
    return 0;
  }
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    console.error(`[s2-session-entry-diff] ${parsed.error}；恢复动作：node scripts/s2-session-entry-diff.mjs --help`);
    return 2;
  }
  if (parsed.flags.has("--help")) {
    printHelp();
    return 0;
  }
  if (parsed.flags.has("--self-check")) return selfCheck(parsed.values["--baseline"]);

  const beforePath = parsed.values["--before"];
  const afterPath = parsed.values["--after"];
  const scope = parsed.values["--scope"] ?? SCOPE_MAIN;
  const baselinePath = parsed.values["--baseline"] ?? DEFAULT_BASELINE_PATH;

  if (!beforePath || !afterPath) {
    console.error("[s2-session-entry-diff] 缺少 --before / --after；恢复动作：node scripts/s2-session-entry-diff.mjs --help");
    return 2;
  }
  if (!VALID_SCOPES.has(scope)) {
    console.error(`[s2-session-entry-diff] --scope 非法：${scope}；恢复动作：用 main 或 child`);
    return 2;
  }

  let report;
  try {
    report = evaluateSessionDiff({ beforePath, afterPath, scope, baselinePath });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  if (parsed.flags.has("--json")) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  return report.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
