/**
 * Views API 模块
 *
 * 提供视图更新的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerViewRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.views.update / plugin.views.listMountPoints 两个 RPC 方法。
 *   update 校验归属二选一（provider-plugin-access U2 分区键泛化）后委托 handleViewUpdate
 *   回调（快照写入 + generation 分配 + 下行广播 plugin:viewUpdate），
 *   listMountPoints 读取挂载点集合副本（TC4：runtime 中继 renderer 上报的挂载点状态）。
 *
 * Worker 侧：createViewsApi() 返回代理对象，通过 RPC 转发到主线程。
 */

import type { GuiComponent } from '@zhushanwen/extension-protocol'
import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { PluginViewMeta, PluginViewScope, PluginContributesView } from '@taiji/shared'
import { errorWithCode } from '../../../utils/errors.js'
import { asSafeKey, asString, asOptionalString } from '../validation.js'

/** views.update 声明命中后的盖印增量（composer-tray-protocol D1/D7）：placement 按
 *  命中声明盖印（全局域分支恒 undefined——mountId 挂载点名是显式契约，不收资格制）；
 *  meta 为载荷可选动态信息原样透传（形状校验已在本模块入口完成）。 */
export interface ViewUpdateStamp {
  placement?: string
  meta?: PluginViewMeta
}

/** Views 服务依赖（主线程侧） */
export interface ViewService {
  /** 挂载点集合（AC10：renderer 经 plugin.mountPoints.sync 上报的副本，listMountPoints 读取） */
  mountPoints: string[]
  /**
   * 插件清单 contributes.views 声明副本查询（composer-tray-protocol D6 存储资格校验的
   * 判定输入）：runtime 装载 manifest 时 plugin-registry 已缓存 descriptor——生产实现 =
   * registry.getDescriptor(pluginId)?.contributes?.views ?? []（返回副本或只读引用均可，
   * 校验侧只读）。该插件无清单声明时返回空数组。
   */
  declaredViews: (pluginId: string) => PluginContributesView[]
  /**
   * 视图更新处理（快照写入 + generation 分配 + 下行广播 plugin:viewUpdate）。
   * 归属为 scope 联合（provider-plugin-access U2）：会话域 { sessionId } 定向投递该
   * 会话；全局域 { mountId, pluginId } 走全局广播（Provider 页等无会话挂载位，插件
   * 维度已并入分区键）。旧「payload.sessionId 显式必填」契约已泛化（二选一，都缺或
   * 都给 → INVALID_VIEW_SCOPE）。stamp 为盖印增量（见 ViewUpdateStamp）。
   */
  handleViewUpdate: (
    pluginId: string,
    viewId: string,
    guiTree: GuiComponent[],
    scope: PluginViewScope,
    stamp?: ViewUpdateStamp,
  ) => void
}

/**
 * views.update 的归属参数解析（U2 校验序）：sessionId / mountId 恰好其一。
 *
 * 错误码分层：都缺或都给 → INVALID_VIEW_SCOPE（归属形态错误）；present 但类型错 /
 * 非白名单字符 → INVALID_SESSION_ID / INVALID_MOUNT_ID（asSafeKey，值进分区键的
 * 路径安全校验，'provider.authorize' 形态的点号在白名单内）。globalPluginId = 全局
 * 域的插件维度（调用方已按「通道身份优先、载荷自报回落」解析，见 register 内注释）。
 */
export function resolveViewScope(params: Record<string, unknown>, globalPluginId: string): PluginViewScope {
  const sessionId = asOptionalString(params.sessionId, 'sessionId')
  const mountId = asOptionalString(params.mountId, 'mountId')
  if ((sessionId === undefined) === (mountId === undefined)) {
    throw errorWithCode(
      sessionId !== undefined
        ? 'Invalid view scope: sessionId and mountId are mutually exclusive — pass exactly one '
          + '(sessionId for a session-scoped view, mountId for a global mount point like "provider.authorize"). '
          + 'Remove the field you do not need and retry.'
        : 'Invalid view scope: exactly one of sessionId or mountId is required — pass sessionId '
          + '(session-scoped view) or mountId (global mount point like "provider.authorize"). '
          + 'Add the field matching where the view should render and retry.',
      'INVALID_VIEW_SCOPE',
    )
  }
  if (sessionId !== undefined) {
    return { kind: 'session', sessionId: asSafeKey(sessionId, 'sessionId') }
  }
  return { kind: 'global', mountId: asSafeKey(mountId!, 'mountId'), pluginId: globalPluginId }
}

