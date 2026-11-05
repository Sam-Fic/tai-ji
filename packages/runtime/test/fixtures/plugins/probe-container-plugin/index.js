/**
 * probe-container-plugin —— 容器位统一验收探针插件（测试基建 fixture 形态）。
 *
 * 消费方：verify-taiji 剧本 scenarios/probe-containers.mjs（容器扩展点统一验收，
 * 设计 §8.2 S1-S4 / impl-plan A1-A5、A7、A8）——剧本在实例启动前把本目录种子进
 * <dataDir>/plugins/（external sandbox 形态装载），宿主按来源强制 sandbox，
 * 权限经 plugin.approvePermissions 批准后激活。
 *
 * 验收素材（声明面 = package.json taijiPlugin.contributes）：
 * - S1/A1：probe.tab（drawer.tab）声明 → 抽屉标签条派生出现 + 本文件按焦点会话推树；
 * - S2/A2：probe.panel（overlay.content）声明 + headerAction activation
 *   {kind:'overlay', tabId:'probe.panel'} → 浮层标签条派生「探针浮层」段，
 *   头部按钮点击经容器导航执行器开浮层并渲染本插件推树；
 * - S3/A3：list-tree 行 action.hostAction 嵌套位双向导航（抽屉树 → 开浮层；浮层树 → 开抽屉）
 *   + params 标量透传（unknownKey 反例 → §5.4 行 8 未知键 warning、动作照常）——导航声明
 *   必须落在 TreeItem.action.hostAction 嵌套位（渲染层 hasAction 判据只读该位，顶层
 *   hostAction 无兼容读取路径，2026-11-04 修复前曾因此点不动）；
 * - S4/A4：probe.bad（placement=nonexistent.slot）→ 不可用声明（不派生进任何容器，
 *   插件管理页标记 + §5.4 行 2 warning）；
 * - A8/S8：无禁用/卸载分支由 verify 剧本经宿主操作驱动（本插件被动配合重放）。
 *
 * fixture 形态约束（对齐 scenarios/lib-plugin-fixtures.mjs 的 sandbox 防线要求）：
 * 零 import 纯 ESM（sandbox fork 子进程黑名单防线内），动作全部经 ctx.api 的 RPC。
 * 声明形态依据（D1 落地契约）：
 * - HostContainerAction = { kind:'overlay'|'drawer', tabId, params? }（extension-protocol
 *   core/types.ts；字段名 tabId 与设计 §5.2 终态「contentId」的名词分歧，改名则本文件
 *   与 manifest 同步换名）；
 * - PluginContributesView = { id, title, placement, icon?, order?, emptyState?, scope? }；
 * - 推树出口 api.views.update(viewId, tree, { sessionId })（scheduler-manager 同款）。
 */

const VIEW_ID = 'probe-container-plugin.tab'
const OVERLAY_VIEW_ID = 'probe-container-plugin.panel'

/** 组装抽屉面板树：文本行 + 统计行 + list-tree（hostAction 正向开浮层 / unknown params 反例）。 */
function buildDrawerTree(sessionId) {
  return [
    {
      type: 'ansi-text',
      props: { lines: [`探针面板已挂载（会话 ${sessionId.slice(0, 8)}）`] },
    },
    {
      type: 'stats-line',
      props: { items: [{ label: '推树次数', value: '1' }] },
    },
    {
      type: 'list-tree',
      props: {
        items: [
          {
            id: 'probe-row-open-overlay',
            label: '打开探针浮层（action.hostAction → overlay.content）',
            action: { hostAction: { kind: 'overlay', tabId: OVERLAY_VIEW_ID } },
          },
          {
            id: 'probe-row-unknown-params',
            label: '未知参数反例（§5.4 行 8：warning + 动作照常）',
            action: { hostAction: { kind: 'drawer', tabId: VIEW_ID, params: { unknownKey: 1 } } },
          },
        ],
      },
    },
  ]
}

/** 组装浮层内容树：文本行 + list-tree（hostAction 反向开抽屉，S3 双向覆盖）。 */
function buildOverlayTree() {
  return [
    {
      type: 'ansi-text',
      props: { lines: ['探针浮层内容（headerAction activation 直开或树内 hostAction 导入）'] },
    },
    {
      type: 'list-tree',
      props: {
        items: [
          {
            id: 'probe-row-open-drawer',
            label: '回到探针面板（action.hostAction → drawer.tab）',
            action: { hostAction: { kind: 'drawer', tabId: VIEW_ID } },
          },
        ],
      },
    },
  ]
}

export async function activate(context) {
  const { api } = context
  const sink = context.subscriptions
  let pushed = false

  const pushAll = async (sessionId) => {
    try {
      await api.views.update(VIEW_ID, buildDrawerTree(sessionId), { sessionId })
      await api.views.update(OVERLAY_VIEW_ID, buildOverlayTree(), { sessionId })
      pushed = true
    } catch (e) {
      console.warn('[probe-container-plugin] views.update failed:', e)
    }
  }

  // 焦点会话追踪 + 冷启动兜底（scheduler-manager 同款：didActivate + list() 取
  // lastActiveAt 最大者；探针不需要 per-session 镜像，无 didCreate 挂点）
  let focusSessionId = null
  sink.push(
    api.sessions.onDidActivateSession((session) => {
      focusSessionId = session.id
      void pushAll(session.id)
    }),
  )
  const sessions = await api.sessions.list()
  if (!pushed && sessions.length > 0) {
    const last = [...sessions].sort(
      (a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0),
    )[0]
    focusSessionId = last.id
    await pushAll(last.id)
  }
  void focusSessionId
}

export async function deactivate() {
  // 探针无持外资源；subscriptions 由宿主随禁用/卸载统一清理
}
