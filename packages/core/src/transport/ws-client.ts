/**
 * WebSocket 客户端 —— 连接状态机（core 版）。
 *
 * 自 packages/renderer/src/lib/ws-client.ts（重建版）迁入。断连恢复策略（时间机制删除裁决）：
 * 连接异常关闭（onclose）即置 failed 终态等用户手动重试，不做心跳保活、探活与自动退避
 * 重连——恢复全部事件驱动（IPC supervisor 事件 / visibility 切前台 / 用户手动重试）。
 *
 * [HISTORICAL] 不变量：
 * 1. 状态机：disconnected → connecting → connected；异常关闭（onclose）→ failed 终态；
 *    restarting / failed（IPC 驱动）与 waiting-runtime 为连接控制器编排态
 * 2. generation 计数：新连接 ++generation，旧 WS 的残余回调（onopen/onclose/onmessage）
 *    检查 gen !== wsGeneration 时直接 return，不干扰新连接
 *
 * S1-W1 auth 握手（spec §3.3 D4）：connect(url, credentials) 凭据为 {auth:'token'} 时，
 * open 后首条消息发 {type:'auth'}，收到 auth.result {ok:true} 才置 connected（resubscribeAll
 * 随 connected 之后启动，重订阅消息不会被 runtime 当「auth 前消息」丢弃）。
 * {auth:'skip'}（mock 平台）跳过握手，onopen 即 connected。token 空串是合法值——强制握手
 * 探测语义（移动壳无凭据首连：握手必被拒 → onAuthRejected → D8 恢复链），与 skip 不可互代。
 * 内部重连复用 currentCredentials；runtime 重启换 token 由 use-connection 的
 * onRuntimePort 路径重新拉取后 connect(url, newCredentials) 覆盖。auth 应答靠连接生命周期
 * 事件驱动（runtime 侧握手超时关闭未认证连接 → onclose）。
 *
 * 与 renderer 版的差异（迁移改造）：
 * - new WebSocket(url) → getPlatform().webSocket.create(url)（平台注入，mock 由 platform
 *   的 webSocket factory 决定，ws-client 不再感知 VITE_MOCK / mock-ws）
 * - 删除 import.meta.hot HMR 块（core headless 无 HMR）
 * - ConnectionState 含 restarting/failed（IPC 驱动，7 导出签名不变）
 *
 * 入站 parse 前置大小检查 + 终止阀（crash-forensics §3.3 D8 / u10a）：
 * - JSON.parse 前检查帧大小：text 帧 `string.length` > 40M code units（≈80MB UTF-16）、
 *   binary 帧按字节 > 80MB → 整条丢弃（不 parse——UTF-16 放大 + 对象图再放大正是 E3 类
 *   OOM 形态，响亮失败优于静默 parse 巨型字符串）。阈值论证：出站检查（C-comm-14）下合法
 *   帧恒 ≤32MiB UTF-8 字节，text 帧 string.length 恒 ≤32M code units，40M = 25% 余量，
 *   只拦「检查已失效/协议漂移」的显著超界形态（哨兵语义）。
 * - 丢弃 → seq gap → 重订阅全量拉取 → 拉取响应同样超界 → 再丢的死循环，由**终止阀**防护：
 *   同一 session **连续 3 次**丢帧后暂停该 session 的自动重订阅（send 层拦截
 *   `session.subscribe`，与 WS 连接态无关）；**作用域 = 单 session**（resubscribeAll 的
 *   全局恢复机制不受影响，其余 session 流不连坐）。
 * - 恢复触发器 = 用户动作：`retryInboundDroppedSession(sid)`（renderer 消费者经
 *   onInboundFrameDropped 回调感知 trip，在用户切走再切回该 session 时调用一次以解除
 *   暂停并重试订阅）；应用重启是兜底路径。
 * - 归因（超界帧不可 parse，无法从对象图取 sessionId）：text 帧头部有界窗口（4KB）
 *   正则提取——① `"id"` 命中 in-flight subscribe 簿记（send 时登记的
 *   session.subscribe 请求，subscribe reply 超界是死循环主形态）→ 归因其目标 session；
 *   ② 否则取首个 `"sessionId"` 字段（live push 帧形态）；③ 均无 → null（只上报，
 *   不参与阀门）。binary 帧不读内容（无 text 可扫），归因恒 null。
 * - 每次丢弃经 onInboundFrameDropped 回调通知（单槽，对齐 onMessage 体例）——renderer
 *   消费者经既有 renderer-log IPC 通道带结构化标记上报进崩溃登记清单（main.jsonl
 *   `inbound-frame-dropped`，D1 矩阵），不新建 IPC 通道。
 *
 * 依赖方向：platform/port（getPlatform）→ 无下游（暴露 connect/disconnect/send/getState/onMessage）
 */
import { ref, readonly } from 'vue'
import type { ClientMessage, ServerMessage } from '@taiji/shared'
import { getPlatform, WS_READY_STATE, type WebSocketCloseInfo, type WebSocketLike } from '../platform/port'

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'restarting' // runtime 崩溃，主进程正在拉起新实例（来自 IPC runtime-restarting）
  | 'failed'     // 连接关闭 / runtime 重启用尽，需用户手动重试
  | 'waiting-runtime' // 已请求目标快照但尚未获得，无连接可发起（connection-datasync-ssot §6.8；快照推送/拉取到达即转 connecting）

