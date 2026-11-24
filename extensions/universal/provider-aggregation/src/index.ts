/**
 * provider-aggregation —— pi 进程内的模型路由扩展（设计 D1/D5/D6/D7/D9；单元 U2）。
 *
 * 职责：把 providers.json 顶层 routes 域（@taiji/shared AggregationRoutesFile，唯一权威）
 * 派生为 pi 虚拟模型注册（AGGREGATION_PROVIDER_ID 承载，每条路由一个条目），并在每个
 * 请求发起前从端点中选出本次实际发往的物理模型：非 retry 求值按路由条件（时间窗 / 额度）
 * 硬闸 + burnt 软避让（终局 failover，D6 修订方案 B）；retry 求值透传上一失败端点——
 * pi 的重试预算真正打到上游，终局失败（预算用尽）才 burnt 换端点。
 * 注册条目派生规则（id/name/thinkingLevels 并集/contextWindow 最小值）单源在
 * virtual-model-definitions.ts 的 buildVirtualModelDefinitions（本文件 re-export）——
 * RL1/A9 目录一致性对账（m8 aggregation-catalog-consistency.test）以同 fixture 调用
 * 同一函数派生注册条目集，与本注册路径零漂移。
 *
 * 配置生效机制（D1 修订形态——时间机制红线对齐，AS21：无定时器、无 fs.watch）：
 * ① 工厂期注册：扩展工厂函数体内同步读配置并 registerVirtualModel——pi 的 pending
 *    队列在全部工厂返回后、--model 解析之前统一 flush（provider-live-sync 同款先例，
 *    catalog-bridge.ts:8-12）；子 agent spawn --model 命中路由依赖此时点（AS12/GL4）。
 * ② session_start 对账：重读配置，覆盖工厂期之后到会话开始之间的变化——已注册 id
 *    幂等替换、条目消失标记删除态（保持注册）、新增 id 补注册（「下次会话加载可用」
 *    的后半边）；同时为全部条目补齐 contextWindow 元数据（工厂期会话目录未装配，
 *    此时才可解析端点元数据，D4 ⑤/D7）。
 * ③ route 求值前 mtime 检查重读：只处理当前已注册 id——同 id 编辑幂等替换（对运行中
 *    会话下一请求生效，V5）、条目消失标记删除态（本会话保持注册 + 闭包显式失败，
 *    不调 unregister——AS22：未注册虚拟模型在 resolveModel 处抛原始 is not registered，
 *    到不了 route）、配置中新增 id 忽略（运行中新建路由不热注册，D1 ③）。
 *
 * 闭包失败态（D9/AX5——不静默回落）：
 * - enabled=false（停用）：保持注册，route 显式失败「已停用」；
 * - 条目删除：保持注册，route 显式失败「已删除」；同一 id 重新创建后下次求值前重读
 *   以新定义幂等替换，无需换模型即恢复；
 * - 无候选端点：显式失败，逐端点列明落选原因 + 恢复指引（AX5）；
 * - 配置损坏/不可读：保持上一有效注册继续路由（warn 呈报；磁盘隔离与「路由配置已隔离」
 *   呈报是 runtime extras store 的既有语义，扩展侧不重复实现）。
 *
 * 额度数据（D3/SC5，M2 接线）：route 求值时经 QuotaCacheReader 读 quota-cache.json
 * （mtime 门 + 共享新鲜度纯函数过滤，quota-cache-reader.ts），新鲜条目投影为
 * providerId → 快照 map 喂入求值纯函数；读失败/缺失/全过期 = 空快照（额度未知 →
 * fail-open，矩阵行 6/12）。读取只挂 route 求值时点，无定时器（ADR-0190）。
 *
 * 零配置环境（V8/④）：无 routes 域 = 空集 = 零注册零路由闭包，无任何轮询与空闲成本。
 *
 * 目录解析与求值分层（AX3/AX5 与 route-matrix.md 总则 6 的边界）：端点供给侧状态
 * （凭据、provider 启停）不在求值输入；但 route 返回值必须是已注册物理模型——候选端点
 * 在 ctx.modelRegistry 解析不到（provider 已删/模型已移除，即配置层悬空端点）时该端点
 * 本次无法作为返回目标，按「不可解析」落选并继续下一候选。这是返回值构造的结构约束，
 * 不是供给侧预判：我们不读凭据状态、不因 provider 禁用拦截（AS16）。
 *
 * 日志通道 = @zhushanwen/pi-extension-logger（error 落 pi.appendEntry 持久化 +
 * TAIJI_AGENT_DEBUG/TAIJI_AGENT_EXT_LOG 文件日志——pi 不捕获 extension stderr）。
 */

