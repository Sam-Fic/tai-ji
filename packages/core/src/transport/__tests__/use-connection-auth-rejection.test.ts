// use-connection auth 拒绝信号消费测试（remote-use D8 / U1.3 + connection-datasync-ssot §6.3）。
//
// 真实 ws-client（不 mock，区别于 mode-dispatch 测试的模块 mock）+ fake 平台 WebSocket，
// 锁定 use-connection 形态分支的信号消费方：
// 1. 远程 profile 形态：connectRemoteProfile 注册 ws-client onAuthRejected → 转发
//    ports.onAuthRejected + 抑制位置位；visibility 切前台触发点被抑制（不重连）；reset +
//    visibility 再触发 → 重连恢复（显式复用 lastConnectedUrl 与 lastCredentials，S4）
// 2. 本地 ipc 形态（桌面）：拒绝 → 重拉快照换凭据（§6.3：拒绝后旧凭据重连必再拒）——
//    快照推进 seq → 断旧连新（新凭据）；重拉失败 / 同 seq → 置 failed 等用户手动重试
// 3. teardown 拆卸信号监听：重装后转发目标跟随最新装配（不串台）
//
// 运行：cd packages/core && npx vitest run src/transport/__tests__/use-connection-auth-rejection.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RuntimeTargetSnapshot } from '@taiji/shared'
import { providePlatform } from '../../platform/port'
import { useConnection, setConnectionPorts, type ConnectionPorts } from '../use-connection'
import {
  disconnect,
  getState,
  isAuthRejectedSuppressed,
  resetAuthRejectionSuppression,
} from '../ws-client'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'

let fakes: FakeWebSocket[]
let visibilityHandler: (() => void) | null = null

