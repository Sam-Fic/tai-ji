/**
 * UI 请求串行队列（UiRequestQueue）
 *
 * 把插件发起的 UI 弹窗请求（confirm / select / input）串行派发给前端，在前端响应后收尾。
 *
 * 行为契约（时间机制删除裁决：无语义超时、无防泄漏兜底窗）：
 * - 同时只允许一个弹窗活跃（activeUiRequest），后续请求进 uiRequestQueue 排队。
 * - 等待无时限：请求挂到用户响应 / 插件卸载（Worker dispose 收尾在途请求）。
 * - requestId 尊重 Worker 侧来方值（params.requestId，去重与响应匹配锚）；重复 id
 *   warn + 丢弃后到者（防御性——共享 Worker 内 id 碰撞会误删他方 pending）。
 *
 * 依赖：仅依赖一个 broadcast 回调（type + payload），不耦合 broker / broadcastFn 细节。
 */

import { randomSuffix } from '../../utils/ids.js'

/** 排队中的请求条目（dispatch 时所有权移交 pendingUiRequests）。 */
interface QueuedRequest {
  requestId: string
  method: string
  pluginId: string
  params: Record<string, unknown>
  resolve: (v: unknown) => void
}

/** 等待前端响应的活跃请求。entry 是请求元数据（pluginId 供呈现侧定位）。 */
interface PendingRequest {
  entry: QueuedRequest
}

/** 本队列可广播的消息类型（与 shared ServerMessageMap 契约对齐）。 */
export type UiBroadcastType = 'plugin:uiRequest'

/**
 * 广播回调：把 UI 请求推给前端。payload requestId 必带（dispatch 恒含）——与
 * shared ServerMessageMap['plugin:uiRequest'] 契约对齐，消费方（plugin-service 广播
 * 回调）可免 `as ServerMessage` 断言直接构造类型化消息。pluginId 同样恒含
 * （dispatch 从 entry.pluginId 带出，uiRequest 侧为透传字段）。
 */
export type UiBroadcastFn = (
  type: UiBroadcastType,
  payload: { requestId: string; pluginId: string } & Record<string, unknown>,
) => void

export class UiRequestQueue {
  /** 当前活跃的 UI 请求 ID（串行排队，同一时刻仅一个） */
  activeUiRequest: string | null = null

  /** 等待中的 UI 请求队列 */
  uiRequestQueue: Array<QueuedRequest> = []

  /** 等待前端响应的 UI 请求 */
  pendingUiRequests = new Map<string, PendingRequest>()

  private readonly broadcast: UiBroadcastFn

  constructor(broadcast: UiBroadcastFn) {
    this.broadcast = broadcast
  }

  /**
   * 处理 UI 弹窗请求（串行排队）。
   * 同时只允许一个弹窗显示在前端，后续请求排队等待。等待无时限（挂到用户响应）。
   */
  async handleRequest(method: string, params: Record<string, unknown>, pluginId: string): Promise<unknown> {
    // requestId 生成权在 Worker 侧 ui-api，本层尊重来方值（响应匹配按它进行）。
    // 来方缺失（旧版 Worker / 直接调用）时本地生成，保持可用。
    const requestId = typeof params.requestId === 'string' && params.requestId.length > 0
      ? params.requestId
      : `${pluginId}_${Date.now()}_${randomSuffix()}`

    // 重复 id 防御：warn + 丢弃后到者（纯 Error → dispatch 回 INTERNAL_ERROR，
    // 不用 string code 保持 JSON-RPC error.code 线协议形状）
    if (
      this.pendingUiRequests.has(requestId)
      || requestId === this.activeUiRequest
      || this.uiRequestQueue.some(q => q.requestId === requestId)
    ) {
      console.warn(
        `[ui-request-queue] duplicate ui requestId=${requestId} (plugin=${pluginId}) — dropping the late duplicate`,
      )
      throw new Error(
        `duplicate ui request id '${requestId}' — an unresolved dialog with this id already exists; re-issue with a fresh request`,
      )
    }

    const entry: QueuedRequest = { requestId, method, pluginId, params, resolve: () => {} }
    return new Promise<unknown>((resolve) => {
      entry.resolve = resolve
      if (this.activeUiRequest !== null) {
        this.uiRequestQueue.push(entry)
        return
      }
      this.activeUiRequest = requestId
      this.dispatch(entry)
    })
  }

  /** 处理前端返回的 UI 响应（供 server.ts / plugin-message-handler 调用） */
  handleResponse(requestId: string, result: unknown): void {
    const pending = this.pendingUiRequests.get(requestId)
    if (!pending) return

    this.pendingUiRequests.delete(requestId)
    pending.entry.resolve(result)
    this.processNext()
  }

  /** 发送 UI 请求到前端。 */
  private dispatch(entry: QueuedRequest): void {
    this.pendingUiRequests.set(entry.requestId, { entry })

    // 广播给前端（requestId 以本层裁决值为准，覆盖来方 params 缺失场景）
    const broadcastPayload = {
      ...entry.params,
      requestId: entry.requestId,
      pluginId: entry.pluginId,
      method: entry.method,
    }
    this.broadcast('plugin:uiRequest', broadcastPayload)
  }

  /** 处理队列中的下一个 UI 请求 */
  private processNext(): void {
    if (this.uiRequestQueue.length === 0) {
      this.activeUiRequest = null
      return
    }
    const next = this.uiRequestQueue.shift()!
    this.activeUiRequest = next.requestId
    this.dispatch(next)
  }
}
