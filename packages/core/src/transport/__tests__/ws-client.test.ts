// ws-client.test.ts —— core C03 簇合并产物（round5-G）。
// 共同被测业务模块：`src/transport/ws-client.ts`。mock 相容：单侧 mock ../api/pending、../ws-client——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源（时间机制删除裁决后重塑：探活 / 心跳 / 退避重连已删，onclose → failed 终态）：
//   - ws-client.auth-rejection（D8 信号 + 重连抑制位 + failed 终态）
//   - ws-client.inbound-guard（80MB 阈值 / per-session 终止阀 / in-flight 簿记生命周期）
//   - ws-client.single-flight（单飞防并存 + failed 后显式 connect 重试）

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { providePlatform, WS_READY_STATE } from '../../platform/port'
import { connect, disconnect, getState, isAuthRejectedSuppressed, onAuthRejected, resetAuthRejectionSuppression, onMessage, send, onInboundFrameDropped, retryInboundDroppedSession, isInboundValveTripped, INBOUND_FRAME_MAX_TEXT_CODE_UNITS, _resetInboundGuardForTest, _inFlightSubscribeCountForTest, type InboundFrameDroppedInfo } from '../ws-client'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'
import { type ClientMessage, type ServerMessage } from '@taiji/shared'

// ======== 来源：ws-client.auth-rejection.test.ts ========
describe("ws-client.auth-rejection", () => {
  // ── 测试平台注入（invariants 测试同款 fake websocket factory）──
  let fakes: FakeWebSocket[]

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

  function latestFake(): FakeWebSocket {
    expect(fakes.length).toBeGreaterThan(0)
    return fakes[fakes.length - 1]
  }

  function authResult(ok: boolean): string {
    return JSON.stringify({ type: 'auth.result', payload: { ok } })
  }

  describe('ws-client auth 拒绝信号与重连抑制（D8）', () => {
    beforeEach(() => {
      installTestPlatform()
      resetAuthRejectionSuppression()
      disconnect() // 重置模块级单例状态（上轮残留连接）
    })
    afterEach(() => {
      disconnect()
      resetAuthRejectionSuppression()
    })

    it('信号先于 close 触发：触发瞬间 socket 仍 OPEN 且 close 未调用，随后 close 照常', () => {
      let observedAtSignal: string | null = null
      const off = onAuthRejected(() => {
        observedAtSignal = `readyState=${latestFake().readyState} closeCalls=${latestFake().closeCalls}`
      })
      connect('ws://test', { auth: 'token', token: 'tok-d8' })
      latestFake().triggerOpen()
      latestFake().triggerMessage(authResult(false))
      // 信号触发瞬间：readyState=OPEN(1) 且 close 尚未调用——「先于 close」的直接证据
      expect(observedAtSignal).toBe('readyState=1 closeCalls=0')
      // onmessage 返回后 close 已调（消费方处置先于 onclose 置 failed 的顺序保证）
      expect(latestFake().closeCalls).toBe(1)
      off()
    })

    it('有注册消费方：拒绝置抑制位，close 落 failed 终态（无自动重连，重连责任移交消费方）', () => {
      const handler = vi.fn()
      const off = onAuthRejected(handler)
      connect('ws://test', { auth: 'token', token: 'tok-d8' })
      const f = latestFake()
      f.triggerOpen()
      f.triggerMessage(authResult(false))
      expect(handler).toHaveBeenCalledTimes(1)
      expect(isAuthRejectedSuppressed()).toBe(true)
      f.triggerClose()
      // 连接异常关闭 = failed 终态：不自动重连（无新 WS），等消费方换凭据重连
      expect(getState().value).toBe('failed')
      expect(fakes.length).toBe(1)
      off()
    })

    it('无注册消费方（mock 形态）：拒绝不置抑制位，close 同落 failed 终态', () => {
      connect('ws://test', { auth: 'token', token: 'tok-desktop' })
      const f = latestFake()
      f.triggerOpen()
      f.triggerMessage(authResult(false))
      expect(isAuthRejectedSuppressed()).toBe(false)
      f.triggerClose()
      expect(getState().value).toBe('failed')
      expect(fakes.length).toBe(1) // 无自动重连
    })

    it('resetAuthRejectionSuppression 显式解除：重试 connect 可达、auth 成功复位抑制位', () => {
      const off = onAuthRejected(() => {})
      connect('ws://test', { auth: 'token', token: 'tok-stale' })
      let f = latestFake()
      f.triggerOpen()
      f.triggerMessage(authResult(false))
      f.triggerClose()
      expect(getState().value).toBe('failed')
      expect(fakes.length).toBe(1) // 抑制中且无自动重连：无新连接

      // token 重试路径形态：reset → 显式 connect（新凭据）
      resetAuthRejectionSuppression()
      // reset 直接锚，且必须落在 connect 之前：markConnected（auth 成功）也会复位抑制位，
      // 若锚在 connect 后则 reset 体被掏空仍全绿（无判别力）
      expect(isAuthRejectedSuppressed()).toBe(false)
      connect('ws://test', { auth: 'token', token: 'tok-new' })
      expect(fakes.length).toBe(2)
      f = latestFake()
      f.triggerOpen()
      f.triggerMessage(authResult(true))
      expect(getState().value).toBe('connected')
      // markConnected 自动复位抑制位
      expect(isAuthRejectedSuppressed()).toBe(false)
      // 连接再关闭仍落 failed 终态（自动重连不存在），重连责任在显式 connect
      f.triggerClose()
      expect(getState().value).toBe('failed')
      expect(fakes.length).toBe(2)
      off()
    })
  })
});

