// fan-out.js — N 个已知独立任务并行派发 + 全量收集（通用 subagent 编排）
//
// 模式：tasks 成员对象数组逐条派 agent()（parallel() allSettled——任一成员死亡/失败
// 不阻断其余成员、不阻断 run 收尾）→ 全量收集 → 可选 aggregate（末尾追加一个 agent()
// 把全部结果归约成一份结论）。aggregate 缺省 false = 纯收集。
//
// 与 batch 的分工：batch 是 `subagent_batch` 批量 tool 的专用执行体（同一收集内核、
// 无归约节点）；本模板是通用编排面，归约段按需开启。两模板共用 _shared/batch-collect.cjs
// 收集内核（校验/派发/allSettled 降级/产物契约谓词/通知体积截断/partial 收尾），差异只在
// 本文件末尾的 aggregate 段——复制两份收集逻辑必然漂移，故收敛为单实现。
//
// 与 parallel 的分工：parallel 是「多视角分析同一目标」（单一目标转译成视角 prompt）；
// fan-out 是「N 条完整自包含任务直接派发」（tasks 每个成员 = 一条可直接派发的 task
// prompt + 可选成员级 agent/model/thinkingLevel，不加转译包装）。
//
// 成员级配置：成员对象的 agent（执行者 .md 绝对路径）/ model / thinkingLevel 是成员级
// 覆盖，未指定字段不进 agent() 调用——留给 run 级 $MODEL / $THINKING_LEVEL 继承
// （worker-script-builder 的 agent() 对象分支：opts 显式值优先，缺省回落 run 级）。
// description 由收集内核按 label（本模板传 "fan-out"）+ "-" + i 构造（buildMemberCall）
// ——它是成员复用身份键（同 run 内同名在途会拒绝或续写为同一身份），不承载显示语义；
// 改值会破坏 resume 回放与成员唯一性。两模板 label 不同 → 身份键不撞车。
//
// 结果归因权威：results[].taskIndex 由本模板按派发序（$ARGS.tasks 下标）赋值，
// results[].task 文本同样以 $ARGS.tasks 为权威源——成员输出 schema 不含 taskIndex
// 字段，成员无从错报；「只重派失败任务」的归因不因成员输出错位而错杀。
//
// 用法：
//   workflow run fan-out --args 'tasks=[{"task":"任务一","agent":"/path/a.md"},{"task":"任务二"}]'（pi 宿主语法）
//   zsw workflow --workflow fan-out --workdir <绝对路径>（zsw 宿主直参语法；per-workflow
//   参数用 zsw 专属 flag，语义见 @pi-meta parameters；tasks 必填且为成员对象数组）
//
// ⚠️ lintScript 约束（本脚本已遵守）：含 parallel() 入口，禁止 bare IIFE

/* @pi-meta
name: fan-out
description: 通用编排：N 个已知独立任务并行派发并全量收集，可选把全部结果归约成一份结论
when: N 个相互独立的任务需要一次派发并行执行并收齐全部结果
notFor: 任务间有依赖顺序，或多视角分析同一目标
# phase 名带引号：checkPhaseConsistency 的声明提取只认带引号字符串（unquoted 形态
# 会误报 "called but not in meta.phases" warning——parallel.js 等既有模板受此局限）
phases: ["fan-out", "aggregate"]
# thinkingLevel enum 与运行级白名单 THINKING_ORDER 同源（subagent-core src/shared/model-ref.ts；
# worker 模板 eval 环境无法 import TS，此处字面量须手动同步；fan-out-script.test.ts 解析本
# meta 块的 enum 值集与 THINKING_ORDER 动态对拍，漂移即红）
parameters:
  type: object
  additionalProperties: false
  properties:
    tasks:
      type: array
      minItems: 1
      maxItems: 20
      items:
        type: object
        additionalProperties: false
        required: [task]
        properties:
          task: { type: string, minLength: 1 }
          agent: { type: string, pattern: "^/" }
          model: { type: string }
          thinkingLevel: { type: string, enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] }
          deliverables:
            type: array
            minItems: 1
            items:
              type: object
              additionalProperties: false
              required: [kind]
              properties:
                kind: { type: string, enum: ["file", "structured_output"] }
                path: { type: string, minLength: 1 }
                minBytes: { type: integer, minimum: 1 }
    aggregate: { type: boolean, default: false }
  required: [tasks]
usage: |
  ## 使用说明
  - tasks 每个元素 = 一个成员对象：task 必填（完整自包含、可直接派发的任务描述），可选 agent（成员级执行者 .md 绝对路径，pattern ^/）/ model / thinkingLevel（成员级覆盖）；全部任务并行执行，结果一次性收齐
  - 成员未指定的 agent/model/thinkingLevel 留空继承 run 级默认；经 subagent_batch 工具调用时工具层会自动把运行级 agent 填进未指定的成员（该工具走 batch 模板，无 aggregate）
  - 任一成员失败不阻断其余成员：部分失败收尾 status=partial（失败条目带 taskIndex/error），只重派失败 taskIndex 对应的成员即可，勿全批重跑
  - 成员可选 deliverables（产物契约，机器可验证谓词）：[{kind:"file", path, minBytes}] 要求产物文件真实落盘（size ≥ minBytes，缺省 1 = 存在且非空）/ [{kind:"structured_output"}] 要求成员结构化产出有效。成员交付结算前校验：全不满足 → 该成员 failed（agent.no_deliverable）；部分满足 → 不算失败，缺项记 outcome.partialMembers（[{taskIndex, missing[]}]）与该成员条目 observations；不传 deliverables = 不做交付校验（行为与无此字段时一致）
  - aggregate=true 时末尾追加一个聚合 agent，把全部结果归约成一份结论（缺省 false 纯收集）
  - 每个成员输出 summary（数百字内，通知内联展示）+ 可选 fullReportPath（完整产物落盘路径）；结果总量超预算时按序截断并置 truncated 标记（taskIndex/status/路径/observations 恒完整）
  - 示例（pi 宿主语法）：workflow run fan-out --args 'tasks=[{"task":"统计 src 下 ts 文件数","agent":"/path/counting-agent.md"},{"task":"统计 src 下 md 文件数"}]'
  - 示例（zsw 宿主直参语法；`zsw` 为 CLI 简写，实际以注入段 node "<绝对路径>/bin/zsw.js" 形态为准）：zsw workflow --workflow fan-out --workdir <绝对路径>（per-workflow 参数用 zsw 专属 flag，语义见 @pi-meta parameters；tasks 必填且为成员对象数组）
*/

