/**
 * Pending 请求映射 —— 命令 id（randomUuid）→ Promise。
 *
 * 依赖方向：无下游（被 api/domains 调用）。
 *
 * 注：将 ServerMessage(id) 路由到 pending.resolve 的 dispatcher 由 features 层
 * （useChat/useSidebar）在订阅 transport.on 时串联，本层只提供注册表。
 * resolveEnvelope 例外：它是 core route-inbound 委托的 pending 分流出口（R2/ES1），
 * u4 后生产路径经 route-inbound defaultPorts 静态直连本模块（不经壳装配）；
 * TransportPorts.pending 仅作 core 内部测试注入 seam（见 route-inbound.ts）。
 *
 * 生命周期纯事件驱动（ADR-0188）：reply 到达经 resolve/reject/resolveEnvelope 结算，
 * WS 断连经 rejectAll 批量收尾（use-connection 断连汇合分支）。无时间兜底——runtime
 * 不回 = 调用方挂住，由断连收尾或人工干预收终，不靠猜测时间的超时中断等待。
 */
import type { ServerMessage } from '@taiji/shared'
import { randomUuid } from '../../utils/random-uuid'

/** 注册中的 pending 请求 */
export interface PendingRequest<T = unknown> {
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

/**
 * [Q1-5] pendingMap 容量上限：超限时驱逐最老（Map 迭代序 = 插入序，首个 key 即最老）。
 * 防异常场景（高频 RPC + runtime 不回）下 map 无限增长。
 */
const MAX_PENDING = 256

// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：RPC pending promise 去重表（容量上限 256，非 GUI 数据）
const pendingMap = new Map<string, PendingRequest>()

/** 生成新命令 id（randomUuid：secure context 缺失时走 v4 fallback，见 utils/random-uuid）。
 *  命名避开泛化 create（Gate-1.5 duplicate_exports：
 *  与 api/domains/session.ts 的 session.create RPC 同名异义，消费方仅 request.ts）。 */
export function createCommandId(): string {
  return randomUuid()
}

/**
 * [Q1-5] 超限驱逐最老：Map 迭代序 = 插入序，首个 key 即最早注册的 pending。
 * reject 前先 delete（原子：JS 单线程无并发窗口），迟到的响应对已驱逐 id 静默丢弃。
 */
function evictOldestIfOverflow(): void {
  while (pendingMap.size >= MAX_PENDING) {
    const oldest = pendingMap.keys().next().value
    if (oldest === undefined) break
    reject(
      oldest,
      Object.assign(new Error(`pending requests overflow (max ${MAX_PENDING}), evicted oldest`), { code: 'overflow' }),
    )
  }
}

/**
 * 注册 pending 请求，返回与之关联的 Promise。
 *
 * 结算全部事件驱动：reply 到达（resolve / resolveEnvelope / reject）或 WS 断连
 * （rejectAll）。无超时兜底（ADR-0188：时间等待机制退役，runtime 不回 = 挂住）。
 */
export function register<T>(id: string): Promise<T> {
  evictOldestIfOverflow()
  return new Promise<T>((resolve, reject) => {
    pendingMap.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    })
  })
}

/** 按 id resolve pending 请求（id 不存在时 no-op，防重复/过期响应） */
export function resolve<T>(id: string, value: T): void {
  const req = pendingMap.get(id)
  if (!req) return
  pendingMap.delete(id)
  req.resolve(value)
}

/**
 * 是否存在该 id 的 pending 请求。
 *
 * 用于入站路由区分「RPC reply（id 命中 pending）」与「带 id 的 server-push 广播」——
 * runtime 的 broadcast 消息（config.skills/agents/...）也携带 nextPushId 作为 id，
 * 若仅凭 msg.id 存在就判定为 reply，会把广播误吞进 pending 分流（pendingMap 无此 id → 静默丢弃），
 * 导致靠广播推送的 store（skills/agents 等，无 RPC 兜底）永空。
 */
export function has(id: string): boolean {
  return pendingMap.has(id)
}

/** 按 id reject pending 请求（id 不存在时 no-op） */
export function reject(id: string, error: unknown): void {
  const req = pendingMap.get(id)
  if (!req) return
  pendingMap.delete(id)
  req.reject(error)
}

/**
 * 按 envelope 语义 settle pending 请求（收尾 6：envelope 展开下沉 pending 层）。
 *
 * 接受原始 ServerMessage：id 命中 pending 时——
 * - type==='error'：展开 error envelope（code 提取 + details.detail 展开到 Error）后 reject；
 * - 其他 type：resolve msg.payload 原样。
 * id 缺失或未命中 pending（如带 nextPushId 的广播）→ no-op，绝不吞广播。
 *
 * 逻辑从 core/coordination/route-inbound.ts 的 pending 分流分支搬移（行为零变化），
 * core 侧已改为一行 `ports.pending.resolveEnvelope(msg); return`（收尾 6 完成态）。
 */
export function resolveEnvelope(msg: ServerMessage): void {
  if (!msg.id || !pendingMap.has(msg.id)) return
  if (msg.type === 'error') {
    // type==='error' 已窄化 payload 为 error envelope（含 code + message + 可选 details）。
    // 透传 code 到 reject 的 Error（D-021：NodeState.reason 需要 error code 区分失败类型，
    // 如 out_of_cwd / permission_denied）。此前只透传 message 丢了 code。
    // details.detail 展开：string（如 WORKTREE_EXISTS 的 cwd）→ Error.cwd；object（如
    // SETUP_FAILED 的 { exitCode, stderr }）→ Object.assign 展开到 Error 上。
    const payload = msg.payload as {
      code?: string
      message?: string
      details?: Record<string, unknown>
    }
    const message = typeof payload.message === 'string' ? payload.message : 'request failed'
    const code = typeof payload.code === 'string' ? payload.code : 'unknown'
    const enriched: Record<string, unknown> = { code }
    const d = payload.details?.detail
    if (typeof d === 'string') {
      // 字符串 detail（如 WORKTREE_EXISTS 的 cwd）直接作 cwd 字段
      enriched.cwd = d
    } else if (d && typeof d === 'object') {
      // 对象 detail（如 { exitCode, stderr }）展开到 Error 上
      Object.assign(enriched, d)
    }
    reject(msg.id, Object.assign(new Error(message), enriched))
  } else {
    resolve(msg.id, msg.payload)
  }
}

/** 批量 reject 所有 pending 请求（WS 断连 / runtime 崩溃时调）。 */
export function rejectAll(error: unknown): void {
  for (const [, req] of pendingMap) {
    req.reject(error)
  }
  pendingMap.clear()
}
