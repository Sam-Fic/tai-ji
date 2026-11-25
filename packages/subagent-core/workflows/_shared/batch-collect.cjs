// workflows/_shared/batch-collect.cjs
//
// 批量编排共用内核：「N 个已知独立任务并行派发 + 全量收集」的唯一实现。
//
// 消费方（两个模板，差异只在调用方）：
//   - batch.js   `subagent_batch` 批量 tool 的专用执行体——纯收集：直接返回全部
//                成员结果，无归约节点（归约由主 agent 自行完成）
//   - fan-out.js 通用模板——同一收集内核 + 可选 aggregate 归约段
// 收拢为单实现的理由：收集语义（成员对象校验 / 派发 / allSettled 降级 / 产物契约
// 谓词 / 通知体积截断 / partial 收尾）是同一套契约的两处消费，复制两份必然漂移
//（deliverables 谓词、截断阶梯任一侧漏改即批量行为分叉）。
//
// 注入依赖：agent / parallel / log 是 worker 模板宿主注入的自由变量，本模块不 import
// 它们——由调用方作参数传入（模板自身是这些变量的宿主）。fs 取 Node 内置。
//
// label 参数 = 调用方模板名（"batch" / "fan-out"）：进错误文案前缀、日志文案、成员
// description 前缀（成员复用身份键，同 run 内同名在途会拒绝或续写为同一身份）与
// 收尾 message——同一内核两处消费的归因可读（用户从通知文案一眼看出是哪个入口派的
// 批次），也是 resume 回放时成员身份不撞车的前提（两模板的 label 不同 → 身份键不同）。
//
// 结构：入参校验（parseTasks 编排 + 4 个谓词函数）/ 产物契约谓词 / 派发 / 单成员结算 /
// 截断与 outcome。函数粒度按 metrics 门禁（maxCyclomatic 15）切分——收集段天然是
// 「多形态分支 × 多字段」的判定矩阵，揉在一个函数里既不可读也不可测。
"use strict";

const fs = require("node:fs");

// ── 入参校验（成员对象-only 契约 + deliverables 纵深）────────────────────
// 三层防线：ajv（类型/词表封闭）→ 工具入口（schema minLength + trim）→ 本模块
//（直参宿主绕过 ajv 的纵深 + 空白串 + deliverables 条件语义）。

/** tasks 必填且非空（schema minItems:1 的脚本入口纵深）。 */
function assertTasksArray(tasks, label) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(label + ": tasks is required (non-empty array of member objects). Correct: {\"tasks\":[{\"task\":\"task one\"},{\"task\":\"task two\"}]}");
  }
}

/**
 * 旧格式迁移指引（成员对象化之前：tasks 字符串数组 / 顶层 agents 键）——与 scriptPath
 * 旧格式文案同构：命名旧形状、给迁移映射（agents 逗号串 → 逐成员 agent）与恢复
 * 动作（按旧 tasks 内容重派成员对象新 run）。纵深兜底覆盖绕过 validateRunArgs/ajv 的
 * 直参宿主形态（zsw 直参等）；pi 宿主标准路径在 ajv 层已被拒并拿到同款迁移文案
 *（args-validator legacyArgsAdvisory），两处文案同构。
 */
function assertNoLegacyShape(args, tasks, label) {
  const legacyStringTasks = tasks.some((t) => typeof t === "string");
  const legacyAgentsKey = args.agents !== undefined;
  if (!legacyStringTasks && !legacyAgentsKey) return;
  throw new Error(
    label + ": legacy args shape detected (" +
      [
        ...(legacyStringTasks ? ["tasks elements are plain strings"] : []),
        ...(legacyAgentsKey ? ['top-level "agents" key present'] : []),
      ].join("; ") +
      ") — this shape predates the member-object parameter format and is no longer accepted. " +
      "Migration: one member object per task (task required; agent/model/thinkingLevel optional per-member overrides; " +
      'a legacy agents="/a.md,/b.md" maps to agent on each member in the same order). ' +
      "Recovery: re-dispatch a NEW run with member-object tasks. " +
      'Correct: {"tasks":[{"task":"task one","agent":"/a/one.md"},{"task":"task two"}]}',
  );
}

