/**
 * useSettingsErrorEsc —— 设置弹层懒加载错误态的 window 级 Esc 兜底（模态族自消费档）。
 *
 * 背景：SettingsModal 经 defineAsyncComponent 懒加载（AppShell，v-if 门控），装载失败时
 * errorComponent（AsyncErrorFallback overlay，模态表面 'async-error-fallback-overlay'，
 * 登记 yieldsEsc）替换其挂载——SettingsModal 自身的 window 级 Esc 兜底随组件消失，而
 * 编排器 Esc 分支（key-orchestrator）因该占位表面让位后无人消费 = Esc 死键：全屏遮罩
 * 无关闭按钮，文案（common.loadFailedHint）承诺的「Esc 可退出」恢复通道失效，用户被
 * 困在错误态。
 *
 * 本 composable 在宿主（AppShell）补占位态的自关通道，与 SettingsModal 的 window 兜底
 * 同款机制、同款口径：
 * - 注册条件 = open + 装载失败（reactive target，false 时自动卸载）——正常态零介入，
 *   Esc 完整保留给 SettingsModal（含其内层弹层让位检查）；
 * - 执行序 = 编排器先行让位（AppShell setup 内 useKeyOrchestrator 首位注册，本监听
 *   后注册）→ 本监听消费；
 * - defaultPrevented 先检 + otherSurfaceYieldsEsc('async-error-fallback-overlay')
 *   排除占位自身查其他让位成员（内层弹层开着 Esc 归内层），命中即 preventDefault。
 *
 * close 动作由宿主注入（AppShell = settingsOpen=false，v-if 卸载，重开 = fresh load）。
 */
import { useEventListener } from '@vueuse/core'
import { otherSurfaceYieldsEsc } from '@/composables/features/app/modal-surface-registry'

export function useSettingsErrorEsc(
  /** 设置弹层开合态读点（动作时刻直读，禁缓存） */
  isOpen: () => boolean,
  /** 装载失败态读点（createLazyChunkRetry.failed；false = 正常态，监听不注册） */
  isFailed: () => boolean,
  /** 关闭动作（宿主注入：AppShell = settingsOpen=false） */
  close: () => void,
): void {
  useEventListener(
    () => (isOpen() && isFailed() ? window : null),
    'keydown',
    (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      if (otherSurfaceYieldsEsc('async-error-fallback-overlay')) return
      e.preventDefault()
      close()
    },
  )
}
