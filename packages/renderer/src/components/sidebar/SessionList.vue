<template>
  <!--
    展示组件 · 会话列表（R6.2 锚定分组形态，demo Sidebar.vue sessions 视图权威）。
    区头（SessionListHeader 子组件：「项目与会话」+ 总会话计数 + 新建项目/归档入口 +
    双段模式开关），下方为：
    - 默认项目区（用户裁决 2026-10-13 方案 A）：默认项目 = 未归类收件箱，不展示项目框——
      平铺模式 = 置顶平铺会话区（无组头/无左线/无缩进）；目录模式 = 置顶目录标签序列
      （无组包裹）。空区不渲染头行；锚定/新建/拖放/开合入口 = DefaultProjectHead
      轻量头行（chevron 开合 + 点行按模式锚定 +「+」在此新建 + session drop 落点）；
      开合默认收起、持久化（useProjectGroups defaultZoneExpanded）。降级形态无头行，
      会话本体不受开合控制恒显（无头行 = 无收起入口，gate 它 = 会话消失死角）。
    - 命名项目组：保持 ProjectGroup 框（组头 + 左线 + 缩进）。两种模式的展开态都按组
      独立记忆并持久化（默认收起，多项目同开）：平铺模式点组头 = 切换锚定并展开目标组
      （其余组开合不动，点当前组头 = 折叠/展开翻转），锚定只决定新会话归属与「当前」
      chip；目录模式 = 浏览态：组头只开合自己、不切换锚定，「当前」chip 只读；组内按
      cwd 目录静态标签分组（SessionDirLabel，与默认项目目录区共用同一实现）。目录行
      悬停操作（目录内新建 / 批量删除）为 real 独有功能性入口。
    - session 拖拽移动归属（落点 = 各组头 + 默认头行）：useSessionDropTarget 统一交互
      （types 命中判别 + dropActive 高亮），drop 走既有 setProject 事件链（同归属 no-op），
      落折叠组后强制展开。
    - project 组头拖拽换位：PROJECT_DRAG_MIME 分流（与 session 拖拽同组头共存），
      drop → projectStore.reorderProject（自定义序持久化，orderedProjects 消费）。
    分组规则 SSOT = sessionBelongsToProject（默认项目聚合未归类 + 孤儿）；组序 SSOT =
    projectStore.orderedProjects（用户自定义序优先 + lastUsedAt 稳定序 + 默认项目固定
    最后，锚定切换不重排；默认区置顶是纯视图层拆分，不改组序）。组内平铺序 = runtime
    组序展平。
    新建项目入口 = 区头行内「+」钮（紧贴模式开关左侧，用户裁决 2026-10-11）：点击后列表
    顶部出现草稿输入行，Enter 确认 → 锚定新项目并展开空态（空名 / Esc 丢弃草稿）。
    空命名组显示「暂无会话，点组头「+」在此新建任务」（缩进对齐左线内侧）。
  -->
  <div class="session-list flex h-full min-h-0 flex-col">
    <!-- 区头抽 SessionListHeader（demo .sess-head 规格与工具组注释随组件走）：
         标题/计数 + 新建项目「+」 + 归档入口 + A/C 双段模式开关。固定于 ScrollArea 外
         （不随列表滚动）。 -->
    <SessionListHeader
      :total-count="totalCount"
      :archive-count="archiveCount"
      :mode="mode"
      :editing-enabled="editingEnabled"
      @start-create="startCreate"
      @set-mode="setMode"
      @open-archives="emit('openArchives')"
    />

    <ScrollArea class="min-h-0 flex-1">
    <div class="flex flex-col pt-0.5 pb-2 pl-1.5">
      <!-- 新建项目草稿行（用户裁决 2026-10-11：区头「+」点击后，列表顶部出现新组输入态；
           Enter / 失焦提交非空名 → 创建并锚定展开，空名 / Esc 丢弃草稿不创建） -->
      <div v-if="creating" class="flex items-center px-[6px] py-[5px]" data-testid="project-draft-row">
        <Input
          ref="createInputRef"
          v-model="draft"
          data-testid="project-create-input"
          class="min-w-0 flex-1 h-[24px] rounded-[5px] border-border-strong bg-bg-input px-[7px] text-[length:var(--text-xs)] text-neutral-fg"
          :placeholder="t('sidebar.projectGroup.namePlaceholder')"
          :aria-label="t('sidebar.projectGroup.newProject')"
          @keydown.enter.prevent="commitCreate"
          @keydown.esc.stop.prevent="cancelCreate"
          @blur="onDraftBlur"
        />
      </div>
      <ProjectLoadStatus v-if="projectAreaMode !== 'groups'" :mode="projectAreaMode" :load-error="projectStore.loadError" @retry="retryProjectLoad" />
      <template v-if="mode === 'flat'">
        <!-- 默认项目平铺区（用户裁决 2026-10-13 方案 A）：默认项目 = 未归类收件箱，不展示项目框，
             session 平铺在列表顶部，空区不渲染头行；降级形态（§6.7）同一渲染位承载会话本体（无默认项目头行，
             内容不受开合控制恒显——无头行即无收起入口，gate 降级内容 = 会话消失死角） -->
        <DefaultProjectHead
          v-if="defaultZone && defaultZone.items.length"
          :current="projectStore.isDefaultProject"
          :name="defaultZone.name"
          :expanded="defaultZoneExpanded"
          :count="defaultZone.items.length"
          @head-click="onDefaultZoneHeadClick"
          @create-task="onCreateTaskIn(defaultZone)"
          @drop-session="onDropToDefault"
        />
        <div
          v-if="sessionBodyZone && sessionBodyZone.items.length && (!defaultZone || defaultZoneExpanded)"
          class="flex flex-col"
          :data-testid="degradedZone ? 'session-body-flat' : 'default-project-flat-zone'"
        >
          <SessionItem
            v-for="s in sessionBodyZone.items"
            :key="s.id"
            :session="s"
            :active="s.id === activeId"
            :status="statusOf(s.id)"
            :child-count="childCountOf(s)"
            :parent-label="parentLabelOf(s)"
            :handoff-target-label="handoffTargetLabelOf(s)"
            :restored-highlight="s.id === restoredSessionId"
            @select="emit('select', $event)"
            @rename="emit('rename', $event)"
            @archive="emit('archive', $event)"
            @set-project="onSetProject"
            @navigate-parent="emit('navigateParent', $event)"
            @abort="emit('abort', $event)"
            @force-quit="emit('forceQuit', $event)"
            @export-jsonl="emit('exportJsonl', $event)"
          />
        </div>
        <!-- 命名项目组（多开：每組开合独立记忆并持久化，默认收起；点组头切锚定并展开目标组、
             其余组不动；「当前」chip 标识锚定组。会话行缩进（demo .pgi .si）：行内左距 9px
             与目录标签对齐；作用到 ProjectGroup 槽内直接子 .session-item（任意变体替代 scoped
             后代选择器） -->
        <ProjectGroup
          v-for="pg in namedGroups"
          :key="pg.id"
          :project-id="pg.id"
          :name="pg.name"
          :count="pg.items.length"
          :current="pg.id === projectStore.activeProjectId"
          :expanded="flatExpanded.has(pg.id)"
          :is-default="pg.isDefault"
          class="[&>.session-item]:pl-[9px]"
          @head-click="onGroupHeadClick(pg)"
          @create-task="onCreateTaskIn(pg)"
          @rename-commit="onRenameCommit(pg, $event)"
          @delete-request="requestDelete(pg)"
          @drop-session="onDropToGroup(pg, $event)"
          @reorder="onGroupReorder($event.draggedId, $event.targetId)"
        >
          <SessionItem
            v-for="s in pg.items"
            :key="s.id"
            :session="s"
            :active="s.id === activeId"
            :status="statusOf(s.id)"
            :child-count="childCountOf(s)"
            :parent-label="parentLabelOf(s)"
            :handoff-target-label="handoffTargetLabelOf(s)"
            :restored-highlight="s.id === restoredSessionId"
            @select="emit('select', $event)"
            @rename="emit('rename', $event)"
            @archive="emit('archive', $event)"
            @set-project="onSetProject"
            @navigate-parent="emit('navigateParent', $event)"
            @abort="emit('abort', $event)"
            @force-quit="emit('forceQuit', $event)"
            @export-jsonl="emit('exportJsonl', $event)"
          />
          <div
            v-if="!pg.items.length"
            class="pt-[2px] pb-[6px] pl-[9px] pr-[8px] text-[length:var(--text-2xs)] text-neutral-dim"
            data-testid="project-group-empty"
          >
            {{ t('sidebar.sessionList.groupEmpty') }}
          </div>
        </ProjectGroup>
      </template>
      <!-- 目录模式：默认项目目录区（置顶无组框）+ 命名项目组；降级形态（§6.7）同一渲染位承载会话本体 -->
      <template v-else>
        <!-- 默认项目：无组头，轻量头行（锚定/新建/拖放/开合入口，同平铺模式）+ 目录标签直接平铺在
             列表顶部（用户裁决 2026-10-13：默认项目不展示项目 item，目录模式下同样不给框）。
             开合 gate 与平铺模式同判据：降级形态（无头行）内容恒显 -->
        <template v-if="sessionBodyZone">
          <DefaultProjectHead
            v-if="defaultZone && defaultZone.items.length"
            :current="projectStore.isDefaultProject"
            :name="defaultZone.name"
            :expanded="defaultZoneExpanded"
            :count="defaultZone.items.length"
            @head-click="onDefaultZoneHeadClick"
            @create-task="onCreateTaskIn(defaultZone)"
            @drop-session="onDropToDefault"
          />
          <template v-if="!defaultZone || defaultZoneExpanded">
            <template v-for="g in sessionBodyZone.dirs" :key="g.cwd">
              <SessionDirLabel
                :cwd="g.cwd"
                :count="g.sessions.length"
                :confirming="folderConfirmingCwd === g.cwd"
                :delete-available="isFolderDeleteAvailable(sessionBodyZone, g.cwd)"
                @new-in-folder="emit('newSessionInFolder', $event)"
                @remove-click="onFolderRemoveClick"
                @leave="onFolderMouseLeave"
              />
              <div class="gi">
                <SessionItem
                  v-for="s in g.sessions"
                  :key="s.id"
                  :session="s"
                  :active="s.id === activeId"
                  :status="statusOf(s.id)"
                  :child-count="childCountOf(s)"
                  :parent-label="parentLabelOf(s)"
                  :handoff-target-label="handoffTargetLabelOf(s)"
                  :restored-highlight="s.id === restoredSessionId"
                  @select="emit('select', $event)"
                  @rename="emit('rename', $event)"
                  @archive="emit('archive', $event)"
                  @set-project="onSetProject"
                  @navigate-parent="emit('navigateParent', $event)"
                  @abort="emit('abort', $event)"
                  @force-quit="emit('forceQuit', $event)"
                  @export-jsonl="emit('exportJsonl', $event)"
                />
              </div>
            </template>
          </template>
        </template>
        <!-- 命名项目组：开合独立记忆并持久化（默认收起），组头只开合不切换锚定 + 目录静态标签分组。
             目录内会话行再深一级（demo .pgi .gi .si = 21px），任意变体替代 scoped 后代选择器 -->
        <ProjectGroup
          v-for="pg in namedGroups"
          :key="pg.id"
          :project-id="pg.id"
          :name="pg.name"
          :count="pg.items.length"
          :current="pg.id === projectStore.activeProjectId"
          :expanded="dirExpanded.has(pg.id)"
          :is-default="pg.isDefault"
          class="[&_.gi>.session-item]:pl-[21px]"
          @head-click="onGroupHeadClick(pg)"
          @create-task="onCreateTaskIn(pg)"
          @rename-commit="onRenameCommit(pg, $event)"
          @delete-request="requestDelete(pg)"
          @drop-session="onDropToGroup(pg, $event)"
          @reorder="onGroupReorder($event.draggedId, $event.targetId)"
        >
          <div
            v-if="!pg.items.length"
            class="pt-[2px] pb-[6px] pl-[9px] pr-[8px] text-[length:var(--text-2xs)] text-neutral-dim"
            data-testid="project-group-empty"
          >
            {{ t('sidebar.sessionList.groupEmpty') }}
          </div>
          <template v-else>
            <!-- 目录静态标签（SessionDirLabel，与默认项目目录区共用同一实现）：
                 group/folder 命名 group 在标签行组件内（Tailwind 命名 group 是「任意层级祖先」
                 匹配，容器带它会令 hover 组内任意 SessionItem 时也触发 folder 按钮，
                 破坏单行独立 hover 语义）。 -->
            <div v-for="g in pg.dirs" :key="g.cwd" class="grp">
              <SessionDirLabel
                :cwd="g.cwd"
                :count="g.sessions.length"
                :confirming="folderConfirmingCwd === g.cwd"
                :delete-available="isFolderDeleteAvailable(pg, g.cwd)"
                @new-in-folder="emit('newSessionInFolder', $event)"
                @remove-click="onFolderRemoveClick"
                @leave="onFolderMouseLeave"
              />
              <!-- 目录内会话行（再深一级缩进）：每条 session 渲染 SessionItem（扁平列表：
                   fork 分支 / agent 子会话均按一般 session 各占一行，侧栏不做父子聚合——D9）。 -->
              <div class="gi">
                <SessionItem
                  v-for="s in g.sessions"
                  :key="s.id"
                  :session="s"
                  :active="s.id === activeId"
                  :status="statusOf(s.id)"
                  :child-count="childCountOf(s)"
                  :parent-label="parentLabelOf(s)"
                  :handoff-target-label="handoffTargetLabelOf(s)"
                  :restored-highlight="s.id === restoredSessionId"
                  @select="emit('select', $event)"
                  @rename="emit('rename', $event)"
                  @archive="emit('archive', $event)"
                  @set-project="onSetProject"
                  @navigate-parent="emit('navigateParent', $event)"
                  @abort="emit('abort', $event)"
                  @force-quit="emit('forceQuit', $event)"
                  @export-jsonl="emit('exportJsonl', $event)"
                />
              </div>
            </div>
          </template>
        </ProjectGroup>
      </template>

    </div>
  </ScrollArea>

    <!-- 删除项目二次确认（文案写明后果，spec sidebar §3.7：「N 个会话将归回默认项目」；
         计数 = 该组实际会话数——数字 = 实际归回的会话数） -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="t('sidebar.projectGroup.deleteTitle')"
      :description="t('sidebar.projectGroup.deleteDesc', {
        name: pendingDelete?.name || t('sidebar.projectGroup.defaultName'),
        count: pendingDelete?.items.length ?? 0,
      })"
      :confirm-text="t('sidebar.projectGroup.deleteConfirm')"
      :cancel-text="t('sidebar.projectGroup.cancel')"
      variant="danger"
      @confirm="confirmDelete"
    />
  </div>