/**
 * connect 凭据对象（S4 凭据语义显式化）：auth 意图由调用方显式声明，替代旧
 * `token?: string` 三态隐式协议（undefined=保留上次 / ''=强制空串握手 / 值=正常握手——
 * 三态靠调用方与实现共享的隐式约定，U1.3 假 connected 事故的根因形态）。
 *
 * - `{ auth: 'token', token }`：走 auth 握手（open 后首条 auth 帧，auth.result ok 才
 *   connected）。token 空串 = 强制握手探测：必被 runtime 拒（bad_token）→
 *   onAuthRejected → D8 恢复链。移动壳无凭据首连用它，不得因「空值≈无凭据」误读成 skip。
 * - `{ auth: 'skip' }`：跳过握手，onopen 即 connected（mock 装配形态；URL 仅是
 *   platform factory 的路由标识，ws-client 不解析 URL）。
 */
export type ConnectCredentials =
  | { auth: 'token'; token: string }
  | { auth: 'skip' }

// ── 常量 ────────────────────────────────────────────────────
/**
 * WS 1001 Going Away（RFC 6455）——runtime 计划内关停（connection-manager stop）发给
 * 全部存量连接的 close 码，客户端据此区分「服务重启中」与网络断（remote-use D8，文案
 * 信号 onGoingAway）。与 runtime 侧 WS_CLOSE_GOING_AWAY 同码，协议值
 * 同源 RFC，两侧常量各自就近维护。可读性 P6 探针已证（2026-10-03，Chromium 收
 * close(1001,'Server shutting down') 后 onclose event.code===1001）。
 */
const WS_CLOSE_GOING_AWAY = 1001
/** 断连日志的 close reason 截断上限（字符）：reason 极端长时防日志行爆长，超长部分丢弃。 */
const WS_CLOSE_REASON_LOG_MAX_CHARS = 120
/**
 * pre-auth 发送队列容量上限（防泄漏）：入队消息与 request 层 pending 一一对应
 * （renderer pending 层 MAX_PENDING=256 同界），超限驱逐最老并经 onQueueDrop 通知。
 */
const MAX_PREAUTH_QUEUE = 256

// ── 入站帧检查常量（crash-forensics §3.3 D8）────────────────────────
/** text 帧大小上限（string.length code units，≈80MB UTF-16；出站检查 32MiB 上界 + 25% 余量）。 */
export const INBOUND_FRAME_MAX_TEXT_CODE_UNITS = 40_000_000
/** binary 帧大小上限（字节；与 text 上限的 80MB 语义对齐）。 */
export const INBOUND_FRAME_MAX_BINARY_BYTES = 80_000_000
/** 终止阀阈值：同一 session 连续丢帧达此次数 → 暂停该 session 自动重订阅。 */
export const INBOUND_DROP_VALVE_TRIP_THRESHOLD = 3
/** 超界帧归因扫描窗口（头部 code units）——sessionId/id 字段在 JSON envelope 前部，4KB 足够。 */
const INBOUND_GUARD_ATTRIBUTION_WINDOW = 4096

// ── 状态 ────────────────────────────────────────────────────
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，已登记）：WS 连接状态单例 ref（UI 连接指示的数据源，12 类未覆盖）
const state = ref<ConnectionState>('disconnected')
let ws: WebSocketLike | null = null
let wsGeneration = 0
/** 本次连接凭据（S1-W1/S4）：connect(url, credentials) 更新；重连发起方（快照推送 /
 *  visibility / 用户重试后的 connect 调用）经 getCurrentToken 读用。
 *  「保留上次凭据」是本模块内部行为，不在公开签名表达。 */
let currentCredentials: ConnectCredentials | null = null
/**
 * 本代连接是否已完成 auth（模块级真源，send() 的发送门槛）。
 * WS 握手完成即 readyState=OPEN，但 token 模式下要等 auth.result ok 才算完成——
 * TCP open → auth.result 窗口内 send() 真实送出的消息会被 runtime 设计性静默丢弃
 * （connection-manager handleUnauthedMessage，spec §3.3 D4），故未完成 auth 前入队。
 * connect() 开始时按凭据 kind 初始化（skip → onopen 即视为完成）；gen 检查保证只有当前代写入。
 */
let connectionAuthed = false
/** pre-auth 窗口入队的出站消息（FIFO；auth.result ok 后按序 flush） */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记）：pre-auth 发送队列（容量上限 256，非 GUI 数据；登记见 docs/architecture/data-source-registry.md §4 ⑧）
const preAuthQueue: ClientMessage[] = []

/** 队列丢弃原因（onQueueDrop 回调第二参，消费方按需区分日志/错误文案） */
export type SendQueueDropReason = 'auth-failed' | 'closed' | 'overflow' | 'disconnected'

/** 队列丢弃回调（单槽，对齐 onMessage 体例）：use-connection 注册，对带 id 消息 reject 对应 pending */
let queueDropHandler: ((msgs: ClientMessage[], reason: SendQueueDropReason) => void) | null = null

