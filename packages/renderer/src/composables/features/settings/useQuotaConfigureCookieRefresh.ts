/**
 * cookie 自动续期控制器（手动入口；执行体 = main 隐藏窗口刷新器，经 lib/ipc 调用）。
 *
 * 从 useQuotaConfigure 拆出（taste max-lines：续期状态与动作自成一组，不与草稿 /
 * readiness 判定交叉）。契约见 core QuotaCookieRefreshView：
 * - 成功态跨重查保留（succeededAt 记时刻），重查成败由测试结果区独立呈现——
 *   「续期成功 + 查询失败」与「续期失败」两个事实并列可见
 * - 显示态按 provider id 代际收口：同 id 的对象替换（runtime provider 广播）不误清，
 *   id 真变才 reset；在途刷新迟到完成按触发时 pid 落盘、丢弃显示态写入
 */
import { ref, computed } from 'vue'
import type { ComputedRef } from 'vue'
import { getQuotaRefreshTarget } from '@taiji/shared'
import type { QuotaCookieRefreshView } from '@taiji/core'
import { refreshQuotaCookie } from '@/lib/ipc'

/**
 * 控制器输入：主工厂内 ref 的 getter 只读视图（getter 内读 ref 建立响应式依赖）。
 * t 的形态对齐 QuotaConfigureInputs['t']（i18n Translate 窄化，壳层注入）。
 */
export function createCookieRefreshController(inputs: {
  t: (key: string, params?: Record<string, unknown>) => string
  /** 当前编辑 provider id（无 provider = undefined，动作 no-op） */
  providerId: () => string | undefined
  /** 当前类型草稿（未选 = undefined） */
  fetcherId: () => string | undefined
  /** 磁盘已保存的 fetcher（从未保存 = undefined） */
  savedFetcher: () => string | undefined
  /** 当前草稿是否 cookie 形态（isCookieAuth 透传） */
  isCookieAuth: () => boolean
  /** 续期导出串的落盘（走 quota.configure 保存链，runtime 单点写 secrets 文件） */
  saveCookie: (pid: string, cookie: string) => Promise<{ ok: boolean; error?: string }>
  /** 续期成功后的结果刷新（重跑 testQuery；仅在 provider 未切换时调用） */
  onRefreshed: () => Promise<void>
}): {
  view: ComputedRef<QuotaCookieRefreshView>
  refreshCookie: () => Promise<void>
  /** 状态复位（编辑体切换 provider / 重新装配时调用）：续期结果不跨 provider 残留 */
  reset: () => void
} {
  const running = ref(false)
  const result = ref<'ok' | 'fail' | null>(null)
  const succeededAt = ref<number | null>(null)
  const error = ref('')

  /**
   * 入口可用性：cookie 形态 + 当前 fetcher 在 QUOTA_REFRESH_TARGETS 在册（在册 ⊆ cookie
   * 类——opendesign 等 cookie 类但无刷新目标的 fetcher 不在册，入口不渲染）+ 类型未变更
   * （归属判据同 readiness：类型已变未保存时，续期保存的 cookie 归属不明，等保存后再刷）。
   * 从未保存过类型的 provider（savedFetcher undefined）放行：选好类型即可先续期登录
   * （SSO 窗弹出），cookie 落盘后「保存并测试」即可消费。
   */
  const available = computed<boolean>(() => {
    if (!inputs.isCookieAuth()) return false
    const fid = inputs.fetcherId()
    if (!fid || getQuotaRefreshTarget(fid) === undefined) return false
    const saved = inputs.savedFetcher()
    return saved === undefined || fid === saved
  })

  const view = computed<QuotaCookieRefreshView>(() => ({
    available: available.value,
    running: running.value,
    result: result.value,
    succeededAt: succeededAt.value,
    error: error.value,
  }))

  /** 复位续期显示态（provider 真切换时由 syncFromProvider 调用）。running 不在此复位：在途刷新由 refreshCookie 的 finally 统一收尾——中途复位会在刷新执行期间放行按钮产生第二次点击（main 侧 inflight dedup 返回同一 Promise，两条链各自落盘同值冗余写）。 */
  function reset(): void {
    result.value = null
    succeededAt.value = null
    error.value = ''
  }

  /**
   * 手动触发续期：main 隐藏窗口刷新器导出新 cookie 串（main 不落盘），经 saveCookie
   * （quota.configure 保存链）由 runtime 单点写 secrets 文件。成功（保存 ok）重跑
   * testQuery 并**保留成功态**（succeededAt 记时刻）——重查的成败由测试结果区独立
   * 呈现，「续期成功 + 查询失败」与「续期失败」两个事实并列可见，不再互相覆盖；成功
   * 态持续到下一次续期触发或 provider 真切换（reset）。失败只写 error——不动草稿与
   * 既有测试结果（用户已填的输入不因续期失败丢失）。lib/ipc 封装保证不 reject（main
   * 侧业务失败也 resolve ok:false），catch 面只覆盖通道装配异常。
   */
  async function refreshCookie(): Promise<void> {
    const pid = inputs.providerId()
    const fid = inputs.fetcherId()
    if (!pid || !fid || !available.value || running.value) return

    // 代际守卫：在途刷新可达 15s~120s，期间编辑体可能切到别的 provider——落盘按触发时
    // 捕获的 pid 已正确完成，显示态写入与重查须丢弃（旧 provider 的结果不得写进新
    // provider 的显示态、也不得在新 provider 上发起重查）
    const stillCurrent = (): boolean => inputs.providerId() === pid

    running.value = true
    result.value = null
    succeededAt.value = null
    error.value = ''
    try {
      const refreshed = await refreshQuotaCookie({ fetcherId: fid, providerId: pid })
      if (!(refreshed.ok && refreshed.cookie)) {
        if (stillCurrent()) {
          result.value = 'fail'
          error.value = refreshed.error || inputs.t('settings.providerEdit.quotaCookieAutoRefreshFail')
        }
        return
      }
      // 单写方落盘（data-source-registry #66）：保存失败按续期失败呈现（cookie 未生效）
      const saved = await inputs.saveCookie(pid, refreshed.cookie)
      if (!saved.ok) {
        if (stillCurrent()) {
          result.value = 'fail'
          error.value = saved.error || inputs.t('settings.providerEdit.quotaCookieAutoRefreshFail')
        }
        return
      }
      if (stillCurrent()) {
        result.value = 'ok'
        succeededAt.value = Date.now()
        await inputs.onRefreshed()
      }
    } catch (e) {
      if (stillCurrent()) {
        result.value = 'fail'
        error.value = e instanceof Error ? e.message : inputs.t('settings.providerEdit.quotaCookieAutoRefreshFail')
      }
    } finally {
      running.value = false
    }
  }

  return { view, refreshCookie, reset }
}
