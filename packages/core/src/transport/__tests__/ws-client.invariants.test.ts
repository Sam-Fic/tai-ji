// ws-client 不变量特征测试 —— 规格权威。
//
// 规格来源：原 docs/architecture/renderer-rebuild/ws-client-invariants.md（文档已删除，
//   remote-use 期撰写，
//   依据 renderer-package-topology.md §5.1 ws-client 不预拆整体迁入 / §11.0.4 不变量定义
//   修正 / 附录 B.2-4 特征测试覆盖），2026-09-13 复核后沉入本注释块——文档已删除，本块是
//   特征测试断言点的唯一规格权威；描述已逐类对照现行实现（ws-client.ts + coordination/）修正。
//
// 不变量定义修正：旧「本地模式逐字节不变」不可执行（测试无法锁定字节级）→
//   新「特征测试覆盖的关键行为不变」（下列行为特征 = 特征测试必须锁定的不变量）。
//
// ── 不变量定义（按现行实现修正后的口径，[漂移] 标注与原稿的差异）──
// ① 连接状态机：模块级状态机仅允许合法迁移。现行 6 态 disconnected/connecting/connected/
//   restarting/failed/waiting-runtime。[漂移] 原稿 4 态 connecting/open/closing/closed 是
//   remote-use 期术语；closing 中间态不存在——主动 disconnect 先摘回调再 close，直接置
//   disconnected；reconnecting 态随自动重连机制删除退役。断言点：connecting → connected
//   （onopen，token 模式经 auth.result ok 的 markConnected）可达；主动 disconnect →
//   disconnected 可达且残余回调不干扰行为（行为范围锁定，不锁摘回调的实现手段——摘回调与
//   gen 拦截等价）；非法迁移拒绝（已连接/连接中重复 connect 幂等 no-op，不重置状态不建新
//   WS）；onclose → failed 终态（自动重连已删，closed 是手动重试的起点）。
// ② auth 握手：token 模式下 open 后首帧必为 {type:'auth', payload:{token}}，等 auth.result
//   才进消息处理（握手期业务消息丢弃）。应答无客户端计时窗——握手超时由 runtime 侧关闭
//   未认证连接驱动（onclose → failed）。[漂移] 原稿的 buildAuthMessage 共享函数与 auth.ok /
//   auth.reject 双类型不存在——现行 wire 协议是单一 auth.result { ok, reason? }
//   （shared/protocol.ts，runtime 对握手失败 close 1008），auth 帧在 ws-client onopen 内联
//   构造。[漂移] 原稿「auth.ok 后订阅 + flush pending」——resubscribeAll / pending rejectAll
//   归 use-connection 编排层（connected false→true watch 驱动），ws-client 层等价行为是
//   markConnected 置位 + pre-auth 队列 flush（见 ⑥）。[漂移] 原稿「auth.reject 降级：标记
//   连接不可用 + 壳降级 UI」——现行语义 = close 落 failed（新 token 由 use-connection 的
//   onRuntimePort 路径刷新后显式重连），非降级 UI。
// ③ close code 分流：按 WebSocket close code 分流。1001 段已激活（remote-use D8）：
//   现行 ws-client onclose 读 close code，1001（runtime 计划内关停）触发 onGoingAway 文案
//   信号；1006 等异常关闭不触发信号。两类 close 均落 failed 终态（自动重连已删）。
//   4001/4xxx「不重连」分流仍 todo（后续 wave）；分流判定集中在 ws-client 单点（不散落
//   routeInbound/domain）。[漂移] 原稿「4001 不重连」与现行 auth 拒绝行为（close → failed，
//   等 token 刷新后显式重连）语义已趋同——激活时按现行语义裁决分流表，不照搬原稿。
// ④ seq 回放（可靠投递语义）：session 通道消息带 seq，gap 检测后 reconcile 保证消息不丢。
//   seq 机制全部在 transport + coordination（seqGate / subscription-state / route-inbound），
//   不进 domain（domain store 只面对已排序、已去重的消息流）。断言点：gap 检测 → subscribe
//   reconcile（fromSeq = lastSeenSeq 排他下界）；[漂移] 原稿「reconcile 响应后服务端发
//   seqReset → reload 全量历史 + 重载前静默窗口」不存在（runtime/core 均无 seqReset）——现行
//   是增量回拉，snapshot/stateSnapshot 经 replay dispatcher 走与 live 相同的路由管线（seqGate
//   去重 + gapDispatchedSeqs 簿记 drop + ROUTE_TABLE effects），基线 max() 收敛不回退；
//   presence 弱可靠通道不入 seq 桶（靠 auth.ok/presence.list 兜底，约束同时锁定在
//   coordination/presence.ts 头注释，防未来误「修复」成入桶）；send.rejected 是 runtime 预检
//   拒绝的独立反馈类型（shared/protocol.ts D-006，带 clientUuid 回带），消费在
//   domain/chat/useChat（不进对话流）——原稿断言点已被实现消化，不在本文件 todo。
// ⑤ 断连恢复策略（时间机制删除裁决）：连接异常关闭（onclose）→ failed 终态等用户手动重试，
//   不做心跳保活、探活与自动退避重连。[漂移] 原稿「指数退避 1s/×2/30s 帽 + 60s 时长上限」
//   已整体删除；[漂移] 原稿「visibilitychange 触发立即重连 + 重置退避计数」保留在
//   transport/use-connection.ts（切回 visible 且未连接时用最近 url 主动重连，用户在场信号
//   驱动；无退避计数可言），由 use-connection-visibility.test.ts 锁定；in-flight subscribe
//   簿记随连接关闭清理（事件驱动，无 TTL）。
//
// ── 协议演进纪律 ──
// - ws-client 从 remote-use 整体迁入 core/transport 后不预拆（auth/seq 经模块级状态紧
//   耦合，拆分边界按实际耦合测量再定——架构文档 §5.1）。
// - 新增行为不变量时，先扩本注释块规格 + 新增 it.todo，再实现——规格先行，本注释块随实现
//   漂移时同步修正。
//
// ── 激活范围 ──
// 已激活：① 3 条 + ② 3 条 + ③ close code 分流 1001/1006 两条（remote-use D8）+ ④ gap
//   reconcile 1 条 + ⑤ 断连终态与手动重试 2 条 + ⑥ pre-auth 发送队列 5 条（review
//   findings-confirmation #3）+ 辅助状态（restarting/failed IPC 驱动）。
// 保持 todo 范围（C4 deferred）：③ 余 4001/4xxx 两条、④ reconcile 回放断言 + presence
//   2 条——4001/4xxx 分流与 presence 能力未落地，激活待后续 wave。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { providePlatform } from '../../platform/port'
import type { ClientMessage } from '@taiji/shared'
import {
  connect,
  disconnect,
  getState,
  onGoingAway,
  onMessage,
  onQueueDrop,
  setFailed,
  setRestarting,
  send,
  type SendQueueDropReason,
} from '../ws-client'
import { configureRouteInbound, type TransportPorts } from '../../coordination/route-inbound'
import { subscribeSession, resetSubscriptionStates } from '../../coordination/subscription-state'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'