/** 注册 pre-auth 队列丢弃回调，返回取消函数 */
export function onQueueDrop(cb: (msgs: ClientMessage[], reason: SendQueueDropReason) => void): () => void {
  queueDropHandler = cb
  return () => {
    if (queueDropHandler === cb) queueDropHandler = null
  }
}

// ── auth 拒绝显式信号 + 重连抑制位（remote-use D8）──────────────────

/**
 * auth 拒绝回调（单槽，对齐 onMessage 体例）：auth.result ok:false 时、**先于 ws.close()**
 * 触发。消费方 = use-connection 的两个形态分支——本地形态 installLocalAuthVerification
 * （快照重拉换凭据，connection-datasync-ssot §6.3）+ 远程 profile 形态
 * installAuthRejectionSignal（D8 转发至壳层凭据重摄）；mock 形态无握手不注册——不注册 =
 * 拒绝不置抑制位。
 */
let authRejectedHandler: (() => void) | null = null

/**
 * auth 拒绝重连抑制位（D8「全触发点」）：存在注册消费方时拒绝即置位——本地与远程两个
 * 形态分支都注册消费方（仅 mock 不注册），故除 mock 外拒绝都短路 visibility 切前台
 * 自动重连（use-connection 经 isAuthRejectedSuppressed 查询）、重连责任移交消费方
 * （本地形态快照重拉 / 远程形态壳层凭据重摄）。解除 = markConnected（auth 成功 =
 * 凭据已有效）；resetAuthRejectionSuppression 是消费方交还重连责任的显式入口
 * （远程形态壳层 token 提交后调用，随即显式 connect）。
 */
let authRejectedSuppressed = false

/** 注册 auth 拒绝回调，返回取消函数。注册本身即武装抑制位（未注册 = 行为不变）。 */
export function onAuthRejected(cb: () => void): () => void {
  authRejectedHandler = cb
  return () => {
    if (authRejectedHandler === cb) authRejectedHandler = null
  }
}

// ── 服务端计划内关停信号（remote-use D8）──────────────────────────

/**
 * 计划内关停回调（单槽，对齐 onAuthRejected 体例）：onclose 读到 close 1001（runtime
 * 计划内停机）时、先于置 failed 触发。消费方 = connection-view（移动壳断线条「服务重启中」
 * 文案分流）；桌面形态不注册 = 信号无人消费。P6 探针（设计 §5.4
 * 检查点 1）证实浏览器 CloseEvent 可读 code 1001；读不到（无事件形态/异常环境）不触发，
 * 消费方维持现状文案——降级安全。
 */
let goingAwayHandler: (() => void) | null = null

/** 注册服务端计划内关停回调，返回取消函数。 */
export function onGoingAway(cb: () => void): () => void {
  goingAwayHandler = cb
  return () => {
    if (goingAwayHandler === cb) goingAwayHandler = null
  }
}

/** auth 拒绝重连抑制位查询（use-connection 的 visibility 主动重连触发点检查用）。 */
export function isAuthRejectedSuppressed(): boolean {
  return authRejectedSuppressed
}

// ── auth 接受信号（实例核对，connection-datasync-ssot §6.1/§6.3）─────────────

/**
 * auth 接受回调（单槽，对齐 onAuthRejected 体例）：auth.result ok:true 时、**先于
 * connected 化**触发，携带应答 runtimeId（runtime 侧 env 注入缺失/旧 runtime 时为 null）。
 *
 * 消费方 = use-connection 本地形态连接控制器（核对期望快照 runtimeId，不一致 fail-fast）。
 * 回调返回 false = 消费方裁决拒绝该连接（连到非预期实例）——ws-client 停止 connected 化
 * 并主动断开（不走自动重连；重拉快照/失败呈现由消费方编排）。返回 true（或未注册）=
 * 继续 markConnected。未注册时行为与旧客户端逐字节一致（P-1 兼容：仅读 payload.ok 的
 * 消费路径不破坏）。
 */
let authAcceptedHandler: ((info: { runtimeId: string | null }) => boolean) | null = null

/** 注册 auth 接受回调，返回取消函数。 */
export function onAuthAccepted(cb: (info: { runtimeId: string | null }) => boolean): () => void {
  authAcceptedHandler = cb
  return () => {
    if (authAcceptedHandler === cb) authAcceptedHandler = null
  }
}

/**
 * 显式解除 auth 拒绝重连抑制：消费方交还重连责任的显式入口。远程形态 = 壳层 token 输入
 * 视图提交新凭据后、重新发起连接前调用（复位后随即显式 connect）。本地形态的快照重拉
 * 分支不复位（重连责任留在快照驱动路径，新连接 auth 成功 markConnected 时自行复位）。
 * markConnected（auth 成功）会自行复位，不经本入口。
 */
export function resetAuthRejectionSuppression(): void {
  authRejectedSuppressed = false
}

// ── 入站帧检查：类型 / 状态 / 公开 API（crash-forensics §3.3 D8）────

