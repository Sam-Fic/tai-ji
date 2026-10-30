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
 *
 * SKIP_IN_CI 登记表：L1 on-diff 中无法在 ubuntu 消费环境承载的 rule 显式登记
 * （带理由），跳过时输出标注——不静默吞。
 *
 * 用法：
 *   node scripts/run-affected-e2e-ci.mjs [--base <ref>] [--dry-run] [--json-in <file>]
 *   --dry-run    只打印将执行/跳过的清单，不真跑（CI 步骤机械核验与本地预演）
 *   --json-in    测试注入：直接给 select-affected-e2e --json 的输出文件（跳过
 *                spawn git diff，fixture 形态不依赖仓库 diff 状态）
 *
 * 退出码：0 全部通过（或清单空）/ 1 有失败 rule / 2 输入错误（清单产出失败）
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SELECTOR = join(SCRIPT_DIR, "select-affected-e2e.mjs");

/** CI 消费环境无法承载的 L1 on-diff rule 显式登记（跳过时输出标注，不静默吞）。 */
export const SKIP_IN_CI = {
  "E2E-SPAWNISOL-01":
    "playwright electron project 需桌面环境（mac runner / xvfb），ubuntu 消费 job 无法承载——归 e2e-behavior 同族 runner 或本地空载串行跑",
};

/** CI 消费面过滤：on-diff + L1（always 由既有固定 job 承载，不重复）。 */
export function selectCiRunnable(rules) {
  return rules.filter((r) => r.trigger === "on-diff" && r.layer === "L1");
}

/** 执行计划分桶：run / skip（登记跳过）。 */
export function planExecution(rules) {
  const runnable = [];
  const skipped = [];
  for (const r of rules) {
    if (SKIP_IN_CI[r.id]) skipped.push({ rule: r, reason: SKIP_IN_CI[r.id] });
    else runnable.push(r);
  }
  return { runnable, skipped };
}

// ---------- main ----------

function loadRules(argv) {
  const jsonInIdx = argv.indexOf("--json-in");
  if (jsonInIdx !== -1) {
    return { status: 0, rules: JSON.parse(readFileSync(argv[jsonInIdx + 1], "utf8")) };
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
    console.log(`\n===== [${rule.id}] ${rule.summary} =====`);
    console.log(`$ ${rule.run}`);
    const t0 = Date.now();
    let code = 0;
    try {
      execFileSync(rule.run, {
        cwd: REPO_ROOT,
        shell: true,
        stdio: "inherit",
        env: { ...process.env, TAIJI_SKIP_REAL_PI: "1" },
      });
    } catch {
      code = 1;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (code !== 0) failures.push(rule.id);
    console.log(`----- [${rule.id}] ${code === 0 ? "PASS" : "FAIL"}（${secs}s）-----`);
  }

  if (failures.length > 0) {
    console.error(`\n[run-affected-e2e-ci] FAIL：${failures.length}/${runnable.length} 条失败：${failures.join(", ")}`);
    console.error("  恢复动作：逐条读上方该 rule 的输出归因修复（禁不归因重试/放宽断言/膨胀预算）；");
    console.error("  失败 rule 与改动的映射见 docs/testing/e2e-map.json 对应条目。");
    return 1;
  }
  console.log(`\n[run-affected-e2e-ci] PASS：${runnable.length} 条全部通过`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) process.exit(main());