function installTestPlatform(): void {
  fakes = []
  providePlatform({
    kind: 'mock',
    storage: {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
    webSocket: {
      create: () => {
        const f = createFakeWebSocket()
        fakes.push(f)
        return f
      },
    },
  })
}

function authResult(ok: boolean): string {
  return JSON.stringify({ type: 'auth.result', payload: { ok } })
}

/** 本地形态 ipc 端口 stub（快照可编程——auth 拒绝重拉 / 实例核对重拉都要改变返回值） */
let stubSnapshot: RuntimeTargetSnapshot
function buildIpc(port: number, token: string, opts?: { seq?: number; runtimeId?: string }): NonNullable<ConnectionPorts['ipc']> {
  stubSnapshot = { seq: opts?.seq ?? 1, runtimeId: opts?.runtimeId ?? 'rt-fix', port, token }
  return {
    getRuntimeTargetSnapshot: vi.fn(async () => stubSnapshot),
    onRuntimePort: vi.fn().mockReturnValue(() => {}),
    onRuntimeRestarting: vi.fn().mockReturnValue(() => {}),
    onRuntimeFailed: vi.fn().mockReturnValue(() => {}),
    onRuntimeError: vi.fn().mockReturnValue(() => {}),
    getRuntimeStartError: vi.fn().mockResolvedValue(null),
    restartRuntime: vi.fn().mockResolvedValue(undefined),
  }
}

function makePorts(spec: { remote: boolean }): {
  ports: ConnectionPorts
  onAuthRejected: ReturnType<typeof vi.fn>
} {
  const onAuthRejected = vi.fn()
  const ports: ConnectionPorts = {
    ...(spec.remote ? {} : { ipc: buildIpc(4000, 'tok-local') }),
    visibility: {
      isVisible: () => true,
      onVisibilityChange: (cb) => {
        visibilityHandler = cb
        return () => {
          visibilityHandler = null
        }
      },
    },
    env: { isMock: false, isDev: false },
    ...(spec.remote
      ? {
          connectionProfile: {
            resolve: async () => ({ url: 'ws://192.168.1.5:3210', token: 'tok-remote' }),
          },
        }
      : {}),
    onAuthRejected,
    effects: {},
    t: (key: string) => key,
    onRuntimeUnavailable: vi.fn(),
  }
  return { ports, onAuthRejected }
}

async function initFresh(ports: ConnectionPorts): Promise<void> {
  setConnectionPorts(ports)
  await useConnection().init()
}

describe('use-connection auth 拒绝信号消费（D8）', () => {
  beforeEach(() => {
    installTestPlatform()
    resetAuthRejectionSuppression()
    disconnect()
    visibilityHandler = null
  })
  afterEach(() => {
    // 复位 use-connection 模块级单例态（initialised/listeners/lastConnectedUrl），用例互不污染
    useConnection().teardown()
    disconnect()
    resetAuthRejectionSuppression()
  })

  it('远程形态：auth 拒绝 → ports.onAuthRejected 转发 + 抑制位；visibility 触发点被抑制；reset 后重连恢复', async () => {
    const { ports, onAuthRejected } = makePorts({ remote: true })
    await initFresh(ports)
    expect(fakes.length).toBe(1)
    const f = fakes[0]
    f.triggerOpen()
    expect(JSON.parse(f.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-remote' } })
    f.triggerMessage(authResult(false))
    // 信号转发 + 抑制位置位
    expect(onAuthRejected).toHaveBeenCalledTimes(1)
    expect(isAuthRejectedSuppressed()).toBe(true)
    f.triggerClose()
    expect(getState().value).toBe('failed')

    // D8 触发点②：切前台主动重连被抑制（无新连接）
    visibilityHandler?.()
    expect(fakes.length).toBe(1)

    // token 重试路径：reset → visibility 再触发 → 重连恢复（显式复用 lastConnectedUrl + lastCredentials）
    resetAuthRejectionSuppression()
    visibilityHandler?.()
    expect(fakes.length).toBe(2)
    const f2 = fakes[1]
    f2.triggerOpen()
    expect(JSON.parse(f2.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-remote' } })
  })

  it('本地形态：auth 拒绝 → 重拉快照换凭据——快照推进 seq 则断旧连新（§6.3）', async () => {
    const { ports, onAuthRejected } = makePorts({ remote: false })
    await initFresh(ports)
    expect(fakes.length).toBe(1)
    const f = fakes[0]
    f.triggerOpen()
    expect(JSON.parse(f.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-local' } })
    // runtime 已重启换凭据：拒绝后重拉到的快照推进到 seq 2（新 runtimeId + 新 token）
    stubSnapshot = { seq: 2, runtimeId: 'rt-new', port: 4500, token: 'tok-new' }
    f.triggerMessage(authResult(false))
    // ports.onAuthRejected（壳层 D8 转发面）不被调——本地形态走控制器快照重拉，不走壳层
    expect(onAuthRejected).not.toHaveBeenCalled()
    // 抑制位置位（注册消费方即武装）：visibility 重连被短路，重连由控制器以新快照凭据发起
    expect(isAuthRejectedSuppressed()).toBe(true)
    f.triggerClose()
    // close 事件先落 failed（onclose 终态），IPC 重拉回包到达后按新快照断旧连新
    expect(getState().value).toBe('failed')
    await Promise.resolve()
    await Promise.resolve()
    expect(fakes.length).toBe(2)
    expect(getState().value).toBe('connecting')
    const f2 = fakes[1]
    f2.triggerOpen()
    expect(JSON.parse(f2.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-new' } })
  })

  it('本地形态：auth 拒绝后重拉同 seq 快照（凭据未变）→ 置 failed 等用户手动重试', async () => {
    const { ports } = makePorts({ remote: false })
    await initFresh(ports)
    expect(fakes.length).toBe(1)
    const f = fakes[0]
    f.triggerOpen()
    // 重拉仍是 seq 1 同快照（凭据未变——拒绝另有原因的异常态）——stubSnapshot 未变
    f.triggerMessage(authResult(false))
    // 同代快照处置发生在重拉微任务内（拉取 → 裁决 no-op → 置 failed），先 flush 再断言
    await Promise.resolve()
    await Promise.resolve()
    // 旧凭据重试必再拒：置 failed 呈现 + 手动重试入口（retryRuntime 重启 runtime 换凭据）；
    // 抑制位不复位——重连责任留在快照驱动路径，防 visibility 用旧凭据徒劳重试
    expect(isAuthRejectedSuppressed()).toBe(true)
    expect(getState().value).toBe('failed')
    expect(fakes.length).toBe(1) // 无自动重连
  })

  it('本地形态：onclose 早到侧（close 事件先于 IPC 重拉回包）→ close 落 failed，重拉回包按快照裁决收尾', async () => {
    // 真实时序（推进 seq 主形态）：auth 拒绝同步置抑制位 + ws.close() 后，真实 WS 的 onclose
    // 异步到达早于 IPC 重拉回包——close 先落 failed 终态，回包到达后按快照裁决收尾（推进 →
    // 断旧连新；同 seq → 维持 failed）。
    const { ports, onAuthRejected } = makePorts({ remote: false })
    await initFresh(ports)
    expect(fakes.length).toBe(1)
    const f = fakes[0]
    f.triggerOpen()
    expect(JSON.parse(f.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-local' } })
    // 同 seq 快照（凭据未变——拒绝另有原因的异常态）：stubSnapshot 未变
    f.triggerMessage(authResult(false))
    // 同步段：抑制位置位 + 消费方触发（重拉进入微任务等待）；fake 的 close() 不触发 onclose
    //（helper 契约），此刻 onclose 尚未发生
    expect(onAuthRejected).not.toHaveBeenCalled()
    expect(isAuthRejectedSuppressed()).toBe(true)
    // 早到侧：onclose 先于 IPC 回包到达（手动 triggerClose 模拟真实 WS 的异步 close 事件）
    f.triggerClose()
    expect(getState().value).toBe('failed')
    // IPC 重拉回包（同 seq）到达：快照未推进 → 维持 failed 等用户手动重试（抑制位不复位）
    await Promise.resolve()
    await Promise.resolve()
    expect(isAuthRejectedSuppressed()).toBe(true)
    expect(getState().value).toBe('failed')
    expect(fakes.length).toBe(1) // 无自动重连，重试责任在 retryRuntime
  })

  it('teardown 拆卸信号监听：重装后转发目标跟随最新装配（不串台）', async () => {
    const first = makePorts({ remote: true })
    await initFresh(first.ports)
    useConnection().teardown()
    disconnect()

    const second = makePorts({ remote: true })
    await initFresh(second.ports)
    const f = fakes[fakes.length - 1]
    f.triggerOpen()
    f.triggerMessage(authResult(false))
    expect(second.onAuthRejected).toHaveBeenCalledTimes(1)
    expect(first.onAuthRejected).not.toHaveBeenCalled()
  })
})
