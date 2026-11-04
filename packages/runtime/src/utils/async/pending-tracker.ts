/**
 * PendingTracker — 请求/回复登记表（D15/D25）。
 *
 * 收编 plugin-rpc-client / plugin-rpc-server / plugin-activator.pendingReplies
 * 三处同构的 `Map<K, { resolve, reject }>` + resolve/reject(on reply) +
 * rejectAll(on dispose) 样板。
 *
 * 抽象边界（刻意收窄，不污染）：
 *   - 无墙钟：登记的请求挂到回复到达或 dispose rejectAll，不做时间阈值判死。
 *   - resolve 通道把原始值交给调用方：reply 是否算"成功"是领域逻辑，不由 tracker 判断。
 *     调用方在收到回复后，自己决定调 resolve(k, value) 还是 reject(k, err)。
 *   - 不支持注册副作用钩子：pendingPermissions / pendingUiRequests 的异类语义各自保留，
 *     不入本抽象。
 */

export class PendingTracker<K extends string | number, T> {
  private pending = new Map<K, {
    resolve: (value: T) => void
    reject: (error: Error) => void
  }>()

  /** 当前登记的请求数量。 */
  get size(): number {
    return this.pending.size
  }

  /** 是否存在登记中的 key（handleResponse 的命中判断）。 */
  has(key: K): boolean {
    return this.pending.has(key)
  }

  /**
   * 登记一个 pending 请求，返回在回复到达后被解析的 Promise（无墙钟——回复永不到达时
   * 由 dispose rejectAll 收尾）。
   */
  register(key: K): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(key, { resolve, reject })
    })
  }

  /**
   * 成功回复到达时调用：解析对应 Promise。
   * @returns 是否命中（false 表示该 key 不在登记表中，调用方可据此区分"回复"与"主动请求"）。
   */
  resolve(key: K, value: T): boolean {
    const entry = this.pending.get(key)
    if (!entry) return false
    this.pending.delete(key)
    entry.resolve(value)
    return true
  }

  /**
   * 失败回复到达时调用（如 JSON-RPC error 响应）：拒绝对应 Promise。
   * @returns 是否命中。
   */
  reject(key: K, error: Error): boolean {
    const entry = this.pending.get(key)
    if (!entry) return false
    this.pending.delete(key)
    entry.reject(error)
    return true
  }

  /**
   * 拒绝所有登记中的请求（用于 dispose / 进程退出）。
   * 清理后 tracker 为空，可安全丢弃。
   */
  rejectAll(error: Error): void {
    for (const [, entry] of this.pending) {
      entry.reject(error)
    }
    this.pending.clear()
  }
}