import type { ExtensionAPI, ExtensionContext, ExtensionVirtualModel, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";
import type { AggregationRoute } from "@zhushanwen/extension-protocol/aggregation";
import { RoutesConfigReader, type ConsumedRoutesSectionRead } from "./config-store.ts";
import { QuotaCacheReader } from "./quota-cache-reader.ts";
import {
	decideRoute,
	endpointThinkingLevels,
	memberRef,
	parseFailoverState,
	resolveThinkingLevel,
	MEMBER_BLOCK_REASON_LABELS,
	type MemberBlockReason,
	type RouteEvaluation,
	type RouteFailoverState,
} from "./router.ts";
import {
	buildVirtualModelDefinitions,
	resolveContextWindowFromDirectory,
	type ResolveAggregationContextWindow,
} from "./virtual-model-definitions.ts";

/** RL1/A9 对账导出面：注册条目集派生规则单源（详见 virtual-model-definitions.ts 头注释）。 */
export {
	buildVirtualModelDefinitions,
	resolveContextWindowFromDirectory,
	type AggregationModelDirectorySnapshot,
	type AggregationVirtualModelDefinition,
	type ResolveAggregationContextWindow,
} from "./virtual-model-definitions.ts";

const logger = getLogger("provider-aggregation");

/** 注册状态（每扩展工厂实例一份，闭包共享引用）。 */
interface AggregationState { // oe-exempt:20261106:framework:扩展内部状态聚合契约，单实现为设计终态
	/** 当前保持 pi 注册的路由 id（含停用/已删除态——删除=保持注册，AS22）。 */
	registeredIds: Set<string>
	/** enabled=false 的路由 id：闭包显式失败「已停用」（D9 停用侧）。 */
	disabledIds: Set<string>
	/** 配置中条目已消失的路由 id：闭包显式失败「已删除」（D9 删除侧）。 */
	deletedIds: Set<string>
	/** id → 最后一次有效读到的定义（route 闭包求值用最新定义——编辑对下一请求生效）。 */
	definitions: Map<string, AggregationRoute>
	/**
	 * routeId → memberRef → 链内已观察连续失败次数（闭包内存）。
	 *
	 * 生命周期 = 活跃重试链：retry 透传时递增（bumpChainFailure），终局观察在下一轮
	 * 非 retry 求值读取它判「pi 重试预算是否用尽」。计数本身不持久化——session 历史不记
	 * 瞬态记账；burn 证据（预算用尽的结论）随 burnt 走 router state 持久化。
	 */
	failures: Map<string, ReadonlyMap<string, number>>
}

function createState(): AggregationState {
	return {
		registeredIds: new Set(),
		disabledIds: new Set(),
		deletedIds: new Set(),
		definitions: new Map(),
		failures: new Map(),
	}
}

/** 端点引用不可解析的落选文案（AX5 求值输入内可知：配置引用 + 当前目录快照）。 */
const ENDPOINT_UNRESOLVABLE_LABEL = "端点不在当前模型目录（provider 已删或模型已移除）"

/** 组合单端点落选原因的面向用户文案（矩阵行 10「时间窗外 + 额度低于阈值」形态）。 */
function formatBlockReasons(reasons: readonly MemberBlockReason[]): string {
	return reasons.map(reason => MEMBER_BLOCK_REASON_LABELS[reason]).join(" + ")
}

/**
 * 无候选端点的结构化错误（矩阵「全部端点不可选」行：逐端点列明落选原因 + 恢复指引，AX5）。
 */
function buildNoCandidateError(
	route: AggregationRoute,
	evaluation: Extract<RouteEvaluation, { outcome: "no-candidate" }>,
	unresolvableRefs: readonly string[],
): Error {
	const lines: string[] = []
	for (const member of evaluation.members) {
		if (member.available) continue
		lines.push(`${member.memberRef}（${formatBlockReasons(member.reasons)}）`)
	}
	for (const ref of unresolvableRefs) {
		lines.push(`${ref}（${ENDPOINT_UNRESOLVABLE_LABEL}）`)
	}
	return new Error(`模型路由 "${route.id}"（${route.name}）：当前无可用端点：${lines.join("；")}。请检查路由端点的时间窗/额度条件配置，或在模型选择器更换模型。`)
}

/** 候选端点全部不可解析的结构化错误（悬空端点：设置页标记提示的运行时兜底呈现）。 */
function buildUnresolvableError(route: AggregationRoute, refs: readonly string[]): Error {
	return new Error(`模型路由 "${route.id}"（${route.name}）：候选端点都不在当前模型目录：${refs.join("；")}（${ENDPOINT_UNRESOLVABLE_LABEL}）。请在设置页检查路由端点引用的 provider 与模型是否仍然存在。`)
}

/**
 * 把派生条目集落到 pi 注册与扩展状态（工厂期全量 / session_start 对账 / route 求值前
 * 重读三处注册时点的公共应用段）。条目元数据派生单源 buildVirtualModelDefinitions
 * （RL1/A9 对账同函数）；本函数只补注册路径特有的部分：route 闭包绑定（求值上下文：
 * pi 句柄 + 扩展状态 + 配置/额度读取器）与注册状态记账。
 *
 * 同 provider+id 重复注册 = pi 侧幂等替换（AS1/UD1）。enabled=false 照常注册（停用 =
 * 保持注册 + route 显式失败「已停用」，D9 停用侧——注册集按 enabled 投影后才与注入
 * 目录相等，RL1「启停一致」的消费侧形态）。
 *
 * resolveContextWindow 为可选参数：工厂期无 modelRegistry（注册 flush 早于会话装配）
 * 不解析；session_start 对账与 route 前重读传入目录快照解析补齐（D4 ⑤/D7）。
 */
function registerRouteDefinitions(
	pi: ExtensionAPI,
	state: AggregationState,
	reader: RoutesConfigReader,
	quotaReader: QuotaCacheReader,
	routes: readonly AggregationRoute[],
	resolveContextWindow: ResolveAggregationContextWindow | undefined,
): void {
	const definitions = buildVirtualModelDefinitions(routes, resolveContextWindow)
	for (let index = 0; index < routes.length; index++) {
		const route = routes[index]!
		const definition: ExtensionVirtualModel = {
			...definitions[index]!,
			route: (request, ctx) => evaluateAndRoute(pi, state, reader, quotaReader, route.id, request, ctx),
		}
		pi.registerVirtualModel(definition)
		state.registeredIds.add(route.id)
		state.definitions.set(route.id, route)
		if (route.enabled) state.disabledIds.delete(route.id)
		else state.disabledIds.add(route.id)
		state.deletedIds.delete(route.id)
	}
}

/** 把 config-store 读取结果落到注册状态的公共尾段：文件有而注册集没有的 id 标删除态。 */
function markVanishedIds(state: AggregationState, fileIds: ReadonlySet<string>): void {
	for (const id of state.registeredIds) {
		if (!fileIds.has(id)) state.deletedIds.add(id)
	}
}

/**
 * 应用一次读取结果到注册状态（工厂期全量 / session_start 全量对账共用）。
 *
 * - ok：文件全集遍历——已注册 id 幂等替换，新增 id 补注册；registeredIds 中不在文件的
 *   id 标记删除态（保持注册）。
 * - absent：全部条目消失（文件被删/移走）——已注册 id 全部标记删除态（保持注册）。
 * - corrupt/unreadable：保持当前注册不动（RL4「扩展保持旧注册」），warn 呈报。
 */
function applyReadResult(
	pi: ExtensionAPI,
	state: AggregationState,
	reader: RoutesConfigReader,
	quotaReader: QuotaCacheReader,
	read: ConsumedRoutesSectionRead,
	resolveContextWindow: ResolveAggregationContextWindow | undefined,
): void {
	if (read.status === "corrupt" || read.status === "unreadable") {
		logger.warn(`routes config ${read.status} — keeping last valid registrations (${read.reason})`)
		return
	}
	if (read.status === "absent") {
		for (const id of state.registeredIds) state.deletedIds.add(id)
		return
	}
	registerRouteDefinitions(pi, state, reader, quotaReader, read.file.routes, resolveContextWindow)
	markVanishedIds(state, new Set(read.file.routes.map(r => r.id)))
}

/**
 * route 求值前置重读（D1 ③：只处理已注册 id——编辑替换/删除标记；新增 id 忽略）。
 *
 * 与 applyReadResult 的差异点：新增 id（文件有、本进程未注册）不注册——运行中会话的
 * 新建路由不热注册（D1 ③ 边界），留给下次会话加载（工厂期 / session_start 对账）。
 */
function reconcileRegisteredOnly(pi: ExtensionAPI, state: AggregationState, reader: RoutesConfigReader, quotaReader: QuotaCacheReader, ctx: ExtensionContext): void {
	const { changed, read } = reader.readIfChanged()
	if (!changed) return
	if (read.status === "corrupt" || read.status === "unreadable") {
		logger.warn(`routes config ${read.status} — keeping last valid registrations (${read.reason})`)
		return
	}
	if (read.status === "absent") {
		for (const id of state.registeredIds) state.deletedIds.add(id)
		return
	}
	const registeredRoutes = read.file.routes.filter(route => state.registeredIds.has(route.id))
	registerRouteDefinitions(pi, state, reader, quotaReader, registeredRoutes, route => resolveContextWindowFromDirectory(ctx.modelRegistry, route))
	markVanishedIds(state, new Set(read.file.routes.map(r => r.id)))
}

/** pi 的重试预算默认值（锚 pi 实装 settings-manager.js getRetrySettings：`retry?.maxRetries ?? 3`）。 */
const DEFAULT_MAX_RETRIES = 3

/**
 * pi 的自动重试预算（同步读 effective settings）。
 *
 * 扩展无重试决策钩子、auto_retry 事件族对扩展不可见（retry-rules 头注释已登记：扩展
 * 可见 message_end，但不可见重试决策 payload——attempt 序号 / maxAttempts / 已调度 vs
 * 预算耗尽）——「pi 重试了几次」只能由路由回调在 retry 求值时自己点数（透传计数），
 * 预算同步读取；settings 变更下一轮求值生效，无缓存无定时器。
 *
 * enabled=false（重试停用）= 零次重试：预算读 0——用户裁决规则「超过 pi 的重试次数即
 * failover」在停用形态下即首败即超（题面 §3.6 行为后果同）；否则 maxRetries 缺省 3。
 */
function readMaxRetries(pi: ExtensionAPI): number {
	const retry = pi.getSettings().retry
	if (retry?.enabled === false) return 0
	return retry?.maxRetries ?? DEFAULT_MAX_RETRIES
}

/**
 * retry 透传时递增端点链内失败计数（闭包内存：生命周期 = 活跃重试链——终局观察在下一轮
 * 非 retry 求值读它判「pi 重试预算是否用尽」；burn 结论随 burnt 走 router state 持久化，
 * 计数本身不落 session 历史）。
 */
function bumpChainFailure(state: AggregationState, routeId: string, ref: string): void {
	const perRoute = new Map(state.failures.get(routeId))
	perRoute.set(ref, (perRoute.get(ref) ?? 0) + 1)
	state.failures.set(routeId, perRoute)
}

/**
 * 写回前把 burnt 裁剪到当前配置成员（存储卫生）：手改 / 跨版本 fork 的 session 注入的非配置
 * ref，不随每次 state 写回整体重新序列化而放大携带（修剪发现 P4）。无裁剪时原引用返回——
 * 与 burntIn 的引用比较纪律不受影响（pi 落盘门禁是引用比较）。
 */
function pruneBurntToConfig(burnt: ReadonlySet<string>, route: AggregationRoute): ReadonlySet<string> {
	const configRefs = new Set(route.members.map(memberRef))
	for (const ref of burnt) {
		if (!configRefs.has(ref)) {
			const next = new Set<string>()
			for (const kept of burnt) if (configRefs.has(kept)) next.add(kept)
			return next
		}
	}
	return burnt
}

/**
 * 求值前置短路（AX5 显式失败）：停用/删除/内部状态缺失 → 结构化错误；否则返回当前定义。
 * 短路先于 retry 透传与条件求值——停用/删除态不进任何选择路径（D9）。
 */
function requireActiveRoute(state: AggregationState, routeId: string): AggregationRoute {
	if (state.deletedIds.has(routeId)) {
		throw new Error(`模型路由 "${routeId}" 已删除，请在设置页重新创建或更换模型。`)
	}
	if (state.disabledIds.has(routeId)) {
		throw new Error(`模型路由 "${routeId}" 已停用，请在设置页重新启用或更换模型。`)
	}
	const route = state.definitions.get(routeId)
	if (route === undefined) {
		// 防御分支：deleted/disabled 短路已先行，正常控制流不可达（注册与定义同生命周期）。
		throw new Error(`模型路由 "${routeId}" 没有有效的路由定义（扩展内部状态缺失），请重开会话恢复。`)
	}
	return route
}

/**
 * ① retry 透传（D6 修订 / 方案 B）：pi 自动重试原样返回上一失败端点——重试归属在途
 * 请求的延续，不复查路由条件（直连模型同样不复查任何东西），pi 的重试预算真正打到
 * 上游；终局失败（预算用尽或 fail-fast）由下一轮求值的终局观察感知并 burnt → failover。
 *
 * 失败端点已不在本路由配置 / 模型目录（链中路过配置被改或悬空）→ 返回 undefined 落
 * 正常选择；该次重试预算被正常选择选中的端点消耗——计数必须记在它头上（选择返回处 bump）。
 */
function passthroughFailedEndpoint(
	state: AggregationState,
	route: AggregationRoute,
	routeId: string,
	failedRequest: NonNullable<ModelRouteRequest["failed"]>,
	request: ModelRouteRequest,
	ctx: ExtensionContext,
): ModelRoute | undefined {
	const failed = failedRequest.model
	const member = route.members.find(m => m.providerId === failed.provider && m.modelId === failed.id)
	if (member === undefined) return undefined
	const model = ctx.modelRegistry.find(member.providerId, member.modelId)
	if (model === undefined) return undefined
	bumpChainFailure(state, routeId, memberRef(member))
	return {
		model,
		thinkingLevel: resolveThinkingLevel(request.thinkingLevel, endpointThinkingLevels(member)),
	}
}

/**
 * 单次路由求值（pi route 回调入口）。
 *
 * 顺序：求值前 mtime 重读（编辑对下一请求生效的触发点）→ 停用/删除短路（AX5 显式
 * 失败）→ **retry 透传**（reason=retry 且 failed 在配置内 → 原样返回该端点，D6 修订
 * 方案 B）→ 非 retry 走 decideRoute（终局观察 + 条件硬闸 + burnt 软避让）→ 按偏好序
 * 解析物理模型（第一个可解析的即命中）→ 档位向上取映射（D7）。全部失败路径 throw
 * 结构化错误（pi 契约内路径：failed 路由把虚拟模型留在消息上，virtual-models.d.ts
 * 「Failed routing leaves the virtual model on its message」）。
 */
function evaluateAndRoute(
	pi: ExtensionAPI,
	state: AggregationState,
	reader: RoutesConfigReader,
	quotaReader: QuotaCacheReader,
	routeId: string,
	request: ModelRouteRequest,
	ctx: ExtensionContext,
): ModelRoute {
	reconcileRegisteredOnly(pi, state, reader, quotaReader, ctx)

	const route = requireActiveRoute(state, routeId)

	// ① retry 透传（D6 修订 / 方案 B）：失败端点仍在配置/目录内 → 原样返回并记账
	// （passthroughFailedEndpoint）；已不在 → 落正常选择，该次重试预算由正常选择
	// 选中的端点消耗（见选择返回处 bump）。
	const failedRequest = request.reason === "retry" ? request.failed : undefined
	if (failedRequest !== undefined) {
		const passthrough = passthroughFailedEndpoint(state, route, routeId, failedRequest, request, ctx)
		if (passthrough !== undefined) return passthrough
	}

	// ② 非 retry（或透传不可用）：终局观察 + 条件求值 + burnt 软避让（纯函数 decideRoute）。
	const now = new Date()
	// M2 接线（D3/SC5）：mtime 门读取 quota-cache.json，共享新鲜度纯函数过滤后的
	// providerId → 快照 map；读失败/缺失/全过期 = 空快照（额度未知 → 纯函数 fail-open，
	// 矩阵行 6/12）。与求值墙钟同一时点（AX3：同输入必同输出）。
	const burntIn = parseFailoverState(request.state)
	const decision = decideRoute({
		route,
		now,
		quotaByProviderId: quotaReader.readFreshSnapshots(now.getTime()),
		messages: request.messages,
		burnt: burntIn,
		failures: state.failures.get(routeId) ?? new Map<string, number>(),
		maxRetries: readMaxRetries(pi),
		// 链边界 = user/continuation（新回合起点）；retry 落 normal-selection 与 direct
		// （链中压缩/扩展调用）不是边界——它们的 messages 是在途投影（失败 attempt 已
		// 被 _omitRecoveryAttempt 剔除），按它观察会抹掉活链记账（修剪复审 F1）
		chainBoundary: request.reason === "user" || request.reason === "continuation",
	})
	// 链内失败计数落闭包内存（生命周期 = 活跃重试链；burn 证据随 burnt 走 router state，
	// 计数本身不持久化——session 历史不记瞬态记账）。
	state.failures.set(routeId, decision.failures)

	if (decision.outcome === "no-candidate") {
		// 观察可能已 burnt 端点但无处落盘（throw 路径无 state 出口）——终局观察幂等重导
		// （跳过虚拟模型消息向前找物理结局），下一轮求值重新 derive，不依赖镜像。
		throw buildNoCandidateError(route, decision, [])
	}

	// 按偏好序解析物理模型（第一个可解析的即命中；部分候选悬空时静默落选续试——AX5）。
	const unresolvableRefs: string[] = []
	for (const memberIndex of decision.memberIndexes) {
		const member = route.members[memberIndex]
		if (member === undefined) continue
		const model = ctx.modelRegistry.find(member.providerId, member.modelId)
		if (model === undefined) {
			unresolvableRefs.push(memberRef(member))
			continue
		}
		// retry 求值落到正常选择（失败端点已不在配置/目录）：该次重试预算被此端点消耗——
		// 不计数则预算漏记，终局观察误判 fail-fast → failover 晚一整轮（修剪发现 P2）
		if (failedRequest !== undefined) bumpChainFailure(state, routeId, memberRef(member))
		// burnt 集变化才写 router state（同引用 / undefined = pi 不落 virtual-model-state
		// 条目——agent-session.js：route.state !== undefined && !== state 才 append）。
		// 写回前裁剪到当前配置成员：手改 / fork 注入的非配置 ref 不随每次写回放大携带
		// （修剪发现 P4；无裁剪时 pruneBurntToConfig 原引用返回，守住引用比较纪律）。
		const nextBurnt = pruneBurntToConfig(decision.burnt, route)
		const nextState: RouteFailoverState | undefined = nextBurnt !== burntIn ? { burnt: [...nextBurnt] } : undefined
		return {
			model,
			thinkingLevel: resolveThinkingLevel(request.thinkingLevel, endpointThinkingLevels(member)),
			state: nextState,
		}
	}
	throw buildUnresolvableError(route, unresolvableRefs)
}

/**
 * 扩展工厂（pi 加载期同步执行）。
 *
 * options.configPath / options.quotaCachePath 仅供测试注入 tmp 路径（pi 加载器只传第一
 * 个参数）——生产路径由 RoutesConfigReader / QuotaCacheReader 缺省推导（getProviderExtrasPath /
 * getQuotaCachePath）。
 */
export default function providerAggregation(pi: ExtensionAPI, options?: { configPath?: string, quotaCachePath?: string }): void {
	setPiHandle(pi)

	const state = createState()
	const reader = new RoutesConfigReader(options?.configPath)
	const quotaReader = new QuotaCacheReader(options?.quotaCachePath)

	// ① 工厂期全量注册（同步工厂体内——pending flush 先于 --model 解析，AS12）。
	//    此时无 modelRegistry 可解析（会话未装配），contextWindow 不声明（session_start
	//    对账补齐）；thinkingLevels 并集来自配置声明，无需目录。
	const factoryRead = reader.readIfChanged()
	if (factoryRead.changed) applyReadResult(pi, state, reader, quotaReader, factoryRead.read, undefined)

	// ② session_start 对账（D1 ②）：readLatest 全量重读（无视 mtime 门——求值前重读会
	//    消费文件内容但只处理已注册 id，新增 id 被有意忽略；门控对账会让被消费的新增 id
	//    永远注册不上）。已注册 id 幂等替换、条目消失标记删除态、新增 id 补注册、
	//    contextWindow 元数据补齐（工厂期会话目录未装配，此时才可解析端点元数据，D4 ⑤/D7）。
	//    失败不阻断会话启动（下次 session_start 重试）。
	pi.on("session_start", async (_event, sessionCtx) => {
		try {
			applyReadResult(pi, state, reader, quotaReader, reader.readLatest(), route => resolveContextWindowFromDirectory(sessionCtx.modelRegistry, route))
		} catch (err) {
			logger.error(`session-start aggregation reconcile failed: ${err instanceof Error ? err.message : String(err)}`)
		}
	})
}
