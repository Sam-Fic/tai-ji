/**
 * useAppUpdate 的启动编排轴工厂：恢复持久化提醒（restorePreloadedUpdate /
 * restorePendingUpdate）+ 读取升级启动结果（checkLaunchResult）。
 *
 * 无定时调度（ADR-0188 丁类退役）：启动 30s 首查 / 15min 周期 / visibilitychange
 * 补查全部退役——联网检测只由用户手动触发（设置页「检查更新」按钮，checkForUpdate）。
 *
 * 依赖方向：本模块 → use-app-update-state（读 state 检查）+ use-app-update-restore
 * （启动恢复链）+ use-app-update-launch（启动结果通知）。被 useAppUpdate.ts 消费。
 */
import type { UpdateStateContainer } from './use-app-update-state'

/** 启动编排轴依赖：state 容器 + 各轴方法 */
export interface AutoCheckAxisDeps {
  state: UpdateStateContainer
  restorePreloadedUpdate(): Promise<boolean>
  restorePendingUpdate(): Promise<void>
  checkLaunchResult(): Promise<void>
}

/** 启动编排轴 */
export interface AutoCheckAxis {
  /**
   * 启动编排：先恢复持久化提醒（立即），再读取启动结果。
   * 不联网（恢复链均为本地读取）；联网检测只剩设置页手动「检查更新」。
   *
   * 必须在活跃 effect scope 内调用，通常在组件 setup 顶层同步调用
   * （恢复链内部使用 onScopeDispose 类钩子时依赖活跃 scope）。
   */
  initAutoCheck(): void
}

/** 创建启动编排轴 */
export function createAutoCheckAxis(deps: AutoCheckAxisDeps): AutoCheckAxis {
  const { restorePreloadedUpdate, restorePendingUpdate, checkLaunchResult } = deps

  function initAutoCheck(): void {
    // 恢复链无条件执行（均为本地读取不联网）：先恢复 preloaded（downloaded 态，
    // 优先级高于 pending）
    void restorePreloadedUpdate().then((restored) => {
      if (!restored) {
        // preloaded 无效 → 回退 restorePendingUpdate（available 态）
        void restorePendingUpdate()
      }
    })
    // 读取启动结果（升级成功/失败/回滚），consumed 一次性：首次调用返回结果并清空
    void checkLaunchResult()
  }

  return { initAutoCheck }
}