/** 成员对象形态：task 必填且非空白——schema minLength 不拦空白字符串，入口 trim 检查补上。 */
function assertMembersWellFormed(tasks, label) {
  if (tasks.some((m) => m === null || typeof m !== "object" || typeof m.task !== "string" || m.task.trim() === "")) {
    throw new Error(label + ": tasks elements must be objects with a non-blank \"task\" string. " +
      'Correct: {"tasks":[{"task":"task one","agent":"/a/one.md","model":"provider/model","thinkingLevel":"high"}]}');
  }
}

/**
 * deliverables 单条声明校验（ajv 层已拦 kind 词表封闭 file/structured_output 与
 * additionalProperties:false；这里补 ajv 表达不了的条件语义与直参宿主绕过 ajv 的纵深
 * ——kind="file" 必须带非空 path，structured_output 携带 path/minBytes 属矛盾声明）。
 * @returns 问题描述清单（空 = 全部合法）
 */
function deliverableDeclarationProblems(ds, i, bad) {
  if (!Array.isArray(ds) || ds.length === 0) {
    bad.push("tasks[" + i + "].deliverables must be a non-empty array");
    return;
  }
  ds.forEach((d, j) => {
    const at = "tasks[" + i + "].deliverables[" + j + "]";
    if (d === null || typeof d !== "object") {
      bad.push(at + " must be an object");
      return;
    }
    if (d.kind === "file") {
      if (typeof d.path !== "string" || d.path.trim() === "") {
        bad.push(at + ': kind="file" requires a non-empty "path"');
      }
    } else if (d.kind === "structured_output") {
      if (d.path !== undefined || d.minBytes !== undefined) {
        bad.push(at + ': kind="structured_output" takes no path/minBytes');
      }
    } else {
      bad.push(at + ': kind must be "file" or "structured_output" (got ' + JSON.stringify(d.kind) + ")");
    }
  });
}

/** 全量成员的 deliverables 声明校验（@returns 问题描述清单，空 = 合法或无声明）。 */
function collectDeliverableProblems(tasks) {
  const bad = [];
  for (let i = 0; i < tasks.length; i++) {
    const ds = tasks[i] && tasks[i].deliverables;
    if (ds === undefined) continue;
    deliverableDeclarationProblems(ds, i, bad);
  }
  return bad;
}

/**
 * tasks 入参校验总编排（validateRunArgs/ajv 类型校验之后的纵深兜底）。
 * @param args  $ARGS 原对象（legacy 顶层 agents 残留键在此识别）
 * @param label 调用方模板名（错误文案前缀）
 * @returns 校验通过的成员对象数组
 */
function parseTasks(args, label) {
  const tasks = args && args.tasks;
  assertTasksArray(tasks, label);
  assertNoLegacyShape(args, tasks, label);
  assertMembersWellFormed(tasks, label);
  const bad = collectDeliverableProblems(tasks);
  if (bad.length > 0) {
    throw new Error(label + ": invalid deliverables — " + bad.join("; ") + ". " +
      'Deliverable shapes: {"kind":"file","path":"/abs/report.md","minBytes":100} or {"kind":"structured_output"}. ' +
      "Members without deliverables are not delivery-checked.");
  }
  return tasks;
}

// ── 产物契约谓词（subagent-observability §3.3.10）────────────────
// deliverables 机器可验证谓词，两形态封闭：{kind:"file", path, minBytes}（产物文件
// 真实落盘且 size ≥ minBytes，缺省 1 = 存在且非空）/ {kind:"structured_output"}
//（成员结构化产出有效——固定 schema 的 required summary 非空事实）。
// 「本任务无产物」由不传 deliverables 表达（缺省 = 不做交付校验，行为与无此字段
// 逐字节一致）。

