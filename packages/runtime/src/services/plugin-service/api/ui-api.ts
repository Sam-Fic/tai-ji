/**
 * UI API 模块
 *
 * 提供前端交互（对话框、通知）的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerUiRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.ui.showSelect / showConfirm / showInput / notify 四个 RPC 方法，
 *   以及 plugin-header-action-modal-points 点位的命令式方法：
 *   plugin.ui.updateHeaderAction（AP-1，sessionId 必填）。
 *
 * Worker 侧：createUiApi() 返回代理对象，通过 RPC 转发到主线程。
 *
 * showSelect/confirm/input 经 ctx.handleUiRequest 发 extension_ui_request 到前端并等待响应。
 *
 * UI 弹窗等待（时间机制删除裁决）：dialog 类三方法（showConfirm/showSelect/showInput）
 * 是「等人工操作」，无时限——请求挂到用户响应 / 插件卸载（Worker dispose 经
 * rpcClient.rejectAll 收尾在途请求）。requestId 在 Worker 侧生成随 params 传递，
 * queue 按它去重与响应匹配；无超时即无到期取消通知（expired 链已随超时删除）。
 * notify 纯展示类无等待语义。
 *
 * S3-W3（D7 窄校验层）：全部方法入口 fail-fast 校验——缺字段/错类型/越界键抛
 * INVALID_* 结构化错误（message 含字段名与期望格式），畸形输入不产生 UI 副作用。
 * S3-W4（D7 限流与防毒化）：
 *   - notify 与 plugin.notify 共用同一每插件令牌桶（deps.limiter，默认 20 条/s）
 *     + message ≤8KB（INVALID_MESSAGE）；
 *   - updateHeaderAction badge/tooltip 同口径 ≤4KB
 *     （INVALID_BADGE / INVALID_TOOLTIP，code 按字段名推导），
 *     超长展示文本不入广播帧。
 */

import type { HeaderActionUpdatePayload } from '@taiji/shared'
import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import {
  asBoundedString,
  asOptionalString,
  asSafeKey,
  asString,
  asStringArray,
} from '../validation.js'
import { errorWithCode } from '../../../utils/errors.js'
import { randomSuffix } from '../../../utils/ids.js'
import { guardNotifyParams, NotifyRateLimiter } from './notify-api.js'

/** KB → 字节换算 */
const BYTES_PER_KB = 1024
/** 对话框 title/message 等短文本上限：8KB（UTF-8 字节），防超长文本撑爆前端弹窗 */
const UI_TEXT_MAX_KB = 8
const UI_TEXT_MAX_BYTES = UI_TEXT_MAX_KB * BYTES_PER_KB

/**
 * headerAction badge·tooltip 上限：4KB（UTF-8 字节）。S3-W4 口径，超长展示
 * 文本在入口拒绝（INVALID_BADGE / INVALID_TOOLTIP），不入广播帧。
 */
const HEADER_TEXT_MAX_KB = 4
const HEADER_TEXT_MAX_BYTES = HEADER_TEXT_MAX_KB * BYTES_PER_KB

/** Worker→host dialog 请求携带的控制字段（queue 尊重来方值）。 */
export interface UiRequestMeta {
  requestId?: string
}

/** 从 handler params 提取控制字段（类型检查窄化，非法值不进 meta）。 */
function extractUiRequestMeta(params: Record<string, unknown>): UiRequestMeta {
  const meta: UiRequestMeta = {}
  if (typeof params.requestId === 'string' && params.requestId.length > 0) {
    meta.requestId = params.requestId
  }
  return meta
}

// ── plugin headerAction 广播出线（plugin-header-action-modal-points AP-1）──────
//
// 广播经 wireRuntimeUiExits 注入的出口执行（出口持有 broadcastFn，属于装配侧）。
// 出线缺省时 updateHeaderAction 回 {updated:false}——装配缺陷可见，不谎报成功。

/**
 * 广播出线（装配侧经 wireRuntimeUiExits 注入）。返回是否真正发出：false = 出线已接线
 * 但 broadcastFn 缺失被 warn 丢弃（装配缺陷）——调用方据此拒绝「假成功」回执
 * （B-F2：updateHeaderAction 回 {updated:false}，不让插件误以为渲染端已收到）。
 */
export interface RuntimeUiExits {
  broadcastHeaderActionUpdate: (payload: HeaderActionUpdatePayload) => boolean
}

let runtimeUiExits: RuntimeUiExits | null = null

