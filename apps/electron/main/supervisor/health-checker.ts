/**
 * 健康检查器（TCP 端口探测 + HTTP /health 探活）。
 *
 * 对应 spec §4.2 M2 子职责「健康检查」。W5 后拆为两种探测语义：
 *
 * [HISTORICAL] 不变量：
 * - isPortInUse：纯 TCP（net.createConnection），仅检测「端口有人占」。
 *   保留给 port-discoverer 在选端口时探测是否被占用（语义不变）。
 * - checkHealthEndpoint：HTTP /health（fetch），验证「runtime 已完成启动、
 *   HTTP 服务就绪」。2xx 视为健康，非 2xx 或 fetch reject 视为未就绪。
 *   W5 修复：旧 waitForHealth 走 TCP，会在 listen 之后但业务 handler 注册
 *   完成之前就返回 true，导致前端过早连接丢消息。
 *
 * 两种探测不能互相替代：
 * - TCP 探测快但不准确（listen != ready）
 * - HTTP 探测准确但要求 runtime 已起 HTTP 服务
 *   port-discoverer 选端口时 runtime 还没起，只能用 TCP；
 *   supervisor 等运行时 ready 时必须用 HTTP。
 *
 * 依赖方向：health-checker → node:net + 全局 fetch（Electron/Node 18+ 内置）
 */
import { createConnection } from 'node:net'

/** 健康检查重试次数（默认）：总窗 = 150×200ms = 30s——被保护对象是 runtime 冷启动
 *  （tsx 转译 + migrations + 依赖校验后首个 boot 可达十秒级，D3 验收实测 pnpm install
 *  后首个实例 6s 窗必超时 → supervisor 误判死循环清理，占满端口段）。按 AGENTS.md
 *  超时量级红线「按被保护对象粒度校准」：启动是任务级（十秒级），窗口必须覆盖它。 */
export const HEALTH_RETRY_COUNT = 150

/** 健康检查重试间隔（默认） */
export const HEALTH_INTERVAL_MS = 200

/** TCP 连接超时 */
export const CONNECT_TIMEOUT_MS = 500

/** 健康检查端点 URL 模板（仅本地回环，绝不连外网） */
const HEALTH_ENDPOINT = (port: number) => `http://127.0.0.1:${port}/health`

/**
 * 检测端口是否被监听（TCP socket 连接尝试）。
 *
 * 仅用于 port-discoverer 探测候选端口是否已被占用（不验证业务就绪）。
 *
 * @param port 目标端口
 * @param timeoutMs 连接超时，默认 CONNECT_TIMEOUT_MS
 * @returns true=端口在监听 / false=空闲或连接失败
 */
export function isPortInUse(port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/**
 * 调 HTTP /health 端点验证 runtime 业务就绪状态。
 *
 * [HISTORICAL] W5：相比纯 TCP 探测，能区分「端口已 listen」与「HTTP 服务就绪」。
 * - 2xx → true（健康）
 * - 非 2xx → false（服务起来了但未就绪，如 503）
 * - fetch reject（ECONNREFUSED / 超时）→ false（端口卡死或 runtime 还没 listen）
 *
 * 不向调用方抛错（waitForHealth 据此累计重试，而非崩溃）。
 *
 * @param port runtime 监听端口
 * @returns true=HTTP 服务就绪 / false=未就绪或连不上
 */
export async function checkHealthEndpoint(port: number): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_ENDPOINT(port))
    return response.ok
  } catch {
    // fetch reject：连接拒绝/超时/DNS 失败等，均视为「未就绪」而非异常
    return false
  }
}

/**
 * 进程活性探测结果（liveness 判据分级的三态，2026-11-03「死/忙分级」改造）。
 *
 * - dead：进程不存在（kill(pid,0) ESRCH）——确证死，可杀。
 * - refused：进程在但端口拒绝连接（ECONNREFUSED）——listen 句柄已不在，
 *   HTTP 服务死透，等同确证死（方案处置表：端口连接拒绝 = 死）。
 * - timeout：进程在但连接未在超时窗内建立——本地回环下极罕见（OS accept
 *   队列不依赖目标进程 JS 执行），主要对应 SIGSTOP 冻结等人为暂停形态，
 *   按忙处理（不杀，进假死持续窗口累计）。
 * - alive：进程在且端口接受连接——进程活性无虞，服务健康与否交给 /health 探测。
 */
