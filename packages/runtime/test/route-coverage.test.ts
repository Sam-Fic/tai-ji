/**
 * 路由对账测试（plugin.listVersions 漏登记 handles 事故后立的门禁，2026-11-10）。
 *
 * 事故形态：fd3d42084 新增 plugin.listVersions 时改了协议类型、分发表、case handler
 * 三处，漏了第四处——server 路由表构建源（各 handler 的 handles 清单）。消息在路由层
 * 落 unknown_type，渲染端安装流程卡死。三道既有防线全部漏放：handles 类型是宽泛的
 * ClientMessageType[]（无完备性校验）、测试 mock 在 service 层（不经路由注册）、
 * RT-1#6 运行守卫只覆盖「认领有分发无」方向。
 *
 * 本测试补第四道防线：协议全集（shared CLIENT_MESSAGE_TYPES，与 ClientMessageType
 * 类型双向锁死）vs runtime 全部认领面（16 显式 handler handles + settings 兜底
 * claimedTypes + server 内联 2 项），差集必须 === 豁免清单（每条带理由）。
 * 新增 RPC 漏登记任何一处 → 差集多出一项 → 本测试红，错误信息列出漏登记名。
 */
import { CLIENT_MESSAGE_TYPES, type ClientMessageType } from '@taiji/shared'
import { describe, expect, it } from 'vitest'
import { BtwMessageHandler } from '../src/transport/btw-message-handler.js'
import { CanvasMessageHandler } from '../src/transport/canvas-message-handler.js'
import { ExtensionMessageHandler } from '../src/transport/extension-message-handler.js'
import { FileMessageHandler } from '../src/transport/file-message-handler.js'
import { GitMessageHandler } from '../src/transport/git-message-handler.js'
import { PluginMessageHandler } from '../src/transport/plugin-message-handler.js'
import { PresetMessageHandler } from '../src/transport/preset-message-handler.js'
import { ProjectMessageHandler } from '../src/transport/project-message-handler.js'
import { QuotaMessageHandler } from '../src/transport/quota-message-handler.js'
import { SessionMessageHandler } from '../src/transport/session-message-handler.js'
import { SettingsMessageHandler } from '../src/transport/settings-message-handler.js'
import { SubagentMessageHandler } from '../src/transport/subagent-message-handler.js'
import { TerminalMessageHandler } from '../src/transport/terminal-message-handler.js'
import { TtsMessageHandler } from '../src/transport/tts-message-handler.js'
import { UsageMessageHandler } from '../src/transport/usage-message-handler.js'
import { WorkspaceMessageHandler } from '../src/transport/workspace-message-handler.js'
import { WorktreeMessageHandler } from '../src/transport/worktree-message-handler.js'

/**
 * 豁免清单：不在任何 handler 认领面、但有明确归属的协议成员。登记纪律：
 * 每条必须带理由（值 = 归属说明）；失去豁免理由（如预留实装、孤儿清理）时必须移除。
 */
const ROUTE_COVERAGE_EXEMPT: ReadonlyMap<ClientMessageType, string> = new Map([
  ['auth', '连接层鉴权握手首帧：connection-manager 在路由分发之前拦截处理（非 buildRoutes 认领形态）'],
  ['runtime.readiness', 'startup-readiness-and-current-state 设计 M0 契约期预留，实装随 M2/U6（见 protocol.ts 条目注释）'],
  ['tool.approve', '已删除的 no-op 占位：工具审批走 extension_ui_request 通道，renderer 从不发送（settings-message-handler 注释在案）'],
  ['tool.deny', '同 tool.approve：已删除的 no-op 占位'],
  ['tool.always_allow', '同 tool.approve：已删除的 no-op 占位（「总是允许」由 config.setToolPermissions 声明式配置覆盖）'],
  ['config.getTimeout', '协议孤儿：core transport 有 command 发送点但 renderer 无调用、runtime 无处理（半残遗留，清理待裁）'],
  ['config.setTimeout', '同 config.getTimeout：协议孤儿（半残遗留，清理待裁）'],
])

