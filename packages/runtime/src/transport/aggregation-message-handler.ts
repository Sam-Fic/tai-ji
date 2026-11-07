/**
 * 模型路由域 aggregation.* message handler（getRouteView / saveRoute / deleteRoute，3 条 case；
 * provider-aggregation U9——路由视图 RPC 与保存/删除编排的 runtime 半边）。
 *
 * Extracted-settings 先例同款 class + handle() switch 形态（network-proxy-config-message-handler.ts
 * 同款；不匹配返回 false 由 SettingsMessageHandler 继续路由）。编排分工（D10 双权威分层）：
 * - routes 权威（端点/条件）写入在本 handler（modifyAggregationRoutes RMW，校验在锁内——
 *   validate 与写入读同一份 current，防并发保存竞态）；
 * - scopedModels 权威（可选性/顺序）的排序/开关写入不经本 handler——前端经既有
 *   config.setScopedModels 通道直达（D10/D11：该通道与其 default 同步编排零改动）；
 * - 删除是唯一 runtime 内跨两权威的编排点：routes 删除 → scopedModels 精确清理（按
 *   <聚合providerId>/<routeId> 复合串精确过滤，禁 provider 前缀清理——同一聚合 provider
 *   承载全部路由）→ 默认编排（清理后新首位同步为 default，决策纯函数与 setScopedModels
 *   既有编排同语义）→ 失败恢复（清理失败按 routes 删除为主语义，不回滚删除；残留孤儿由
 *   读取侧「失效引用」标记兜住，下一次保存清理）。
 *
 * 视图失效广播（protocol.ts aggregation.routeView 注释契约）：saveRoute/deleteRoute 成功后
 * 以 last-value 全量下发 join 视图，多窗口同步；前端丢失由 getRouteView 拉取收敛。
 */
import type { WebSocket as WsType } from 'ws'
import type { AggregationErrorCode, ClientMessage } from '@taiji/shared'
import { validateAggregationRouteUpsert } from '@taiji/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'
import {
  buildAggregationRouteView,
  resolveDefaultSyncAfterScopedWrite,
  scopedModelsWithRouteRemoved,
} from '@taiji/core/domain/settings'

/** 保存校验失败信封（error envelope code = shared AggregationErrorCode 词表）。 */
class AggregationRouteValidationError extends Error {
  constructor(
    public readonly code: AggregationErrorCode,
    public readonly errors: string[],
  ) {
    super(errors.join('；'))
  }
}