</template>

<script setup lang="ts">
import type { SessionGroup, SessionSummary } from '@taiji/shared'
import type { DerivedStatus } from '@/types'
import { computed, onBeforeUnmount, provide, ref, watch, type Ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { isSessionCompleted } from '@/composables/logic/sessionStatus'
import { registerModalSurface } from '@/composables/features/app/modal-surface-registry'
import { useProjectStore } from '@/stores/project'
import { useProjectGroups, type ProjectGroupVM } from '@/composables/features/sidebar/useProjectGroups'
import { useFolderDeleteConfirm } from '@/composables/features/sidebar/useFolderDeleteConfirm'
import { useSidebarSessionMode } from '@/composables/features/sidebar/use-sidebar-session-mode'
import ProjectGroup from './ProjectGroup.vue'
import DefaultProjectHead from './DefaultProjectHead.vue'
import ProjectLoadStatus from './ProjectLoadStatus.vue'
import SessionListHeader from './SessionListHeader.vue'
import SessionDirLabel from './SessionDirLabel.vue'
import SessionItem from './SessionItem.vue'

const { t } = useI18n()
const projectStore = useProjectStore()

const props = withDefaults(defineProps<{
  /** 按 cwd 分组的会话（对齐后端 SessionGroup[]，全量、不预过滤——分组归属在本组件按项目切分） */
  groups: SessionGroup[]
  activeId: string | null
  /** 派生状态点，由容器注入 useSessionDerivations.derivedStatus */
  statusOf: (id: string) => DerivedStatus
  /**
   * 归档条目数（session-archive D10 归档入口角标数据源）：config.sessions 广播帧携带值
   * / 归档列表拉取对账（store.archiveCount 经 Sidebar 注入）。0 = 角标隐藏，按钮仍可点。
   * 可选缺省 0（既有测试挂载不传时角标隐藏的默认形态）。
   */
  archiveCount?: number
  /**
   * 刚恢复的 session id（session-archive §5.1 恢复高亮：unarchive reply 消费点，经
   * Sidebar 从 archive store 注入；null = 无恢复高亮）。置顶构造性成立（恢复重写主文件
   * → mtime = 恢复时刻 → 组内第一），本字段只驱动行 accent-soft 高亮渐隐。
   */
  restoredSessionId?: string | null
}>(), { archiveCount: 0, restoredSessionId: null })

const emit = defineEmits<{
  select: [sessionId: string]
  rename: [sessionId: string]
  /**
   * 归档（session-archive D6）：SessionItem 悬停归档钮两段确认后透传——Sidebar 接
   * useSidebarSessionActions.onArchiveSession（useSidebar.archiveSession core 编排）。
   */
  archive: [sessionId: string]
  newSession: []
  /** 打开归档列表视图（D10 工具组归档入口钮；Sidebar 接 useArchiveView.openArchiveView） */
  openArchives: []
  /** 目录行「+」：以该 cwd 为预选目录进 landing 新建（延迟 create，由 Sidebar 调 newSession(cwd)） */
  newSessionInFolder: [cwd: string]
  /** 停止运行中的 session（软停止，SessionItem 两段确认后调 abort → stopped，可 restore） */
  abort: [sessionId: string]
  /** 删除指定 cwd 下所有 session（folder 维度批量删除，两段式确认后由 Sidebar 调 deleteFolder） */
  deleteFolder: [cwd: string]
  /** 归入项目（D14 语义修正）：透传 SessionItem 的 setProject */
  setProject: [{ sessionId: string; projectId: string }]
  /** 查看父 session（agent-managed-session U8）：透传 SessionItem 的 navigateParent */
  navigateParent: [parentAgentSessionId: string]
  /** 强制退出（两段确认后）：透传 SessionItem 的 forceQuit，Sidebar 接 sessionApi.forceQuit */
  forceQuit: [sessionId: string]
  /** 导出 JSONL：透传 SessionItem 的 exportJsonl，
   *  Sidebar 接 exportSessionJsonl IPC + toast。 */
  exportJsonl: [payload: { sessionId: string; sessionFile?: string; suggestedName?: string }]
}>()

/**
 * 子会话计数（D9 中性计数徒标）：按 parentAgentSessionId 分组计数（零新协议，纯内存推导）。
 * 口径 = **未完成数**（判据见 sessionStatus.ts 的 isSessionCompleted）：绿点（idle/done）
 * 不予计入，active / error / stopped / dead 都算。取全量 groups 计数——锚定分组形态下
 * 全部会话行都已挂载（折叠组体常驻 DOM），跨项目的 agent 子会话同样可见可数。
 */
const childCountByParent = computed<Map<string, number>>(() => {
  const counts = new Map<string, number>()
  for (const g of props.groups) {
    for (const s of g.sessions) {
      const parent = s.parentAgentSessionId
      if (!parent) continue
      if (isSessionCompleted(s.status)) continue
      counts.set(parent, (counts.get(parent) ?? 0) + 1)
    }
  }
  return counts
})

/** 取某 session 的未完成子会话数（0 = 无未完成子会话，徒标不渲染） */
function childCountOf(s: SessionSummary): number {
  return childCountByParent.value.get(s.id) ?? 0
}

/**
 * 反查分支 session 的父 session label（P3 修复血缘显示）。
 *
 * SessionItem 详情卡用 `displaySession.parentLabel || displaySession.parentSession` 展示血缘，
 * 本 helper 按 session.parentSession 反查父 session，取其 label 注入 parentLabel。
 *
 * 匹配规则（FR-20 双键兜底）：parentSession 可能是父的 sessionFile（活跃 session
 * 落盘路径）或父的 id（源未落盘时用 sessionId 作血缘键），两种 key 取并集保证命中。
 * 仅在当前 session 所在 cwd 组内查找（分支与父同 cwd）；无父或父不在同组返回空串，
 * SessionItem 回退到 parentSession 原值。
 */
function parentLabelOf(s: SessionSummary): string {
  if (!s.parentSession) return ''
  const parent = props.groups
    .filter((g) => g.cwd === s.cwd)
    .flatMap((g) => g.sessions)
    .find((p) => p.sessionFile === s.parentSession || p.id === s.parentSession)
  return parent?.label ?? ''
}

/**
 * 反查交接目标的显示名（chat-flow-consistency U9 / S8）：源会话的 handedOffTo 记录目标
 * session id，按 id 在全量 groups 内反查其 label 注入展示对象（已交接徽标 title 用）。
 * 目标已删 / 不在列表 → 空串，Display 回退显目标 id 前缀（已发生事实不回滚，徽标照显）。
 * 与 parentLabelOf 的差异：交接目标是 runtime 新建的独立会话（通常同 cwd 但不限），
 * 按精确 id 全量查找，无双键兜底需要。
 */
function handoffTargetLabelOf(s: SessionSummary): string {
  if (!s.handedOffTo) return ''
  const target = props.groups
    .flatMap((g) => g.sessions)
    .find((p) => p.id === s.handedOffTo)
  return target?.label ?? ''
}

/** 单一 Esc 监听器——避免每个 SessionItem 各自注册 window keydown listener（N 项 N 个监听器）。
 *  SessionItem inject 后 watch escCount 变化清自身确认态。 */
const escCount = ref(0)
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') escCount.value++
})
provide('sessionItemEsc', escCount)