/** 注入广播出线（registerAllRpcMethods 装配时调用一次；重复调用覆盖——模块级单例语义）。 */
export function wireRuntimeUiExits(exits: RuntimeUiExits): void {
  runtimeUiExits = exits
}

/** 测试复位（出线）。生产禁用。 */
export function resetRuntimeUiExitsForTest(): void {
  runtimeUiExits = null
}

/** UI 服务依赖（主线程侧） */
export interface UiHandlers {
  /**
   * 发送 extension_ui_request 到前端。
   * 经 handleUiRequest 发送，返回前端选择结果。
   * meta：Worker 侧生成的 requestId，透传 UiRequestQueue——queue 尊重来方 requestId
   * （去重与响应匹配按它进行）。
   */
  showSelect(title: string, options: string[], pluginId: string, meta?: UiRequestMeta): Promise<string | undefined>
  showConfirm(title: string, message: string, pluginId: string, meta?: UiRequestMeta): Promise<boolean>
  showInput(title: string, defaultValue: string | undefined, pluginId: string, meta?: UiRequestMeta): Promise<string | undefined>
  notify(pluginId: string, level: string, message: string): Promise<void>
  /**
   * notify 令牌桶（S3-W4）。缺省自建（默认 20 条/s）；与 plugin.notify 入口
   * 共享时应由装配方（plugin-rpc-setup）传入同一实例。
   */
  limiter?: NotifyRateLimiter
}

export function registerUiRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: UiHandlers,
): void {
  // notify 令牌桶（S3-W4）：与 plugin.notify 共用同一实例时由 deps.limiter 注入
  const limiter = deps.limiter ?? new NotifyRateLimiter()

  rpcServer.registerMethod('plugin.ui.showSelect', async (params) => {
    const title = asBoundedString(params.title, 'title', UI_TEXT_MAX_BYTES)
    const options = asStringArray(params.options, 'options')
    const pluginId = asString(params.pluginId, 'pluginId')
    return deps.showSelect(title, options, pluginId, extractUiRequestMeta(params))
  })

  rpcServer.registerMethod('plugin.ui.showConfirm', async (params) => {
    const title = asBoundedString(params.title, 'title', UI_TEXT_MAX_BYTES)
    const message = asBoundedString(params.message, 'message', UI_TEXT_MAX_BYTES)
    const pluginId = asString(params.pluginId, 'pluginId')
    return deps.showConfirm(title, message, pluginId, extractUiRequestMeta(params))
  })

  rpcServer.registerMethod('plugin.ui.showInput', async (params) => {
    const title = asBoundedString(params.title, 'title', UI_TEXT_MAX_BYTES)
    const defaultValue = asOptionalString(params.defaultValue, 'defaultValue')
    const pluginId = asString(params.pluginId, 'pluginId')
    return deps.showInput(title, defaultValue, pluginId, extractUiRequestMeta(params))
  })

  // ── plugin.ui.notify（与 plugin.notify 同一道窄校验 + 令牌桶）─────────────
  rpcServer.registerMethod('plugin.ui.notify', async (params) => {
    // 与 plugin.notify 同一道窄校验 + 令牌桶（guardNotifyParams 共用）
    const guarded = guardNotifyParams(limiter, params)
    if (guarded === null) {
      console.warn(
        `[ui-api] ui notify dropped: rate limit ${limiter.config.ratePerSec}/s exceeded (plugin=${String(params.pluginId)})`,
      )
      return
    }
    await deps.notify(guarded.pluginId, guarded.level, guarded.message)
  })

  // ── plugin headerAction 点位（AP-1，u5b）─────────────────────────────────
  // sessionId 必填（E15：缺/非法 → INVALID_SESSION_ID，不回落全局槽/猜测路径）。
  rpcServer.registerMethod('plugin.ui.updateHeaderAction', async (params) => {
    const pluginId = asString(params.pluginId, 'pluginId')
    const headerActionId = asSafeKey(params.headerActionId, 'headerActionId')
    // E15：徽标是 per-session 语义（AP-1），缺/非法 sessionId 拒绝、不回落全局槽
    const sessionId = asSafeKey(params.sessionId, 'sessionId')
    // badge/tooltip ≤4KB（S3-W4 同口径，B-F1）：超长展示文本不入广播帧
    const badge =
      params.badge === undefined ? undefined : asBoundedString(params.badge, 'badge', HEADER_TEXT_MAX_BYTES)
    const tooltip =
      params.tooltip === undefined ? undefined : asBoundedString(params.tooltip, 'tooltip', HEADER_TEXT_MAX_BYTES)
    if (params.disabled !== undefined && typeof params.disabled !== 'boolean') {
      throw errorWithCode(
        `Invalid disabled: expected a boolean but received ${typeof params.disabled}.`,
        'INVALID_DISABLED',
      )
    }
    if (params.hidden !== undefined && typeof params.hidden !== 'boolean') {
      throw errorWithCode(
        `Invalid hidden: expected a boolean but received ${typeof params.hidden}.`,
        'INVALID_HIDDEN',
      )
    }
    // badge ≤4 字符的截断由渲染端承担（AP-1），帧面存原文
    // B-F2：回执如实反映投递结果——出线未接线（optional-chain 跳过）或 broadcastFn
    // 缺失被 warn 丢弃时回 {updated:false}，不让插件误以为渲染端已收到
    const delivered =
      runtimeUiExits?.broadcastHeaderActionUpdate({
        pluginId,
        headerActionId,
        sessionId,
        ...(badge !== undefined && { badge }),
        ...(tooltip !== undefined && { tooltip }),
        ...(params.disabled !== undefined && { disabled: params.disabled }),
        ...(params.hidden !== undefined && { hidden: params.hidden }),
      }) ?? false
    return { updated: delivered }
  })
}