// ── 入参（$ARGS）──────────────────────────────────────────────────
// scriptPath 锚定检查（worker 宿主契约的显式前提，加固点）：workerData.scriptPath 是
// 本脚本真实路径的唯一定位点，也是 resume 重建的锚——缺席或为空串即 fail-fast
// （空串 = record 流为 scriptPath 载荷落地前的旧格式，resume 重建无锚可恢复），
// 不回退 cwd——消除从用户目录误加载代码的路径侧。本检查必须先于 _shared 内核的
// require（内核的加载锚就是 scriptPath，检查与加载不可换序）。
if (typeof workerData === "undefined" || !workerData || typeof workerData.scriptPath !== "string" || workerData.scriptPath === "") {
  if (workerData && typeof workerData.scriptPath === "string") {
    throw new Error("fan-out: core_module_load_failed: workerData.scriptPath is an empty string (record stream predates the scriptPath field); resume rebuild has no anchor for this run. " +
      "Recovery: re-run the workflow (runs recorded before the field existed cannot be resumed).");
  }
  throw new Error("fan-out: core_module_load_failed: workerData.scriptPath is missing. " +
    "Recovery: the worker host (WorkerHost) must inject scriptPath via workerData when launching the worker " +
    "(the real path of this script; injection point: the workerData assembly in src/orchestration/worker-host.ts). " +
    "Never rely on process.cwd() coincidence.");
}
// worker 沙箱为 eval 模式：require 相对路径以 cwd 为基准（非脚本目录），必须用
// workerData.scriptPath 锚定脚本目录（parallel.js 同模式）；SCRIPT_DIR + 字面量拼接是
// 依赖闭包检查（check-subagent-core-closure D9-①）唯一认可的两种静态可解析形态之一
//（另一种 = require("path").dirname(workerData.scriptPath) + 字面量内联）。
const SCRIPT_DIR = require("path").dirname(workerData.scriptPath);
const batchCore = require(SCRIPT_DIR + "/_shared/batch-collect.cjs");

const tasks = batchCore.parseTasks($ARGS, "fan-out");

// ── 段 1：fan-out（并行派发 + 全量收集，内核与 batch 模板共用）────
phase("fan-out");

const collected = await batchCore.collectMembers({ tasks, label: "fan-out", agent, parallel, log });

// ── 段 2：aggregate（可选归约 + 收尾定稿）────────────────────────
phase("aggregate");

let aggregateOut;
if ($ARGS.aggregate === true) {
  // 聚合成员不指定 agent（缺省执行者，review-fix-loop aggregator 同惯例——
  // 「归约者归谁」无歧义解，聚合是通用归并工作）
  try {
    const agg = await agent({
      prompt:
        "以下是 " + tasks.length + " 个并行任务的全部结果（JSON，task=任务描述，summary=该任务结果摘要，" +
        "fullReportPath=完整报告路径）。请综合全部结果归约成一份结论：关键发现、共识与分歧、后续建议。conclusion 数百字内。\n\n" +
        JSON.stringify(collected.results),
      schema: {
        type: "object",
        properties: {
          conclusion: { type: "string", description: "全部任务结果的归约结论（数百字内）" },
        },
        required: ["conclusion"],
      },
      description: "fan-out-aggregate",
    });
    aggregateOut = agg && typeof agg.conclusion === "string" ? agg.conclusion : undefined;
    if (aggregateOut === undefined) {
      aggregateOut = { error: "aggregate agent 返回缺 conclusion 字段" };
    }
  } catch (err) {
    // 归约成员失败不炸 run（对齐成员失败语义）：已收集的 results 照常收尾
    const msg = err && err.message ? err.message : String(err);
    aggregateOut = { error: msg };
    log("fan-out aggregate 失败：" + msg);
  }
}

return batchCore.buildOutcome({
  results: collected.results,
  partialMembers: collected.partialMembers,
  failedCount: collected.failedCount,
  label: "fan-out",
  taskCount: tasks.length,
  aggregateOut,
});