/** messaging 最小 mock：各 handler 构造器只存 ctx，构造期不解引用 service。 */
const messaging = {
  sendError: () => {},
  reply: () => {},
} as const

/** as unknown 中转的 ctx 构造（红线禁 any；unknown 中转满足类型形状即可实例化）。 */
function minimalCtx<T>(): T {
  return { ...messaging } as unknown as T
}

/** 全部认领面聚合（与 server.ts buildRoutes + handleMessage 的认领结构一一对应）。 */
function collectClaimedTypes(): Set<ClientMessageType> {
  const claimed = new Set<ClientMessageType>()
  const addAll = (types: readonly ClientMessageType[]): void => {
    for (const t of types) claimed.add(t)
  }
  // server.ts buildRoutes 内联两项（ping 直回 pong；session.compactBackground 直连 handler）
  addAll(['ping', 'session.compactBackground'])
  // 16 个显式 handler（handles 已全部从内部分发表派生或字面量登记）
  addAll(new SessionMessageHandler(minimalCtx()).handles)
  addAll(new ExtensionMessageHandler(minimalCtx()).handles)
  addAll(new CanvasMessageHandler(minimalCtx()).handles)
  addAll(new PluginMessageHandler(minimalCtx()).handles)
  addAll(new SubagentMessageHandler(minimalCtx()).handles)
  addAll(new GitMessageHandler(minimalCtx()).handles)
  addAll(new FileMessageHandler(minimalCtx()).handles)
  addAll(new WorkspaceMessageHandler(minimalCtx()).handles)
  addAll(new ProjectMessageHandler(minimalCtx()).handles)
  addAll(new WorktreeMessageHandler(minimalCtx()).handles)
  addAll(new TerminalMessageHandler(minimalCtx()).handles)
  addAll(new QuotaMessageHandler(minimalCtx()).handles)
  addAll(new TtsMessageHandler(minimalCtx()).handles)
  addAll(new UsageMessageHandler(minimalCtx()).handles)
  addAll(new PresetMessageHandler(minimalCtx()).handles)
  addAll(new BtwMessageHandler(minimalCtx()).handles)
  // settings 兜底（偏好组 + 域路由表，claimedTypes 从既有结构派生）
  addAll(new SettingsMessageHandler(minimalCtx()).claimedTypes)
  return claimed
}

describe('路由对账：协议全集 vs runtime 认领面', () => {
  it('协议每个成员都被认领或登记豁免（漏登记即红，错误信息列出漏登记名）', () => {
    const claimed = collectClaimedTypes()
    const unclaimed = CLIENT_MESSAGE_TYPES.filter(
      (type) => !claimed.has(type) && !ROUTE_COVERAGE_EXEMPT.has(type),
    )
    expect(
      unclaimed,
      `以下协议成员无任何 handler 认领也未登记豁免——若为新增 RPC，在对应 handler 的分发表加 case（handles 由表派生自动跟上）；若为预留/孤儿，在本测试 ROUTE_COVERAGE_EXEMPT 登记并写理由：\n${unclaimed.join('\n')}`,
    ).toEqual([])
  })

  it('豁免清单不腐化：每条豁免仍是有效协议成员', () => {
    const stale = [...ROUTE_COVERAGE_EXEMPT.keys()].filter(
      (type) => !CLIENT_MESSAGE_TYPES.includes(type),
    )
    expect(
      stale,
      `豁免清单登记了协议已不存在的成员（类型已删除？豁免应随之移除）：\n${stale.join('\n')}`,
    ).toEqual([])
  })

  it('认领面不越界：每个认领项都是有效协议成员（拼写错/协议漏登记即红）', () => {
    const claimed = collectClaimedTypes()
    const protocol = new Set<string>(CLIENT_MESSAGE_TYPES)
    const foreign = [...claimed].filter((type) => !protocol.has(type))
    expect(
      foreign,
      `handler 认领了协议之外的成员（handles 拼写错，或 ClientMessageType 漏登记该类型）：\n${foreign.join('\n')}`,
    ).toEqual([])
  })
})