/** file 谓词：满足返回 undefined；未满足返回原因短语（stat 异常 → 不满足，不炸脚本）。 */
function fileDeliverableMiss(d) {
  const minBytes = typeof d.minBytes === "number" && Number.isFinite(d.minBytes) && d.minBytes > 0
    ? d.minBytes
    : 1;
  try {
    const st = fs.statSync(d.path);
    if (!st.isFile()) return "not a regular file";
    if (st.size < minBytes) return "size " + st.size + " < minBytes " + minBytes;
    return undefined;
  } catch (err) {
    return "not readable (" + (err && err.code ? err.code : "stat failed") + ")";
  }
}

/** structured_output 谓词：成员结果对象的结构化产出事实（required summary 非空）。 */
function structuredOutputMiss(r) {
  if (r && typeof r.summary === "string" && r.summary !== "") return undefined;
  return "no valid structured output (missing/empty summary)";
}

/** 单成员交付校验（成员交付结算前，§3.3.10）：返回未满足 deliverable 描述清单。 */
function missingDeliverables(member, r) {
  const missing = [];
  for (const d of member.deliverables) {
    if (d.kind === "file") {
      const why = fileDeliverableMiss(d);
      if (why !== undefined) missing.push("file:" + d.path + " (" + why + ")");
    } else if (d.kind === "structured_output") {
      const why = structuredOutputMiss(r);
      if (why !== undefined) missing.push("structured_output (" + why + ")");
    } else {
      // 词表外 kind（ajv enum 第一道 + 入口纵深第二道之后的最后一道防线）
      missing.push(String(d.kind) + " (unknown deliverable kind)");
    }
  }
  return missing;
}

// ── 派发 ───────────────────────────────────────────────

/**
 * 成员级覆盖展开：字段存在且为非空字符串才进 agent() 调用，未指定字段不写 key——
 * 留给 run 级 $MODEL / $THINKING_LEVEL 继承（worker-script-builder agent() 对象分支：
 * opts 显式值优先，缺省回落 run 级）。
 */
function memberOverride(member, key) {
  const v = member[key];
  return typeof v === "string" && v !== "" ? { [key]: v } : {};
}

/** 单成员的 agent() 调用 opts（schema 固定 summary/fullReportPath，description = 身份键）。 */
function buildMemberCall(member, i, label) {
  return {
    prompt: member.task,
    schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "结果摘要（数百字内），通知内联展示" },
        fullReportPath: { type: "string", description: "可选：完整产物的落盘路径（报告类任务建议写入文件）" },
      },
      required: ["summary"],
    },
    description: label + "-" + i,
    ...memberOverride(member, "agent"),
    ...memberOverride(member, "model"),
    ...memberOverride(member, "thinkingLevel"),
  };
}

/**
 * 并行派发全部成员。
 *
 * parallel() 接受 Promise 数组；agent() 返回 Promise。allSettled 语义由 parallel 归一化
 * 承担：成员死亡（SIGTERM/引擎崩溃）降级为 {status:"failed", error} 条目，不炸整批。
 */
async function dispatchMembers(opts) {
  const tasks = opts.tasks;
  return opts.parallel(
    tasks.map((member, i) => opts.agent(buildMemberCall(member, i, opts.label))),
  );
}

// ── 单成员结算 ───────────────────────────────────────────
// 收集结果：taskIndex/task 以 tasks（派发序）为权威源，不采信成员自报。
// [§3.3.10] 声明 deliverables 的成员在结算前先过交付校验：全满足 → 成功交付；
// 部分满足 → status 维持 ok（不进失败、无 cause），缺项进 partialMembers + 条目
// observations；全不满足 → failed（agent.no_deliverable——宣称完成但没产物）。
// 成员死于上游失败时上游事实优先（UC-12）：不产 agent.no_deliverable 覆盖
// provider/harness 事实，deliverables 全缺降级为 observations。

