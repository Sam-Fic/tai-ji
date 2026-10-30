#!/usr/bin/env node
/**
 * check-shared-module-admission.mjs — @taiji/shared 模块准入机器检查
 *
 * 红灯配套（设计 D14 / impl-plan u-foundation F3）：「@taiji/shared 立模块准入
 * 规则 + 机器检查」。shared 是全部 workspace 包的最底层数据源（package.json 零
 * workspace 依赖），最大的退化风险 = 垃圾抽屉化（什么都往里塞）。本检查把准入
 * 规则中可机械核验的部分红灯化。
 *
 * ── 准入规则（成文判据，新增模块进 packages/shared/src/ 前逐条核对）──────────
 *
 * 1. 跨包契约：模块的消费方 ≥ 2 个包，或虽当前单消费方但属跨进程 / 跨包契约的
 *    单一权威形状（如 IPC 载荷、路径公式——契约两端在进程/包两侧）。单包实现
 *    细节、仅一个包使用的工具函数不得进 shared（放该包内部）。
 * 2. 零 workspace 依赖：shared 源码不 import 任何 @taiji/* 包、不使用跨包相对
 *    路径 import（shared 必须保持依赖图最底层——上层才允许向下依赖）。
 * 3. 纯模块形态：只允许 类型 / 常量 / 纯函数 / 数据清单（JSON）/ 纯函数配置
 *    （tailwind preset）。禁止 IO 与进程副作用（node:fs / net / http(s) /
 *    child_process / worker_threads 等内置禁令；node:path / node:url /
 *    node:os(homedir) 等纯计算模块放行）；禁止 UI 组件；禁止可变全局态。
 * 4. 登记完备：每个顶层模块必须在 scripts/shared-module-registry.json 登记
 *    purpose（一句话跨包理由）——登记动作即准入声明，新模块 PR 由 reviewer 按
 *    上述 1-3 卡点（消费广度与契约属性是语义判定，机器不冒充）。
 *
 * ── 机器检查项（本脚本）────────────────────────────────────────────────
 *
 *   A. 依赖方向：src 内（排除 __tests__）零 @taiji/* import、零跨包相对 import
 *   B. IO/进程禁令：src 内（排除 __tests__）零禁用内置 import（BANNED_BUILTINS）
 *   C. 登记完备：磁盘顶层模块集与 registry 登记集双向一致
 *      （磁盘多出 = 未登记即红；登记多出 = 死登记即红）
 *
 * 用法：
 *   node scripts/check-shared-module-admission.mjs              # 检查仓库当前状态
 *   node scripts/check-shared-module-admission.mjs --root <dir> # 测试注入 fixture 树
 *
 * 退出码：0 通过 / 1 有违规 / 2 输入错误（目录缺失、registry 解析失败）
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 禁用内置模块（IO / 进程 / 网络副作用；纯计算模块 path/url/os/util 不在列）。 */
export const BANNED_BUILTINS = [
  "node:fs",
  "node:fs/promises",
  "node:net",
  "node:http",
  "node:https",
  "node:child_process",
  "node:worker_threads",
  "node:dgram",
  "node:tls",
  "node:cluster",
  "node:v8",
];

// ---------- 纯函数（scripts/__tests__/check-shared-module-admission.test.mjs 消费） ----------

/** 收集 shared/src 顶层模块文件名（.ts / .json；__tests__ 目录整体不算模块）。 */
export function listTopModules(sharedSrcDir) {
  return readdirSync(sharedSrcDir)
    .filter((n) => {
      const p = join(sharedSrcDir, n);
      return statSync(p).isFile() && /\.(ts|json)$/.test(n);
    })
    .sort();
}

/** 检查 A+B：依赖方向与内置禁令（输入 = 相对路径 → 源码文本 的数组，排除测试文件）。 */
export function scanSourceViolations(sources) {
  const violations = [];
  for (const [rel, src] of sources) {
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (/^@taiji\//.test(spec)) {
        violations.push(`${rel}: import workspace 包 ${spec}（shared 必须保持最底层，规则 2）`);
      } else if (/^\.\.\/\.\.\//.test(spec)) {
        violations.push(`${rel}: 跨包相对 import ${spec}（绕过依赖图，规则 2）`);
      } else {
        const builtin = spec.startsWith("node:") ? spec : "";
        if (builtin && BANNED_BUILTINS.includes(builtin)) {
          violations.push(`${rel}: 禁用内置 import ${builtin}（shared 纯模块形态，规则 3）`);
        }
      }
    }
  }
  return violations;
}

/** 检查 C：登记完备双向对账。 */
export function reconcileRegistry(diskFiles, registeredFiles) {
  const disk = new Set(diskFiles);
  const reg = new Set(registeredFiles);
  return {
    unregistered: diskFiles.filter((f) => !reg.has(f)),
    dead: registeredFiles.filter((f) => !disk.has(f)),
    missingPurpose: registeredFiles.filter((f) => disk.has(f)),
  };
}

// ---------- main ----------

function walkSources(rootDir, baseDir = rootDir, out = []) {
  for (const name of readdirSync(rootDir).sort()) {
    if (name === "node_modules" || name === "__tests__") continue;
    const p = join(rootDir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkSources(p, baseDir, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push([p.slice(baseDir.length + 1), readFileSync(p, "utf8")]);
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

  // A+B：依赖方向与 IO 禁令
  const sources = walkSources(sharedSrc);
  for (const v of scanSourceViolations(sources)) failures.push(v);

  // C：登记完备双向对账 + purpose 非空
  const diskFiles = listTopModules(sharedSrc);
  const registered = registry.modules ?? [];
  const registeredFiles = registered.map((m) => m.file);
  const { unregistered, dead } = reconcileRegistry(diskFiles, registeredFiles);
  if (unregistered.length > 0) {
    failures.push(`未登记模块（进 shared 须在 scripts/shared-module-registry.json 登记 purpose，规则 4）：${unregistered.join(", ")}`);
  }
  if (dead.length > 0) {
    failures.push(`死登记（磁盘模块已不存在，须删登记行）：${dead.join(", ")}`);
  }
  const emptyPurpose = registered.filter((m) => diskFiles.includes(m.file) && (!m.purpose || !m.purpose.trim()));
  if (emptyPurpose.length > 0) {
    failures.push(`登记缺 purpose（准入声明载体，规则 4）：${emptyPurpose.map((m) => m.file).join(", ")}`);
  }

  console.log(
    `[check-shared-module-admission] 源码 ${sources.length} 文件 / 顶层模块 ${diskFiles.length}（登记 ${registeredFiles.length}）；依赖方向与 IO 禁令扫描 ${sources.length} 文件`,
  );

  if (failures.length > 0) {
    console.error(`\n[check-shared-module-admission] FAIL（${failures.length} 处）：`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error("  恢复动作：按脚本头注释准入规则 1-4 逐条核对；新模块先确认跨包契约属性再登记 purpose。");
    return 1;
  }
  console.log("[check-shared-module-admission] PASS：依赖方向干净、零 IO 内置、登记双向一致");
  return 0;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) process.exit(main());
