#!/usr/bin/env node
/**
 * run-affected-e2e-ci.mjs — on-diff e2e 清单的 CI 执行消费者
 *
 * 红灯②「on-diff e2e 清单接入 CI 执行消费者」（设计 D13 / impl-plan u-foundation
 * F1-②）的执行体：CI 里消费 scripts/select-affected-e2e.mjs 产出的 on-diff 机器
 * 清单（--json），把受影响的 L1（mock 零 token）层 rule 逐条真实执行——
 * 「改了哪个域 → CI 跑对应 e2e」不再依赖开发者本地自觉。
 *
 * 执行口径（AGENTS.md e2e 执行准则 SSOT）：
 *   - 消费面 = trigger=on-diff && layer=L1（mock / 零 token 层可进 CI；真实 LLM 与
 *     真实进程层 L2/L2.5/L3 禁入 CI——CI 与本地同口径 TAIJI_SKIP_REAL_PI=1）
 *   - always 规则（E2E-ELECTRON-01 / E2E-VISUAL-01）不在此消费：已有 CI 固定 job
 *     （e2e-behavior / e2e-visual）承载，重复执行纯浪费 runner
 *   - 空载串行：逐条顺序执行（跨包并发会饱和 CPU，2026-09-15 send-queue-e2e 事故）
 *   - 解掩蔽：单条失败不中断后续（全部跑完末尾聚合判红，一次 run 暴露全部失败——
 *     对齐 ci.yml 既有 continue-on-error + 聚合模式）
 *   - 失败分桶：命令执行完并返回非零 = 用例失败（结论可信）；命令没跑起来 /
 *     未返回退出码（spawn 失败、被信号终止）= 无法执行（不是用例结论，必须先修
 *     执行环境）——两者混在一个 FAIL 形态里会把「e2e 红了」和「e2e 根本没跑」
 *     压成同一件事
 *
 * CI 可执行性登记（单源 = e2e-map 条目自身的 ci 字段）：消费面内的 rule 若在
 * ubuntu 消费环境无法承载（需桌面环境，或依赖被 .gitignore 忽略的构建产物），
 * 就在该 rule 的 e2e-map 条目上登记 `ci: { runnable: false, skipReason }`——
 * 判定与理由和 layer/trigger/run 写在同一行登记里，由 scripts/validate-e2e-map.mjs
 * 结构校验；本脚本只读该字段，不另维护白名单。缺省（无 ci 字段）= 可跑。
 * 跳过时输出 [skip] 行标注理由，不静默吞。
 *
 * 用法：
 *   node scripts/run-affected-e2e-ci.mjs [--base <ref>] [--dry-run] [--json-in <file>]
 *   --dry-run    只打印将执行/跳过的清单，不真跑（CI 步骤机械核验与本地预演）
 *   --json-in    测试注入：直接给 select-affected-e2e --json 的输出文件（跳过
 *                spawn git diff，fixture 形态不依赖仓库 diff 状态）
 *
 * 退出码：0 全部通过（或清单空）/ 1 有失败 rule / 2 输入错误（清单产出失败、
 *         --json-in 文件缺失或非法 JSON）
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SELECTOR = join(SCRIPT_DIR, "select-affected-e2e.mjs");

/** 失败摘要截断长度（错误原文可能很长，聚合输出只留可归因的开头）。 */
const MAX_FAILURE_DETAIL = 400;

/** CI 消费面过滤：on-diff + L1（always 由既有固定 job 承载，不重复）。 */
export function selectCiRunnable(rules) {
  return rules.filter((r) => r.trigger === "on-diff" && r.layer === "L1");
}

/** 执行计划分桶：run / skip（e2e-map 条目登记 ci.runnable=false 时跳过，理由随行）。 */
export function planExecution(rules) {
  const runnable = [];
  const skipped = [];
  for (const r of rules) {
    if (r.ci?.runnable === false) {
      skipped.push({
        rule: r,
        reason: r.ci.skipReason ?? "(未登记 skipReason——validate-e2e-map 应拦截该形态)",
      });
    } else {
      runnable.push(r);
    }
  }
  return { runnable, skipped };
}

/**
 * 失败归因：kind='assert' = 命令执行完、返回非零退出码（用例结论）；
 * kind='exec' = 无退出码（spawn 失败 / 被信号终止）或 126 / 127（POSIX shell
 * 「不可执行 / 找不到命令」）——都不是用例结论。
 */
export function classifyFailure(err) {
  const status = typeof err?.status === "number" ? err.status : null;
  const detail = [
    status === null ? "(无退出码)" : `exit=${status}`,
    err?.signal ? `signal=${err.signal}` : null,
    err?.message ? String(err.message) : null,
  ]
    .filter(Boolean)
    .join(" · ")
    .replace(/\s+/g, " ")
    .slice(0, MAX_FAILURE_DETAIL);
  const notExecuted = status === null || status === 126 || status === 127;
  return { kind: notExecuted ? "exec" : "assert", detail };
}

