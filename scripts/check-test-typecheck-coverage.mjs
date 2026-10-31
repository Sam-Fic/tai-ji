#!/usr/bin/env node
/**
 * check-test-typecheck-coverage.mjs — renderer 测试 typecheck 覆盖对账检查
 *
 * 红灯③「renderer 测试文件纳入 typecheck」（设计 D13 / impl-plan u-foundation F1-③）
 的机器对账形态：tsconfig.typecheck-test.json include 全量化（新测试文件自动受检）
 + exclude = 显式存量债务清单（带错测试文件暂缓、逐个修复后收编）。
 *
 * 本检查三项对账（防登记表腐烂）：
 *   1. include 形态断言：必须含全量四形态（__tests__ 目录 / *.test.ts / *.test.tsx /
 *      *.spec.ts）——防改回逐文件白名单（新文件漏网的原始缺口复发）
 *   2. exclude（债务清单）⊆ 磁盘测试文件集——exclude 只能列真实测试文件（防死路径）
 *   3. 双跑对账（核心）：
 *      a. 正式跑（exclude 生效）必须绿——新文件类型错即红（不在 exclude = 直接受检）
 *      b. 全量跑（临时 tsconfig 清空 exclude）取有错文件集 E：
 *         E \ exclude → 未登记的新债务（存量文件新增类型错 / exclude 漏登记）→ 红
 *         exclude \ E → stale（该文件已可收编）→ 红，要求从 exclude 删行收编
 *      ——债务只减不增：收编有强制信号，新增债务必须显式登记（登记时即知是债）
 *   4. 基础设施故障隔离（正式跑与全量跑同一判据 classifyRun）：跑非零退出且零可
 *      解析错误 = vue-tsc 崩溃 / spawn 失败 / 配置错（不是零类型错误）→ 打印原始
 *      输出并按独立失败类别红掉，不进入 exclude 债务归因——防止把基础设施故障误判
 *      成全部 exclude 可收编（照 stale 指引删行会把真实债务纳回正式跑变红），也防止
 *      把 spawn 失败报成「新登记外文件存在类型错误」而输出零证据
 *
 * 临时 tsconfig 全绝对路径形态写 mkdtemp 目录（相对 include/paths 在 /tmp 下解析
 * 落空），跑完整目录删除，不留工作区。
 *
 * 用法：node scripts/check-test-typecheck-coverage.mjs [--renderer-dir <dir>]
 *   --renderer-dir 默认 packages/renderer（相对仓库根）；测试注入用
 *
 * 退出码：0 对账通过 / 1 对账失败（新债务 / stale / 正式跑红 / include 形态回退 /
 *         正式跑或全量跑基础设施故障）
 *         2 输入错误（目录缺失、tsconfig 解析失败）
 *
 * 跳过真实 vue-tsc 双跑（单测/无依赖环境）：--no-run 开关只跑静态对账（1/2 项），
 * CI 与本地全量校验必须真跑（默认形态），--no-run 仅供脚本自身单测复用纯函数链。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/** include 必须包含的全量四形态（与主 tsconfig 的 exclude 形态互补对齐）。 */
export const REQUIRED_INCLUDE_FORMS = [
  "src/**/__tests__/**/*",
  "src/**/*.test.ts",
  "src/**/*.test.tsx",
  "src/**/*.spec.ts",
];

// ---------- 纯函数（scripts/__tests__/check-test-typecheck-coverage.test.mjs 消费） ----------

/** 断言 tsconfig include 含全量四形态，返回缺失形态清单（空 = 通过）。 */
export function missingIncludeForms(include) {
  return REQUIRED_INCLUDE_FORMS.filter((f) => !include?.includes(f));
}

/** 判定文件是否测试文件（__tests__ 目录内 .ts，或 *.test.ts / *.spec.ts）。
 *  与 include 形态对齐（.d.ts 声明文件不算测试文件）。 */
export function isTestFile(relPath) {
  if (relPath.endsWith(".d.ts")) return false;
  if (/\.test\.tsx?$/.test(relPath) || /\.spec\.ts$/.test(relPath)) return true;
  return /(^|\/)__tests__\/.*\.ts$/.test(relPath) && !relPath.endsWith(".d.ts");
}