/** 一次入站超界帧丢弃的通知载荷（onInboundFrameDropped 回调参数）。 */
export interface InboundFrameDroppedInfo {
  /** 归因 session（头部有界扫描提取；null = 无法归因——只上报，不参与阀门计数）。 */
  sessionId: string | null
  /** 超界帧尺寸（text 帧 = code units；binary 帧 = 字节）。 */
  frameSize: number
  /** 帧形态（text / binary）。 */
  kind: 'text' | 'binary'
  /** 本帧是否使归因 session 首次触发终止阀（第 3 次；tripped 后续丢帧为 false）。 */
  valveTripped: boolean
  /** 归因 session 的连续丢帧计数（含本帧；无法归因时为 0）。 */
  sessionDropCount: number
}

/** 入站帧丢弃回调（单槽，对齐 onMessage 体例）：renderer 装配层注册，经既有
 *  renderer-log IPC 通道带结构化标记上报崩溃登记清单；valveTripped=true 时同时驱动
 *  该 session 的静态错误提示。 */
let inboundFrameDroppedHandler: ((info: InboundFrameDroppedInfo) => void) | null = null

/** 注册入站帧丢弃回调，返回取消函数。 */
export function onInboundFrameDropped(cb: (info: InboundFrameDroppedInfo) => void): () => void {
  inboundFrameDroppedHandler = cb
  return () => {
    if (inboundFrameDroppedHandler === cb) inboundFrameDroppedHandler = null
  }
}

/** per-session 连续丢帧计数（终止阀判定依据；正常帧到达清零——「连续」语义）。 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记）：入站检查 per-session 丢帧计数簿记（防死循环阀门依据；登记见 docs/architecture/data-source-registry.md §4 ⑧）
const inboundDropStreakBySession = new Map<string, number>()
/** 终止阀生效中的 session（自动重订阅被 send 层拦截；retryInboundDroppedSession 解除）。 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记）：终止阀生效 session 集合（自动重订阅暂停的判定依据；登记见 docs/architecture/data-source-registry.md §4 ⑧）
const inboundValveTrippedSessions = new Set<string>()
/**
 * in-flight subscribe 簿记（requestId → 目标 session）：超界帧归因锚。
 * send() 出站 `session.subscribe` 时登记；正常 reply 到达（id 命中）或连接关闭时清理。
 * subscribe reply 超界是 D8 死循环主形态（拉取响应同样超界）——reply 不可 parse 拿不到 id，
 * 反向经簿记把丢帧归因回目标 session。
 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记）：in-flight subscribe 归因簿记（超界 reply 的反查锚；登记见 docs/architecture/data-source-registry.md §4 ⑧）
const inFlightSubscribes = new Map<string, string>()

/**
 * 解除指定 session 的终止阀（恢复触发器入口）：移除暂停 + 清零丢帧计数，此后该 session
 * 的 subscribe 请求恢复放行（调用方随即发起一次重试订阅）。
 * @returns true = 该 session 曾 tripped、本次已解除；false = 未 tripped（调用方无需动作）。
 */
export function retryInboundDroppedSession(sessionId: string): boolean {
  if (!inboundValveTrippedSessions.has(sessionId)) return false
  inboundValveTrippedSessions.delete(sessionId)
  inboundDropStreakBySession.delete(sessionId)
  console.log(`[ws] inbound drop valve released for session ${sessionId}: one re-subscribe allowed`)
  return true
}

/** 查询指定 session 的终止阀是否生效（renderer 静态提示态的判定源）。 */
export function isInboundValveTripped(sessionId: string): boolean {
  return inboundValveTrippedSessions.has(sessionId)
}

/** 测试钩子：清空入站检查全部模块级状态（对齐 resetSubscriptionStates 模式）。 */
export function _resetInboundGuardForTest(): void {
  inboundDropStreakBySession.clear()
  inboundValveTrippedSessions.clear()
  inFlightSubscribes.clear()
  inboundFrameDroppedHandler = null
}

/** 测试钩子：in-flight subscribe 簿记当前条目数（G2 重连 sweep 断言用；生产代码零消费）。 */
export function _inFlightSubscribeCountForTest(): number {
  return inFlightSubscribes.size
}

/** 通知队列丢弃（清空方负责 splice，此处只广播） */
function notifyQueueDrop(msgs: ClientMessage[], reason: SendQueueDropReason): void {
  if (msgs.length === 0) return
  queueDropHandler?.(msgs, reason)
}

/** 清空 pre-auth 队列并通知（auth 失败 / 连接关闭 / 终止态；幂等） */
function dropPreAuthQueue(reason: SendQueueDropReason): void {
  notifyQueueDrop(preAuthQueue.splice(0), reason)
}

/** auth 完成后按序 flush 队列（markConnected 内调用；防御连接已失效时走 drop） */
function flushPreAuthQueue(): void {
  if (preAuthQueue.length === 0) return
  const batch = preAuthQueue.splice(0)
  if (ws?.readyState === WS_READY_STATE.OPEN) {
    for (const msg of batch) ws.send(JSON.stringify(msg))
  } else {
    notifyQueueDrop(batch, 'closed')
  }
}

/** 消息回调（连接骨架阶段不注册；后续业务层注册处理 ServerMessage） */
let messageHandler: ((msg: ServerMessage) => void) | null = null

/** 注册消息回调，返回取消函数 */
export function onMessage(cb: (msg: ServerMessage) => void): () => void {
  messageHandler = cb
  return () => {
    if (messageHandler === cb) messageHandler = null
  }
}

