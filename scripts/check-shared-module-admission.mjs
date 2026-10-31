#!/usr/bin/env node
/**
 * check-shared-module-admission.mjs — @taiji/shared 模块准入机器检查
 *
 * 红灯配套（设计 D14 / impl-plan u-foundation F3）：「@taiji/shared 立模块准入
 * 规则 + 机器检查」。shared 是全部 workspace 包的最底层数据源：package.json 只允许
 * 登记 ALLOWED_WORKSPACE_DEPS 内的两个已发布契约包（@zhushanwen/extension-protocol、
 * @zhushanwen/subagent-engine-sdk——两者自身不依赖 shared，方向 private → 已发布），
 * 其余 workspace 依赖一律不许。最大的退化风险 = 垃圾抽屉化（什么都往里塞）。本检查
 * 把准入规则中可机械核验的部分红灯化。
 *
 * ── 准入规则（成文判据，新增模块进 packages/shared/src/ 前逐条核对）──────────
 *
 * 1. 跨包契约：模块的消费方 ≥ 2 个包，或虽当前单消费方但属跨进程 / 跨包契约的
 *    单一权威形状（如 IPC 载荷、路径公式——契约两端在进程/包两侧）。单包实现
 *    细节、仅一个包使用的工具函数不得进 shared（放该包内部）。
 * 2. 依赖方向：shared 源码不 import ALLOWED_WORKSPACE_DEPS 之外的任何 workspace 包
 *    （@taiji/* 与 @zhushanwen/* 同判据——shared 必须保持依赖图最底层，上层才允许
 *    向下依赖）、不使用跨包相对路径 import（规则 2 的豁免表在脚本内，附方向依据）。
 * 3. 纯模块形态：只允许 类型 / 常量 / 纯函数 / 数据清单（JSON）/ 纯函数配置
 *    （tailwind preset）。禁 node 内置模块（C-state-05 唯一判据：node:path /
 *    node:url / node:os 等「纯计算」内置同样在禁列，裸名 fs / fs/promises 与 node:
 *    前缀同判据；判据数据 = scripts/shared-node-builtin-rules.json，与 pre-commit 的
 *    .githooks/check_shared_node_builtin.py 共用同一份，两条检查同源）；禁止 UI
 *    组件；禁止可变全局态。
 * 4. 登记完备：每个模块（src 顶层文件 + 一级子目录目录级条目）必须在
 *    scripts/shared-module-registry.json 登记 purpose（一句话跨包理由）——登记动作
 *    即准入声明，新模块 PR 由 reviewer 按上述 1-3 卡点（消费广度与契约属性是语义
 *    判定，机器不冒充）。
 *
 * ── 机器检查项（本脚本）────────────────────────────────────────────────
 *
 *   A. 依赖方向：src 内（排除 __tests__）零 ALLOWED_WORKSPACE_DEPS 之外的 workspace
 *      import、零跨包相对 import
 *   B. node 内置禁令：src 内（排除 __tests__）零 node 内置 import；名单与存量白名单
 *      见 scripts/shared-node-builtin-rules.json（C-state-05 唯一判据，与 .githooks/
 *      check_shared_node_builtin.py 同源）
 *   C. 登记完备：磁盘模块集（src 顶层文件 + 一级子目录目录级条目）与 registry 登记集
 *      双向一致（磁盘多出 = 未登记即红；登记多出 = 死登记即红）
 *
 * 用法：
 *   node scripts/check-shared-module-admission.mjs              # 检查仓库当前状态
 *   node scripts/check-shared-module-admission.mjs --root <dir> # 测试注入 fixture 树
 *   （判据数据始终取自脚本所在目录，不随 --root 切换：规则是仓库策略，不是 fixture 内容）
 *
 * 退出码：0 通过 / 1 有违规 / 2 输入错误（目录缺失、registry 或判据数据解析失败）
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const RULES_PATH = new URL("./shared-node-builtin-rules.json", import.meta.url);

let rules;
try {
  rules = JSON.parse(readFileSync(RULES_PATH, "utf8"));
} catch (err) {
  throw new Error(
    `[check-shared-module-admission] 判据数据读取失败：scripts/shared-node-builtin-rules.json（${err instanceof Error ? err.message : String(err)}）` +
      "；恢复动作：从 git 历史恢复该文件（与 .githooks/check_shared_node_builtin.py 共用同一份）",
  );
}

/**
 * 规则 2 豁免表：shared 允许 import 的 workspace 包（方向依据 = 被依赖包更底层）。
 * - @zhushanwen/extension-protocol：npm 已发布契约包，仅依赖 @zhushanwen/state-machine，
 *   不依赖 shared —— 依赖图上严格位于 shared 之下；shared 消费其类型与 customType 常量
 *   （message.ts 值级 import/re-export、protocol.ts type-only 直引）。
 * - @zhushanwen/subagent-engine-sdk：npm 已发布引擎契约包，运行期依赖只有 ajv，不依赖
 *   shared —— 同上；shared 消费其 FailureCause 等词表类型（retry-rules.ts / subagent.ts）。
 * 表外任何 @taiji/* / @zhushanwen/* import 即红；新增豁免须先确认方向依据（不依赖 shared）。
 */
