// src/reconcile-edge.ts
//
// 切回边沿对账转发注册槽（completion-signal-delivery D8② 三入口同构的跨扩展
// 接线件）：`__taiji_bg_reconcile__` 内部命令（切回补强边沿——taiji runtime 在
// getCommands 时按节流触发，覆盖「切走切回同进程重挂接、session_start 不重发」
// 场景）的注册方是 @zhushanwen/pi-base-tool-enhance，而 session-manager /
// subagent-workflow 两域的对账编排在各自扩展内装配（deps 需当前 pi / session
// entries / 域闭包状态，外部无法直构）。subagent 域的同类转发走 SubagentService
// 进程单例（base-tool-enhance 直依 subagent-core，A5 先例）；两域与
// base-tool-enhance 无依赖边（跨扩展依赖通道不存在），本槽作为三方共同依赖包
// 内的进程级转发点补上该通道：两域 extension load 时订阅，切回 handler 派发。
//
// 生命周期（与 pi.on 装配期订阅的 RL13 论证同款）：订阅点 = extension load
// 装配期，同域 key 重复订阅覆盖前值——同进程 session 替换会重建 eventBus 并
// 重新 load extension，新实例的订阅覆盖旧实例（旧闭包捕获的 stale pi 随之被
// 替换），无死 handler 累积。槽本体挂 globalThis（C-ext-06：Symbol.for +
// 进程级槽，防 jiti 多实例模块图槽分裂——delivery-port.ts 的
// DELIVERY_PORT_SLOT_KEY 同款形态）。

/** 切回边沿上下文（派发方 handler ctx 的结构化最小子集——本包不依赖 pi 类型，
 *  与 ExtensionCommandContext.sessionManager 结构兼容；getEntries / getSessionFile /
 *  getSessionId 三成员即两域对账 deps 的全部 ctx 侧输入）。 */
export interface ResumeReconcileContext { // oe-exempt:20261102:framework:跨扩展契约接口（delivery-port 定义、两消费域结构兼容锚，非单实现抽象）
	sessionManager: {
		getEntries(): readonly unknown[];
		getSessionFile(): string | undefined;
		getSessionId(): string;
	};
}

/** 域订阅回调（切回边沿 → 该域对账编排；域侧自带围栏——对账编排内部全量
 *  catch，失败 warn 留痕后下一对账边沿幂等重查，异常原则上不向派发方传播，
 *  本侧围栏只兜「域侧围栏漏网」的防御位）。 */
export type ResumeReconcileListener = (ctx: ResumeReconcileContext) => void;

/** 进程级槽键（C-ext-06：Symbol.for + globalThis，防 jiti 多实例槽分裂）。 */
export const RESUME_RECONCILE_SLOT_KEY = Symbol.for(
	"@zhushanwen/pi-delivery-port.resumeReconcile",
);

type ResumeReconcileSlot = { listeners: Map<string, ResumeReconcileListener> };

function getSlot(): ResumeReconcileSlot {
	// globalThis 无 symbol 索引签名，Reflect 安全读写（delivery-port.ts getSlot 同款）
	let slot = Reflect.get(globalThis, RESUME_RECONCILE_SLOT_KEY) as
		| ResumeReconcileSlot
		| undefined;
	if (!slot) {
		slot = { listeners: new Map() };
		Reflect.set(globalThis, RESUME_RECONCILE_SLOT_KEY, slot);
	}
	return slot;
}

/**
 * 域订阅（extension load 装配期调用；同域重复订阅覆盖前值——reload 后新闭包
 * 覆盖旧闭包，防 stale pi 转发）。domain = 域名单（如 "session-manager" /
 * "subagent-workflow"），仅作槽内键与失败报告的归因标签。
 */
export function subscribeResumeReconcile(
	domain: string,
	listener: ResumeReconcileListener,
): void {
	getSlot().listeners.set(domain, listener);
}

/**
 * 切回边沿派发（`__taiji_bg_reconcile__` handler 调用）：逐域同步调用，单个
 * listener 异常不阻断其余域；失败逐域收集返回，由派发方 warn 留痕（本包无
 * logger 依赖——错误语义不吞：返回清单即报告通道）。无订阅（两域扩展未启用 /
 * 装配前）= 空清单，缺席语义非错误（与 SubagentService 单例缺席语义同族）。
 */
export function dispatchResumeReconcile(
	ctx: ResumeReconcileContext,
): Array<{ domain: string; error: unknown }> {
	const failures: Array<{ domain: string; error: unknown }> = [];
	for (const [domain, listener] of getSlot().listeners) {
		try {
			listener(ctx);
		} catch (err) {
			failures.push({ domain, error: err });
		}
	}
	return failures;
}

/** 测试隔离：清空全部域订阅（生产禁用——订阅生命周期与 extension load 一致）。 */
export function _resetResumeReconcileForTest(): void {
	getSlot().listeners.clear();
}
