// plugin-downlink-contract.test.ts —— plugin 系下行帧 ↔ bridge PLUGIN_HANDLERS 跨包对账（机器防线）。
//
// 防的缺口：runtime 新增 plugin: 下行广播类型时 renderer 侧 PLUGIN_HANDLERS 漏登记，
// 帧落 bridge「未知类型」error 路径（bus error from plugin:xxx: unknown message type；
// 曾漏形态 = plugin:commandRegistered，2026-10 裁决补登记 + 本对账）。
//
// 取数源（避免 grep 源码的扫描方式）：runtime 广播字面量散落生产点、无集中常量，
// 权威枚举收敛在 wire SSOT = @taiji/shared PLUGIN_DOWNLINK_TYPES（protocol.ts，
// `satisfies readonly ServerMessageType[]` 锚定 union 成员；收敛决策与残余缺口说明
// 见该常量注释）。
//
// 断言三向：
//   ① 编译期：ServerMessageType union 的 `plugin:` 冒号前缀成员 ⊆ PLUGIN_DOWNLINK_TYPES
//     （union 加成员漏登记清单 = 本文件类型错误，CI TypeCheck - core 拦截）；
//   ② 运行时：PLUGIN_DOWNLINK_TYPES 每个类型 ∈ PLUGIN_BRIDGE_TYPES ∪ 专用消费方豁免清单；
//   ③ 运行时反向：PLUGIN_BRIDGE_TYPES 每个键 ∈ PLUGIN_DOWNLINK_TYPES（bridge 键必须是
//     已登记 wire 类型，拦手写漂移）。
// 另附 plugin:commandRegistered 的 bridge 归一行为断言（登记转发的最小行为锁定）。
import { describe, it, expect } from 'vitest'
import { PLUGIN_DOWNLINK_TYPES, type ServerMessageType } from '@taiji/shared'
import { MessageBusBridge, PLUGIN_BRIDGE_TYPES } from '../message-bus-bridge'
import { MockMessageSource, type IncomingPluginMessage } from '../plugin-message-source'
import { InternalEventBus } from '../internal-event-bus'

// ── ① 编译期差集断言（union 的 plugin: 成员与清单严格一致）───────────────────
// 差集非空时本类型解析为差集元组、赋值报编译错误（错误消息含漏登记成员名）；
// 编译通过时恒为 true，下方运行时断言兜底表达。
type _UncoveredWireDownlink = Exclude<Extract<ServerMessageType, `plugin:${string}`>, (typeof PLUGIN_DOWNLINK_TYPES)[number]>
const wireUnionFullyCovered: _UncoveredWireDownlink extends never ? true : [_UncoveredWireDownlink] = true

describe('plugin 下行帧 ↔ PLUGIN_HANDLERS 跨包对账', () => {
  it('① ServerMessageType union 的 plugin: 成员全部登记进 PLUGIN_DOWNLINK_TYPES（编译期差集恒空）', () => {
    expect(wireUnionFullyCovered).toBe(true)
  })

  // 专用消费方豁免清单：不进 bridge PLUGIN_HANDLERS 的 wire 类型，逐条带消费方指针。
  // 新增豁免须附理由与消费方文件——豁免 = 「该类型有意不经 bridge 归一」的登记决策，
  // 不是漏登记的掩体；若该类型同时也在落 bridge 未知类型 error 路径（见会话报告的
  // 存量 wart），登记与否属产品裁决，不在本测试内自行扩权。
  const DEDICATED_CONSUMER_EXEMPTIONS: Record<string, string> = {
    // provider-plugin-access D9：core transport events 域订阅（domains/plugin.ts
    // onGlobalType('plugin:event')），首个消费方 = 凭据状态增量提示（D5）。
    'plugin:event': 'core transport events 域 onGlobalType 专用订阅（domains/plugin.ts）',
    // timeout-plugin-service D2：ui 壳 companion-band 适配层 onGlobal 直订撤窗
    //（shell-adapters.ts onUiRequestExpired）。
    'plugin:uiRequestExpired': 'ui shell-adapters onGlobal 专用订阅（超时撤窗，D2）',
    // timeout-plugin-service D3：ui permission-request-controller WS 直订撤审批弹窗。
    'plugin:permissionRequestExpired': 'permission-request-controller WS 专用订阅（审批超时撤窗，D3）',
    // plugin.ui.snapshot 拉取 RPC 的 reply（msg.id 命中 pending 层消费），reply 帧不进
    // 广播路由（route-inbound 先判 id），永不达 bridge。
    'plugin:uiSnapshot': 'RPC reply 帧（pending 层按 id 消费），非广播不进 bridge',
  }

  it('② PLUGIN_DOWNLINK_TYPES 每个类型被 PLUGIN_HANDLERS 登记或在专用消费方豁免清单内', () => {
    const bridgeTypes = new Set(PLUGIN_BRIDGE_TYPES)
    const unregistered = PLUGIN_DOWNLINK_TYPES.filter(
      (t) => !bridgeTypes.has(t) && !(t in DEDICATED_CONSUMER_EXEMPTIONS),
    )
    // 消息可操作：缺恢复动作（登记豁免二选一）+ 权威源指针
    expect(
      unregistered,
      `以下 wire 下行类型未登记 PLUGIN_HANDLERS 也未登记豁免：${unregistered.join(', ')}。` +
        '恢复：在 message-bus-bridge.ts PLUGIN_HANDLERS 补解析函数（转 bus 事件外发），' +
        '或在本测试 DEDICATED_CONSUMER_EXEMPTIONS 登记专用消费方指针（豁免 = 有意不经 bridge 的登记决策）',
    ).toEqual([])
  })

  it('③ PLUGIN_BRIDGE_TYPES 每个键都是已登记的 wire 下行类型（反向：拦手写漂移）', () => {
    const wireTypes = new Set<string>(PLUGIN_DOWNLINK_TYPES)
    const orphans = PLUGIN_BRIDGE_TYPES.filter((t) => !wireTypes.has(t))
    expect(
      orphans,
      `PLUGIN_HANDLERS 含未登记 wire SSOT 的键：${orphans.join(', ')}。` +
        '恢复：在 packages/shared/src/protocol.ts 补 ServerMessageType union 成员 + PLUGIN_DOWNLINK_TYPES 清单项（wire 契约先于 bridge 键）',
    ).toEqual([])
  })

  it('plugin:commandRegistered 帧经 bridge 归一为 plugin-command-registered 事件（簿记字段剥除）', () => {
    const source = new MockMessageSource()
    const bus = new InternalEventBus()
    const events: unknown[] = []
    bus.on('plugin-command-registered', (e) => events.push(e))
    new MessageBusBridge({ source, bus })

    const msg: IncomingPluginMessage = {
      type: 'plugin:commandRegistered',
      payload: {
        pluginId: 'demo-plugin',
        commandId: 'demo.refresh',
        handlerId: 'handler-1',
        workerId: 'worker-1',
        title: 'Refresh',
        registeredAt: 1700000000000,
      },
    }
    source.emit(msg)

    // 簿记字段（handlerId/workerId/registeredAt）不进 renderer 事件；声明字段原样保留
    expect(events).toEqual([
      {
        kind: 'plugin-command-registered',
        command: { pluginId: 'demo-plugin', commandId: 'demo.refresh', title: 'Refresh' },
      },
    ])
  })
})