/** 后代 SessionItem 删除确认态登记槽（modal-surface-registry spec §6.7 后行档聚合谓词的读点来源）：
 *  每个 SessionItem 把自己的 confirming ref 注入本集合，卸载即撤。聚合谓词直读各 ref 当前值
 *  （动作时刻新鲜度），不经 escCount 反向推导——广播计数器单调递增、非状态本体（modal-surface-registry spec §6.7 禁绑）。 */
const itemConfirmingSet = new Set<Ref<boolean>>()
provide('sessionItemConfirmingSet', itemConfirmingSet)

/**
 * folder 删除两段式确认编排（useFolderDeleteConfirm，从本组件提取）：确认态本体 +
 * Esc/mouseleave/点击外部三复位入口 + MF-2 删除可用性检查。删除动作经回调回到本组件
 * emit deleteFolder；「escCount watch 复位」与后代 SessionItem 清确认态共享一次 Esc。
 */
const { folderConfirmingCwd, onFolderRemoveClick, onFolderMouseLeave, isFolderDeleteAvailable } =
  useFolderDeleteConfirm({
    groups: () => props.groups,
    escCount,
    onDeleteFolder: (cwd) => emit('deleteFolder', cwd),
  })

// ── A/C 双模式（N8 延续：flat = 锚定聚焦 / groups = 目录浏览态；类型来自 useProjectGroups）──