/** 连接状态（只读 ref，供 UI 消费） */
export function getState() {
  return readonly(state)
}

/**
 * 设置为 restarting 态（收到 IPC runtime-restarting 时调，useConnection 编排）。
 * 断开当前 WS（死端口）——等主进程拉起新实例后推新端口再 connect。
 */
export function setRestarting(): void {
  disconnect() // 摘除死端口 socket 的回调，避免其 onclose 覆盖 restarting 状态
  state.value = 'restarting'
}

/**
 * 设置为 failed 态（收到 IPC runtime-failed 时调）。
 * 清空残留 pre-auth 队列，等用户手动重试。
 */
export function setFailed(): void {
  dropPreAuthQueue('disconnected') // 终止态：残留队列消息不再有机会发出
  state.value = 'failed'
}

/**
 * 设置为 waiting-runtime 态（connection-datasync-ssot §6.2/§6.8：init 拉取目标快照为
 * null 时调，use-connection 连接控制器编排）。语义 = 「已请求目标快照但尚未获得，无连接
 * 可发起」——与 connecting（已发起连接正在握手）显式区分，连接屏呈现「正在启动 runtime」。
 *
 * disconnect 先清残留连接；快照到达（推送或拉取）后控制器 connect() 转入 connecting。
 */
export function setWaitingRuntime(): void {
  disconnect()
  state.value = 'waiting-runtime'
}

/**
 * 建立连接（已连接/连接中时幂等 no-op）。
 *
 * @param url         连接地址（纯路由标识，由 platform 的 webSocket factory 消费；mock 装配
 *                    为 mock:// 前缀 URL，ws-client 不解析——mock 判别经 credentials 显式表达）
 * @param credentials 凭据对象（S4 三态显式化）：{auth:'token', token} 走 auth 握手（open 后
 *                    首条 auth 帧，auth.result ok 才 connected；token 空串 = 强制握手探测，
 *                    必被拒 → onAuthRejected → D8 恢复链）；{auth:'skip'} 跳过握手，onopen
 *                    即 connected。无「保留上次」态——重连发起方复用 currentCredentials，
 *                    公开签名不表达。
 */