/** 递归收集目录下（相对该目录）的全部测试文件。
 *  baseDir 指定相对路径基准（rootDir 递归下钻、baseDir 决定 rel 前缀——
 *  收集 src/ 时传 rendererDir 作 baseDir，rel 才保留 src/ 前缀与 exclude 对齐）。 */
export function collectTestFiles(rootDir, baseDir, out = []) {
  for (const name of readdirSync(rootDir).sort()) {
    if (name === "node_modules") continue;
    const p = join(rootDir, name);
    const st = statSync(p);
    if (st.isDirectory()) collectTestFiles(p, baseDir, out);
    else {
      const rel = p.slice(baseDir.length + 1);
      if (isTestFile(rel)) out.push(rel);
    }
  }
  return out;
}

/** 从 tsc/vue-tsc 输出解析「有错文件集」（相对 packages/renderer 的 src/... 路径）。
 *  只收 renderer 包内文件：被测试 import 的他包源文件（如 ../subagent-core）错误
 *  归因于引用它的测试文件——正式跑（exclude 生效）时该 import 链不存在即绿，
 *  链存在且未登记时由「正式跑必须绿」兜住，此处不重复计账。 */
export function parseErrorFiles(output) {
  const files = new Set();
  for (const m of output.matchAll(/^(src\/\S+\.(?:ts|tsx|vue))\(\d+,\d+\): error TS/gm)) files.add(m[1]);
  return [...files].sort();
}

/** 债务对账：返回 {unregistered, stale}（两者皆空 = 通过）。
 *  unregistered = 全量跑有错但不在 exclude 的新债务；stale = exclude 内已无错可收编项。 */
export function reconcileDebt(errorFiles, excludeList) {
  const errSet = new Set(errorFiles);
  const exSet = new Set(excludeList);
  return {
    unregistered: errorFiles.filter((f) => !exSet.has(f)),
    stale: excludeList.filter((f) => !errSet.has(f)),
  };
}

/** 给一次 vue-tsc 跑的结果分级（正式跑与全量跑共用同一判据）：
 *  - ok：零退出
 *  - infra：非零退出且零可解析类型错误 = vue-tsc 崩溃 / spawn 失败（如 pnpm ENOENT）/
 *    配置错——不是类型错误，明细取原始输出前 10 行（此时过滤 `error TS` 会剩空证据）
 *  - type-error：非零退出且有可解析类型错误，明细只取含 `error TS` 的行 */
export function classifyRun(run) {
  if (run.status === 0) return { kind: "ok", errorFiles: [], detailLines: [] };
  const errorFiles = parseErrorFiles(run.stdout);
  const lines = run.stdout.split("\n");
  if (errorFiles.length === 0) {
    return { kind: "infra", errorFiles, detailLines: lines.filter((l) => l.trim()).slice(0, 10) };
  }
  return {
    kind: "type-error",
    errorFiles,
    detailLines: lines.filter((l) => l.includes("error TS")).slice(0, 20),
  };
}

// ---------- main ----------

