/**
 * 托盘 widget 静态信息（标题/图标）的声明取数通道
 * （composer-tray-protocol D7：插件托盘 view 的 title/icon 取清单声明，与 drawer.tab 标签条
 * 同源；差距登记 G10「消费端取值链」的消费半边）。
 *
 * 数据源 = core 模块级单例 contentSlotRegistry（插件 manifest contributes.views 在 renderer
 * 的既有投影，灌入写点 = useExtensionHostBridge.loadExternalContentSlots 单一写路径）。
 *
 * 匹配键：声明 placement === 'composer.tray'（托盘位）× renderer.kind === 'view'
 *（托盘按钮的 viewId 消费形态）× renderer.viewId === viewId × pluginId（条目携带归属；
 * 缺省（测试直挂等）只按 viewId 匹配）。扩展源条目（setWidget 通道）无清单声明，查不到
 * 声明 = undefined——消费端标题链自然落 meta.title ?? viewId（既有行为，零回退）。
 *
 * **本文件是托盘位声明匹配谓词与标题兜底链的单份持有处**：按钮、面板、聚合段头三
 * 消费端共用，禁止在组件内各写一份 placement/viewId 过滤或标题兜底链（谓词/链漂移
 * = 标题与面板标题不同源，违反 D7 同源契约）。
 */
import { computed, toValue } from 'vue'
import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import { COMPOSER_TRAY_PLACEMENT } from '@taiji/core'
import type { WidgetMeta } from '@zhushanwen/extension-protocol'
import { getContentSlotRegistry } from '@/lib/content-slots'

/** 托盘位声明投影（静态信息切片；title = 声明 label，声明结构必填；纯数据形状无实现语义，type alias 是准确形态） */
export type TrayWidgetDeclaration = {
  title: string
  icon?: string
}

/**
 * 托盘位声明单条查询（纯函数；响应式依赖由调用方建立——computed 内先
 * `void registry.snapshot.value` 再调本函数，声明装载/清理才驱动标题刷新，§7.2 范式）。
 *
 * @param viewId widget key（= ViewHostStore viewId；声明侧关联键 = renderer.viewId）
 * @param pluginId 条目归属插件 id（ViewHostStore 条目透传；缺省只按 viewId 匹配）
 * @returns 命中的托盘位声明切片；未命中（扩展源 / 未声明 / 非托盘位）= undefined
 */
export function findTrayWidgetDeclaration(
  viewId: string,
  pluginId: string | undefined,
): TrayWidgetDeclaration | undefined {
  const registry = getContentSlotRegistry()
  const found = registry.snapshot.value.find((d) =>
    d.placement === COMPOSER_TRAY_PLACEMENT
    && d.renderer.kind === 'view'
    && d.renderer.viewId === viewId
    && (pluginId === undefined || d.pluginId === pluginId),
  )
  return found === undefined
    ? undefined
    : { title: found.label, ...(found.icon !== undefined ? { icon: found.icon } : {}) }
}

/** @param viewId widget key（响应式取值，条目增删即重查）
 *  @param pluginId 条目归属插件 id（响应式取值）
 *  @returns 命中的托盘位声明切片；未命中 = undefined
 */
function useTrayWidgetDeclaration(
  viewId: MaybeRefOrGetter<string>,
  pluginId: MaybeRefOrGetter<string | undefined>,
): ComputedRef<TrayWidgetDeclaration | undefined> {
  return computed(() => {
    void getContentSlotRegistry().snapshot.value // 先建依赖再查询（§7.2：声明变更驱动标题刷新）
    return findTrayWidgetDeclaration(toValue(viewId), toValue(pluginId))
  })
}

/**
 * 托盘条目显示标题兜底链本体（D7 单一兜底链的唯一实现，branch-review R1 dmg-r1-3
 * 收编——此前 TrayWidgetButton / TrayWidgetPanel 侧 composable 与 TrayAggregatePanel
 * widgetTitleOf 各持一份逐行等价副本，链升级时段头标题会静默漂移）：
 * 声明 title ?? meta.title（空串视为缺省）→ viewId（v1 旧 extension 与脏数据兜底——
 * 声明与 meta 双缺才出现 viewId 裸标题）。三消费端（按钮 / 面板经 useTrayWidgetDisplayTitle，
 * 聚合段头经 TrayAggregatePanel.widgetTitleOf）禁止各写一份兜底链（链漂移 = 按钮标题
 * 与面板标题不同源，违反 D7 同源契约）。
 *
 * 纯函数（无响应式依赖）：逐条取数场景直接调用；响应式包装见 useTrayWidgetDisplayTitle。
 *
 * @param declaration 声明切片（findTrayWidgetDeclaration 产物；未命中传 undefined）
 * @param metaTitle 缓存 meta 的 title（WidgetMeta.title 契约必填，脏形状窄化后运行时
 *   可缺省——窄化契约见 view-host-store narrowMeta）
 * @param viewId widget key（链尾兜底）
 */
export function resolveTrayWidgetTitle(
  declaration: TrayWidgetDeclaration | undefined,
  metaTitle: string | undefined,
  viewId: string,
): string {
  const declared = declaration?.title
  if (declared !== undefined && declared.trim() !== '') return declared
  return metaTitle !== undefined && metaTitle.trim() !== '' ? metaTitle : viewId
}

/**
 * 托盘条目显示标题（组件侧响应式单点，TrayWidgetButton / TrayWidgetPanel 共用）：
 * 链本体 = resolveTrayWidgetTitle（上方唯一实现），本函数只做声明查询 + 响应式包装。
 *
 * @returns declaration 声明切片（icon 等其他静态信息消费；Panel 不需要时忽略即可——
 *   computed 惰性，不读取不评估）；displayTitle 兜底链产物
 */
export function useTrayWidgetDisplayTitle(
  viewId: MaybeRefOrGetter<string>,
  pluginId: MaybeRefOrGetter<string | undefined>,
  meta: MaybeRefOrGetter<WidgetMeta | undefined>,
): { declaration: ComputedRef<TrayWidgetDeclaration | undefined>; displayTitle: ComputedRef<string> } {
  const declaration = useTrayWidgetDeclaration(viewId, pluginId)
  const displayTitle = computed(() =>
    resolveTrayWidgetTitle(declaration.value, toValue(meta)?.title, toValue(viewId)))
  return { declaration, displayTitle }
}