export function connect(url: string, credentials: ConnectCredentials): void {
  currentCredentials = credentials

  // 单飞检查（防并存连接）：存在非 CLOSED 的 socket 期间一律不放行建新连接。
  // - OPEN/CONNECTING：已有活跃连接，no-op（幂等行为不变）。
  // - CLOSING：close 握手未完成（移动弱网下可悬挂数秒~分钟）——此前会被模块变量直接覆盖
  //   并开新连接，旧 socket 悬挂期间与新连接并存（半死连接堆积的根因：移动端「同页多连接
  //   并存」复验问题；visibility 切前台 / token 重试等入场口在 CLOSING 窗口交错即复现）。
  //   现改为 no-op：该 socket 的 onclose 到达（WHATWG 保证 close 事件最终触发）后由重连
  //   发起方（用户重试 / 快照推送）接力，收敛为单链。
  // - null / CLOSED：放行（旧连接已死透）。
  if (ws && ws.readyState !== WS_READY_STATE.CLOSED) return

  state.value = 'connecting'
  const gen = ++wsGeneration
  // 本代 auth 状态初始化（skip 模式在 onopen 即视为完成）；后续读写都走模块级
  // connectionAuthed——send() 需要在 connect 闭包外感知 auth 进度（pre-auth 入队门槛）。
  connectionAuthed = credentials.auth === 'skip'
  ws = getPlatform().webSocket.create(url)
  console.log('[ws] connecting to', url)

  /** connected 化（auth 成功或 skip 模式）：置位状态 + flush 队列。 */
  const markConnected = () => {
    state.value = 'connected'
    // auth 成功 = 凭据已有效（D8）：复位重连抑制位
    authRejectedSuppressed = false
    flushPreAuthQueue()
  }

  ws.onopen = () => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，忽略
    if (!connectionAuthed) {
      // S1-W1：首条消息必须是 auth；connected 推迟到 auth.result ok（重订阅随后）。
      // token 取自 currentCredentials（!connectionAuthed ⇔ 本代凭据为 {auth:'token'}；兜底
      // 空串 = 探测语义，异常态凭据必被 runtime 拒走 D8 恢复链，不会静默假 connected）。
      // 应答无客户端计时窗：握手超时由 runtime 侧关闭未认证连接驱动（onclose → failed）。
      const token = currentCredentials?.auth === 'token' ? currentCredentials.token : ''
      ws!.send(JSON.stringify({ type: 'auth', payload: { token } }))
      return
    }
    markConnected()
  }

  ws.onmessage = (event) => {
    if (gen !== wsGeneration) return
    // 入站帧检查（D8）：JSON.parse 前置大小检查——超界整条丢弃（不 parse，防 OOM 形态），
    // 归因 + 计数 + 终止阀见 handleOversizedInboundFrame。检查在 auth 检查之前（任何阶段
    // 的超界帧都拦，含握手期异常帧）。
    const measured = measureInboundFrame(event.data)
    if (measured !== null && isInboundFrameOverLimit(measured)) {
      handleOversizedInboundFrame(measured)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(String(event.data))
    } catch (e) {
      // JSON 解析失败：仅记日志跳过（dispatch 已移出 try，handler 抛错不再被此处吞掉）
      console.error('[ws] parse error:', e)
      return
    }
    noteParsedInboundFrame(parsed)
    // auth 握手期：只消费 auth.result，其余消息（握手期不应出现）丢弃
    if (!connectionAuthed) {
      const r = parsed as { type?: unknown; payload?: { ok?: unknown; runtimeId?: unknown } | null }
      if (r.type === 'auth.result' && r.payload != null) {
        if (r.payload.ok === true) {
          connectionAuthed = true
          // 实例标识核对（connection-datasync-ssot §6.3）：应答 runtimeId 先交消费方
          // 裁决再 connected 化——false = 连到非预期实例，fail-fast 断开（不 markConnected：
          // 不置 connected、不 flush 队列；重拉快照/失败呈现由消费方编排）。
          if (authAcceptedHandler) {
            const rawId = r.payload.runtimeId
            const accepted = authAcceptedHandler({ runtimeId: typeof rawId === 'string' ? rawId : null })
            if (!accepted) {
              console.warn('[ws] auth accepted but rejected by identity check (runtimeId mismatch), disconnecting')
              disconnect()
              return
            }
          }
          markConnected()
        } else {
          // runtime 拒绝（token 失效，如 runtime 已换 token 重启）→ 凭据已失效，自动重连
          // 只复用旧凭据必再拒：有消费方形态在下方置重连抑制位短路 visibility 自动重连，
          // 重连改由消费方驱动——本地形态 = use-connection recoverAfterAuthRejection
          // 重拉目标快照、携新快照凭据重连（新连接 auth 成功 markConnected 时抑制位
          // 复位）；远程形态 = 壳层 D8 凭据重摄路径换凭据；
          // pre-auth 队列清空 + 通知（入队消息的 pending 由 onQueueDrop 消费方快速 reject）
          dropPreAuthQueue('auth-failed')
          // D8 显式信号：先置抑制位 + 触发消费方，再 close（信号先落，消费方处置先于
          // onclose 置 failed）。消费方 = 本地形态（快照重拉换凭据，§6.3）与远程形态
          // （壳层 D8 凭据重摄）；无注册消费方（mock）不置位，close 走断连路径，行为不变。
          if (authRejectedHandler) {
            authRejectedSuppressed = true
            authRejectedHandler()
          }
          console.warn('[ws] auth rejected by runtime, closing')
          ws?.close()
        }
      }
      return
    }
    if (!isServerMessage(parsed)) {
      console.warn('[ws] dropping malformed (non-ServerMessage) inbound:', parsed)
      return
    }
    messageHandler?.(parsed)
  }

  ws.onclose = (event?: WebSocketCloseInfo) => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，不干扰新连接
    // 断连观测（只加日志不改行为）：close 原因在 renderer 侧不可见——补打
    // code/reason/wasClean 供排查归因。
    const closeDesc = event
      ? `code=${event.code} wasClean=${event.wasClean}${event.reason ? ` reason="${event.reason.slice(0, WS_CLOSE_REASON_LOG_MAX_CHARS)}"` : ''}`
      : 'no close event (mock stub)'
    console.warn('[ws] closed:', closeDesc)
    // D8 close code 分流（只读码不加协议）：1001 = runtime 计划内关停 → 先触发消费方
    // 文案信号再置 failed（顺序对齐 authRejected「先置位再 close」——信号先落）；
    // 无事件形态（mock 桩）或非 1001 不触发。
    if (event?.code === WS_CLOSE_GOING_AWAY) goingAwayHandler?.()
    // 连接异常关闭 = failed 终态（时间机制删除裁决）：不做自动重连，等用户手动重试
    // （renderer 连接屏重试按钮 / 移动壳重连编排 / visibility 切前台重连）。
    state.value = 'failed'
    dropPreAuthQueue('closed')
    // in-flight subscribe 簿记随连接关闭清理（事件驱动）：关闭连接的 subscribe reply
    // 永不到达，归因锚退役，防簿记跨连接累积。
    inFlightSubscribes.clear()
  }

  ws.onerror = () => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，忽略（避免误 close 掉已被新 gen 取代的当前 socket）
    // 连接失败路径的预期日志（warn 非 error）：error 事件本身零信息（Event 对象无
    // code/reason），浏览器原生 console 已打「WebSocket connection ... failed」，
    // 紧随的 onclose 日志带 code（1006 等）承载归因——error 级是同事实的三重噪音，
    // runtime 不可用场景下刷红 devtools 却无可操作信息
    console.warn('[ws] connection error (native failure in browser console; close event follows)')
    ws?.close()
  }
}

/**
 * 当前连接凭据只读取值面（terminal-multi-instance 设计 §0.5 P6）。
 *
 * 用途：终端域的「runtime 世代变更」核对判据——renderer 在 WS 连接建立边沿比较本值与
 * 上一次连接建立时保存的值，**变化即世代变更**（每次 spawn 重新生成 randomBytes token，
 * 旧 token 对新进程必失效）；未变即同世代（WS 闪断 / 无新进程的幂等 `runtime-port` 广播沿），
 * 终端域不重置。端口值不构成世代信号（`findAvailablePort` 重启常落回原端口）。
 *
 * 语义：模块私有 `currentCredentials` 的只读世代判据面——token 形态凭据返回其 token
 * （`connect(url, credentials)` 每次传入时更新、内部退避重连复用 currentCredentials 时
 * 保留上次值、skip 形态 / 未连接为 null）。空串 token 是合法值（强制握手探测语义），
 * 原样返回不归一。世代判据只做相等性比较，非鉴权用途——鉴权走握手 {type:'auth'} 通道。
 */