function runVueTsc(rendererDir, tsconfigPath) {
  // pnpm --filter 经 workspace 定位 renderer 包（node_modules/.bin 提升形态，同 CI 步骤口径）
  const cwd = rendererDir;
  try {
    return {
      status: 0,
      stdout: execFileSync("pnpm", ["exec", "vue-tsc", "--noEmit", "-p", tsconfigPath], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (err) {
    return { status: err.status ?? 1, stdout: String(err.stdout ?? "") + String(err.stderr ?? "") };
  }
}

/** 构造全量临时 tsconfig（extends 正式 tsconfig、exclude 清空、include/paths 绝对化），
 *  返回临时文件路径（调用方负责删除临时目录）。 */
export function buildFullTsconfig(formalTsconfigPath, tmpDir) {
  const formal = JSON.parse(readFileSync(formalTsconfigPath, "utf8"));
  const rendererDir = dirname(formalTsconfigPath);
  const abs = (p) => (isAbsolute(p) ? p : join(rendererDir, p));
  const full = {
    extends: formalTsconfigPath,
    compilerOptions: {
      ...formal.compilerOptions,
      paths: Object.fromEntries(
        Object.entries(formal.compilerOptions?.paths ?? {}).map(([k, v]) => [k, v.map(abs)]),
      ),
    },
    include: (formal.include ?? []).map(abs),
    exclude: [],
  };
  // extends 之上的同键覆盖已含 noEmit 等；exclude 清空 = 全量形态
  const tmpPath = join(tmpDir, "tsconfig.typecheck-test.full.json");
  writeFileSync(tmpPath, JSON.stringify(full, null, 2));
  return tmpPath;
}

// main 职责拆两段：staticChecks = include 形态与 exclude 死路径静态对账；
// runDebtReconciliation = 双跑债务对账（tsconfig exclude 集 ↔ 全量错误集双向一致）。

/** [main 拆分] 静态对账（第 1/2 项）：include 全量形态断言 + exclude ⊆ 磁盘测试文件集。
 *  失败明细推入 failures；返回 { failures, missingForms, deadExcludes, diskTests } 供 main 汇总输出。 */
function staticChecks(tsconfig, rendererDir) {
  const failures = [];
  const missingForms = missingIncludeForms(tsconfig.include);
  if (missingForms.length > 0) {
    failures.push(`include 缺全量形态（新测试文件将漏出 typecheck）：${missingForms.join(", ")}`);
  }
  const diskTests = collectTestFiles(join(rendererDir, "src"), rendererDir);
  const diskSet = new Set(diskTests);
  const deadExcludes = (tsconfig.exclude ?? []).filter((f) => !diskSet.has(f));
  if (deadExcludes.length > 0) {
    failures.push(`exclude 含非测试文件/死路径（须删除）：${deadExcludes.join(", ")}`);
  }
  return { failures, missingForms, deadExcludes, diskTests };
}

/** [main 拆分] 双跑对账（第 3 项）：正式跑（exclude 生效）必须绿 + 全量跑债务对账。
 *  失败明细推入 failures；返回 { formalInfra, infraFailure, debtFindings, errorCount,
 *  excludeCount } 供 main 汇总行与恢复指引分流（infraFailure = 全量跑基础设施故障、
 *  债务对账已跳过）；临时目录必清（finally）。run 参数仅测试注入用法。 */
export function runDebtReconciliation(rendererDir, tsconfigPath, tsconfig, failures, run = runVueTsc) {
  // 正式跑错误分级与全量跑同一判据（头注释第 4 项）：零可解析错误 = 基础设施故障，
  // 不得归因为「新登记外文件存在类型错误」——否则明细零证据、恢复指引把人导向
  // exclude 登记（exclude 是债务清单，不是基础设施故障的处置手段）。
  const formal = classifyRun(run(rendererDir, tsconfigPath));
  if (formal.kind === "infra") {
    failures.push("typecheck 基础设施故障：正式 typecheck:test（exclude 生效）未产出可解析结果（spawn 失败 / vue-tsc 崩溃 / 配置错）：");
    failures.push(...formal.detailLines);
  } else if (formal.kind === "type-error") {
    failures.push("正式 typecheck:test（exclude 生效）跑红——新登记外文件存在类型错误：");
    failures.push(...formal.detailLines);
  }
  const debtFindings = formal.kind === "type-error" ? 1 : 0;
  const tmpDir = mkdtempSync(join(tmpdir(), "test-typecheck-full-"));
  try {
    const fullTsconfig = buildFullTsconfig(tsconfigPath, tmpDir);
    const full = classifyRun(run(rendererDir, fullTsconfig));
    const errorFiles = full.errorFiles;
    // 全量跑非零退出且零可解析错误 = vue-tsc 基础设施故障（崩溃 / 配置错），
    // 不能当零类型错误对账——否则全部 exclude 误判 stale，照指引删行会把真实
    // 债务纳回正式跑变红。按独立失败类别红掉，债务对账跳过（头注释第 4 项）。
    if (full.kind === "infra") {
      failures.push("全量跑未产出可解析结果（疑似 vue-tsc 基础设施故障），债务对账跳过：");
      failures.push(...full.detailLines);
      return {
        formalInfra: formal.kind === "infra",
        infraFailure: true,
        debtFindings,
        excludeCount: (tsconfig.exclude ?? []).length,
      };
    }
    const { unregistered, stale } = reconcileDebt(errorFiles, tsconfig.exclude ?? []);
    if (unregistered.length > 0) {
      failures.push(`未登记债务（全量跑有错但不在 exclude，须修复或显式登记）：${unregistered.join(", ")}`);
    }
    if (stale.length > 0) {
      failures.push(`stale 债务登记（已无类型错误，须从 tsconfig exclude 删行收编）：${stale.join(", ")}`);
    }
    return {
      formalInfra: formal.kind === "infra",
      infraFailure: false,
      debtFindings: debtFindings + unregistered.length + stale.length,
      errorCount: errorFiles.length,
      excludeCount: (tsconfig.exclude ?? []).length,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2)) {
  const rendererRel = argv.includes("--renderer-dir") ? argv[argv.indexOf("--renderer-dir") + 1] : "packages/renderer";
  const noRun = argv.includes("--no-run");
  const rendererDir = resolve(REPO_ROOT, rendererRel);
  const tsconfigPath = join(rendererDir, "tsconfig.typecheck-test.json");

  if (!existsSync(tsconfigPath)) {
    console.error(`[check-test-typecheck-coverage] tsconfig 缺失：${tsconfigPath}`);
    console.error("  恢复动作：确认在仓库根运行，或用 --renderer-dir 指向 renderer 包目录");
    return 2;
  }
  const srcDir = join(rendererDir, "src");
  if (!existsSync(srcDir)) {
    console.error(`[check-test-typecheck-coverage] renderer src 目录缺失：${srcDir}`);
    console.error("  恢复动作：确认在仓库根运行，或用 --renderer-dir 指向含 src/ 的 renderer 包目录");
    return 2;
  }
  let tsconfig;
  try {
    tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
  } catch (err) {
    console.error(`[check-test-typecheck-coverage] tsconfig 解析失败：${err instanceof Error ? err.message : String(err)}`);
    console.error("  恢复动作：修复 tsconfig.typecheck-test.json 的 JSON 语法错误（误删/改坏时按 git 历史恢复）");
    return 2;
  }

  const { failures, missingForms, deadExcludes, diskTests } = staticChecks(tsconfig, rendererDir);

  // 3. 双跑对账（--no-run 跳过，仅供单测复用纯函数链）
  let debt = null;
  if (!noRun) {
    debt = runDebtReconciliation(rendererDir, tsconfigPath, tsconfig, failures);
    const fullRunSummary = debt.infraFailure
      ? "债务对账跳过（全量跑基础设施故障，先按上方 vue-tsc 原始输出归因）"
      : `${debt.errorCount} 文件有类型错误`;
    console.log(
      `[check-test-typecheck-coverage] 全量跑：${fullRunSummary} / exclude 登记 ${debt.excludeCount} 项 / 磁盘测试文件 ${diskTests.length} 个`,
    );
  }

  console.log(
    `[check-test-typecheck-coverage] include 形态${missingForms.length === 0 ? "OK" : "FAIL"}；` +
      `exclude 死路径 ${deadExcludes.length} 项；磁盘测试文件 ${diskTests.length} 个（未 exclude = 受检 ${diskTests.length - (tsconfig.exclude ?? []).length} 个）`,
  );

  if (failures.length > 0) {
    console.error(`\n[check-test-typecheck-coverage] FAIL：`);
    for (const f of failures) console.error(`  - ${f}`);
    // 恢复指引按失败类别分流：基础设施故障不得把人导向 exclude 登记
    // （exclude 是债务清单，登记不解决 vue-tsc 崩溃 / spawn 失败 / 配置错）。
    if (debt?.formalInfra || debt?.infraFailure) {
      console.error("  恢复动作（基础设施故障）：按上方 vue-tsc 原始输出归因——确认 pnpm exec vue-tsc");
      console.error("  可执行、tsconfig 可解析；这类失败与类型错误无关，不得靠 exclude 登记绕过。");
    }
    if (debt === null || debt.debtFindings > 0 || missingForms.length > 0 || deadExcludes.length > 0) {
      console.error("  恢复动作：新类型错误当场修复（不得放宽断言）；确属暂缓的存量债务，在");
      console.error("  packages/renderer/tsconfig.typecheck-test.json 的 exclude 显式登记；已修复的从 exclude 删行收编。");
    }
    return 1;
  }
  console.log("[check-test-typecheck-coverage] PASS：include 全量、债务对账一致、正式跑绿");
  return 0;
}

// pathToFileURL 而非 `new URL(`file://${argv[1]}`)`：后者把路径里的 # / ? 当 URL
// 片段 / 查询分隔符，href 与 import.meta.url 不等 → 脚本静默空转 exit 0。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(join(process.argv[1])).href;
if (isMain) process.exit(main());