export const ALLOWED_WORKSPACE_DEPS = new Set([
  "@zhushanwen/extension-protocol",
  "@zhushanwen/subagent-engine-sdk",
]);

/** node 内置模块名单（去掉 node: 前缀的规范名，C-state-05 数据，与 hook 同源）。 */
export const BUILTIN_MODULES = new Set(rules.builtinModules);

/** 存量待治理白名单（文件名匹配；治理完成后从判据数据删除即全量拦截）。 */
export const NODE_BUILTIN_ALLOWLIST_FILES = new Set(rules.allowlistFiles);

// ---------- 纯函数（scripts/__tests__/check-shared-module-admission.test.mjs 消费） ----------

const MODULE_EXT_RE = /\.(ts|tsx|mts|cts|json)$/;

/**
 * 收集 shared/src 全部模块条目（__tests__ / node_modules 整体不算模块）：
 *   - src 顶层文件（.ts/.tsx/.mts/.cts/.json）按文件名登记
 *   - src 一级子目录按目录级条目登记（`sub/`）——一个目录 = 一个准入单位，其下的
 *     文件增删不再逐个登记；目录里一个模块文件都没有时不产生登记项
 * 返回值已排序，供登记双向对账使用。
 */
export function listSharedModules(sharedSrcDir) {
  const out = [];
  // 目录是否（递归地）承载至少一个模块文件
  const carriesModules = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (carriesModules(p)) return true;
      } else if (MODULE_EXT_RE.test(name)) {
        return true;
      }
    }
    return false;
  };
  for (const name of readdirSync(sharedSrcDir).sort()) {
    if (name === "node_modules" || name === "__tests__") continue;
    const p = join(sharedSrcDir, name);
    if (statSync(p).isDirectory()) {
      if (carriesModules(p)) out.push(`${name}/`);
    } else if (MODULE_EXT_RE.test(name)) {
      out.push(name);
    }
  }
  return out.sort();
}

/**
 * import 说明符提取形态（词法近似扫描，只认引号字面量，与 from 形态同等限制）：
 *   - 静态：`import x from "spec"` / `export x from "spec"`
 *   - side-effect：`import "spec"`——side-effect import 语法上只能出现在模块顶层
 *     语句位置，锚定行首，避免误伤注释里的用法示例文本（如「import '@taiji/…'」）
 *   - 动态：`import("spec")`（含 `import ("spec")` 空格变体；表达式位置不可锚行首）
 * 三形态在合法源码上互不重叠，同一 spec 不会重复计数。
 */
const IMPORT_SPEC_PATTERNS = [
  /from\s+['"]([^'"]+)['"]/g,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
];

const WORKSPACE_SPEC_RE = /^@(?:taiji|zhushanwen)\//;

/** `@scope/name/subpath` → `@scope/name`（豁免表按包粒度登记）。 */
function workspacePackageOf(spec) {
  return spec.split("/").slice(0, 2).join("/");
}

function violationMessage(rel, spec) {
  if (WORKSPACE_SPEC_RE.test(spec) && !ALLOWED_WORKSPACE_DEPS.has(workspacePackageOf(spec))) {
    return `${rel}: import workspace 包 ${spec}（shared 必须保持最底层，规则 2；确属更底层契约须在 ALLOWED_WORKSPACE_DEPS 登记方向依据）`;
  }
  if (/^\.\.\/\.\.\//.test(spec)) {
    return `${rel}: 跨包相对 import ${spec}（绕过依赖图，规则 2）`;
  }
  const builtinName = spec.replace(/^node:/, "");
  if (BUILTIN_MODULES.has(builtinName) && !NODE_BUILTIN_ALLOWLIST_FILES.has(basename(rel))) {
    return `${rel}: 禁用内置 import ${spec}（C-state-05：shared 零 node 依赖，规则 3）`;
  }
  return null;
}