// ── 测试平台注入（fake websocket factory，每次 create 产出新 fake 并登记） ──
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

describe('ws-client 不变量 ① 连接状态机', () => {
  beforeEach(() => {
    installTestPlatform()
    disconnect() // 重置模块级单例状态（上轮残留连接）
  })
  afterEach(() => {
    disconnect()
  })

  it('合法迁移 connecting → open 可达（onopen 触发）', () => {
    connect('ws://test', { auth: 'skip' })
    expect(getState().value).toBe('connecting')
    latestFake().triggerOpen()
    expect(getState().value).toBe('connected')
  })

  it('合法迁移 open → closed 可达（主动 disconnect，残余回调不干扰行为）', () => {
    connect('ws://test', { auth: 'skip' })
    latestFake().triggerOpen()
    expect(getState().value).toBe('connected')

    disconnect()
    expect(getState().value).toBe('disconnected')
    // 行为范围锁定（不锁「摘回调」实现手段——「保留回调 + gen 拦截」等价实现行为相同）：
    // 残余 open/close 触发不改变状态；主动断开不触发 failed（编排型拆连语义）
    const f = latestFake()
    f.triggerOpen()
    expect(getState().value).toBe('disconnected')
    f.triggerClose()
    expect(getState().value).toBe('disconnected')
    expect(fakes.length).toBe(1)
  })

  // 参数化覆盖单飞检查（connect 内「存在非 CLOSED socket 即 return」分支）的两个 readyState
  // 输入分区：connected（OPEN）与 connecting（CONNECTING）下重复 connect 一律幂等 no-op——
  // 不建新 WS、状态不被重置。CLOSING 分区由 single-flight 文件锁定（原 single-flight
  // 「CONNECTING 期间重复 connect」用例与本用例锁同一检查行，已收敛至此）。
  it.each([
    { partition: 'connected（OPEN）', driveOpen: true },
    { partition: 'connecting（CONNECTING）', driveOpen: false },
  ])('非法迁移：$partition 下重复 connect 幂等 no-op（不建新 WS、不重置状态）', ({ driveOpen }) => {
    connect('ws://test', { auth: 'skip' })
    if (driveOpen) latestFake().triggerOpen()
    const stateBefore = driveOpen ? 'connected' : 'connecting'
    expect(getState().value).toBe(stateBefore)
    expect(fakes.length).toBe(1)

    connect('ws://test-2', { auth: 'skip' }) // 非 CLOSED socket 存在，重复建连应被拒绝
    expect(fakes.length).toBe(1) // 未创建新 WS
    expect(getState().value).toBe(stateBefore) // 状态不被重置
  })
})