// ======== 来源：ws-client.inbound-guard.test.ts ========
describe("ws-client.inbound-guard", () => {
  // ── 测试平台注入（invariants 同款 fake websocket factory）──────────
  let fakes: FakeWebSocket[]

  function installTestPlatform(): void {
    fakes = []
    providePlatform({
      kind: 'mock',
      storage: { get: async () => null, set: async () => {}, remove: async () => {} },
      webSocket: {
        create: () => {
          const f = createFakeWebSocket()
          fakes.push(f)
          return f
        },
      },
    })
  }

  function latestFake(): FakeWebSocket {
    expect(fakes.length).toBeGreaterThan(0)
    return fakes[fakes.length - 1]
  }

  // ── 夹具构造 ────────────────────────────────────────────────────────

  /** 出站 subscribe 请求（生产 request.ts command() 同款形状，invariants as 断言体例）。 */
  function subscribeMsg(id: string, sessionId: string): ClientMessage {
    return { type: 'session.subscribe', id, payload: { sessionId } } as ClientMessage
  }

  /**
 * 超界 text 帧（总 code units > INBOUND_FRAME_MAX_TEXT_CODE_UNITS）。prefix 落在
 * 检查归因扫描窗口（头部 4KB）内——归因字段必须在前缀里。
 */
  function oversizedFrame(prefix: string): string {
    const padUnits = INBOUND_FRAME_MAX_TEXT_CODE_UNITS - prefix.length
    return `${prefix}"pad":"${'x'.repeat(padUnits)}"}`
  }

  /** live push 形态超界帧前缀（头部含 sessionId 字段——归因路径 ②）。 */
  function livePushPrefix(sessionId: string): string {
    return `{"type":"message.chunk","seq":9,"payload":{"sessionId":"${sessionId}","blob":"`
  }

  /** subscribe reply 形态超界帧前缀（头部含 id 字段——归因路径 ①，簿记反查）。 */
  function subscribeReplyPrefix(requestId: string): string {
    return `{"id":"${requestId}","type":"session.subscribe","payload":{"snapshot":"`
  }

  describe('ws-client 入站检查 ① 80MB 阈值（超界丢帧不断链）', () => {
    let dropped: InboundFrameDroppedInfo[]
    let offDrop: () => void
    let dispatchHandler: Mock<(msg: ServerMessage) => void>

    beforeEach(() => {
      installTestPlatform()
      disconnect()
      _resetInboundGuardForTest()
      dropped = []
      offDrop = onInboundFrameDropped((info) => dropped.push(info))
      dispatchHandler = vi.fn<(msg: ServerMessage) => void>()
      onMessage(dispatchHandler)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      connect('ws://test', { auth: 'skip' })
      latestFake().triggerOpen()
    })

    afterEach(() => {
      offDrop()
      disconnect()
      _resetInboundGuardForTest()
      vi.restoreAllMocks()
    })

    it('超界 text 帧整条丢弃（不 parse 不 dispatch），后续正常帧照常到达（不断链）', () => {
      latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))

      expect(dropped).toHaveLength(1)
      expect(dropped[0].kind).toBe('text')
      expect(dropped[0].frameSize).toBeGreaterThan(INBOUND_FRAME_MAX_TEXT_CODE_UNITS)
      expect(dispatchHandler).not.toHaveBeenCalled() // 检查在 parse 前，帧未进入路由

      // 不断链：检查命中后消息泵不死，正常帧照常 dispatch
      latestFake().triggerMessage(JSON.stringify({ type: 'message.chunk', seq: 1, payload: { sessionId: 's1' } }))
      expect(dispatchHandler).toHaveBeenCalledTimes(1)
    })

    it('恰好 40M code units 不触发检查（> 严格大于边界，不误伤合法大帧）', () => {
      // 长度恰为上限的帧：不超界 → 走 parse 链，检查回调零触发 = 未被检查丢弃
      const boundaryFrame = '{"pad":"' + 'x'.repeat(INBOUND_FRAME_MAX_TEXT_CODE_UNITS - 10) + '"}'
      expect(boundaryFrame.length).toBe(INBOUND_FRAME_MAX_TEXT_CODE_UNITS)
      latestFake().triggerMessage(boundaryFrame)
      expect(dropped).toHaveLength(0)
    })
  })

  describe('ws-client 入站检查 ② per-session 连续计数与终止阀', () => {
    let dropped: InboundFrameDroppedInfo[]
    let offDrop: () => void

    beforeEach(() => {
      installTestPlatform()
      disconnect()
      _resetInboundGuardForTest()
      dropped = []
      offDrop = onInboundFrameDropped((info) => dropped.push(info))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      connect('ws://test', { auth: 'skip' })
      latestFake().triggerOpen()
    })

    afterEach(() => {
      offDrop()
      disconnect()
      _resetInboundGuardForTest()
      vi.restoreAllMocks()
    })

    it('同 session 连续 3 次丢帧 → 第 3 帧触发终止阀（valveTripped=true，session 归因）', () => {
      for (let i = 1; i <= 3; i++) latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))

      expect(dropped).toHaveLength(3)
      expect(dropped.map((d) => d.sessionDropCount)).toEqual([1, 2, 3])
      expect(dropped[0].valveTripped).toBe(false)
      expect(dropped[1].valveTripped).toBe(false)
      expect(dropped[2]).toMatchObject({ sessionId: 's1', valveTripped: true })
      expect(isInboundValveTripped('s1')).toBe(true)
    })

    it('trip 后第 4 帧继续上报（valveTripped=false，A6 登记清单 ×4 计数语义）', () => {
      for (let i = 1; i <= 4; i++) latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))

      expect(dropped).toHaveLength(4)
      expect(dropped[3]).toMatchObject({ sessionId: 's1', valveTripped: false, sessionDropCount: 4 })
      expect(dropped.filter((d) => d.valveTripped)).toHaveLength(1) // 仅第 3 帧 trip 一次
    })

    it('正常帧到达中断「连续」性：丢 2 → 正常帧 → 再丢 2，不触发终止阀', () => {
      latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))
      latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))
      // 同 session 的可 parse 正常帧到达 → 计数清零（连续性中断）
      latestFake().triggerMessage(JSON.stringify({ type: 'message.chunk', seq: 1, payload: { sessionId: 's1' } }))
      latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))
      latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))

      expect(dropped).toHaveLength(4)
      expect(dropped.every((d) => !d.valveTripped)).toBe(true)
      expect(dropped[3].sessionDropCount).toBe(2) // 中断后重新累计
      expect(isInboundValveTripped('s1')).toBe(false)
    })

    it('无法归因（头部无 id 簿记命中无 sessionId 字段）→ 只上报不参与阀门', () => {
      for (let i = 1; i <= 3; i++) latestFake().triggerMessage(oversizedFrame('{"blob":"'))

      expect(dropped).toHaveLength(3)
      expect(dropped.every((d) => d.sessionId === null && d.sessionDropCount === 0)).toBe(true)
      expect(dropped.every((d) => !d.valveTripped)).toBe(true)
      expect(isInboundValveTripped('s1')).toBe(false)
    })

    it('不同 session 计数互不干扰：s1/s2 各丢 2 帧均不 trip；s1 第 3 帧 trip 而 s2 不连坐', () => {
      latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))
      latestFake().triggerMessage(oversizedFrame(livePushPrefix('s2')))
      latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))
      latestFake().triggerMessage(oversizedFrame(livePushPrefix('s2')))
      expect(isInboundValveTripped('s1')).toBe(false)
      expect(isInboundValveTripped('s2')).toBe(false)

      latestFake().triggerMessage(oversizedFrame(livePushPrefix('s1')))
      expect(dropped[4]).toMatchObject({ sessionId: 's1', valveTripped: true })
      expect(isInboundValveTripped('s1')).toBe(true)
      expect(isInboundValveTripped('s2')).toBe(false) // 单 session 作用域，s2 不连坐
    })
  })

  describe('ws-client 入站检查 ③ 终止阀的订阅暂停与恢复', () => {
    let dropped: InboundFrameDroppedInfo[]
    let offDrop: () => void

    beforeEach(() => {
      installTestPlatform()
      disconnect()
      _resetInboundGuardForTest()
      dropped = []
      offDrop = onInboundFrameDropped((info) => dropped.push(info))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      connect('ws://test', { auth: 'skip' })
      latestFake().triggerOpen()
    })

    afterEach(() => {
      offDrop()
      disconnect()
      _resetInboundGuardForTest()
      vi.restoreAllMocks()
    })

    function tripSession(sessionId: string): void {
      for (let i = 1; i <= 3; i++) latestFake().triggerMessage(oversizedFrame(livePushPrefix(sessionId)))
      expect(isInboundValveTripped(sessionId)).toBe(true)
    }

    it('trip 后该 session 的 subscribe 出站被拦截（send false），其余 session 与其他消息放行', () => {
      tripSession('s1')

      expect(send(subscribeMsg('rpc-s1', 's1'))).toBe(false) // 自动重订阅暂停点
      expect(latestFake().sent.some((d) => d.includes('rpc-s1'))).toBe(false) // 未上 wire

      expect(send(subscribeMsg('rpc-s2', 's2'))).toBe(true) // 其余 session 不连坐
      expect(send({ type: 'ping', payload: {} })).toBe(true) // 非 subscribe 消息不受影响
      expect(latestFake().sent.some((d) => d.includes('rpc-s2'))).toBe(true)
    })

    it('retryInboundDroppedSession 解除暂停（恢复触发器入口），随后该 session subscribe 放行；未 tripped 返回 false', () => {
      tripSession('s1')
      expect(retryInboundDroppedSession('s2')).toBe(false) // 未 tripped：调用方无需动作

      expect(retryInboundDroppedSession('s1')).toBe(true)
      expect(isInboundValveTripped('s1')).toBe(false)
      expect(send(subscribeMsg('rpc-retry', 's1'))).toBe(true) // 解除后放行（重试订阅可达 wire）
      expect(latestFake().sent.some((d) => d.includes('rpc-retry'))).toBe(true)
    })

    it('in-flight subscribe 簿记归因：出站 subscribe 后其 reply 帧超界 → 归因目标 session（头部无 sessionId 字段）', async () => {
      expect(send(subscribeMsg('rpc-1', 's1'))).toBe(true)

      // reply 形态超界帧：头部只有 id（subscribe reply 顶层无 sessionId 字段），经簿记反查归因 s1
      for (let i = 1; i <= 3; i++) {
        expect(send(subscribeMsg(`rpc-${i}`, 's1'))).toBe(true)
        latestFake().triggerMessage(oversizedFrame(subscribeReplyPrefix(`rpc-${i}`)))
      }

      expect(dropped).toHaveLength(3)
      expect(dropped.every((d) => d.sessionId === 's1')).toBe(true)
      expect(dropped[2].valveTripped).toBe(true) // 死循环主形态同样触发终止阀
    })

    it('正常 reply 到达清理簿记：同 id 的后续超界帧退化为无法归因（null，不参与阀门）', () => {
      expect(send(subscribeMsg('rpc-x', 's1'))).toBe(true)
      // 可 parse 的正常帧带同 id → 簿记清理（订阅正常完成，归因锚退役）
      latestFake().triggerMessage(JSON.stringify({ id: 'rpc-x', type: 'session.subscribe', payload: { snapshot: [], lastSeq: 0 } }))

      latestFake().triggerMessage(oversizedFrame(subscribeReplyPrefix('rpc-x')))
      latestFake().triggerMessage(oversizedFrame(subscribeReplyPrefix('rpc-x')))
      latestFake().triggerMessage(oversizedFrame(subscribeReplyPrefix('rpc-x')))

      expect(dropped).toHaveLength(3)
      expect(dropped.every((d) => d.sessionId === null)).toBe(true)
      expect(isInboundValveTripped('s1')).toBe(false) // 无法归因 → 阀门不误触发
    })
  })

  describe('ws-client 入站检查 ④ in-flight subscribe 簿记生命周期（连接关闭清理，事件驱动）', () => {
    // 时间机制删除裁决：簿记不再按 TTL 惰性过期，改为随连接关闭清理（disconnect /
    // onclose 两路径）——关闭连接的 subscribe reply 永不到达，归因锚退役。
    beforeEach(() => {
      installTestPlatform()
      disconnect()
      _resetInboundGuardForTest()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      connect('ws://test', { auth: 'skip' })
      latestFake().triggerOpen()
    })

    afterEach(() => {
      disconnect()
      _resetInboundGuardForTest()
      vi.restoreAllMocks()
    })

    it('主动 disconnect 清空簿记（拆连后 reply 永不到达，归因锚退役）', () => {
      expect(send(subscribeMsg('rpc-old', 's1'))).toBe(true)
      expect(_inFlightSubscribeCountForTest()).toBe(1)

      disconnect()
      expect(_inFlightSubscribeCountForTest()).toBe(0)
    })

    it('异常关闭（onclose）清空簿记；重试 connect 后新订阅正常登记（不被误清）', () => {
      expect(send(subscribeMsg('rpc-drop', 's1'))).toBe(true)
      expect(_inFlightSubscribeCountForTest()).toBe(1)

      latestFake().triggerClose()
      expect(getState().value).toBe('failed')
      expect(_inFlightSubscribeCountForTest()).toBe(0)

      // 用户重试 connect → 新连接确立，resubscribeAll 形态的新订阅（新 id）正常登记
      connect('ws://test', { auth: 'skip' })
      latestFake().triggerOpen()
      expect(send(subscribeMsg('rpc-new', 's1'))).toBe(true)
      expect(_inFlightSubscribeCountForTest()).toBe(1)
    })
  })
});

