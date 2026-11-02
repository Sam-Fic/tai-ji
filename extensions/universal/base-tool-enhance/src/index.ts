/**
 * @zhushanwen/pi-base-tool-enhance 入口。
 *
 * M1：同名 override pi 内置 bash 工具 + 前台委托官方工厂 + 工具报错审计 hook（D11）。
 * M2：background 任务核心生命周期——bash background 分支（spawn 后台 + registry +
 * 模块级单例任务表）、bash_output / bash_kill 工具、进程退出收殓、subagent 降级。
 * M3：pending-notifications 通知接入——load 时刷新通知通路的 pi 引用（D17
 * session 替换接管）+ 挂 exit 边沿通知回调（unregister emit + 完成通知经 port.deliver
 * 入账，缺席兜底 sendMessage steer）+ session_start 对账 + 收殓终态通知补投
 * （对账路径 = 唯一生产者，session_start 差集逐任务 port.deliver，幂等由 port
 * seenIds + 内核三级判重承管——unified-delivery 波 3；投递统一化设计的现行登记处 = ADR-0074 与 docs/CONTEXT.md『统一投递』段）。
 * 维护链三触发点（completion-signal-delivery D2/D7）：session_start 事件 +
 * `__taiji_bg_reconcile__` 切回内部命令（taiji runtime 在 getCommands 时补触发，
 * 覆盖「切走切回同进程重挂接、session_start 不重发」场景；60s 节流窗已随 ADR-0122
 * 防御机制清查退役，高频触发由三判据早退承担零成本）+ agent_settled 回合收尾事件
 * （进程存活形态的对账兜底边沿，注册点见下方 agent_settled 订阅注释）。
 * 切回入口同时补挂三域对账（subagent 域 = completion-signal-delivery V4b 入口③，A5 缺陷
 * 修复；session-manager / subagent-workflow 两域 = D8② 三入口同构的切回边沿）：
 * subagent 域的 session_start / agent_settled 两入口在服务内自挂，切回是唯一需要扩展侧
 * 补挂的边沿——经进程单例 SubagentService.runNotifyReconcileMaintenance 转发
 * （reason="resume"；单例缺席 = 对账不挂，缺席语义非错误）；session-manager /
 * subagent-workflow 两域与 base-tool-enhance 无依赖边（跨扩展依赖通道不存在），
 * 经 pi-delivery-port 进程级注册槽 dispatchResumeReconcile 派发（两域 extension
 * load 时 subscribeResumeReconcile 订阅；槽内逐域围栏，失败 warn 不阻断）。
 * 收殓下沉（u-bte-remove）：M5 孤儿收殓已移交 taiji runtime（background-task-
 * reaper 双触发点——session 销毁时 + 启动期兜底扫描，设计 file-lock-unification-
 * and-reaper-sink.md §3.2 D2），extension 不再做全局扫描/全局锁；session_start
 * 维护链仅剩 M3 对账（session 级豁免类，每 session_start 执行，D3 粒度段）。
 * 白名单与配置体系（M4 已交付）经 bash-tool execute 读时加载接入。
 */