export class AggregationMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理模型路由域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'aggregation.getRouteView': {
        this.ctx.reply(ws, msg.id, 'aggregation.routeView', this.buildView())
        return true
      }
      case 'aggregation.saveRoute': {
        await this.handleSaveRoute(msg, ws)
        return true
      }
      case 'aggregation.deleteRoute': {
        await this.handleDeleteRoute(msg, ws)
        return true
      }
      default:
        return false
    }
  }

  /** join 视图组装（读取侧标记 → wire 载荷；纯逻辑单点 = core route-orchestration）。 */
  private buildView() {
    return buildAggregationRouteView(this.ctx.configService.readAggregationRoutes())
  }

  /**
   * routes 权威保存（单权威写——scopedModels 半边由前端经既有通道另行写入，跨两权威的
   * 保存顺序与回滚编排见 core route-orchestration createRouteSaveOrchestrator）。
   * 保存语义 = upsert：id 已存在视为自身替换（编辑保存），不存在按新建校验（撞名冲突
   * 拒绝）；跨 id 改名 = 删除重建（id 是跨进程对齐键，编辑器不提供改名——shared
   * validateAggregationRouteUpsert 注释契约）。校验失败在本 handler 内拦截直接 sendError
   * （AggregationErrorCode 词表 code，envelope 形态与 server.ts 全局 catch 同款；不经全局
   * catch——校验类失败是设计内合法产出，不落 server 级 handler error 日志）；非校验错误
   * 上抛经 server.ts 全局 catch。
   */
  private async handleSaveRoute(
    msg: Extract<ClientMessage, { type: 'aggregation.saveRoute' }>,
    ws: WsType,
  ): Promise<void> {
    const { route } = msg.payload
    try {
      await this.ctx.configService.modifyAggregationRoutes((current) => {
        const isReplace = current.some(r => r.id === route.id)
        const result = validateAggregationRouteUpsert(route, current, isReplace ? route.id : undefined)
        if (!result.ok) throw new AggregationRouteValidationError(result.code, result.errors)
        return isReplace ? current.map(r => (r.id === route.id ? route : r)) : [...current, route]
      })
    } catch (err) {
      if (err instanceof AggregationRouteValidationError) {
        this.ctx.sendError(ws, err.code, err.errors.join('；'), msg.id)
        return
      }
      throw err
    }
    const read = this.ctx.configService.readAggregationRoutes()
    const savedIssues = read.memberIssues.filter(i => i.routeId === route.id)
    this.ctx.reply(ws, msg.id, 'aggregation.routeSaved', { route, memberIssues: savedIssues })
    this.publishViewChanged()
    // SC2 状态副本同步（provider-aggregation §2.5）：路由保存后即触发 provider 列表广播，
    // 运行中会话的 model.list / config.providers 立即含新条目（启停/改名等经 saveRoute 的
    // 目录变化不滞留到下一次无关广播）。与 deleteRoute 分支的广播收尾对称。
    this.ctx.broadcastProviderList()
    // 触发点①（provider-aggregation D3/U4）：routes 权威写方时刻的额度按需刷新——端点
    // 条件/引用可能新增额度维度（含 simple→advanced 翻转），保存是明确数据需求时刻。
    // 可选钩子（组合根注入 U4 编排），内部自捕获错误 fire-and-forget，不阻断保存回执。
    this.ctx.aggregationRoutesMutated?.()
  }

  /**
   * 路由删除（runtime 内跨两权威编排，失败恢复语义见文件头）。回执携带清理后的
   * scopedModels 全量（前端整表替换）；清理失败时回执删除前原值——残留孤儿由读取侧
   * 「失效引用」标记兜住（下次 getRouteView / routeView 广播的 orphanRefs 呈现）。
   */
  private async handleDeleteRoute(
    msg: Extract<ClientMessage, { type: 'aggregation.deleteRoute' }>,
    ws: WsType,
  ): Promise<void> {
    const { routeId } = msg.payload
    const before = this.ctx.configService.readAggregationRoutes()
    if (!before.routes.some(r => r.id === routeId)) {
      this.ctx.sendError(ws, 'route_not_found', `路由 "${routeId}" 不存在，可能已被删除。请刷新路由页后重试。`, msg.id)
      return
    }
    // ① routes 删除（主语义——失败上抛经 server 全局 catch sendError，scopedModels 未动）。
    await this.ctx.configService.modifyAggregationRoutes(current => current.filter(r => r.id !== routeId))
    // ② scopedModels 精确清理（辅助语义——失败不回滚删除，显式呈报 + 读取侧标记兜住）。
    let cleaned: string[]
    let cleanupFailed = false
    try {
      cleaned = await this.ctx.configService.modifyScopedModels(current => scopedModelsWithRouteRemoved(current, routeId))
    } catch (err) {
      cleaned = before.scopedModels
      cleanupFailed = true
      console.warn(`[aggregation-handler] deleteRoute: scopedModels 精确清理失败（routes 删除已生效，残留引用由路由页「失效引用」提示兜住、下次保存清理；default 同步随清理失败一并跳过——scopedModels 权威未跟上，「新第一位即默认」前提不成立，已删路由的 default 悬空由 findValidDefaultModel 既有 auto-fix 兜底）：`, err)
    }
    // ③ 默认编排（清理后新首位同步为 default；失败降级 warn——删除主语义已生效，不阻断
    // 回执）。清理失败时跳过：cleaned 此时是删除前原值（可能含被删路由引用），以它为基准
    // 同步 default 会把已删路由写入 settings.json default 并广播假默认（U9 失败恢复语义：
    // 残留由读取侧「失效引用」标记兜住，不在残留态上叠加 default 改写）。
    if (!cleanupFailed) this.syncDefaultAfterScopedWrite(cleaned)
    this.ctx.broadcastProviderList()
    this.ctx.reply(ws, msg.id, 'aggregation.routeDeleted', { routeId, scopedModels: cleaned })
    this.publishViewChanged()
    // 触发点①（provider-aggregation D3/U4）：删除同样走 routes 写方时刻刷新编排——
    // 被删路由的额度端点引用消失，后续回合收尾（触发点③）的判定链自然收窄；本次调用
    // 使仍在服务中的其余路由引用端点保持新鲜。可选钩子同 saveRoute 分支语义。
    this.ctx.aggregationRoutesMutated?.()
  }

  /**
   * scopedModels 变化后的默认编排（决策单点 resolveDefaultSyncAfterScopedWrite 与
   * setScopedModels 既有编排同语义；写侧幂等对比同 model-message-handler
   * .syncDefaultToScopedModels：新首位 ≠ 当前 default 才写，相同视为已同步）。
   */
  private syncDefaultAfterScopedWrite(scopedModels: string[]): boolean {
    // routes 实况入参：路由级可用性判定（routeId 存在且 enabled）对齐读取侧
    // findValidDefaultModel 聚合分支——停用/悬空路由不被写成 default（清理失败路径已在
    // 上游跳过，此处再判一道兜住 cleanupFailed=false 但首位仍为停用路由的形态）。
    const target = resolveDefaultSyncAfterScopedWrite(
      scopedModels,
      this.ctx.configService.listProviders(),
      this.ctx.configService.readAggregationRoutes().routes,
    )
    if (!target) return false
    try {
      const currentDefault = this.ctx.configService.getDefaultModel()
      if (currentDefault && `${currentDefault.provider}/${currentDefault.modelId}` === target.ref) {
        return true
      }
      this.ctx.configService.setDefaultModel(target.provider, target.modelId)
      this.ctx.broadcast({
        type: 'config.defaults',
        id: this.ctx.nextPushId(),
        payload: { defaultModel: target.ref, source: 'default-set' },
      })
      return true
    } catch (err) {
      console.warn(`[aggregation-handler] default 同步到 "${target.ref}" 失败（scopedModels 已写入 ${scopedModels.length} 条），保留现有 default：`, err)
      return false
    }
  }

  /** 视图失效广播（join 视图全量重读下发；多窗口同步，last-value 语义）。 */
  private publishViewChanged(): void {
    this.ctx.broadcast({
      type: 'aggregation.routeView',
      id: this.ctx.nextPushId(),
      payload: this.buildView(),
    })
  }
}