describe('ws-client 不变量 ② auth 握手', () => {
  // auth 握手已落地 core ws-client（onopen 首条 auth / auth.result ok 才 markConnected）。
  // core ws-client 层无「订阅触发 + pending flush」——resubscribeAll / pending.rejectAll
  // 归 use-connection 编排层（connected 状态监听驱动），故按 ws-client 实际行为断言等价语义
  // （connected 置位 + 握手期业务消息丢弃）。
  beforeEach(() => {
    installTestPlatform()
    disconnect() // 重置模块级单例状态（上轮残留连接）
  })
  afterEach(() => {
    disconnect()
  })

  it('auth.result ok=true 后进入 connected；握手期业务消息被丢弃（不进消息处理）', () => {
    const handler = vi.fn()
    const off = onMessage(handler)

    connect('ws://test', { auth: 'token', token: 'tok-1' })
    const f = latestFake()
    f.triggerOpen()
    // open 后首条 send 是 auth 握手消息
    expect(JSON.parse(f.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-1' } })
    // 握手未完成：不置 connected
    expect(getState().value).toBe('connecting')

    // 握手期业务消息（合法 ServerMessage 形状）不进入消息处理
    f.triggerMessage(JSON.stringify({ type: 'message.chunk', seq: 1, payload: { sessionId: 's1' } }))
    expect(handler).not.toHaveBeenCalled()

    // auth.ok → markConnected
    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
    expect(getState().value).toBe('connected')

    // 对照：握手完成后同一形状消息正常进入消息处理（丢弃仅发生在握手期）
    f.triggerMessage(JSON.stringify({ type: 'message.chunk', seq: 2, payload: { sessionId: 's1' } }))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.chunk' }))
    off()
  })

  it('auth.result ok=false（reject）后不进入 connected，close 落 failed 终态', () => {
    const handler = vi.fn()
    const off = onMessage(handler)

    connect('ws://test', { auth: 'token', token: 'tok-2' })
    const f = latestFake()
    f.triggerOpen()
    expect(getState().value).toBe('connecting')

    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: false } }))
    // 拒绝：不 markConnected（主动断开，新 token 由上层 connect(url, 新凭据对象) 刷新）
    expect(getState().value).toBe('connecting')
    expect(f.closeCalls).toBe(1)

    // 拒绝后仍处握手期：业务消息不进入消息处理
    f.triggerMessage(JSON.stringify({ type: 'message.chunk', seq: 1, payload: { sessionId: 's1' } }))
    expect(handler).not.toHaveBeenCalled()

    // close 完成（onclose 到达）→ failed 终态（无自动重连，等显式重连）
    f.triggerClose()
    expect(getState().value).toBe('failed')
    off()
  })

  it('auth 消息在 open 前不发（open 后首条 send 即 auth，含 payload.token 结构）', () => {
    connect('ws://test', { auth: 'token', token: 'tok-3' })
    const f = latestFake()
    // open 前（CONNECTING）：不发送任何消息
    expect(f.sent).toHaveLength(0)

    f.triggerOpen()
    expect(f.sent).toHaveLength(1)
    expect(JSON.parse(f.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-3' } })
  })
})

