/**
 * subagent-workflow Extension — Factory（extension 装配点）
 *
 * 合并 @zhushanwen/pi-subagents + @zhushanwen/pi-workflow 为统一包。
 * 注册项：7 tool（subagent_start / subagent_manage / subagent_message + subagent_batch
 * + workflow_run / workflow_control + workflow-script）+ 3 command（subagents + workflows + subagent-model）
 * + messageRenderer（subagent-bg-notify）+ session 事件。
 *
 * 包内结构（执行运行时已迁 packages/subagent-core，本包只留注册点与宿主适配）：
 *   interface/           → 注册胶水（tools / commands / TUI 渲染 / GUI mappers）
 *   host/                → pi 宿主端口实现（HostServices / NotifyDomain 的 pi 侧兑现）
 *   injectors/           → 提示注入器（engine-awareness / model-list / resource-list …）
 *   session-lifecycle.ts → 会话生命周期装配 seam（测试可注入 fake 依赖）
 *   workflow-events.ts   → workflow 域事件族装配 seam（7 个 pi.on handler + deps 装配）
 *
 * 本文件 = 组合根：只留注册（tools / commands / renderer）与
 * 装配接线（core 端口 / 注入器 / 两个 seam 调用）。
 *
 * 架构导航见 docs/extensions/subagents/architecture.md。
 *
 * 设计基线：D-004（旧包不动）/ ADR-025（进程内执行）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { setPiHandle } from "@zhushanwen/pi-extension-logger";

// ═══ core 宿主端口接线（subagent-core 包抽离 u0-wire；实现见 src/host/pi-host.ts） ═══
import { configureCore } from "@zhushanwen/subagent-core";
import { configureNotifyDomain } from "@zhushanwen/subagent-core";
import { createPiHostServices, createPiNotifyDomainPorts } from "./host/pi-host.ts";

// ═══ 经 core barrel 消费执行域（执行运行时住 packages/subagent-core） ═══
// [U7] 引擎列表状态文件（registry → engines.json，GUI 引擎选择器数据源）
import { syncEnginesFile } from "@zhushanwen/subagent-core";
// [W11/DoD#5] registerPiEngine（inproc 'pi' 注册）已随内建引擎删除：registry 'pi'
// 由下方 syncEnginesFile 的三级发现装载 cli descriptor（engines/zcode 同理由
// registerZcodeEngine D8 薄壳承载）。
// [P3 引擎接线] 组合根登记 'zcode' 引擎（D8 薄壳：vendored 定位 cli descriptor；
// engineDataDir 默认走 common/data-dir SSOT）
import { registerZcodeEngine } from "@zhushanwen/subagent-core";
// bg-notify 送达通道 customType（notify 词表单源，与 shared/runtime/core 消费侧同源）
import { SUBAGENT_BG_NOTIFY_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";
// [engine-awareness U3/D7-④] per-turn 引擎检测编排 + before_agent_start 链尾接线
import { setupEngineAwarenessInjector } from "./injectors/engine-awareness.ts";
import { setupModelListInjector } from "./injectors/model-list-injector.ts";
import { setupSubagentListInjector } from "./injectors/subagent-list-injector.ts";
import { setupWorkflowListInjector } from "./injectors/workflow-list-injector.ts";
import { renderBgNotifyMessage } from "./interface/gui/bg-notify-render.ts";
import { registerWorkflowsCommand } from "./interface/command/commands.ts";
import { registerSubagentTool } from "./interface/tool/subagent-tool.ts";
// ═══ interface/ 层（tools/commands/tui 合并） ═══
import { registerSubagentsCommand } from "./interface/command/subagents.ts";
// [subagent-model-switch U6] 模型切换 RPC 通道消费端（§7.1.1，runtime 出站点 prompt 触达）
import { registerSubagentModelCommand } from "./interface/command/subagent-model.ts";
import { registerSubagentsTool } from "./interface/tool/tool-subagents.ts";
import { registerWorkflowTool } from "./interface/tool/tool-workflow.ts";
import { registerWorkflowScriptTool } from "./interface/tool/tool-workflow-script.ts";
// ═══ workflow 域事件族装配 seam（7 个 pi.on handler + makeDeps/lazyDeps；
// 与 session-lifecycle.ts 同构，D2 原样搬移 + lazyDeps 样板收敛） ═══
import { setupWorkflowDomain } from "./workflow-events.ts";

// ── Factory ──────────────────────────────────────────────────

export default function subagentsWorkflowExtension(pi: ExtensionAPI): void {
  // 注入 pi handle 给全局 extension-logger，让深层代码（best-effort / error-recovery）
  // 的 getLogger("subagents") 也能走 appendEntry。
  setPiHandle(pi);

  // [u0-wire] core 宿主端口接线：本波端口尚无 core 消费方（消费切换在 u0-log /
  // u0-data-discovery / u0-notify 波次），接线本身零行为变化。紧随 setPiHandle——
  // core log 桥接走 pi-extension-logger，其 pi handle 先注入则配置完成即桥接链路
  // 完整；且先于任何可能消费 core 端口的初始化逻辑（引擎登记等）。缺省态若被消费，
  // dataRoot 抛 core_host_not_configured（§3.4），接线后不再可达。
  configureCore(createPiHostServices());
  // [F1] 通知域端口无 factory 基准参数：跨 session 残留过滤基准（W4 读侧过滤②）
  // 由 core 读侧 per-call 提供（session-pending 读「被读 entries 所属 session」）——
  // 本装配在扩展启动时执行一次，session id 逐 session 变化，factory 定型表达不了
  // per-call 基准（生产装配也从未传参，防御曾实际缺基准）。
  configureNotifyDomain(createPiNotifyDomainPorts());

  // [W11/DoD#5] 'pi' 的 inproc 注册（registerPiEngine）已删除——缺省引擎 'pi' 的
  // registry 条目由下方 syncEnginesFile 内的三级发现装载（cli descriptor，幂等），
  // P4 配置路由（agent frontmatter engine 字段 + 三层优先级）在其上消费；chat 域
  // pi 引擎不经 registry（SubagentService 自持 DI，W11 主 agent 裁决的临时豁免范围）。
  // [P3 引擎接线] 登记 'zcode'（幂等同上）。D8 薄壳：vendored 定位 cli descriptor。
  registerZcodeEngine();

  // [U7b] 引擎列表在 extension 模块加载时即同步 engines.json（不等 session_start——
  // 用户体验拍板 2026-08-25：taiji 打开后激活任意 session 的第一时间（含 TUI 等价
  // 场景）GUI 引擎选择器就该有数据；session_start 处保留幂等重写兜底 jiti 双路径/
  // 模块重载场景的刷新）。
  // [skill-reload D9] oncePerProcess 不提权（用户裁决）：检查 Map 是 ext-guards
  // 模块级状态，jiti reload 后归零 → 进程级维护跨 reload 幂等重跑属预期，不为此
  // 提权 globalThis。factory 期引擎重注册的危险面已由 D2b 消除——
  // registerEngineDescriptor 稳定标识等价则保留单例不 dispose（幂等重注册，杀令 B
  // 拆除），本调用点的 discovery 面与上方 registerZcodeEngine 都经此入口；标识变化
  // （引擎包真升级）仍走现状 dispose。恢复误杀面由 session_start(reason==='reload')
  // 门控消除（D4，session-lifecycle.ts recoverCrashedRuns 检查调用点的
  // [skill-reload D4] 注释有对应登记）。
  syncEnginesFile(getAgentDir());

  // ════════════════════════════════════════════════════════════
  //  subagents 域：tool + command + messageRenderer
  // ════════════════════════════════════════════════════════════
  registerSubagentTool(pi);
  registerSubagentsCommand(pi);
  registerSubagentModelCommand(pi);
  pi.registerMessageRenderer(SUBAGENT_BG_NOTIFY_CUSTOM_TYPE, renderBgNotifyMessage);

  // ════════════════════════════════════════════════════════════
  //  injectors：before_agent_start 注入 <available_subagents> + <available_workflows>
  //  + <available_provider_models>（模型列表供派发时指定 model 参数；与 subagent/workflow 清单对称）
  //
  //  归位自 unified-hooks（subagent-list-injector）+ 新增 workflow-list-injector。
  //  injector 是 subagent-workflow 的内聚功能（让 LLM 知道有哪些 agent/workflow
  //  可用），与同包 resource-discovery 同包后直接 import，消除跨包依赖（ADR-031）。
  //  pi 串联多 before_agent_start handler：各自返回 systemPrompt 链式叠加。
  // ════════════════════════════════════════════════════════════
  setupSubagentListInjector(pi);
  setupWorkflowListInjector(pi);
  setupModelListInjector(pi);

  // ════════════════════════════════════════════════════════════
  //  workflow 域：per-factory 状态 + 7 个 session/model 事件 + deps 装配
  //
  //  状态创建（lsRef / notifiedRunIds / workerHost / registry / sessionState）、log、
  //  makeLifecycleDeps / makeDeps、7 个 pi.on handler、getWorkflowDeps 检查 +
  //  lazyDeps 已收编 workflow-events.ts（事件族 seam，与 session-lifecycle.ts 同构；
  //  7 个 handler 的注册相对顺序原样保留）。此处仅接线——在途上报（createInFlightReporter
  //  + setInFlightListener 登记与 attach/detach 驱动）同为该 seam 家内装配。
  // ════════════════════════════════════════════════════════════
  const workflow = setupWorkflowDomain(pi);

  // ════════════════════════════════════════════════════════════
  //  [U7 + engine-awareness U3] before_agent_start：引擎感知注入（链尾注册，D7——
  //  段内容变化只断 system prompt 尾部 cache 前缀）。
  //  D7-④：接线收编于 engine-awareness.ts 的 setupEngineAwarenessInjector（与上方
  //  三个 setup* 同形，注入链序由调用先后表达）；per-session lastEngine 经
  //  sessionState 存取器注入。编排/渲染/链尾依据的完整注释随迁至该函数。
  // ════════════════════════════════════════════════════════════
  setupEngineAwarenessInjector(pi, {
    getLastEngine: (sid) => workflow.state.sessionState.get(sid)?.lastEngine,
    setLastEngine: (sid, engine) => {
      const state = workflow.state.sessionState.get(sid);
      if (state) state.lastEngine = engine;
    },
  });

  // ════════════════════════════════════════════════════════════
  //  Tools（7 个）+ Commands（3 个）—— 注册点盘点
  //
  //  全包 7 tool：本段注册 4（workflow_run + workflow_control 经 registerWorkflowTool、
  //  subagents 经 registerSubagentsTool、workflow-script 经 registerWorkflowScriptTool）；
  //  其余 3（subagent_start / subagent_manage / subagent_message 经 registerSubagentTool）
  //  在上方「subagents 域」段（factory 期）注册。3 command：subagents / subagent-model
  //  同在 subagents 域段，workflows 在本段段尾。
  //
  //  lazyDeps / isScriptRunning / registry 由 workflow-events.ts 装配结果提供。
  //  guard：workflow tool 与 subagent_batch（批量派发入口）共用同一 guard——两者是同一条
  //  runWorkflow 管道的入口，单检查防双 guard 语义漂移（D3 复用裁决）。
  // ════════════════════════════════════════════════════════════
  const guard = { isProcessing: false };

  registerWorkflowTool(pi, workflow.lazyDeps, guard);
  registerSubagentsTool(pi, workflow.lazyDeps, guard);
  registerWorkflowScriptTool(pi, workflow.state.registry, workflow.isScriptRunning);

  registerWorkflowsCommand(
    pi,
    () => {
      const state = workflow.state.sessionState.get(workflow.state.lsRef.lastSessionId);
      return state?.runs ?? new Map();
    },
    workflow.lazyDeps,
  );
}

// ============================================================
// 进程级单例（channel registry + dialog queue）
// ============================================================

// channel registry 经 channel-registry-access.ts 公开访问（跨扩展 API）。
// dialog queue 单例随 session_start 装配域迁居 session-lifecycle.ts
// （getOrCreateDialogQueue；消费方 = 该文件 createOrReuseServices + workflow-events.ts
// session_shutdown），Symbol key 单定义点随迁，避免双份定义漂移。

// 跨扩展 channel handler 注册入口已收敛到 core 深路径
// `@zhushanwen/subagent-core/execution/assembly/channel-registry-access.ts`
// （getOrCreateChannelRegistry / UiChannelRegistry / ChannelHandler）。
// 历史上的包根 re-export 已删：ask-user 等跨扩展消费者经 globalThis 握手
// （DIALOG_QUEUE_KEY 同款进程级单例），不再经包根 import 消费本模块。