/** 上游失败成员（含无返回）：失败事实原样进 error，deliverables 全缺降级 observations。 */
function settleFailedMember(task, i, r, deliverables) {
  const upstreamError = r ? (r.error || "agent 返回 failed 状态") : "agent 无返回";
  const entry = { task, taskIndex: i, status: "failed", error: upstreamError };
  if (deliverables !== undefined) {
    // UC-12 cause 优先级：上游失败事实优先，不冒充 agent.no_deliverable。
    entry.observations = [
      "deliverables not satisfied: member failed upstream (" + upstreamError + ") — " +
        "agent.no_deliverable not assigned (upstream fact takes precedence)",
    ];
  }
  return entry;
}

/** 成功成员（无 deliverables 声明）：summary/fullReportPath 按类型采信。 */
function settleOkMember(task, i, r) {
  return {
    task,
    taskIndex: i,
    status: "ok",
    summary: typeof r.summary === "string" ? r.summary : undefined,
    fullReportPath: typeof r.fullReportPath === "string" ? r.fullReportPath : undefined,
  };
}

/**
 * 声明 deliverables 的成功成员：过交付校验后按「全满足 / 部分满足 / 全不满足」三分支结算。
 * @returns entry（results 条目）+ failed（是否计入 failedCount）+ missing（未满足清单）
 */
function settleDeliverablesMember(task, i, r, member) {
  const missing = missingDeliverables(member, r);
  const all = member.deliverables.length;
  if (missing.length === all) {
    return {
      entry: {
        task,
        taskIndex: i,
        status: "failed",
        error: "agent.no_deliverable: all " + all + " deliverable(s) missing (" + missing.join("; ") + ")",
        observations: missing.map((m) => "deliverable missing: " + m),
      },
      failed: true,
      missing,
    };
  }
  // 部分交付：成员轮终成功（无失败事实），缺项独立承载（不进 failedMembers）。
  return {
    entry: {
      ...settleOkMember(task, i, r),
      ...(missing.length > 0 ? { observations: missing.map((m) => "deliverable missing: " + m) } : {}),
    },
    failed: false,
    missing,
  };
}

/**
 * 并行派发 + allSettled 收集 + 交付结算。
 * @returns results（派发序）+ partialMembers（部分交付成员清单）+ failedCount
 */
async function collectMembers(opts) {
  const tasks = opts.tasks;
  const label = opts.label;
  opts.log(label + " 开始，tasks=" + tasks.length);

  const rawResults = await dispatchMembers({ tasks, label, agent: opts.agent, parallel: opts.parallel });

  const results = [];
  const partialMembers = [];
  let failedCount = 0;
  for (let i = 0; i < rawResults.length; i++) {
    const r = rawResults[i];
    const member = tasks[i];
    const deliverables = member.deliverables;
    if (!r || r.status === "failed" || r.error) {
      results.push(settleFailedMember(member.task, i, r, deliverables));
      failedCount++;
    } else if (deliverables !== undefined) {
      const settled = settleDeliverablesMember(member.task, i, r, member);
      results.push(settled.entry);
      if (settled.failed) {
        failedCount++;
      } else if (settled.missing.length > 0) {
        partialMembers.push({ taskIndex: i, missing: settled.missing });
      }
    } else {
      results.push(settleOkMember(member.task, i, r));
    }
  }
  if (failedCount === tasks.length) {
    // 全部成员失败 → run failed（终局通知带 NOT task completion 指引）
    throw new Error(label + ": all tasks failed (" + failedCount + "/" + tasks.length + ")");
  }
  opts.log(label + " 收集完成：ok=" + (tasks.length - failedCount) + " failed=" + failedCount);

  return { results, partialMembers, failedCount };
}

// ── 通知体积：results 序列化前保序截断 ─────────────────────
// 壳侧 MAX_RESULT_LENGTH 机制在 workflow-notify.ts（通知序列化预算）；模板侧只做保序截断：
// taskIndex/status/fullReportPath/error（归因与恢复侧）恒完整，summary（体积大头）
// 先让出、task 文本次之；截断发生置 outcome 顶层 truncated: true
const RESULTS_BUDGET_CHARS = 8000;

/** 单条映射：keepTask=false 丢 task 文本、keepSummary=false 丢 summary；
 *  taskIndex/status/fullReportPath/error（归因与恢复侧）与 observations
 *  （交付缺项观察，§3.3.10 归因侧）恒完整。
 *  task 用 delete 而非不写 key，保持与最小条目形态相同的 key 插入顺序。 */