/** 模式开关抽 composable（use-sidebar-session-mode，持久化键与恢复逻辑随迁）；切模式实际发生后的联动复位经回调留在本组件 */
const { mode, setMode } = useSidebarSessionMode(() => {
  folderConfirmingCwd.value = null
})

// ── 项目分组派生与动作（useProjectGroups：归属切分/组序/锚定交互/新建草稿流/重命名与删除
//    确认态/展开态持久化（默认收起）/组头拖拽换位；切模式复位 folderConfirmingCwd 留本组件）──
const {
  projectGroups,
  totalCount,
  projectAreaMode, degradedZone, editingEnabled, retryProjectLoad,
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
} = useProjectGroups({
  groups: () => props.groups,
  mode,
  onNewSession: () => emit('newSession'),
})

// ── session 拖拽落点（拖到组头/默认行 = 移动归属，走既有 setProject 链）──

/** drop 落点统一写入口：同归属 no-op（防自拖自落 + 省一次 RPC），否则透传既有 setProject
 *  事件链（Sidebar → assignSessionToProject → RPC + 乐观更新），拖拽与右键菜单同一写通道 */
function assignDropped(projectId: string, sessionId: string): void {
  const session = props.groups.flatMap((g) => g.sessions).find((s) => s.id === sessionId)
  if ((session?.projectId ?? '') === projectId) return
  emit('setProject', { sessionId, projectId })
}