export type ProcessProbeOutcome =
  | { kind: 'dead' }
  | { kind: 'unreachable'; reason: 'refused' | 'timeout' }
  | { kind: 'alive' }

/**
 * 进程活性探测（独立于 /health 的低层信号，判定「忙」与「死」的分界）。
 *
 * 两段探测：
 * 1. `process.kill(pid, 0)`：0 号信号不发送任何信号，仅做进程存在性检查。
 *    ESRCH = 进程不存在（确证死）；EPERM 等其他错误 = 进程存在但无权限
 *    发信号，继续端口探测（不误判死）。
 * 2. `net.connect(127.0.0.1:port)`：TCP 连接建立由 OS 内核 accept 队列保证，
 *    不需要目标进程的 JS 执行——event-loop 被重算堵死时仍可连。这是「忙」
 *    （端口可连但 /health 超时）与「死」（端口拒绝/进程消失）的可判定分界。
 *    连接建立后立即销毁 socket，不等任何应用层应答。
 *
 * 永不抛错（探针失败是判定输入，不是异常路径）。
 *
 * @param pid runtime 进程 pid
 * @param port runtime 监听端口
 * @param timeoutMs 连接超时，默认 CONNECT_TIMEOUT_MS
 */
export async function probeProcessAlive(
  pid: number,
  port: number,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<ProcessProbeOutcome> {
  try {
    process.kill(pid, 0)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return { kind: 'dead' }
    // 非 ESRCH（EPERM 等）：进程存在，继续端口探测
  }
  return await new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.destroy()
      resolve({ kind: 'alive' })
    })
    let settled = false
    const settle = (outcome: ProcessProbeOutcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    socket.on('error', (err) => {
      socket.destroy()
      const refused = (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
      settle(refused ? { kind: 'unreachable', reason: 'refused' } : { kind: 'unreachable', reason: 'timeout' })
    })
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      settle({ kind: 'unreachable', reason: 'timeout' })
    })
  })
}

/**
 * waitForHealth 的可选参数（W5：支持测试缩短轮询间隔，避免用例过慢）。
 */
export interface WaitForHealthOptions {
  /** 轮询间隔 ms，默认 HEALTH_INTERVAL_MS */
  intervalMs?: number
  /** 最大重试次数，默认 HEALTH_RETRY_COUNT */
  retryCount?: number
  /**
   * 进程存活检查：每轮轮询循环**先**执行它（在探测 /health 之前），返回 false
   * （进程已退出）→ 立即抛错，不再等满重试上限。用途：区分「慢启动超时」与
   * 「进程已崩溃」——对一个已退出的进程等满上限没有意义，且错误信息可归因。
   * 不传时行为与不检查存活完全一致。
   */
  aliveCheck?: () => boolean
}

/**
 * 轮询健康检查：直到 HTTP /health 返回 2xx 或重试耗尽。
 *
 * [HISTORICAL] W5：从 isPortInUse 改为 checkHealthEndpoint，
 * 确保 runtime 已完成 HTTP 服务初始化（而非仅 listen 端口）。
 *
 * @param port 目标端口
 * @param opts 可选参数：intervalMs / retryCount / aliveCheck
 * @throws aliveCheck 返回 false（进程已退出，立即失败不等满上限）
 * @throws 重试耗尽仍不就绪
 */
export async function waitForHealth(
  port: number,
  opts?: WaitForHealthOptions,
): Promise<void> {
  const intervalMs = opts?.intervalMs ?? HEALTH_INTERVAL_MS
  const retryCount = opts?.retryCount ?? HEALTH_RETRY_COUNT
  const aliveCheck = opts?.aliveCheck
  for (let i = 0; i < retryCount; i++) {
    // 存活检查先于健康探测：进程已退出时继续轮询端口只会白等满上限，
    // 错误信息也无法区分「超时」与「崩溃」——立即失败
    if (aliveCheck && !aliveCheck()) {
      throw new Error(`runtime 进程已退出 (exit before healthy, port ${port})`)
    }
    if (await checkHealthEndpoint(port)) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Runtime health check timed out on port ${port}`)
}
