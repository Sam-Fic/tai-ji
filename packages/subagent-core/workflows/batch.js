// batch.js — `subagent_batch` 批量 tool 的专用执行体（纯收集，无归约节点）
//
// 模式：tasks 成员对象数组逐条派 agent()（parallel() allSettled——任一成员死亡/失败
// 不阻断其余成员、不阻断 run 收尾）→ 全量收集 → **直接返回全部成员结果**。
//
// 与 fan-out 的分工：fan-out 是通用模板（同一收集内核 + 可选 aggregate 归约段）；
// 本模板是批量 tool 的固定执行体，契约就是「把 tasks 透传进来、把全部结果带回去」——
// 不设归约节点：归约是主 agent 的职责（它看得见全局意图，一个额外的归约成员只是多一次
// LLM 往返与一层信息损耗），工具层只负责把事实收齐。收集内核与 fan-out 共用同一实现
// （_shared/batch-collect.cjs），两处消费不漂移。
//
// 结果归因权威：results[].taskIndex 由派发序（$ARGS.tasks 下标）赋值，results[].task
// 文本同样以 $ARGS.tasks 为权威源——成员输出 schema 不含 taskIndex 字段，成员无从错报；
// 「只重派失败任务」的归因不因成员输出错位而错杀。
//
// 用法：
//   workflow run batch --args 'tasks=[{"task":"任务一","agent":"/path/a.md"},{"task":"任务二"}]'（pi 宿主语法）
//   zsw workflow --workflow batch --workdir <绝对路径>（zsw 宿主直参语法；per-workflow
//   参数用 zsw 专属 flag，语义见 @pi-meta parameters；tasks 必填且为成员对象数组）
//   经 `subagent_batch` tool 调用时工具层会自动把运行级 agent 填进未指定的成员（本模板
//   自身不感知工具层，tasks 之外的运行级值经 workerData 的 $MODEL/$THINKING_LEVEL 继承）。
//
// ⚠️ lintScript 约束：本模板自身无 IIFE（派发/收集在 _shared 内核，worker 沙箱 eval 模式下
// 经绝对路径 require 加载），bare-IIFE 规则天然不触发；fan-out.js 的同款注释保留——那里
// 确有 parallel 入口。

/* @pi-meta
name: batch
description: 批量派发：N 个独立 subagent 任务并行执行并全量收集结果（subagent_batch 工具的执行体，无归约节点）
when: 需要把 N 个独立任务的结果原样收回时（subagent_batch 工具的执行体；也可 workflow run 直跑）
notFor: 任务间有依赖顺序或多视角分析同一目标（改用 chain / parallel）
# phase 名带引号：checkPhaseConsistency 的声明提取只认带引号字符串（unquoted 形态
# 会误报 "called but not in meta.phases" warning——fan-out.js 等既有模板受此局限）
phases: ["batch"]
# thinkingLevel enum 与运行级白名单 THINKING_ORDER 同源（subagent-core src/shared/model-ref.ts；
# worker 模板 eval 环境无法 import TS，此处字面量须手动同步；batch-script.test.ts 解析本
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
  required: [tasks]
usage: |
  ## 使用说明
  - tasks 每个元素 = 一个成员对象：task 必填（完整自包含、可直接派发的任务描述），可选 agent（成员级执行者 .md 绝对路径，pattern ^/）/ model / thinkingLevel（成员级覆盖）；全部任务并行执行，结果一次性收齐
  - 成员未指定的 agent/model/thinkingLevel 留空继承 run 级默认；经 subagent_batch 工具调用时工具层会自动把运行级 agent 填进未指定的成员
  - 任一成员失败不阻断其余成员：部分失败收尾 status=partial（失败条目带 taskIndex/error），只重派失败 taskIndex 对应的成员即可，勿全批重跑
  - 成员可选 deliverables（产物契约，机器可验证谓词）：[{kind:"file", path, minBytes}] 要求产物文件真实落盘（size ≥ minBytes，缺省 1 = 存在且非空）/ [{kind:"structured_output"}] 要求成员结构化产出有效。成员交付结算前校验：全不满足 → 该成员 failed（agent.no_deliverable）；部分满足 → 不算失败，缺项记 outcome.partialMembers（[{taskIndex, missing[]}]）与该成员条目 observations；不传 deliverables = 不做交付校验（行为与无此字段时一致）
  - 本模板无归约节点：结果原样全量返回，需要一份结论请自行归约（或改用 fan-out 的 aggregate）
  - 每个成员输出 summary（数百字内，通知内联展示）+ 可选 fullReportPath（完整产物落盘路径）；结果总量超预算时按序截断并置 truncated 标记（taskIndex/status/路径/observations 恒完整）
  - 示例（pi 宿主语法）：workflow run batch --args 'tasks=[{"task":"统计 src 下 ts 文件数","agent":"/path/counting-agent.md"},{"task":"统计 src 下 md 文件数"}]'
  - 示例（zsw 宿主直参语法；`zsw` 为 CLI 简写，实际以注入段 node "<绝对路径>/bin/zsw.js" 形态为准）：zsw workflow --workflow batch --workdir <绝对路径>（per-workflow 参数用 zsw 专属 flag，语义见 @pi-meta parameters；tasks 必填且为成员对象数组）
*/

// ── 入参（$ARGS）──────────────────────────────────────────────────
// scriptPath 锚定检查（worker 宿主契约的显式前提，加固点）：workerData.scriptPath 是
// 本脚本真实路径的唯一定位点，也是 resume 重建的锚——缺席或为空串即 fail-fast
// （空串 = record 流为 scriptPath 载荷落地前的旧格式，resume 重建无锚可恢复），
// 不回退 cwd——消除从用户目录误加载代码的路径侧。本检查必须先于 _shared 内核的
// require（内核的加载锚就是 scriptPath，检查与加载不可换序）。
if (typeof workerData === "undefined" || !workerData || typeof workerData.scriptPath !== "string" || workerData.scriptPath === "") {
  if (workerData && typeof workerData.scriptPath === "string") {
    throw new Error("batch: core_module_load_failed: workerData.scriptPath is an empty string (record stream predates the scriptPath field); resume rebuild has no anchor for this run. " +
      "Recovery: re-run the workflow (runs recorded before the field existed cannot be resumed).");
  }
  throw new Error("batch: core_module_load_failed: workerData.scriptPath is missing. " +
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

const tasks = batchCore.parseTasks($ARGS, "batch");

// ── 段 1：batch（并行派发 + 全量收集，无归约节点）────────────────
phase("batch");

const collected = await batchCore.collectMembers({ tasks, label: "batch", agent, parallel, log });

// 纯收集终态：results 全量带回（超预算按序截断 + truncated 标记，归因/恢复字段恒完整），
// 归约由主 agent 自行完成——本模板不追加任何 agent 调用。
return batchCore.buildOutcome({
  results: collected.results,
  partialMembers: collected.partialMembers,
  failedCount: collected.failedCount,
  label: "batch",
  taskCount: tasks.length,
});