function projectEntry(r, keepTask, keepSummary) {
  const entry = { task: r.task, taskIndex: r.taskIndex, status: r.status };
  if (keepSummary && typeof r.summary === "string") entry.summary = r.summary;
  if (typeof r.fullReportPath === "string") entry.fullReportPath = r.fullReportPath;
  if (r.error !== undefined) entry.error = r.error;
  if (r.observations !== undefined) entry.observations = r.observations;
  if (!keepTask) delete entry.task;
  return entry;
}

// 保序降级阶梯：预算耗尽时先丢 summary（体积大头），仍超再让出 task 文本
const FIT_LADDER = [[true, true], [true, false], [false, false]];

function fitResultsInBudget(items) {
  if (JSON.stringify(items).length <= RESULTS_BUDGET_CHARS) {
    return { results: items, truncated: false };
  }
  const fitted = [];
  let used = 2; // "[]" 边界
  for (const r of items) {
    let entry;
    for (const [keepTask, keepSummary] of FIT_LADDER) {
      entry = projectEntry(r, keepTask, keepSummary);
      if (used + JSON.stringify(entry).length + 1 <= RESULTS_BUDGET_CHARS) break;
    }
    used += JSON.stringify(entry).length + 1;
    fitted.push(entry);
  }
  return { results: fitted, truncated: true };
}

/**
 * 组装 run 终局 outcome（模板 return 值）。
 *
 * @param taskCount  成员总数（缺省 results.length——parallel 归一化保证等长，
 *                   显式传入以 tasks 为权威源）
 * @param aggregateOut 可选归约结论（fan-out 模板专属段产物；batch 模板不传 =
 *                     outcome 无 aggregate 字段——纯收集终态）
 */
function buildOutcome(opts) {
  const results = opts.results;
  const partialMembers = opts.partialMembers;
  const failedCount = opts.failedCount;
  const label = opts.label;
  const aggregateOut = opts.aggregateOut;
  const taskCount = typeof opts.taskCount === "number" ? opts.taskCount : results.length;

  const aggregateFailed = aggregateOut !== undefined &&
    typeof aggregateOut !== "string" &&
    typeof aggregateOut.error === "string";

  const fitted = fitResultsInBudget(results);

  const outcome = {
    status: failedCount > 0 || aggregateFailed ? "partial" : "ok",
    results: fitted.results,
  };
  if (aggregateOut !== undefined) {
    outcome.aggregate = aggregateOut;
  }
  if (fitted.truncated) {
    outcome.truncated = true;
  }
  // [subagent-observability §3.3.10/UC-11] 部分交付成员 + 未满足 deliverable 清单进
  // run 终局帧（部分交付成员不进失败集合、无 cause——独立承载「哪个成员缺哪项」）。
  // 条件式落字段：无部分交付时缺席 = 缺省语义（不传 deliverables 的存量形态无此键）。
  if (partialMembers.length > 0) {
    outcome.partialMembers = partialMembers;
  }
  // partial 收尾提示只重派失败 taskIndex 对应的成员（一次恢复查询 + 局部重派纪律）
  outcome.message = label + " 完成：" + taskCount + " 任务（失败 " + failedCount + "）" +
    (failedCount > 0 ? "；只重派失败 taskIndex 对应的成员，勿全批重跑" : "") +
    (partialMembers.length > 0 ? "；部分交付 " + partialMembers.length + " 成员（缺项见 partialMembers）" : "") +
    (aggregateOut !== undefined ? " → 已归约" : "");

  return outcome;
}

// 导出面 = 三个编排入口（模板只消费这三个）。RESULTS_BUDGET_CHARS 是内核内部预算
// 常量（通知体积保序截断），不做导出——无契约消费者；其值由 batch-script.test.ts
// 直接 require 本模块文件断言（锁常量而非锁导出面）。
module.exports = {
  parseTasks,
  collectMembers,
  buildOutcome,
};