// ---------- main ----------

function loadRules(argv) {
  const jsonInIdx = argv.indexOf("--json-in");
  if (jsonInIdx !== -1) {
    try {
      return { status: 0, rules: JSON.parse(readFileSync(argv[jsonInIdx + 1], "utf8")) };
    } catch (err) {
      console.error(`[run-affected-e2e-ci] --json-in 读取/解析失败：${err instanceof Error ? err.message : String(err)}`);
      console.error("  恢复动作：确认 --json-in 指向 select-affected-e2e --json 的输出文件（存在且为合法 JSON）");
      return { status: 2, rules: [] };
    }
  }
  const args = [];
  const baseIdx = argv.indexOf("--base");
  if (baseIdx !== -1) args.push("--base", argv[baseIdx + 1]);
  args.push("--json");
  const sel = spawnSync(process.execPath, [SELECTOR, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (sel.status !== 0) {
    console.error(`[run-affected-e2e-ci] 清单产出失败（select-affected-e2e exit ${sel.status}）：`);
    console.error(String(sel.stderr ?? ""));
    return { status: 2, rules: [] };
  }
  try {
    return { status: 0, rules: JSON.parse(sel.stdout) };
  } catch (err) {
    console.error(`[run-affected-e2e-ci] 清单 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
    return { status: 2, rules: [] };
  }
}

/** 执行单条 rule：返回 null（通过）或失败归因 {kind, detail}。 */
function runRule(rule) {
  console.log(`\n===== [${rule.id}] ${rule.summary} =====`);
  console.log(`$ ${rule.run}`);
  try {
    execFileSync(rule.run, {
      cwd: REPO_ROOT,
      shell: true,
      stdio: "inherit",
      env: { ...process.env, TAIJI_SKIP_REAL_PI: "1" },
    });
    return null;
  } catch (err) {
    const failure = classifyFailure(err);
    console.error(`[${rule.id}] ${failure.kind === "exec" ? "无法执行" : "用例失败"}：${failure.detail}`);
    return failure;
  }
}

function reportFailures(failures, total) {
  const idsOf = (kind) => failures.filter((f) => f.kind === kind).map((f) => f.id);
  const assertFailed = idsOf("assert");
  const execFailed = idsOf("exec");
  console.error(
    `\n[run-affected-e2e-ci] FAIL：${failures.length}/${total} 条失败：${failures.map((f) => f.id).join(", ")}`,
  );
  if (assertFailed.length > 0) {
    console.error(`  用例失败（命令已执行并返回非零退出码）：${assertFailed.join(", ")}`);
  }
  if (execFailed.length > 0) {
    console.error(`  无法执行（命令没跑起来 / 未返回退出码）：${execFailed.join(", ")}`);
  }
  console.error("  恢复动作：逐条读上方该 rule 的输出归因修复（禁不归因重试/放宽断言/膨胀预算）；");
  console.error(
    "  「无法执行」类先修执行环境（依赖安装 / 被 .gitignore 忽略的构建产物 / 可执行文件存在），" +
      "不得用登记 ci.skipReason 掩盖执行环境问题——该字段只用于环境本身无法承载的 rule；",
  );
  console.error("  失败 rule 与改动的映射见 docs/testing/e2e-map.json 对应条目。");
}

export function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const { status, rules } = loadRules(argv);
  if (status !== 0) return status;

  const ciRules = selectCiRunnable(rules);
  const { runnable, skipped } = planExecution(ciRules);
  const ignored = rules.length - ciRules.length;

  console.log(
    `[run-affected-e2e-ci] 清单 ${rules.length} 条：CI 消费面（on-diff × L1）${ciRules.length} 条` +
      `（执行 ${runnable.length} / 登记跳过 ${skipped.length}）；always+L2+L2.5+L3 共 ${ignored} 条不在 CI 消费面（AGENTS.md e2e 执行准则）`,
  );
  for (const s of skipped) console.log(`  [skip] ${s.rule.id}：${s.reason}`);

  if (dryRun) {
    for (const r of runnable) console.log(`  [run] ${r.id}：${r.run}`);
    console.log("[run-affected-e2e-ci] --dry-run 结束（未执行）");
    return 0;
  }

  const failures = [];
  for (const rule of runnable) {
    const t0 = Date.now();
    const failure = runRule(rule);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (failure) failures.push({ id: rule.id, kind: failure.kind });
    const verdict = !failure ? "PASS" : failure.kind === "exec" ? "FAIL（无法执行）" : "FAIL（用例）";
    console.log(`----- [${rule.id}] ${verdict}（${secs}s）-----`);
  }

  if (failures.length > 0) {
    reportFailures(failures, runnable.length);
    return 1;
  }
  console.log(`\n[run-affected-e2e-ci] PASS：${runnable.length} 条全部通过`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(join(process.argv[1])).href;
if (isMain) process.exit(main());