import type {
	AgentSettledEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { bindDeliveryPort, createPiDeliveryPortHost, dispatchResumeReconcile } from "@zhushanwen/pi-delivery-port";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { getSubagentService } from "@zhushanwen/subagent-core";

import { createBashOutputToolDefinition } from "./bash-output-tool.ts";
import { createBashKillToolDefinition } from "./bash-kill-tool.ts";
import { createBashOverrideToolDefinition } from "./bash-tool.ts";
import { handleTaskExit, refreshPiReference } from "./background/notify.ts";
import { installProcessExitGuard } from "./background/process-exit-guard.ts";
import { reconcilePendingEntries } from "./background/pending-reconcile.ts";
import { resolveTaijiDataDir } from "./background/registry.ts";
import { setOnTaskExit } from "./background/exit-collector.ts";
import { setupToolErrorAudit } from "./tool-error-audit.ts";
import { registerUserBashInterceptor } from "./user-bash-interceptor.ts";

const logger = getLogger("base-tool-enhance");

export default function baseToolEnhanceExtension(pi: ExtensionAPI): void {
	// D17 pi 引用刷新：同进程 session 替换（/fork、选择器切换、RPC session.*）→ 新
	// ResourceLoader/eventBus + extension 重新 load → 本调用把通知通路（notify.ts
	// 模块级引用）切到新 pi——任务发起于旧 session 而完成通知投递新 session。
	refreshPiReference(pi);
	// ⑧⑨ exit 事件边沿 → pending:unregister emit + 完成通知经 port.deliver 入账
	//（缺席兜底 sendMessage steer；kill 路径不投递完成通知，见 notify.ts 单点归属
	// 规则）。重复 load 幂等（覆盖同一回调）
	setOnTaskExit(handleTaskExit);
	// 同名 "bash" 覆盖内置工具（pi agent-session _refreshToolRegistry：custom 定义后注册者胜）
	pi.registerTool(createBashOverrideToolDefinition());
	// 查询 / 终止工具（D9：独立小工具，kill 与查询权限语义分离）
	pi.registerTool(createBashOutputToolDefinition());
	pi.registerTool(createBashKillToolDefinition());
	// 进程级收殓（D12）：只认 process 信号/退出，绝不在 session_shutdown / dispose 路径
	installProcessExitGuard();
	// `!` 命令 user_bash 拦截（completion-signal-delivery M2 / U2，D3/D4）：extension
	// load 时注册（事件每次 bash RPC 都发，handler 内部按包装格判定分流，fail-open
	// 返回 undefined 走官方执行）；转后台登记链同进程可达（task-store 模块级单例）
	registerUserBashInterceptor(pi);
	// unified-hooks 退役承接：工具报错审计（D11 落点）
	setupToolErrorAudit(pi);
	// pending 对账（M3）：任意 session 启动触发（startup/reload/new/resume/fork 全
	// reason）。孤儿收殓已下沉 runtime（见文件头），本链无全局扫描。
	// handler 返回维护链 promise（维护链 async 形态，pi runner emit await
	// handler 消费该 promise，runner.js:632），
	// promise 由其消费不产生 unhandled rejection；错误在维护链内 async 捕获
	pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
		// 统一投递端口装配（unified-delivery 波 2 装配点，现行登记处 = ADR-0074 与
		// docs/CONTEXT.md「统一投递（unified delivery，v3）」段）：custom 投递路径
		// 唯一执行者、恒装配（本扩展为 infrastructure 档必载——两套装配并存违背
		// 装配单一归属）。每次 session_start 重绑（dispose 旧实例 + 新实例
		// recover 差集重放）；消费方（notifier / session-manager / workflow，
		// bash 随波 3）经 getDeliveryPort() 进程级槽获取（C-ext-06），缺席时按
		// 各自兜底 + warn。
		bindDeliveryPort(
			createPiDeliveryPortHost(pi, ctx, {
				component: "base-tool-enhance",
				logger,
				// [subagent-observability §3.3.7③] 原 hasRunningBackground（攒批条件谓词）
				// 已随攒批窗整机制退役删除——投递边沿即投，装配宿主无合批控制面。
			}),
		).recover();
		return runReconcileMaintenance(pi, ctx, event.reason);
	});
	// agent_settled 回合收尾边沿对账（completion-signal-delivery D2/D7②）：进程存活
	// 形态（转换窗内单次重提失败等）的兜底恢复入口——同进程不重启不切回时，
	// session_start 与 __taiji_bg_reconcile__ 两入口均不可达，回合收尾是仅剩的确定性
	// 事件边沿（ADR-0122 保留白名单同族：事件驱动、判据现算磁盘事实，无定时器）。
	// 编排与 session_start / 切回互调同一对账函数（RL12 判据单一）；高频边沿的常态
	// 零成本由判据预检短路保证（pending-reconcile：registry 量级扫描先行，无候选
	// 不触 entries 全扫描——设计检查点登记的成本下界）。
	// 订阅生命周期（RL13）：本注册点 = extension load 装配期，每 pi 实例恰一次；
	// 同进程 session 替换会重建 eventBus 并重新 load extension（notify.ts 文件头
	// D17 登记的同一机制），旧实例连同其订阅一并消亡、新实例重新注册——无死
	// handler 累积（构造性成立；pi.on 返回退订函数的契约由 delivery-port 装配侧
	// 同源消费，本订阅随 pi 实例生命周期，无独立退订状态需要管理）。
	pi.on("agent_settled", (_event: AgentSettledEvent, ctx: ExtensionContext) => {
		return runReconcileMaintenance(pi, ctx, "agent_settled");
	});
	// 第二触发点（会话重挂接补强）：桌面「切走会话再切回」是同进程重新
	// 挂接——pi 进程存活、不重发 session_start（真机实证），挂在 session_start 上的
	// 维护链在「投递失败但进程存活」场景（设计 G2 核心场景）永不触发。taiji runtime 在
	// getCommands（切回后 renderer 主动拉取命令的必经查询）时经 client.prompt 发起本
	// 命令（fire-and-forget；原 60s per-session 节流窗已随 ADR-0122 防御机制清查退役，
	// 高频触发由维护链三判据早退承担零成本），handler 调同一维护函数（reason 传
	// 'resume' 语义）。`/__` 双下划线前缀 = 内部命令（前端 internal-command-filter 过滤
	// 不显示）；无待补任务时维护链三判据早退，零输出零 turn。
	// subagent 域补挂（V4b 入口③，A5 缺陷修复）：本命令是切回边沿唯一触发源，
	// bash 域维护链（runReconcileMaintenance）只覆盖本域；subagent 域对账经进程单例
	// 转发（runNotifyReconcileMaintenance → NotifyHost 对账闭包，事实源与补投出口在
	// 服务内装配，扩展侧无法直构 deps）。只挂本入口不挂 session_start / agent_settled
	// ——那两边沿服务内已自挂（revive / agent_settled 订阅），重复转发 = 同边沿双派发。
	// 单例缺席（session_start 前进程形态 / 无 subagent 域宿主）= 对账不挂，非错误。
	// session-manager / subagent-workflow 两域补挂（D8② 三入口同构的切回边沿，U2
	// 修复）：两域同样只在服务/扩展内自挂 session_start / agent_settled 两入口，切回
	// 边沿经 pi-delivery-port 进程级注册槽派发（两域 extension load 时订阅；本扩展
	// 与两域无依赖边，槽是三方共同依赖包内的转发通道）。槽内逐域围栏：失败清单
	// 逐条 warn（域侧围栏漏网的防御位），不阻断 bash 域维护链；空槽（两域未启用）=
	// 缺席语义非错误。
	pi.registerCommand("__taiji_bg_reconcile__", {
		description:
			"Internal: rerun pending background-task reconcile + completion-notify redelivery (triggered by taiji runtime on session resume; session_start does not refire for same-process reattach)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			getSubagentService()?.runNotifyReconcileMaintenance("resume");
			for (const failure of dispatchResumeReconcile(ctx)) {
				logger.warn("resume reconcile listener failed; that domain retried at next reconcile edge", {
					detail: { domain: failure.domain, err: toErrorMessage(failure.error) },
				});
			}
			return runReconcileMaintenance(pi, ctx, "resume");
		},
	});
}