// ======== 来源：ws-client.single-flight.test.ts ========
describe("ws-client.single-flight", () => {
  // ── 测试平台注入（fake websocket factory，每次 create 产出新 fake 并登记）──
  let fakes: FakeWebSocket[]

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

  function latestFake(): FakeWebSocket {
    expect(fakes.length).toBeGreaterThan(0)
    return fakes[fakes.length - 1]
  }

  /** close 配对不变量：任意时点非 CLOSED（存活/悬挂）socket 至多一个。 */
  function expectAtMostOneAlive(): void {
    const alive = fakes.filter((f) => f.readyState !== WS_READY_STATE.CLOSED)
    expect(alive.length).toBeLessThanOrEqual(1)
  }

  describe('ws-client 单飞防并存', () => {
    beforeEach(() => {
      installTestPlatform()
      disconnect() // 重置模块级单例状态（上轮残留连接）
    })
    afterEach(() => {
      disconnect()
    })

    it('旧 socket CLOSING（close 握手未完成）时 connect 不放行；close 事件到达落 failed，重连由显式 connect 接力', () => {
      // 复现路径：弱网下 close() 已发出但 close 事件未送达（socket 悬挂 CLOSING）
      connect('ws://test', { auth: 'skip' })
      const f1 = latestFake()
      f1.triggerOpen()
      f1.setReadyState(WS_READY_STATE.CLOSING)
      expect(getState().value).toBe('connected')

      // 外部 connect（visibility 切前台 / token 重试等价入场）：CLOSING 悬挂期不放行
      connect('ws://test', { auth: 'skip' })
      expect(fakes.length).toBe(1) // 未创建新 WS
      expectAtMostOneAlive()

      // close 事件最终送达 → onclose → failed 终态（无自动重连）
      f1.triggerClose()
      expect(getState().value).toBe('failed')

      // 重试入口（用户手动 / visibility 切前台）显式 connect：旧 socket 已死透 → 放行建新连接
      connect('ws://test', { auth: 'skip' })
      expect(fakes.length).toBe(2)
      expect(f1.readyState).toBe(WS_READY_STATE.CLOSED) // 旧 socket 已死透
      expect(getState().value).toBe('connecting')
      expectAtMostOneAlive()
    })

    it('onclose → failed 后重试（connect 再入场）：旧 socket 已 CLOSED → 放行重建', () => {
      connect('ws://test', { auth: 'skip' })
      latestFake().triggerOpen()
      latestFake().triggerClose() // 连接异常关闭 → failed 终态
      expect(getState().value).toBe('failed')
      const lenAtFail = fakes.length
      expectAtMostOneAlive()

      // 已 failed：无自动重连，state 停留在 failed 等用户手动重试
      expect(fakes.length).toBe(lenAtFail)
      expect(getState().value).toBe('failed')

      // 用户重试 / 重复 init 再入场：ws CLOSED → 放行，state 离开 failed
      connect('ws://test', { auth: 'skip' })
      expect(fakes.length).toBe(lenAtFail + 1)
      expect(getState().value).toBe('connecting')
      expectAtMostOneAlive()
    })

    it('混合驱动序列不变量：open/close/外部 connect 任意交错后非 CLOSED socket 至多一个', () => {
      connect('ws://test', { auth: 'skip' })
      latestFake().triggerOpen()
      expectAtMostOneAlive()

      // 已连接时重复 connect（外部入场口）→ 拦
      connect('ws://test', { auth: 'skip' })
      expect(fakes.length).toBe(1)

      latestFake().triggerClose() // 异常关闭 → failed
      expect(getState().value).toBe('failed')
      connect('ws://test', { auth: 'skip' }) // 重试（旧 socket 已 CLOSED → 放行）
      expect(fakes.length).toBe(2)
      expectAtMostOneAlive()

      // 主动断开后重复 connect（disconnect 置 ws=null → 放行）
      disconnect()
      connect('ws://test', { auth: 'skip' })
      expect(fakes.length).toBe(3)
      expectAtMostOneAlive()
    })
  })
});

