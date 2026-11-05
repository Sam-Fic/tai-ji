/**
 * useFolderDeleteConfirm —— folder 维度删除的两段式确认编排（从 SessionList 提取）。
 *
 * 职责：folderConfirmingCwd 确认态（与 SessionItem.confirming 同范式：存当前确认的 cwd，
 * 同时只允许一个 folder 处于确认态；二次点击同 cwd 才触发删除）+ 三个复位入口
 * （Esc / mouseleave / 点击按钮外部）+ 删除按钮可用性检查（review MF-2）。
 * 展示侧（按钮 title/配色/显隐）留在 SessionDirLabel，确认态本体归本 composable。
 *
 * 依赖注入说明：groups 由调用方以 getter 注入（SessionList 的 props 非响应式直传边界）；
 * escCount 由调用方注入（SessionList 的单一 Esc 广播计数器，provide 给后代 SessionItem——
 * 本 composable watch 同一计数器复位确认态，与后代清确认态共享一次 Esc）；
 * 确认后的删除动作经 onDeleteFolder 回调交还调用方（emit deleteFolder 归组件边界）。
 */
import { ref, watch, type Ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import type { SessionGroup } from '@taiji/shared'
import type { ProjectGroupVM } from '@/composables/features/sidebar/useProjectGroups'

export function useFolderDeleteConfirm(options: {
  /** cwd 全量分组（MF-2 检查的「全量 session 数」数据源，未预过滤） */
  groups: () => SessionGroup[]
  /** Esc 广播计数器（每按一次 Esc 自增，watch 触发复位） */
  escCount: Ref<number>
  /** 两段确认完成后的删除动作（SessionList emit deleteFolder） */
  onDeleteFolder: (cwd: string) => void
}) {
  const { groups, escCount, onDeleteFolder } = options

  /**
   * folder 维度删除的两段式确认态（与 SessionItem.confirming 同范式）。
   * 存当前确认的 cwd（同时只允许一个 folder 处于确认态）；二次点击同 cwd 才 emit deleteFolder。
   * Esc / mouseleave / 点击外部复位。
   */
  const folderConfirmingCwd = ref<string | null>(null)
  function onFolderRemoveClick(cwd: string): void {
    if (folderConfirmingCwd.value !== cwd) {
      folderConfirmingCwd.value = cwd
      return
    }
    folderConfirmingCwd.value = null
    onDeleteFolder(cwd)
  }
  /** 鼠标离开 folder 按钮区域时复位确认态（与 Esc 同源，防止误确认） */
  function onFolderMouseLeave(cwd: string): void {
    if (folderConfirmingCwd.value === cwd) folderConfirmingCwd.value = null
  }

  watch(escCount, () => {
    if (folderConfirmingCwd.value) folderConfirmingCwd.value = null
  })

  /**
   * 点击 folder 确认按钮外部时复位确认态（与 SessionItem.onClickOutside 同范式）。
   * folder 标题行处于 v-for 循环（多个 folder），不便逐项挂 onClickOutside ref，故用
   * 单一 window pointerdown 监听（pointerdown 先于 click，比 click 更早收尾确认态）。
   *
   * 同级 folder 按钮冲突规避：点击另一 folder 的删除按钮时，该按钮的 @click.stop 会切
   * folderConfirmingCwd 到新 cwd。若此处无条件复位会覆盖新值。故只在「点击目标不在任何
   * folder 删除按钮内」时复位——新 cwd 的切换由 onFolderRemoveClick 自行处理，互不干扰。
   */
  useEventListener(window, 'pointerdown', (e: PointerEvent) => {
    if (!folderConfirmingCwd.value) return
    const target = e.target as Element | null
    if (target?.closest('[data-testid="folder-delete-btn"]')) return
    folderConfirmingCwd.value = null
  })

  /**
   * folder 删除可用性（review MF-2，项目分组版）：该 cwd 在**此项目分组内**的可见 session 数
   * < 该 cwd 全量 session 数时隐藏删除按钮。removeByCwd 是 cwd 全量删除（项目无关）——
   * 同一 cwd 的 session 可散布在多个项目分组（按 session.projectId 逐条切分），任一分组内
   * 只显示子集；仅当某分组恰好包含该 cwd 全量会话时点删除才不会连带删掉不可见 session。
   */
  function isFolderDeleteAvailable(zone: Pick<ProjectGroupVM, 'dirs'>, cwd: string): boolean {
    const total = groups().find((g) => g.cwd === cwd)?.sessions.length ?? 0
    const visible = zone.dirs.find((g) => g.cwd === cwd)?.sessions.length ?? 0
    return total > 0 && total === visible
  }

  return { folderConfirmingCwd, onFolderRemoveClick, onFolderMouseLeave, isFolderDeleteAvailable }
}
