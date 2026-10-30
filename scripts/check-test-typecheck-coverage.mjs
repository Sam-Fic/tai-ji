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
 *
 * 临时 tsconfig 全绝对路径形态写 mkdtemp 目录（相对 include/paths 在 /tmp 下解析
 * 落空），跑完整目录删除，不留工作区。
 *
 * 用法：node scripts/check-test-typecheck-coverage.mjs [--renderer-dir <dir>]
 *   --renderer-dir 默认 packages/renderer（相对仓库根）；测试注入用
 *
 * 退出码：0 对账通过 / 1 对账失败（新债务 / stale / 正式跑红 / include 形态回退）
 *         2 输入错误（目录缺失、tsconfig 解析失败）
 *
 * 跳过真实 vue-tsc 双跑（单测/无依赖环境）：--no-run 开关只跑静态对账（1/2 项），
 * CI 与本地全量校验必须真跑（默认形态），--no-run 仅供脚本自身单测复用纯函数链。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));

  const failures = [];

  // 1. include 全量形态断言
  const missingForms = missingIncludeForms(tsconfig.include);
  if (missingForms.length > 0) {
    failures.push(`include 缺全量形态（新测试文件将漏出 typecheck）：${missingForms.join(", ")}`);
  }

  // 2. exclude ⊆ 磁盘测试文件集
  const diskTests = collectTestFiles(join(rendererDir, "src"), rendererDir);
  const diskSet = new Set(diskTests);
  const deadExcludes = (tsconfig.exclude ?? []).filter((f) => !diskSet.has(f));
  if (deadExcludes.length > 0) {
    failures.push(`exclude 含非测试文件/死路径（须删除）：${deadExcludes.join(", ")}`);
  }

  // 3. 双跑对账（--no-run 跳过，仅供单测复用纯函数链）
  if (!noRun) {
    const formalRun = runVueTsc(rendererDir, tsconfigPath);
    if (formalRun.status !== 0) {
      failures.push("正式 typecheck:test（exclude 生效）跑红——新登记外文件存在类型错误：");
      failures.push(...formalRun.stdout.split("\n").filter((l) => l.includes("error TS")).slice(0, 20));
    }
    const tmpDir = mkdtempSync(join(tmpdir(), "test-typecheck-full-"));
    try {
      const fullTsconfig = buildFullTsconfig(tsconfigPath, tmpDir);
      const fullRun = runVueTsc(rendererDir, fullTsconfig);
      const errorFiles = parseErrorFiles(fullRun.stdout);
      const { unregistered, stale } = reconcileDebt(errorFiles, tsconfig.exclude ?? []);
      if (unregistered.length > 0) {
        failures.push(`未登记债务（全量跑有错但不在 exclude，须修复或显式登记）：${unregistered.join(", ")}`);
      }
      if (stale.length > 0) {
        failures.push(`stale 债务登记（已无类型错误，须从 tsconfig exclude 删行收编）：${stale.join(", ")}`);
      }
      console.log(
        `[check-test-typecheck-coverage] 全量跑：${errorFiles.length} 文件有类型错误 / exclude 登记 ${(tsconfig.exclude ?? []).length} 项 / 磁盘测试文件 ${diskTests.length} 个`,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  console.log(
    `[check-test-typecheck-coverage] include 形态${missingForms.length === 0 ? "OK" : "FAIL"}；` +
      `exclude 死路径 ${deadExcludes.length} 项；磁盘测试文件 ${diskTests.length} 个（未 exclude = 受检 ${diskTests.length - (tsconfig.exclude ?? []).length} 个）`,
  );

  if (failures.length > 0) {
    console.error(`\n[check-test-typecheck-coverage] FAIL：`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error("  恢复动作：新类型错误当场修复（不得放宽断言）；确属暂缓的存量债务，在");
    console.error("  packages/renderer/tsconfig.typecheck-test.json 的 exclude 显式登记；已修复的从 exclude 删行收编。");
    return 1;
  }
  console.log("[check-test-typecheck-coverage] PASS：include 全量、债务对账一致、正式跑绿");
  return 0;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) process.exit(main());
