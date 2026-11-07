/*
 * 懒加载 chunk 失败态薄层（原「内部自动重试」已删：时间机制删除裁决——300ms×n 退避
 * 重试退役，装载失败直接进错误态）。
 *
 * 错误态出路（保留件）：关闭后重新打开（宿主 v-if 重挂 = 全新一轮 fresh load）+
 * Esc/⌘W 退出（AsyncErrorFallback 文案指引）。无定时器、无 cache-busting、无自动重试。
 *
 * 保留工厂形态的原因：三处消费方（PanelContainer / AppShell / useDrawerContentDispatch）
 * 已按 { retryKey, failed, loader, onError } 契约接线 defineAsyncComponent，薄层保持该契约
 * 零改消费方——retryKey 恒 0（无重挂驱动），onError 直接 fail 呈现错误态，failed 供宿主
 * 感知错误占位态（消费方 = AppShell settings 错误态 Esc 兜底）。
 */
import { readonly, ref, type Ref } from 'vue'

export interface LazyChunkRetry<T = unknown> { // oe-exempt:20261003:framework:类型契约先行——消费方（状态机单测已删）按此接口接线 defineAsyncComponent，单实现为常态
  /** wrapper 重挂 key：自动重试已删，恒 0（保留字段 = 消费方 :key 接线契约不变） */
  retryKey: Readonly<Ref<number>>
  /** 装载失败态读点：onError fail 时置 true，loader 成功后复位。消费方 = 需要感知
   *  错误占位态的宿主（AppShell settings 错误态 Esc 兜底 useSettingsErrorEsc）；
   *  其余消费方不读不受影响 */
  failed: Readonly<Ref<boolean>>
  /** 传给 defineAsyncComponent 的 loader（失败直接抛，走 errorComponent；成功复位 failed） */
  loader: () => Promise<T>
  /** 传给 defineAsyncComponent 的 onError（装载失败立即 fail 呈现错误态，不重试） */
  onError: (err: unknown, retry: () => void, fail: () => void) => void
}

/**
 * 创建懒加载 chunk 的失败态薄层（每挂载点一个实例，组件 setup 内调用）。
 *
 * 行为：装载失败 → onError 直接 fail() → AsyncErrorFallback 错误态呈现（恢复指引 =
 * 关闭后重新打开 / Esc ⌘W 退出）；宿主重挂（v-if 重开）经 defineAsyncComponent 自身
 * 语义重新 load，恒为全新一轮。
 */
export function createLazyChunkRetry<T>(
  load: () => Promise<T>,
): LazyChunkRetry<T> {
  const retryKey = ref(0)
  const failed = ref(false)
  // loader 包装成功分支复位 failed：错误占位后用户重开（v-if 重挂 → 新一轮 load），
  // 成功即回到正常态——宿主错误态兜底必须随 false 退出（否则正常态 Esc 被宿主抢消费，
  // SettingsModal 的内层弹层让位语义失效）
  const loader = (): Promise<T> =>
    load().then((comp) => {
      failed.value = false
      return comp
    })
  const onError = (_err: unknown, _retry: () => void, fail: () => void) => {
    failed.value = true
    fail()
  }
  return { retryKey: readonly(retryKey), failed: readonly(failed), loader, onError }
}