export function getCurrentToken(): string | null {
  return currentCredentials?.auth === 'token' ? currentCredentials.token : null
}

/** 主动断开（编排型拆连：断旧连新 / restarting / teardown；不触发 failed） */
export function disconnect(): void {
  // 递增 generation 使旧 WS 的回调失效
  wsGeneration++
  dropPreAuthQueue('disconnected') // 回调将被摘除，onclose 清队路径不可达，此处显式清
  // in-flight subscribe 簿记随连接关闭清理（事件驱动，与 onclose 同语义——拆连后旧
  // 请求的 reply 永不到达）
  inFlightSubscribes.clear()
  if (ws) {
    // 先摘回调再 close，避免触发 onclose → 置 failed
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.close()
    ws = null
  }
  state.value = 'disconnected'
}

/**
 * 发送消息（W4：返回 boolean，让调用方 fast-fail）。
 *
 * 返回契约：
 * - readyState=OPEN 且本代 auth 已完成 → 实际发送，返回 true（已发送确认）
 * - readyState=OPEN 但 auth 未完成（TCP open → auth.result 窗口）→ 入 pre-auth 队列
 *   （有界 MAX_PREAUTH_QUEUE），auth 成功后按序 flush，返回 true（已接受）；
 *   auth 失败 / 连接关闭时清队并经 onQueueDrop 通知（消费方 reject 对应 pending）
 * - readyState≠OPEN（CONNECTING/CLOSED）→ 不发送不入队，返回 false（调用方可立即 reject / 重试）
 */
export function send(msg: ClientMessage): boolean {
  // 终止阀拦截（D8）：tripped session 的自动重订阅（gap reconcile / resubscribeAll /
  // ensureStreamSubscription 路径）在此暂停——不发送，返回 false 走 request 层 fast-fail
  // （pending 立即 reject，subscribeSession catch 消化）。恢复经 retryInboundDroppedSession
  // （用户切走切回触发一次），此后同型请求正常放行。其余 session 与非 subscribe 消息不受影响。
  if (isSubscribeForValvedSession(msg)) return false
  if (ws?.readyState === WS_READY_STATE.OPEN) {
    if (!connectionAuthed) {
      if (preAuthQueue.length >= MAX_PREAUTH_QUEUE) {
        // 防泄漏：驱逐最老（FIFO 队头）并通知 drop
        notifyQueueDrop(preAuthQueue.splice(0, 1), 'overflow')
      }
      preAuthQueue.push(msg)
      return true
    }
    recordOutboundSubscribe(msg)
    ws.send(JSON.stringify(msg))
    return true
  }
  return false
}

// ── 内部 ────────────────────────────────────────────────────

// ── 入站帧检查私有实现（crash-forensics §3.3 D8）──────────────────

/** 超界判定前的帧度量（text 帧留原文供归因；binary 帧不读内容——大帧转字符串本身是 OOM 形态）。 */
interface InboundFrameMeasurement {
  kind: 'text' | 'binary'
  size: number
  text: string | null
}

/**
 * 度量入站帧：text 帧（string）按 code units；binary 帧按字节（ArrayBuffer / view /
 * Blob 类——runtime 只发 text JSON，binary 分支是形态存在性防御。core 无 DOM lib，
 * Blob 判定走 duck-typing：带 number size 字段即按 binary 度量）。无法度量的形态
 * （undefined 等）返回 null，不做检查，维持原 parse 错误链行为。
 */
function measureInboundFrame(data: unknown): InboundFrameMeasurement | null {
  if (typeof data === 'string') return { kind: 'text', size: data.length, text: data }
  if (data instanceof ArrayBuffer) return { kind: 'binary', size: data.byteLength, text: null }
  if (ArrayBuffer.isView(data)) return { kind: 'binary', size: data.byteLength, text: null }
  const size = (data as { size?: unknown } | null)?.size
  if (typeof size === 'number') return { kind: 'binary', size, text: null }
  return null
}

function isInboundFrameOverLimit(measured: InboundFrameMeasurement): boolean {
  return measured.kind === 'text'
    ? measured.size > INBOUND_FRAME_MAX_TEXT_CODE_UNITS
    : measured.size > INBOUND_FRAME_MAX_BINARY_BYTES
}

/**
 * 处理超界帧：响亮丢弃（console error）→ 归因 → per-session 连续计数 → 阈值触发终止阀
 * → 丢弃回调通知（每次丢弃都通知——登记清单 ×4 计数由消费方逐帧上报）。
 */