/**
 * 会话域存储资格判定（composer-tray-protocol D6）：会话域推树的 viewId 必须命中该插件
 * 清单 contributes.views 的 raw 声明集合，命中则返回按声明盖印的 placement，未命中返回
 * undefined（调用方结构化拒绝）。
 *
 * 命中口径：viewId === 声明的有效 viewId（v.view ?? v.id——与渲染端 toContentSlotDeclaration
 * 的 renderer.viewId 同源映射）且声明 placement 为非空 string（raw manifest 缺 placement
 * 的声明视为无效声明，不可作为盖印依据）。**不校验 placement 族值**——placement 词表
 * 合法性校验（unknown-placement warn + 标 unavailable）仍在 renderer 注册表装载链
 * （content-slot-registry validateDeclaration），两道校验各管一层（存储资格归 runtime /
 * 派生资格归注册表）；runtime 不重复持有词表（跨进程，注册表实例在 renderer 不可反查）。
 */
function resolveDeclaredPlacement(views: PluginContributesView[], viewId: string): string | undefined {
  for (const v of views) {
    const effectiveViewId = v.view ?? v.id
    if (effectiveViewId === viewId && typeof v.placement === 'string' && v.placement.length > 0) {
      return v.placement
    }
  }
  return undefined
}

const VIEW_META_STATUS_VALUES = new Set(['running', 'done', 'failed', 'idle'])
const VIEW_META_SEVERITY_VALUES = new Set(['ok', 'warn', 'danger'])

/** meta 可选 string 字段校验（title / badge / progress.label 共用）：提供时必须是 string。 */
function assertMetaStringField(obj: Record<string, unknown>, key: string, message: string): void {
  const value = obj[key]
  if (value !== undefined && typeof value !== 'string') {
    throw errorWithCode(message, 'INVALID_VIEW_META')
  }
}

/** meta 可选枚举字段校验（status / severity 共用）：提供时必须命中枚举值集合。 */
function assertMetaEnumField(
  obj: Record<string, unknown>,
  key: string,
  allowed: Set<string>,
  message: (received: string) => string,
): void {
  const value = obj[key]
  if (value !== undefined && !allowed.has(value as string)) {
    throw errorWithCode(message(String(value)), 'INVALID_VIEW_META')
  }
}

/** meta.progress 子对象校验：必须是对象且 current/total 为数值；label/severity 可选字段。 */
function assertValidViewMetaProgress(progress: unknown): void {
  if (progress === null || typeof progress !== 'object' || Array.isArray(progress)) {
    throw errorWithCode(
      `Invalid meta.progress: expected an object with numeric current/total but received (${Array.isArray(progress) ? 'array' : typeof progress}).`,
      'INVALID_VIEW_META',
    )
  }
  const p = progress as Record<string, unknown>
  if (typeof p.current !== 'number' || typeof p.total !== 'number') {
    throw errorWithCode('Invalid meta.progress: current/total must be numbers.', 'INVALID_VIEW_META')
  }
  assertMetaStringField(p, 'label', 'Invalid meta.progress.label: expected a string.')
  assertMetaEnumField(
    p,
    'severity',
    VIEW_META_SEVERITY_VALUES,
    (received) => `Invalid meta.progress.severity: expected one of 'ok' | 'warn' | 'danger' but received (${received}).`,
  )
}

/**
 * views.update 载荷可选 meta 校验（composer-tray-protocol D7：角标/状态/进度动态信息，
 * WidgetMeta 同形）。校验口径：meta 提供时必须是对象；已知键按字段类型校验（title/badge
 * string、status/severity 枚举、progress 对象含 current/total 数值），未知键不校验
 * （消费端按需读，脏数据不崩——渲染端窄化同款哲学）。形状非法 → INVALID_VIEW_META
 * 结构化拒绝（畸形不触发广播，与本模块既有 INVALID_* 校验序一致）。
 */
function assertValidViewMeta(meta: unknown): void {
  if (meta === undefined) return
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw errorWithCode(
      `Invalid meta: expected an object (WidgetMeta-shaped optional payload) but received (${Array.isArray(meta) ? 'array' : typeof meta}).`,
      'INVALID_VIEW_META',
    )
  }
  const obj = meta as Record<string, unknown>
  assertMetaStringField(obj, 'title', 'Invalid meta.title: expected a string.')
  assertMetaStringField(obj, 'badge', 'Invalid meta.badge: expected a short display string.')
  assertMetaEnumField(
    obj,
    'status',
    VIEW_META_STATUS_VALUES,
    (received) => `Invalid meta.status: expected one of 'running' | 'done' | 'failed' | 'idle' but received (${received}).`,
  )
  if (obj.progress !== undefined) assertValidViewMetaProgress(obj.progress)
}

/**
 * 在 PluginRpcServer 上注册视图相关的 RPC handler。
 *
 * 注册的方法：
 * - `plugin.views.update` — 更新视图（校验归属二选一 + 委托 handleViewUpdate）
 * - `plugin.views.listMountPoints` — 查询挂载点集合（返回副本）
 */