/** 拖入命名组头：移动归属 + 强制展开目标组（落折叠组后会话直接可见，不消失） */
function onDropToGroup(pg: ProjectGroupVM, sessionId: string): void {
  assignDropped(pg.id, sessionId)
  expandGroup(pg.id)
}

function onDropToDefault(sessionId: string): void {
  assignDropped('', sessionId)
  expandDefaultZone()
}

/** 「归入项目」菜单落点（SessionItem 菜单/悬停浮层 emit setProject）：展开落点区后再透传
 *  ——与拖入路径（onDropToGroup/onDropToDefault）同构，右键菜单与拖拽两条写通道同保证
 *  「落进收起区的内容必须立即可见」；RPC + toast 编排留在 Sidebar（onAssignProject）。 */
function onSetProject(payload: { sessionId: string; projectId: string }): void {
  if (payload.projectId) expandGroup(payload.projectId)
  else expandDefaultZone()
  emit('setProject', payload)
}

/** 恢复高亮落点展开（session-archive §5.1 恢复高亮的可见性前提，与拖拽/菜单/删除归回
 *  同族的「落进收起区的内容必须立即可见」保证）：restoredSessionId 置位后按分组切分
 *  结果定位恢复会话的归属组——命名组 → expandGroup，默认区或查不到 → expandDefaultZone。
 *  列表数据与置位同为依赖：恢复的会话行经 broadcastSessionList 广播异步回流，置位早于
 *  回流时由数据到达后的再次触发补上展开（展开原语幂等，重复触发无副作用）。 */