// ======== 来源：ws-client.onerror（连接错误路径：warn 降级日志 + gen guard）========
// 覆盖 1769fa7c7 的降级裁决（console.error → console.warn：error 事件零信息，紧随的
// onclose 日志带 code 承载归因）与 onerror 的旧代残余回调 guard。
describe("ws-client.onerror", () => {
  // ── 测试平台注入（前述分节同款 fake websocket factory）──
  let fakes: FakeWebSocket[]

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

  function latestFake(): FakeWebSocket {
    expect(fakes.length).toBeGreaterThan(0)
    return fakes[fakes.length - 1]
  }

  beforeEach(() => {
    installTestPlatform()
    disconnect() // 重置模块级单例状态（上轮残留连接）
  })
  afterEach(() => {
    disconnect()
    vi.restoreAllMocks()
  })

  it('连接错误路径：降级 warn 日志（不落 error 级）并关闭当前 socket', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    connect('ws://test', { auth: 'skip' })
    latestFake().triggerOpen()
    latestFake().triggerError()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/\[ws\] connection error/)
    expect(errorSpy).not.toHaveBeenCalled() // 降级判别面：error 级三重噪音不再出现
    expect(latestFake().closeCalls).toBe(1) // onerror 处置 = 关闭当前 socket（onclose 随后落 failed 终态）
  })

  it('旧代残余 onerror：新连接建立后旧 socket 的 error 回调被 gen guard 拦下（不 warn、不误关新 socket）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    connect('ws://test', { auth: 'skip' })
    const oldFake = latestFake()
    oldFake.triggerOpen()
    oldFake.triggerClose() // 异常关闭 → failed；旧 socket 已 CLOSED（onerror 闭包仍持旧 gen）
    connect('ws://test', { auth: 'skip' }) // 旧 socket 已死透 → 放行建 gen2 新连接
    expect(fakes.length).toBe(2)
    const warnCountBeforeGen2 = warnSpy.mock.calls.length

    oldFake.triggerError()
    expect(warnSpy).toHaveBeenCalledTimes(warnCountBeforeGen2) // gen guard 早退：无降级日志
    expect(latestFake().closeCalls).toBe(0) // 不误关 gen2 新 socket
  })
});