export function registerViewRpcHandlers(
  rpcServer: PluginRpcServer,
  service: ViewService,
): void {
  rpcServer.registerMethod('plugin.views.update', async (params, dispatchCtx) => {
    // S3-W3 窄校验：viewId 进 ViewHostStore 分区键（白名单排除路径分隔符），
    // guiTree 必须是数组（条目结构由渲染端 ViewHostStore 二次窄化）。
    // 畸形即抛 INVALID_*，不触发广播。
    const viewId = asSafeKey(params.viewId, 'viewId')
    // pluginId 双源（U2 全局域键含插件维度）：全局域键用于多插件隔离（S25），插件维度
    // 取通道身份（sandbox fork 与 pluginId 一对一，宿主注册，不可伪造——消息体自报值
    // 任何安全判定不得引用，plugin-rpc-server.RpcIdentity 契约）；trusted 多插件共享
    // Worker 无唯一归属（identity.pluginId === undefined）→ 回落载荷自报（trusted 同
    // 进程对等体互不设防是既有设计语义）。会话域沿用既有取值路径：传给 handleViewUpdate
    // 的是 globalPluginId（身份优先值）——sandbox 通道该值经 overwriteSandboxPluginId
    // 在 dispatch 前已覆写为通道身份（值即通道身份），trusted Worker 回落分支保持载荷
    // 自报；两域同源，不存在「会话域自报 / 全局域身份」的来源差异。
    const identityPluginId = dispatchCtx?.identity?.pluginId
    const globalPluginId = identityPluginId !== undefined
      ? identityPluginId
      : asString(params.pluginId, 'pluginId')
    const scope = resolveViewScope(params, globalPluginId)
    const guiTree = params.guiTree
    if (!Array.isArray(guiTree)) {
      throw errorWithCode(
        `Invalid guiTree: expected an array of GuiComponent but received (${typeof guiTree}).`,
        'INVALID_GUI_TREE',
      )
    }
    // meta 可选校验（D7）：形状非法 → INVALID_VIEW_META，不触发广播
    assertValidViewMeta(params.meta)

    // 会话域存储资格校验（composer-tray-protocol D6）：viewId 必须命中本插件清单
    // contributes.views 声明集合，未命中 → UNDECLARED_VIEW_ID 结构化拒绝（文案附补
    // 声明指引），不入存储不广播——「不声明就没有」的写入层落点。全局域 mountId
    // 分支维持现状不收（挂载点名由宿主注册上报，本身是显式契约）。
    let stamp: ViewUpdateStamp | undefined
    if (scope.kind === 'session') {
      const placement = resolveDeclaredPlacement(service.declaredViews(globalPluginId), viewId)
      if (placement === undefined) {
        throw errorWithCode(
          `View "${viewId}" is not declared by plugin "${globalPluginId}" — session-scoped view updates require a matching `
            + `taijiPlugin.contributes.views entry in the plugin manifest (with id/view matching this viewId, plus placement and title). `
            + 'Add the declaration and retry; undeclared views are rejected so unclaimed trees never reach host storage.',
          'UNDECLARED_VIEW_ID',
        )
      }
      stamp = { placement, ...(params.meta !== undefined ? { meta: params.meta as PluginViewMeta } : {}) }
    } else {
      stamp = { ...(params.meta !== undefined ? { meta: params.meta as PluginViewMeta } : {}) }
    }

    service.handleViewUpdate(globalPluginId, viewId, guiTree as GuiComponent[], scope, stamp)

    return { updated: true }
  })

  rpcServer.registerMethod('plugin.views.listMountPoints', async () => {
    // 返回浅拷贝（T2 tradeoff：RPC 序列化边界不暴露内部数组引用，隔离写侧）
    return [...service.mountPoints]
  })
}

/**
 * 创建 Worker 侧 Views API 代理对象。
 *
 * update(viewId, guiTree, opts)：经 RPC 把视图树推给主线程 → 校验归属二选一 +
 * 会话域声明资格（UNDECLARED_VIEW_ID 拒绝）+ 广播 plugin:viewUpdate。opts 归属
 * 二选一（U2）：{ sessionId } 会话域 / { mountId } 全局域；都给或缺在 RPC 层拒绝
 * （INVALID_VIEW_SCOPE）。opts.meta 可选（composer-tray-protocol D7：角标/状态/进度
 * 动态信息，WidgetMeta 同形全字段可选——会话域推树须先在清单声明该 viewId）。
 * listMountPoints()：经 RPC 查询 runtime 中继的挂载点集合。
 */
export function createViewsApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  update(
    viewId: string,
    guiTree: GuiComponent[],
    opts: ({ sessionId: string } | { mountId: string }) & { meta?: PluginViewMeta },
  ): Promise<void>
  listMountPoints(): Promise<string[]>
} {
  return {
    update: (viewId, guiTree, opts) => {
      const { meta, ...scope } = opts
      return rpcClient
        .request('plugin.views.update', { pluginId, viewId, guiTree, ...scope, ...(meta !== undefined ? { meta } : {}) })
        .then(() => {})
    },

    listMountPoints: () =>
      rpcClient.request('plugin.views.listMountPoints', { pluginId }) as Promise<string[]>,
  }
}