describe('ws-client 不变量 ③ close code 分流', () => {
  // onclose 读 close code：1001（Going Away = runtime 计划内关停，connection-manager stop
  // 发给全部存量连接）触发 onGoingAway 文案信号（消费方 = 移动壳 connection-view「服务重启中」
  // 分流）；其余 close code（1006 异常关闭等）不触发信号。两类 close 均落 failed 终态
  // （自动重连已删，重连由用户手动重试 / 快照推送驱动）。P6 探针（2026-10-03，
  // Playwright Chromium + 与 connection-manager 同调用形态的 ws server）证实浏览器
  // CloseEvent 可读 code/reason。原稿 4001/4xxx「不重连」分流仍属后续迁移 wave：
  // [漂移] 原稿「4001 不重连」与现行断连行为（close → failed，等 token 刷新后显式重连）
  // 语义已趋同——激活时按现行语义裁决分流表，不照搬原稿。分流判定必须集中在
  // ws-client 单点（不散落 routeInbound/domain），便于整体锁定行为。
  let goingAwayCount: number
  let removeGoingAway: () => void

  beforeEach(() => {
    installTestPlatform()
    disconnect()
    goingAwayCount = 0
    removeGoingAway = onGoingAway(() => {
      goingAwayCount++
    })
  })

  afterEach(() => {
    removeGoingAway()
    disconnect()
  })

  it('1001（服务端计划内关停）触发 onGoingAway 信号，close 落 failed 终态', () => {
    connect('ws://test', { auth: 'skip' })
    latestFake().triggerOpen()
    expect(goingAwayCount).toBe(0)

    // 合成事件与真实 CloseEvent 对齐（P6 探针实测 {code:1001, reason, wasClean:true}）
    latestFake().triggerClose({ code: 1001, reason: 'Server shutting down', wasClean: true })
    expect(goingAwayCount).toBe(1)
    // 文案信号不改终态判定：close → failed（重启窗口内由消费方文案分流，不升级判死语义）
    expect(getState().value).toBe('failed')
    expect(fakes.length).toBe(1) // 无自动重连
  })

  it('非 1001（1006 异常关闭）不触发 onGoingAway，同落 failed 终态', () => {
    connect('ws://test', { auth: 'skip' })
    latestFake().triggerOpen()

    latestFake().triggerClose({ code: 1006, reason: '', wasClean: false })
    expect(goingAwayCount).toBe(0)
    expect(getState().value).toBe('failed')
    expect(fakes.length).toBe(1) // 无自动重连
  })

  it.todo('4001（认证失效）不重连，标记需重新认证（壳降级 UI）')
  it.todo('4xxx（服务端正常关闭，如 4000/4003）不重连')
})