function handleOversizedInboundFrame(measured: InboundFrameMeasurement): void {
  const sessionId = attributeOversizedFrame(measured.text)
  let valveTripped = false
  let sessionDropCount = 0
  if (sessionId !== null) {
    sessionDropCount = (inboundDropStreakBySession.get(sessionId) ?? 0) + 1
    inboundDropStreakBySession.set(sessionId, sessionDropCount)
    if (sessionDropCount >= INBOUND_DROP_VALVE_TRIP_THRESHOLD && !inboundValveTrippedSessions.has(sessionId)) {
      inboundValveTrippedSessions.add(sessionId)
      valveTripped = true
      console.error(
        `[ws] inbound drop valve tripped for session ${sessionId}: ` +
          `pausing auto re-subscribe after ${sessionDropCount} consecutive dropped frames ` +
          `(user re-entry retries once; other sessions unaffected)`,
      )
    }
  }
  console.error(
    `[ws] inbound frame dropped (over size limit): kind=${measured.kind} size=${measured.size} ` +
      `session=${sessionId ?? 'unattributed'}`,
  )
  inboundFrameDroppedHandler?.({
    sessionId,
    frameSize: measured.size,
    kind: measured.kind,
    valveTripped,
    sessionDropCount,
  })
}

/**
 * 超界帧归因（帧不可 parse，只能头部有界窗口正则提取——O(窗口) 代价，不建对象图）：
 * ① 首个 `"id"` 命中 in-flight subscribe 簿记 → 归因其目标 session（subscribe reply
 *    超界 = 死循环主形态，reply 顶层无 sessionId 字段，id 反查是唯一精确锚）；
 * ② 否则首个 `"sessionId"` 字段（live push 帧形态：bus.publish 定向推送 payload 带 sessionId）；
 * ③ 均无（含 binary 帧无 text）→ null。
 */
function attributeOversizedFrame(text: string | null): string | null {
  if (text === null) return null
  const window = text.length > INBOUND_GUARD_ATTRIBUTION_WINDOW ? text.slice(0, INBOUND_GUARD_ATTRIBUTION_WINDOW) : text
  const idMatch = /"id":"([^"]{1,128})"/.exec(window)
  if (idMatch) {
    const sid = inFlightSubscribes.get(idMatch[1])
    if (sid) return sid
  }
  const sidMatch = /"sessionId":"([^"]{1,128})"/.exec(window)
  return sidMatch ? sidMatch[1] : null
}

/**
 * send() 出站登记：`session.subscribe` 请求（带 id）记入 in-flight 簿记——其 reply 超界时
 * attributeOversizedFrame 经 id 反查归因目标 session。仅在实际发送路径登记（pre-auth 入队
 * 窗口的 subscribe 实际不存在——订阅经 auth 后的 RPC 发起）；其余 type no-op。
 */
function recordOutboundSubscribe(msg: ClientMessage): void {
  if (msg.type !== 'session.subscribe') return
  const id = (msg as { id?: unknown }).id
  const sid = (msg.payload as { sessionId?: unknown }).sessionId
  if (typeof id === 'string' && typeof sid === 'string') {
    inFlightSubscribes.set(id, sid)
  }
}

/** send() 终止阀判定：该出站请求是否为「被暂停 session」的订阅请求。 */
function isSubscribeForValvedSession(msg: ClientMessage): boolean {
  if (msg.type !== 'session.subscribe' || inboundValveTrippedSessions.size === 0) return false
  const sid = (msg.payload as { sessionId?: unknown }).sessionId
  return typeof sid === 'string' && inboundValveTrippedSessions.has(sid)
}

/**
 * 可 parse 的正常入站帧到达时的检查簿记维护：
 * - id 命中 in-flight subscribe 簿记 → 清理（reply 正常到达 = 订阅完成，归因锚退役）；
 * - payload.sessionId 命中丢帧计数表 → 清零该 session 计数（「连续 3 次」的连续性中断语义：
 *   丢 2 帧 → 正常帧 → 再丢 2 帧，不触发终止阀）。空表时零开销（size 门控，常态热路径）。
 */
function noteParsedInboundFrame(parsed: unknown): void {
  if (inFlightSubscribes.size > 0 && typeof parsed === 'object' && parsed !== null) {
    const id = (parsed as { id?: unknown }).id
    if (typeof id === 'string') inFlightSubscribes.delete(id)
  }
  if (inboundDropStreakBySession.size > 0 && typeof parsed === 'object' && parsed !== null) {
    const sid = (parsed as { payload?: { sessionId?: unknown } }).payload?.sessionId
    if (typeof sid === 'string' && inboundDropStreakBySession.has(sid)) {
      inboundDropStreakBySession.set(sid, 0)
    }
  }
}

/**
 * 入站消息运行时形状检查（MF-5：替代 `JSON.parse(...) as ServerMessage` unsafe cast）。
 * 仅做最小形状校验：type 为字符串 + payload 非 null。不验证 type 是否在已知 ServerMessageType
 * 联合内（未知 type 由下游 dispatcher 兜底分支处理），避免过度收紧静默丢弃合法 runtime 消息。
 * ServerMessage 的 payload 恒为对象（pong / session.writeSegments:result 为 Record<string,never>={}），
 * 故 payload!=null 不会误杀任何合法变体。
 */
function isServerMessage(x: unknown): x is ServerMessage {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { type?: unknown }).type === 'string' &&
    (x as { payload?: unknown }).payload != null
  )
}
