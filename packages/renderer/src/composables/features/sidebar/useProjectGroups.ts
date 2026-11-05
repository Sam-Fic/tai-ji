/**
 * useProjectGroups —— 侧栏项目锚定分组的派生与动作集合（R6.2，从 SessionList 提取）。
 *
 * 职责：项目分组视图模型（归属切分 + 组序 + 组内平铺序）、锚定交互（组头点击按模式
 * 裁决；平铺模式展开态按组独立记忆支持多项目同开——锚定只决定新会话归属与「当前」
 * chip，不再互斥收起其他组 / 组头「+」落点新建）、项目新建草稿流、行内重命名与删除
 * 确认的壳侧状态、组头拖拽换位（projectStore.reorderProject 接线）。
 * 归属切分规则 SSOT = sessionBelongsToProject（默认项目聚未归类 + 孤儿）；组序 SSOT =
 * projectStore.orderedProjects（用户自定义序优先 + lastUsedAt 稳定序 + 默认项目固定
 * 最后，锚定切换不重排）；组内平铺序 = sessionsInRuntimeGroupOrder（runtime 组序展平，
 * 客户端零重排）。
 * 展开态默认收起 + 持久化（sidebar-group-state：平铺/目录两套独立展开集合 + 默认区
 * 开合，localStorage 直存——与模式开关同通道；「展开集合」语义使空集 = 全收起 = 默认）。
 *
 * 依赖注入说明：groups 由调用方以 getter 注入（SessionList 的 props 非响应式直传边界）；
 * mode 由调用方注入（模式持久化留在 SessionList，目录模式开合集与其联动）。
 * useProjectStore 为 pinia store 可在 composable 内直调。
 */
import { computed, nextTick, ref, type ComponentPublicInstance, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import { isDefaultProjectOf } from '@taiji/shared'
import { requestDomainSync, sessionsInRuntimeGroupOrder } from '@taiji/core'
import {
  collectNamedProjectIds,
  sessionBelongsToProject,
} from '@/composables/logic/project-session'
import { DEFAULT_PROJECT_ID, useProjectStore } from '@/stores/project'

/** 项目分组视图模型：项目元信息 + 组内 cwd 目录切分（目录模式渲染源）+ 组内平铺序（平铺模式渲染源）。
 *  数据形状用 type（assign-targets.AssignTarget 同例）——非行为接口，无多实现演进面。 */
export type ProjectGroupVM = {
  id: string
  name: string
  isDefault: boolean
  dirs: SessionGroup[]
  items: SessionSummary[]
}

/** 侧栏会话列表展示模式（与 SessionList 的持久化模式同型） */
export type SidebarSessionMode = 'flat' | 'groups'

/** 组展开态持久化形状（taiji:sidebar-group-state 的 JSON 值） */
type SidebarGroupPersist = {
  /** 平铺模式展开的组 id 集合 */
  flat: string[]
  /** 目录模式展开的组 id 集合 */
  groups: string[]
  /** 默认项目区（session 区）展开态 */
  defaultZone: boolean
}

/** 展开态持久化键（与 `taiji:sidebar-session-mode` 等 UI 偏好同通道、同 localStorage 直存形态） */
const GROUP_STATE_KEY = 'taiji:sidebar-group-state'

const DEFAULT_GROUP_PERSIST: SidebarGroupPersist = { flat: [], groups: [], defaultZone: false }

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string')

/** 恢复持久化展开态（缺失/非法字段回退各字段默认值；全字段缺省 = 全收起 = 默认收起语义） */
function loadGroupPersist(): SidebarGroupPersist {
  try {
    const raw = localStorage.getItem(GROUP_STATE_KEY)
    if (raw === null) return { ...DEFAULT_GROUP_PERSIST }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_GROUP_PERSIST }
    const p = parsed as Partial<Record<keyof SidebarGroupPersist, unknown>>
    return {
      flat: isStringArray(p.flat) ? p.flat : [],
      groups: isStringArray(p.groups) ? p.groups : [],
      defaultZone: typeof p.defaultZone === 'boolean' ? p.defaultZone : false,
    }
  } catch {
    return { ...DEFAULT_GROUP_PERSIST }
  }
}