describe('ws-client 不变量 ④ seq 回放', () => {
  beforeEach(() => {
    installTestPlatform()
    disconnect()
    // 清订阅状态 Map（上轮用例残留 subscribed 标记会干扰 gap 判定，RK3）
    resetSubscriptionStates()
  })
  afterEach(() => {
    disconnect()
  })

  it('seq gap 检测后发起 reconcile 请求（拉取缺失区间）', async () => {
    // spyPorts：pending/events/subscribe 全 vi.fn()，subscribe 返回空 snapshot + lastSeq=10 预置基线
    const subscribeSpy = vi.fn(async () => ({ snapshot: [], stateSnapshot: [], lastSeq: 10 }))
    const spyPorts: TransportPorts = {
      pending: { resolve: vi.fn(), reject: vi.fn(), rejectAll: vi.fn(), has: vi.fn(() => false), resolveEnvelope: vi.fn() },
      events: { dispatchSession: vi.fn(), dispatchGlobal: vi.fn(), dispatchCrossSession: vi.fn() },
      subscribe: subscribeSpy,
    }
    // 注册 dispatcher（模拟 renderer ensureDispatcher 安装：onMessage(configureRouteInbound(ports))）
    onMessage(configureRouteInbound(spyPorts))

    connect('ws://test', { auth: 'skip' })
    latestFake().triggerOpen()

    // 预置 subscribed state：经真实 subscribeSession（spy reply lastSeq=10 → state={10, true}）
    await subscribeSession('s1')
    expect(subscribeSpy).toHaveBeenCalledWith('s1', undefined)

    // fake WS push seq=13 的 session 通道消息：s1 已 subscribed（lastSeenSeq=10），
    // 13 > 10+1 → gap，reconcileFromSeq = lastSeenSeq = 10（排他下界，覆盖缺失段 {11,12}；
    // 非 seq-1=12——runtime subscribe 只返 seq > fromSeq，传 12 会永久漏掉 11/12，MF-1）
    latestFake().triggerMessage(
      JSON.stringify({ type: 'message.chunk', seq: 13, payload: { sessionId: 's1' } }),
    )
    // flush subscribeSession 内部 await（fire-and-forget 微任务）
    await Promise.resolve()
    await Promise.resolve()

    expect(subscribeSpy).toHaveBeenCalledTimes(2)
    expect(subscribeSpy).toHaveBeenLastCalledWith('s1', 10)
  })

  // [漂移修正] 原稿描述「reconcile 响应后服务端发 seqReset → reload 会话历史（重载前静默
  // 窗口）」在现行实现不存在（runtime/core 均无 seqReset 消息、无全量 reload、无静默窗口）。
  // 现行语义：reconcile = subscribeSession(sid, lastSeenSeq) 增量回拉缺失段（fromSeq 排他
  // 下界），reply.snapshot/stateSnapshot 经注入的 replay dispatcher 进入与 live 相同的路由
  // 管线——seqGate 去重（gap 触发消息 live 已 dispatch 但基线未推进，靠 gapDispatchedSeqs
  // 簿记 drop；缺失段逐条递进推进基线）+ ROUTE_TABLE effects + crossSession 分发照常触发
  // （PR #175 review R1 MUST_FIX），基线 max() 收敛不回退（MF-3：reconcile 成功才推进，
  // 失败保持原位可重试）。激活时断言：回放去重 + 基线收敛 + 回放路径 effects 同触发。
  it.todo('reconcile 回放经与 live 相同的路由管线（gap 触发消息簿记去重 + 基线 max() 收敛）')
  // 约束仍有效（presence 弱可靠通道，架构文档 §5.3-4）：presence 是全局协同态，不入 seq 桶，
  // 靠 auth.ok / presence.list 兜底补全。本约束同时锁定在 coordination/presence.ts 头注释
  // （防未来误「修复」成入桶）。presence 当前为占位（C4 deferred）——激活待 presence 落地。
  it.todo('presence 弱可靠通道不入 seq 桶（靠 auth.ok/presence.list 兜底）')
})