watch(
  [() => props.restoredSessionId, () => props.groups],
  () => {
    const id = props.restoredSessionId
    if (!id) return
    const owner = projectGroups.value.find((pg) => pg.items.some((s) => s.id === id))
    if (owner && !owner.isDefault) expandGroup(owner.id)
    else expandDefaultZone()
  },
  { immediate: true },
)

/**
 * 默认项目区 vs 命名项目组（用户裁决 2026-10-13 方案 A：默认项目不展示项目框）。
 * 默认项目 = 未归类收件箱：平铺模式渲染为置顶平铺区（无组头/左线/缩进），目录模式
 * 渲染为置顶目录标签序列（无组头包裹）；命名项目组保持 ProjectGroup 框。组序 SSOT
 * 不动（orderedProjects 默认项目仍固定最后），拆分纯视图层：区置顶 = 渲染位置，
 * 非重排。锚定/新建/drop 入口由 DefaultProjectHead 轻量头行承载（不恢复项目框）。
 */
const defaultZone = computed(() => projectGroups.value.find((pg) => pg.isDefault))
const namedGroups = computed(() => projectGroups.value.filter((pg) => !pg.isDefault))

/**
 * 会话本体渲染源（connection-datasync-ssot §6.7 两形态，默认区所在渲染位共用）：
 * - loaded / 重拉子形态：默认项目区（默认项目 = 未归类收件箱，带头行）；
 * - 降级形态（projectAreaMode !== 'groups'，即 idle / 无数据 loading / failed）：
 *   degradedZone——项目分组区由 ProjectLoadStatus（失败状态条 / 加载占位行）替换，
 *   会话本体按 runtime 会话清单的 cwd 结构照常呈现（平铺模式 = 全量平铺、目录模式 =
 *   cwd 目录标签序列），且不渲染默认项目头行：「未分组/默认组」这个展示概念只在
 *   loaded 态由真实项目清单派生，不渲染兜底默认表（idle 初值）或上次已知表（failed
 *   态缓存视图里残留的旧项目清单）。
 *
 * 模板结构上 ProjectLoadStatus 是独立 v-if（叠加渲染），不占用模式模板的 v-if/v-else
 * 链——否则非 groups 形态会连带整段列表体一起不渲染（§5.2 失败窗口用户看不到任何会话）。
 * 头行的渲染判据是 defaultZone（真实默认项目区，降级形态为 undefined），与渲染位判据
 * sessionBodyZone 分开：两者在降级形态下一有一无。
 *
 * 两个来源都提供 dirs（目录模式渲染源）/ items（平铺模式渲染源），模板按 mode 取用。
 */
const sessionBodyZone = computed(() => degradedZone.value ?? defaultZone.value)

/** 删除确认态聚合谓词（modal-surface-registry spec §6.7 后行档开合态绑定源 = 确认态本体）：
 *  N 个 SessionItem 后代确认态 与 folderConfirmingCwd。任一确认态开着 ⇒ 入聚合让位族
 *  （yieldsEsc=true，见 modal-surface-registry 登记表），编排器 Esc 不动作、由本组件 escCount
 *  链路清确认态——一次 Esc 只清确认不动容器，第二次 Esc 才走层级序。 */
const anyDeleteConfirming = (): boolean =>
  folderConfirmingCwd.value !== null || [...itemConfirmingSet].some((confirming) => confirming.value)

const disposeSurfaceRegistration = registerModalSurface({
  surface: 'session-delete-confirm',
  key: 'session-list-delete-confirm',
  isOpen: anyDeleteConfirming,
})
onBeforeUnmount(disposeSurfaceRegistration)
</script>