export function useProjectGroups(options: {
  /** 全量 cwd 分组（未预过滤——分组归属在本 composable 按项目切分） */
  groups: () => SessionGroup[]
  /** 展示模式（平铺 = 锚定聚焦 / 目录 = 浏览态，决定组头点击语义） */
  mode: Ref<SidebarSessionMode>
  /** 组头「+」落点后进入空态新建（SessionList 向上 emit newSession） */
  onNewSession: () => void
}) {
  const { groups, mode, onNewSession } = options
  const { t } = useI18n()
  const projectStore = useProjectStore()
  const persist = loadGroupPersist()

  /**
   * 项目分组区呈现形态（connection-datasync-ssot §6.7 三形态，按「是否持有最后已知
   * 回执数据」降级）：
   * - 'failed'：project 加载失败——分组区整体替换为失败状态条（原因 + 重试钮）；
   * - 'loading'：无数据形态（idle，或从未成功加载过的 loading）——渲染加载占位行；
   * - 'groups'：loaded，或重拉子形态（loaded→loading 的重连边沿重拉，store 已持有
   *   上一轮回执的项目清单）——正常渲染分组。重拉子形态下 projects 保持最后已知值
   *   （回执未到不替换），下方切分结果自动等于最后已知分组——「保留最后已知分组、
   *   不闪占位」由缓存视图的更新时机构造性成立，无需额外缓存。
   * 「未分组/默认组」这个展示概念只在 loaded 态下由真实项目清单派生（无数据形态不把
   * 兜底默认表渲染成「只有一个空默认组」——本次事故的可见症状，§6.7 不采用段）。
   */
  const projectAreaMode = computed<'groups' | 'loading' | 'failed'>(() => {
    if (projectStore.loadState === 'failed') return 'failed'
    if (projectStore.hasReceivedReceipt) return 'groups'
    return 'loading'
  })

  /** 编辑入口可用性（§6.9：无有效数据形态禁用、重拉子形态不禁用）——store 判据透出。 */
  const editingEnabled = computed(() => projectStore.editingEnabled)

  /** 失败状态条重试钮：触发 project 域同步（域同步器编程入口，并发合流保证在途不重复发）。 */
  function retryProjectLoad(): void {
    requestDomainSync('project')
  }

  /**
   * 项目分组列表（R6.2 锚定分组核心派生）：每个 session 恰好落在一个分组，全部项目
   * 并列可见；目录切分保持 runtime cwd 组序（不重排、不归并——多项目同名目录各自展示，
   * 跨项目归并见 spec sidebar §6 待裁决）。
   *
   * 切分输入 = projectStore.projects（缓存视图）+ sessions（props 派生）。重拉子形态
   * 下 projects 未被替换（回执未到），切分结果即「最后已知分组」。
   *
   * §6.7 前置条件：项目切分仅在持有有效回执数据时执行（loaded，或 loaded→loading 的
   * 重拉子形态——判据即 projectAreaMode==='groups'）。无数据形态与 failed 态不派生
   * 项目分组：「未分组/默认组」这个展示概念只在 loaded 态由真实项目清单派生，不把
   * 兜底默认表（idle 初值）或上次已知表（failed 态保留在缓存视图里）渲染成分组——
   * 失败态由状态条整体替换项目分组区，会话本体照常呈现见 degradedZone。
   */
  const projectGroups = computed<ProjectGroupVM[]>(() => {
    if (projectAreaMode.value !== 'groups') return []
    const namedIds = collectNamedProjectIds(projectStore.projects)
    return projectStore.orderedProjects.map((p) => {
      const isDefault = isDefaultProjectOf(p)
      const dirs = groups()
        .map((g) => ({
          cwd: g.cwd,
          sessions: g.sessions.filter((s) => sessionBelongsToProject(s, p.id, isDefault, namedIds)),
        }))
        .filter((g) => g.sessions.length > 0)
      return {
        id: p.id,
        name: p.name || t('sidebar.projectGroup.defaultName'),
        isDefault,
        dirs,
        items: sessionsInRuntimeGroupOrder(dirs),
      }
    })
  })

  /** 全部 session 总数（区头计数，demo .sess-head .count = 全量口径，跨组汇总） */
  const totalCount = computed(() =>
    groups().reduce((sum, g) => sum + g.sessions.length, 0),
  )

  /**
   * 降级形态的会话本体（§6.7「会话列表本体（目录/分组视图的 cwd 结构，来自 runtime
   * 会话清单）不受影响正常呈现」）：projectAreaMode !== 'groups' 时项目分组区由
   * ProjectLoadStatus（失败状态条 / 无数据加载占位行）替换，会话本体按 runtime 会话
   * 清单的 cwd 目录结构照常呈现。
   *
   * 与 projectGroups 的关键差异：不经项目切分——不渲染默认项目头行、不渲染兜底默认表，
   * 数据源只有 groups()（与 project 域正交，project 加载失败/在途都不影响它可取）。
   * 形状取 ProjectGroupVM 的渲染源子集（dirs / items），目录模式与平铺模式共用。
   */
  const degradedZone = computed<Pick<ProjectGroupVM, 'dirs' | 'items'> | null>(() => {
    if (projectAreaMode.value === 'groups') return null
    const dirs = groups().filter((g) => g.sessions.length > 0)
    return { dirs, items: sessionsInRuntimeGroupOrder(dirs) }
  })

  // ── 锚定分组交互（显式锚定 + 多开：展开态按组独立记忆并持久化，不与锚定互斥）──

  /** 平铺模式「展开的组 id」集合（持久化；空集 = 全收起，默认收起；新组不在集合 = 收起）。
   *  点锚定组头 = 翻转本组；点非锚定组头 = 切锚定并展开目标组，其余组保持自身开合态
   *  （多项目同时展开；锚定只决定新会话归属与「当前」chip，不再收起其他组）。 */
  const flatExpanded = ref(new Set<string>(persist.flat))

  /** 目录模式「展开的组 id」集合（持久化；空集 = 全收起，默认收起）；组头只开合、不切换锚定 */
  const dirExpanded = ref(new Set<string>(persist.groups))

  /** 默认项目区（session 区）展开态（持久化；默认收起） */
  const defaultZoneExpanded = ref(persist.defaultZone)

  /** 全量落盘（任一开合态变更后的统一写入口；字段级浅拷贝快照当前值） */
  function persistGroupState(): void {
    const snapshot: SidebarGroupPersist = {
      flat: [...flatExpanded.value],
      groups: [...dirExpanded.value],
      defaultZone: defaultZoneExpanded.value,
    }
    localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(snapshot))
  }

  /** 开合集合单组翻转（不可变替换触发响应），翻转后落盘 */
  function toggleIn(expanded: Ref<Set<string>>, pgId: string): void {
    const next = new Set(expanded.value)
    if (next.has(pgId)) next.delete(pgId)
    else next.add(pgId)
    expanded.value = next
    persistGroupState()
  }

  /** 确保某组在展开集合中（不可变替换触发响应），变更后落盘——展开集合语义下
   *  「展开」= 加入集合（区别于旧收起集合语义的「移除」） */
  function ensureIn(expanded: Ref<Set<string>>, pgId: string): void {
    if (expanded.value.has(pgId)) return
    const next = new Set(expanded.value)
    next.add(pgId)
    expanded.value = next
    persistGroupState()
  }

  /** 默认项目区收起/展开翻转 + 落盘（onDefaultZoneHeadClick 的翻转分支） */
  function toggleDefaultZone(): void {
    defaultZoneExpanded.value = !defaultZoneExpanded.value
    persistGroupState()
  }

  /** 强制展开默认项目区（默认区「+」落点新建 / session 拖入收起默认区后的可见性保证，
   *  与命名组 expandGroup 同语义——落进收起区的内容必须立即可见） */
  function expandDefaultZone(): void {
    if (defaultZoneExpanded.value) return
    defaultZoneExpanded.value = true
    persistGroupState()
  }

  /** 组头点击（父级按模式裁决，demo onGroupHead/onGroupHeadDir 同构）。
   *  锚定切换命令化（§6.6）：发命令、chip 跟随回执更新（本机毫秒级）；失败 toast 已由
   *  store 出声，此处吞掉 rejection（fire-and-forget 语义）。 */
  function onGroupHeadClick(pg: ProjectGroupVM): void {
    if (mode.value === 'flat') {
      if (pg.id === projectStore.activeProjectId) {
        toggleIn(flatExpanded, pg.id)
        return
      }
      void projectStore.setActiveProject(pg.id).catch(() => {})
      ensureIn(flatExpanded, pg.id)
      return
    }
    toggleIn(dirExpanded, pg.id)
  }

  /** 组头「+」：先落点该项目（新会话归属读 activeProjectId）再进空态新建。
   *  「先锚定后建」时序在命令化下由回执承载（emit newSession 时刻 activeProjectId 必须
   *  已切换——归属预填读它）：await 锚定回执落定后才触发新建；锚定命令失败（revision
   *  失配被拒等，toast 已出声）不进新建流——落点语义无法保证，用户可直接重试。
   *  落点区展开保证：命名组进组展开集合；默认项目区开 defaultZone（新会话归属地必须
   *  可见——收起态下新建 = 会话消失在收起区里）。 */
  async function onCreateTaskIn(pg: ProjectGroupVM): Promise<void> {
    try {
      await projectStore.setActiveProject(pg.id)
    } catch {
      return
    }
    if (pg.isDefault) expandDefaultZone()
    else ensureIn(flatExpanded, pg.id)
    onNewSession()
  }

  /** 强制展开某组（平铺/目录两套展开集合都确保加入——拖拽落组后的展开保证，模式无关） */
  function expandGroup(pgId: string): void {
    ensureIn(flatExpanded, pgId)
    ensureIn(dirExpanded, pgId)
  }

  /** 组头拖拽换位 drop（ProjectGroup 按 PROJECT_DRAG_MIME 命中后转交）：draggedId 移到
   *  目标组相邻位，序写入 projectStore（localStorage 持久化，见 reorderProject） */
  function onGroupReorder(draggedId: string, targetId: string): void {
    projectStore.reorderProject(draggedId, targetId)
  }

  /** 默认区头行点击（与命名组头 onGroupHeadClick 同构的按模式裁决）：平铺 = 非锚定
   *  锚定+展开 / 已锚定翻转开合；目录 = 仅翻转开合（浏览态不切锚定）。锚定命令化：
   *  发命令、chip 跟随回执，失败 toast 由 store 出声。 */
  function onDefaultZoneHeadClick(): void {
    if (mode.value === 'flat' && projectStore.activeProjectId !== DEFAULT_PROJECT_ID) {
      void projectStore.setActiveProject(DEFAULT_PROJECT_ID).catch(() => {})
      expandDefaultZone()
      return
    }
    toggleDefaultZone()
  }

  // ── 项目重命名（ProjectGroup 行内输入）/ 删除（二次确认）──

  const deleteOpen = ref(false)
  const pendingDelete = ref<ProjectGroupVM | null>(null)

  function requestDelete(pg: ProjectGroupVM): void {
    pendingDelete.value = pg
    deleteOpen.value = true
  }

  /** 删除确认（命令化：异步命令失败 toast 已由 store 出声，此处吞 rejection；归回的
   *  会话落默认项目区——删除回执落定后强制展开默认区（落进收起区的内容必须立即可见，
   *  spec sidebar §3.7 恒展开可见的默认收起语义版），命名组开合记忆保留不动） */
  async function confirmDelete(): Promise<void> {
    const target = pendingDelete.value
    pendingDelete.value = null
    deleteOpen.value = false
    if (!target) return
    await projectStore.removeProject(target.id).then(
      () => expandDefaultZone(),
      () => {},
    )
  }

  /** 组头行内重命名提交（ProjectGroup 已做空名检查，store 层再检查默认项目/未知 id；
   *  命令化：失败 toast 已由 store 出声，此处吞 rejection） */
  function onRenameCommit(pg: ProjectGroupVM, name: string): void {
    void projectStore.renameProject(pg.id, name).catch(() => {})
  }

  // ── 新建项目（区头「+」入口，用户裁决 2026-10-11：点击后列表顶部出现草稿输入行）──

  const creating = ref(false)
  const draft = ref('')
  const createInputRef = ref<ComponentPublicInstance | null>(null)

  function startCreate(): void {
    if (creating.value) {
      // 草稿行已开着：二次点击只回焦输入框，不重置已输入内容
      const el = createInputRef.value?.$el
      if (el instanceof HTMLInputElement) el.focus()
      return
    }
    creating.value = true
    draft.value = ''
    nextTick(() => {
      // Input 组件根元素是 <input>，template ref 拿到组件实例，$el 是 input DOM
      const el = createInputRef.value?.$el
      if (el instanceof HTMLInputElement) el.focus()
    })
  }

  /** 提交草稿：非空名发创建命令并关闭草稿行；回执落定后按返回的新 id 显式展开新组
   *   （默认收起语义下空态引导「暂无会话，点组头+在此新建」的可见性依赖此展开）并
   *   展开锚定（回执已锚定新项目）。命令失败 toast 已由 store 出声，此处吞 rejection；
   *   空名 = 丢弃草稿不创建 */
  async function commitCreate(): Promise<void> {
    const name = draft.value.trim()
    creating.value = false
    draft.value = ''
    if (!name) return
    // 命令失败吞 rejection（toast 已由 store 出声；新组未创建，无展开动作）
    const newId = await projectStore.addProject(name).catch(() => null)
    if (newId) expandGroup(newId)
  }

  /** 失焦提交（草稿行无浮层后「点外」无统一关闭路径，失焦即落编辑结果；Esc 先清 creating，
   *  随后的 blur 命中 creating=false 检查无副作用） */
  function onDraftBlur(): void {
    if (creating.value) commitCreate()
  }

  function cancelCreate(): void {
    creating.value = false
    draft.value = ''
  }

  return {
    projectGroups,
    totalCount,
    projectAreaMode,
    degradedZone,
    editingEnabled,
    retryProjectLoad,
    flatExpanded,
    dirExpanded,
    defaultZoneExpanded,
    expandGroup,
    expandDefaultZone,
    onGroupHeadClick,
    onGroupReorder,
    onDefaultZoneHeadClick,
    onCreateTaskIn,
    deleteOpen,
    pendingDelete,
    requestDelete,
    confirmDelete,
    onRenameCommit,
    creating,
    draft,
    createInputRef,
    startCreate,
    commitCreate,
    onDraftBlur,
    cancelCreate,
  }
}