describe('ws-client 不变量 ⑤ 断连恢复策略（onclose → failed 终态，手动重试接力）', () => {
  // 时间机制删除裁决：探活 / 心跳 / 指数退避重连已整体删除。断连恢复 = 用户手动重试
  // （连接屏重试按钮）/ visibility 切前台重连（use-connection，用户在场信号驱动）/
  // 快照推送（applyTargetSnapshot 断旧连新）三选一，全部事件驱动。
  beforeEach(() => {
    installTestPlatform()
    disconnect()
  })
  afterEach(() => {
    disconnect()
  })

  it('连接异常关闭落 failed 终态：时间推进不产生新连接（无自动重连）', () => {
    connect('ws://test', { auth: 'skip' })
    latestFake().triggerOpen()

    latestFake().triggerClose()
    expect(getState().value).toBe('failed')
    const lenAtFail = fakes.length

    // failed 终态稳定：无定时器驱动的重连（原 ⑤ 退避序列断言随机制删除退役）
    expect(fakes.length).toBe(lenAtFail)
    expect(getState().value).toBe('failed')
  })

  it('failed 后显式 connect（用户手动重试形态）放行重建，连接可达 connected', () => {
    connect('ws://test', { auth: 'skip' })
    latestFake().triggerOpen()
    latestFake().triggerClose()
    expect(getState().value).toBe('failed')
    const lenAtFail = fakes.length

    // 重试入口：显式 connect（旧 socket 已 CLOSED → 放行）
    connect('ws://test', { auth: 'skip' })
    expect(fakes.length).toBe(lenAtFail + 1)
    expect(getState().value).toBe('connecting')
    latestFake().triggerOpen()
    expect(getState().value).toBe('connected')
  })

  // [已保留] visibilitychange 切回 visible 触发重连已实现于 transport/use-connection.ts
  //（headless 化经 visibility 端口，非本文件职责）：切回 visible 且未连接时用最近 url
  //（lastConnectedUrl）主动重连；hidden 不触发、已 connected 不触发。
  // 由 use-connection-visibility.test.ts 锁定（无退避计数——自动重连已删）。
})