/**
 * dialog 类请求的统一发起（无时限等待）：
 * 1. requestId 在 Worker 侧生成（全局唯一：pluginId 前缀 + 时间戳 + 随机后缀——
 *    共享 Worker 内多插件并发不碰撞），随 params 传递（queue 按它去重与响应匹配）；
 * 2. 无超时参数——请求挂到用户响应 / 插件卸载（dispose 经 rpcClient.rejectAll 收尾）；
 *    其它错误（dispose / not attached / host 回包错误）原样传播。
 */
function dialogRequest<T>(
  rpcClient: PluginRpcClient,
  pluginId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const requestId = `${pluginId}_${Date.now()}_${randomSuffix()}`
  return rpcClient.request(method, { ...params, requestId }) as Promise<T>
}

export function createUiApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  showSelect(title: string, options: string[]): Promise<string | undefined>
  showConfirm(title: string, message: string): Promise<boolean>
  showInput(title: string, defaultValue?: string): Promise<string | undefined>
  notify(level: 'info' | 'warn' | 'error', message: string): Promise<void>
  /**
   * AP-1：badge/tooltip/disabled/hidden 可变字段更新（sessionId 必填，徽标是 per-session 语义）。
   * 回执 {updated}：true = 广播帧已发出；false = 渲染端未收到（装配缺陷被丢弃），插件
   * 可据此告警或走轮询兜底，不应把 false 当成功。
   */
  updateHeaderAction(id: string, opts: { sessionId: string; badge?: string; tooltip?: string; disabled?: boolean; hidden?: boolean }): Promise<{ updated: boolean }>
  /**
   * provider-plugin-access D9：打开外部 URL（授权页等）。宿主侧 http(s) scheme 白名单
   * 校验（INVALID_URL_SCHEME 拒绝 file:// 与自定义 scheme）；回执 {opened:false} =
   * scheme 已放行但宿主唤起出口未装配（装配缺陷可见，不假成功）。
   */
  openUrl(url: string): Promise<{ opened: boolean }>
} {
  return {
    showSelect: (title: string, options: string[]) =>
      dialogRequest<string | undefined>(rpcClient, pluginId, 'plugin.ui.showSelect', { pluginId, title, options }),

    showConfirm: (title: string, message: string) =>
      dialogRequest<boolean>(rpcClient, pluginId, 'plugin.ui.showConfirm', { pluginId, title, message }),

    showInput: (title: string, defaultValue?: string) =>
      dialogRequest<string | undefined>(rpcClient, pluginId, 'plugin.ui.showInput', { pluginId, title, defaultValue }),

    notify: (level: 'info' | 'warn' | 'error', message: string) =>
      rpcClient.request('plugin.ui.notify', { pluginId, level, message }).then(() => {}),

    updateHeaderAction: (id: string, opts: { sessionId: string; badge?: string; tooltip?: string; disabled?: boolean; hidden?: boolean }) =>
      rpcClient
        .request('plugin.ui.updateHeaderAction', { pluginId, headerActionId: id, ...opts })
        .then(v => v as { updated: boolean }),

    openUrl: (url: string) =>
      rpcClient
        .request('plugin.ui.openUrl', { pluginId, url })
        .then(v => v as { opened: boolean }),
  }
}
