/**
 * Workspace 偏好组 config.* message handler（worktree 目录/脚本 + 默认基分支
 * + UI 语言，9 条简单读写转发 case）。
 *
 * Extracted from settings-message-handler.ts to reduce file size（该文件同类先例：
 * 「Extracted from RuntimeServer to reduce file size」；本组 case 全部仅消费
 * ctx.configService + ctx.reply，迁移零行为变化）。
 *
 * [M4/RT-7#1] 写 case 的落盘失败（config.json 损坏降级态拒绝覆写 / IO 失败）按 D10
 * 错误信封回复（code 透传 SaveAppConfigResult.code），不 reply 成功——对齐
 * system-prompt-terminal-message-handler 的 set 失败形态。
 *
 * 表驱动形态（原直排 switch 改查表，plugin.listVersions 漏登记 handles 事故后改造）：
 * mapped type 完备映射使「表加 key 漏类型 / 类型加成员漏表」双向编译锁死；
 * claimedTypes 由表派生（单一事实源），runtime 路由对账测试消费。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@taiji/shared'
import { writeUiPreferences } from '../services/ui-preferences-helper.js'
import type { SettingsHandlerContext } from './settings-message-handler.js'

/** 偏好组认领的 type 全集（分发表 key 域，单一事实源）。 */
type PreferencesHandledType =
  | 'config.setWorktreeRootDir' | 'config.getWorktreeRootDir'
  | 'config.setSetupScript' | 'config.getSetupScript'
  | 'config.setBareSetupScript' | 'config.getBareSetupScript'
  | 'config.setDefaultBaseBranch' | 'config.getDefaultBaseBranch'
  | 'config.setUiLocale'

/** 按 type 字面量收窄 ClientMessage（查表 key = 运行时 guard，与 switch narrowing 同构）。 */
type PreferencesMsg<T extends PreferencesHandledType> = Extract<ClientMessage, { type: T }>

export class ConfigPreferencesMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /**
   * 分发表：mapped type 完备映射（漏 key / 多 key 均编译错）。条目体与原 switch case
   * 逐字搬移（全同步，时序不变）；查表落空返回 false 与原 default 一致。
   */
  private readonly caseHandlers: { readonly [K in PreferencesHandledType]: (msg: PreferencesMsg<K>, ws: WsType) => void } = {
    'config.setWorktreeRootDir': (msg, ws) => this.setAndReply(ws, msg.id, this.ctx.configService.setWorktreeRootDir(msg.payload.dir), () =>
      this.ctx.reply(ws, msg.id, 'config.worktreeRootDir', { dir: this.ctx.configService.getWorktreeRootDir() })),
    'config.getWorktreeRootDir': (msg, ws) =>
      this.ctx.reply(ws, msg.id, 'config.worktreeRootDir', { dir: this.ctx.configService.getWorktreeRootDir() }),
    'config.setSetupScript': (msg, ws) => this.setAndReply(ws, msg.id, this.ctx.configService.setSetupScript(msg.payload.script), () =>
      this.ctx.reply(ws, msg.id, 'config.setupScript', { script: this.ctx.configService.getSetupScript() })),
    'config.getSetupScript': (msg, ws) =>
      this.ctx.reply(ws, msg.id, 'config.setupScript', { script: this.ctx.configService.getSetupScript() }),
    'config.setBareSetupScript': (msg, ws) => this.setAndReply(ws, msg.id, this.ctx.configService.setBareSetupScript(msg.payload.script), () =>
      this.ctx.reply(ws, msg.id, 'config.bareSetupScript', { script: this.ctx.configService.getBareSetupScript() })),
    'config.getBareSetupScript': (msg, ws) =>
      this.ctx.reply(ws, msg.id, 'config.bareSetupScript', { script: this.ctx.configService.getBareSetupScript() }),
    'config.setDefaultBaseBranch': (msg, ws) => this.setAndReply(ws, msg.id, this.ctx.configService.setDefaultBaseBranch(msg.payload.baseBranch), () =>
      this.ctx.reply(ws, msg.id, 'config.defaultBaseBranch', { baseBranch: this.ctx.configService.getDefaultBaseBranch() })),
    'config.getDefaultBaseBranch': (msg, ws) =>
      this.ctx.reply(ws, msg.id, 'config.defaultBaseBranch', { baseBranch: this.ctx.configService.getDefaultBaseBranch() }),
    // u-locale-channel：写 <dataDir>/ui-preferences.json（tmp+rename 原子写，extension 侧只读热生效）。
    // 无读回 RPC，成功只回 ack（config.uiLocaleSet）；写盘失败经 setAndReply 走 D10 错误信封。
    'config.setUiLocale': (msg, ws) => this.setAndReply(ws, msg.id, writeUiPreferences(this.ctx.configService.getConfigDir(), msg.payload.locale), () =>
      this.ctx.reply(ws, msg.id, 'config.uiLocaleSet', {} as Record<string, never>)),
  }

  /** 本组认领清单——派生自分发表（单一事实源，路由对账测试消费）。 */
  readonly claimedTypes: readonly ClientMessageType[] = Object.keys(this.caseHandlers) as ClientMessageType[]

  /** 处理偏好组消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    // 路由表 key 与 msg.type 字面量同源（上方表逐 key 登记），查表命中即类型匹配；
    // TS 无法静态关联索引访问与 key（correlated types，microsoft/TypeScript#30581），
    // `as never` 是该不变式下的类型层收尾，运行时分发行为与原 switch 完全一致
    //（未命中 → return false，同原 default 分支）。cast 形态对齐 settings/routes 先例。
    const handler = (this.caseHandlers as Partial<Record<ClientMessageType, (msg: ClientMessage, ws: WsType) => void>>)[msg.type]
    if (!handler) return false
    handler(msg as never, ws)
    return true
  }

  /**
   * set case 共用形态：落盘成功 → replyValue 回包读回值；失败 → D10 错误信封
   * （code 透传 SaveAppConfigResult.code）直接回复，不 reply 成功。
   */
  private setAndReply(
    ws: WsType,
    msgId: string | undefined,
    result: { ok: boolean; code?: string; error?: string },
    replyValue: () => void,
  ): void {
    if (result.ok) {
      replyValue()
      return
    }
    this.ctx.sendError(ws, result.code ?? 'app_config_io_error', result.error ?? 'unknown error', msgId)
  }
}