describe('ws-client 不变量 ⑥ pre-auth 发送队列', () => {
  // review findings-confirmation #3：TCP open → auth.result 窗口内 send() 真实送出会被 runtime
  // 设计性静默丢弃（connection-manager handleUnauthedMessage），pending 挂满 65s sweep。
  // 修复：OPEN 但本代未 auth → 入队；auth ok 后按序 flush；auth 失败 / 连接关闭 → 清队 +
  // onQueueDrop 通知（use-connection 消费方对带 id 消息 reject 对应 pending）。
  beforeEach(() => {
    installTestPlatform()
    disconnect()
  })
  afterEach(() => {
    disconnect()
  })

  /** 构造带 id 的 RPC 型 ClientMessage（生产 request.ts command() 同款形状，as 断言体例一致） */
  function rpcMsg(id: string): ClientMessage {
    return { type: 'config.sessions', id, payload: {} } as ClientMessage
  }

  it('pre-auth 窗口 send 入队（返回 true，不上 wire）；auth ok 后按序 flush', () => {
    connect('ws://test', { auth: 'token', token: 'tok-q1' })
    const f = latestFake()
    f.triggerOpen()
    expect(f.sent).toHaveLength(1) // 仅 auth 握手帧

    expect(send(rpcMsg('q-a'))).toBe(true)
    expect(send(rpcMsg('q-b'))).toBe(true)
    // pre-auth：接受但未上 wire（旧行为此处真实送出 → runtime 静默丢弃）
    expect(f.sent).toHaveLength(1)

    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
    expect(getState().value).toBe('connected')
    // flush 到达且保序
    expect(f.sent).toHaveLength(3)
    expect(JSON.parse(f.sent[1]).id).toBe('q-a')
    expect(JSON.parse(f.sent[2]).id).toBe('q-b')
  })

  it('auth 失败清队并通知 drop（带 id 消息可被消费方 reject），消息永不上 wire', () => {
    // 消费方模拟（生产由 use-connection 注册）：带 id 消息 → reject 对应 pending
    const rejectedIds: string[] = []
    let dropReason: SendQueueDropReason | undefined
    const off = onQueueDrop((msgs, reason) => {
      dropReason = reason
      for (const m of msgs) {
        const id = (m as { id?: string }).id
        if (typeof id === 'string') rejectedIds.push(id)
      }
    })

    connect('ws://test', { auth: 'token', token: 'tok-q2' })
    const f = latestFake()
    f.triggerOpen()
    expect(send(rpcMsg('q-rej'))).toBe(true)

    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: false } }))
    f.triggerClose() // auth reject 的 close 到达（落 failed 终态）
    expect(getState().value).toBe('failed')

    expect(f.sent).toHaveLength(1) // 只有 auth 帧，队列消息未上 wire
    expect(dropReason).toBe('auth-failed')
    expect(rejectedIds).toEqual(['q-rej'])
    off()
  })

  it('握手期连接关闭（server close）→ 清队并通知 drop（reason=closed）', () => {
    const droppedIds: string[] = []
    let dropReason: SendQueueDropReason | undefined
    const off = onQueueDrop((msgs, reason) => {
      dropReason = reason
      for (const m of msgs) droppedIds.push(...msgs.map((m2) => String((m2 as { id?: string }).id)))
    })

    connect('ws://test', { auth: 'token', token: 'tok-q3' })
    const f = latestFake()
    f.triggerOpen()
    expect(send(rpcMsg('q-timeout'))).toBe(true)

    f.triggerClose() // 握手期 server close（如 runtime 侧握手超时关闭未认证连接）→ onclose
    expect(getState().value).toBe('failed')
    expect(f.sent).toHaveLength(1)
    expect(dropReason).toBe('closed')
    expect(droppedIds).toEqual(['q-timeout'])
    off()
  })

  it('队列超限（256）驱逐最老并通知 overflow；flush 只发余下且保序', () => {
    const overflowIds: string[] = []
    const off = onQueueDrop((msgs, reason) => {
      expect(reason).toBe('overflow')
      overflowIds.push(...msgs.map((m) => String((m as { id?: string }).id)))
    })

    connect('ws://test', { auth: 'token', token: 'tok-q4' })
    const f = latestFake()
    f.triggerOpen()
    for (let i = 0; i <= 256; i++) send(rpcMsg(`q-${i}`)) // 257 条 → 驱逐 q-0
    expect(overflowIds).toEqual(['q-0'])

    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
    // 1 auth 帧 + 256 条队列消息
    expect(f.sent).toHaveLength(257)
    expect(JSON.parse(f.sent[1]).id).toBe('q-1')
    expect(JSON.parse(f.sent[256]).id).toBe('q-256')
    off()
  })

  it('已 auth 的连接 send 直发不入队（无回归）', () => {
    connect('ws://test', { auth: 'token', token: 'tok-q5' })
    const f = latestFake()
    f.triggerOpen()
    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
    expect(send(rpcMsg('q-direct'))).toBe(true)
    // auth 帧 + 直发消息，无队列中转延迟
    expect(f.sent).toHaveLength(2)
    expect(JSON.parse(f.sent[1]).id).toBe('q-direct')
  })
})

describe('ws-client 辅助状态（restarting/failed IPC 驱动）', () => {
  beforeEach(() => {
    installTestPlatform()
    disconnect()
  })
  afterEach(() => {
    disconnect()
  })

  it('setFailed 置 failed 终态并清空 pre-auth 队列', () => {
    connect('ws://test', { auth: 'skip' })
    latestFake().triggerOpen()
    setFailed()
    expect(getState().value).toBe('failed')
    expect(latestFake().closeCalls).toBe(0) // setFailed 只置态，不 close socket
  })

  it('setRestarting 断开当前连接并置 restarting', () => {
    connect('ws://test', { auth: 'skip' })
    latestFake().triggerOpen()
    setRestarting()
    expect(getState().value).toBe('restarting')
    expect(latestFake().closeCalls).toBe(1) // 当前 WS 被主动 close
    expect(getState().value).not.toBe('disconnected') // 不被断连逻辑覆盖
  })

  it('send 在 OPEN 时发送并返回 true，非 OPEN 返回 false', () => {
    connect('ws://test', { auth: 'skip' })
    expect(send({ type: 'ping', payload: {} })).toBe(false) // CONNECTING 不可发送
    latestFake().triggerOpen()
    expect(send({ type: 'ping', payload: {} })).toBe(true)
    expect(latestFake().sent).toHaveLength(1)
    expect(JSON.parse(latestFake().sent[0])).toEqual({ type: 'ping', payload: {} })
  })
})