/**
 * 对账维护链（M3 对账 + 补投——收殓下沉 runtime 后，u-bte-remove）。
 *
 * 三入口共用本函数（completion-signal-delivery D2/D7② 编排互调）：① session_start
 * 事件（reason 透传）；② `__taiji_bg_reconcile__` 内部命令（runtime 切回触发，reason
 * 恒 "resume"）；③ agent_settled 回合收尾（reason 恒 "agent_settled"——进程存活形态
 * 的兜底恢复入口）。维护逻辑与幂等性对三入口完全一致（RL12 判据单一：三入口对同一
 * 事实状态产出同一判定；跨边沿双投由 port 幂等吞并，见 pending-reconcile.ts 头注）。
 *
 * 执行形态：async——维护链内部全同步（补投经 port.deliver 同步受理，见
 * pending-reconcile.ts ReconcilePi 注释的适配登记）。错误吞掉记 warn（对账/补投失败无害：僵尸 register 停留差集、
 * 待补候选三判据仍命中，下一对账入口幂等重查）——async 捕获防 unhandled
 * rejection 复刻已否决的 fire-and-forget 失效形态。
 *
 * 频率语义（D3 检查粒度）：对账是 session 级操作（读当前 session 的 pi entries +
 * 当前 session 的 registry，appendEntry 幂等），属豁免类不挂进程级 once flag，
 * 每次边沿都执行。桌面端每次激活是 startup+resume 双派发（factory 二调
 * 下 handler 还会累积），对账多次执行幂等无害（补投的重复穿透由 port 幂等接管：
 * 同激活双派发的第二路 deliver 同 id 被 port 吞、已送达任务由送达痕迹判据阻断，
 * 详见 pending-reconcile.ts 头注幂等体系节）；反之若挂进程级 flag，startup 消费
 * flag 后目标 session 的对账将永远被跳过（M3 对账在主链路被禁用，此处是唯一执行点）。
 * agent_settled 高频边沿的常态成本由判据预检短路兜住（registry 量级扫描先行，
 * 无候选不触 entries 全扫描）。
 *
 * 入口无条件 debug 日志（S6 观测通道）：每次 handler 派发都打，含 reason——
 * TAIJI_AGENT_DEBUG=1 时落 extension 日志（默认 no-op），供「factory 二调下维护链
 * 行为」验收观测派发次数。变更登记（u-bte-remove）：reap 下沉 runtime 后本链
 * 不再含全局扫描/全局锁，原 reapSkipped 字段随 reap 调用一并移除——对应 S6
 * 场景「批 2 后 reap 类操作不再执行」。
 */
async function runReconcileMaintenance(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reason: SessionStartEvent["reason"] | "agent_settled",
): Promise<void> {
	logger.debug("reconcile maintenance dispatch", {
		detail: { reason },
	});
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		// 补投判据事实源磁盘化（A1 产品缺陷修复）：getSessionFile() 传 session JSONL
		// 路径，痕迹/日志判据读落盘条目而非内存账——pi _appendEntry persist 失败
		// 无回滚的幽灵内存 entry 曾使 journaled 误真、补投静默失效（机制见
		// pending-reconcile.ts 文件头「判据事实源磁盘化」段）；no-persist 形态
		// getSessionFile() 返回 undefined，对账侧退化内存账（现状行为）。
		await reconcilePendingEntries(
			pi,
			resolveTaijiDataDir(),
			sessionId,
			ctx.sessionManager.getEntries(),
			undefined,
			ctx.sessionManager.getSessionFile(),
		);
	} catch (err) {
		// 对账失败无害：僵尸 register 停留差集，下一 session_start 幂等重查
		logger.warn("session_start pending reconcile failed; zombies retried next session start", {
			detail: { err: toErrorMessage(err) },
		});
	}
}