/** 检查 A+B：依赖方向与内置禁令（输入 = 相对路径 → 源码文本 的数组，排除测试文件）。 */
export function scanSourceViolations(sources) {
  const violations = [];
  for (const [rel, src] of sources) {
    for (const pattern of IMPORT_SPEC_PATTERNS) {
      for (const m of src.matchAll(pattern)) {
        const v = violationMessage(rel, m[1]);
        if (v) violations.push(v);
      }
    }
  }
  return violations;
}

/** 检查 C：登记完备双向对账（purpose 非空校验在 main 内直接读 registry 条目实现）。 */
export function reconcileRegistry(diskModules, registeredModules) {
  const disk = new Set(diskModules);
  const reg = new Set(registeredModules);
  return {
    unregistered: diskModules.filter((m) => !reg.has(m)),
    dead: registeredModules.filter((m) => !disk.has(m)),
  };
}

// ---------- main ----------

const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts)$/;
const DECLARATION_RE = /\.d\.(ts|mts|cts)$/;

function walkSources(rootDir, baseDir = rootDir, out = []) {
  for (const name of readdirSync(rootDir).sort()) {
    if (name === "node_modules" || name === "__tests__") continue;
    const p = join(rootDir, name);
    if (statSync(p).isDirectory()) walkSources(p, baseDir, out);
    // 声明文件只有类型、无运行时 import，扫它只会把 import type 的 node 类型误判为运行时依赖
    else if (SOURCE_EXT_RE.test(name) && !DECLARATION_RE.test(name)) {
      out.push([relative(baseDir, p).split(sep).join("/"), readFileSync(p, "utf8")]);
    }
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx !== -1 ? argv[rootIdx + 1] : ".";
  const sharedSrc = join(root, "packages/shared/src");
  const registryPath = join(root, "scripts/shared-module-registry.json");

  if (!existsSync(sharedSrc)) {
    console.error(`[check-shared-module-admission] packages/shared/src 缺失（${sharedSrc}）`);
    console.error("  恢复动作：在仓库根运行本脚本，或用 --root 指向仓库树根");
    return 2;
  }
  if (!existsSync(registryPath)) {
    console.error(`[check-shared-module-admission] 登记清单缺失：scripts/shared-module-registry.json`);
    console.error("  恢复动作：确认在仓库根运行；清单被删除时按 git 历史恢复");
    return 2;
  }

  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (err) {
    console.error(`[check-shared-module-admission] registry 解析失败：${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const failures = [];

  // A+B：依赖方向与 node 内置禁令
  const sources = walkSources(sharedSrc);
  for (const v of scanSourceViolations(sources)) failures.push(v);

  // C：登记完备双向对账 + purpose 非空
  const diskModules = listSharedModules(sharedSrc);
  const registered = registry.modules ?? [];
  const registeredModules = registered.map((m) => m.file);
  const { unregistered, dead } = reconcileRegistry(diskModules, registeredModules);
  if (unregistered.length > 0) {
    failures.push(
      `未登记模块（进 shared 须在 scripts/shared-module-registry.json 登记 purpose，规则 4）：${unregistered.join(", ")}`,
    );
  }
  if (dead.length > 0) {
    failures.push(`死登记（磁盘模块已不存在，须删登记行）：${dead.join(", ")}`);
  }
  const emptyPurpose = registered.filter((m) => diskModules.includes(m.file) && (!m.purpose || !m.purpose.trim()));
  if (emptyPurpose.length > 0) {
    failures.push(`登记缺 purpose（准入声明载体，规则 4）：${emptyPurpose.map((m) => m.file).join(", ")}`);
  }

  console.log(
    `[check-shared-module-admission] 源码 ${sources.length} 文件 / 模块 ${diskModules.length}（登记 ${registeredModules.length}）；依赖方向与 node 内置禁令扫描 ${sources.length} 文件`,
  );

  if (failures.length > 0) {
    console.error(`\n[check-shared-module-admission] FAIL（${failures.length} 处）：`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error("  恢复动作：按脚本头注释准入规则 1-4 逐条核对；新模块先确认跨包契约属性再登记 purpose。");
    return 1;
  }
  console.log("[check-shared-module-admission] PASS：依赖方向干净、零 node 内置、登记双向一致");
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(join(process.argv[1])).href;
if (isMain) process.exit(main());
