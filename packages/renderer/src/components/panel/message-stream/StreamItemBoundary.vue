<!--
  StreamItemBoundary —— 对话流单条渲染项的错误边界（RD-2#1 / code-harden RD-2）。

  问题：Turn/BashOutputBlock/SystemNotice/SkillNoticeInline 等子组件 render 抛错发生在
  MessageStream 的渲染帧内，全仓 onErrorCaptured=0，错误直达全局 errorHandler（只落盘
  renderer-error.log）——一条坏数据炸掉整屏消息流（退化旧帧/空白），用户零感知。

  机制：本组件包住每条渲染项，onErrorCaptured 捕获子树内（slot 内容 = 各渲染子组件）
  的 render/setup 错误 → 记录（console.error + reportCapturedError 落盘，与全局 errorHandler
  同一上报通道）→ return false 阻断向全局传播 → 切换为「本条渲染失败」占位行（含原文
  预览 + 重试入口）。其余 item 不受影响——故障隔离粒度从整屏收敛到单条。

  重试语义：占位行期间 slot 内容已随 v-if 分支卸载；点重试复位 failed → slot 内容重新
  挂载（slot 函数重新执行，子组件全新实例），数据已被修复时恢复渲染，仍坏则再次落入
  本边界。

  边界自身 render 不消费响应式子树（占位行是静态模板），自身抛错路径结构性为零；slot
  函数体的表达式抛错由上层前置求值兜（stream-view-items.ts，本组件捕获不到自身 render
  帧内的错误——Vue errorCaptured 只链式上报后代组件的错误）。

  B-harden（preview 惰性化后的兜底）：preview 为 thunk，其求值发生在本组件的 render 帧内
  （computed 懒求值）——thunk 抛错时本组件的 errorCaptured 捕获不到自身 render 帧的错误，
  会直接把占位行也炸掉。故 previewText 自带 try/catch 降级为空串（诊断文本可丢，兜底不可丢）。
-->
<template>
  <div
    v-if="failed"
    class="content-col flex min-w-0 items-center gap-2 py-1"
    data-testid="stream-item-error"
  >
    <AlertTriangle class="size-3.5 shrink-0 text-warn" />
    <div class="flex min-w-0 flex-col gap-0.5">
      <span class="text-[length:var(--text-xs)] text-warn">{{ t('panel.message.itemRenderFailed') }}</span>
      <span
        v-if="previewText"
        class="min-w-0 truncate text-[length:var(--text-2xs)] text-neutral-dim"
        :title="previewText"
      >{{ previewText }}</span>
    </div>
    <Button variant="ghost" size="sm" data-testid="stream-item-error-retry" @click="retry">
      {{ t('panel.message.itemRenderRetry') }}
    </Button>
  </div>
  <template v-else>
    <slot />
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { onErrorCaptured, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { reportCapturedError } from '@/boot/error-reporter'

const props = defineProps<{
  /** 原文预览（占位行诊断信息；由上层视图模型算好传入，空串时不显示）。
   *  turn 项为惰性 thunk（B1 派生归零）：仅占位行渲染时求值——正常渲染路径零成本。 */
  preview: string | (() => string)
}>()

// 占位行专用：failed 渲染分支才访问 ⇒ thunk 仅在失败路径物化（computed 懒求值）
// 抛错降级（B-harden）：本组件是渲染失败的最后兜底，自身不能再抛——thunk 求值失败
// （turn 数据畸形致 previewText/turnPreview 抛错）时降级为空串，占位行只丢诊断文本、
// 不把「单条渲染失败」升级成「占位行也渲染失败」。
const previewText = computed(() => {
  const p = props.preview
  if (typeof p !== 'function') return p
  try {
    return p()
  } catch (err) {
    // 双通道上报（与同文件 onErrorCaptured 及全部同族 Guard 一致）：renderer 无 console
    // 持久化，只 console.error 会让该错误在打包版完全不可见——用户看到「无诊断文本的
    // 占位行」而日志零痕迹。降级方向（return ''）不扩大故障面：进入 failed 分支本身已
    // 意味着单条渲染失败显形 + retry 入口在场，preview 只是二线诊断文本。
    console.error('[StreamItemBoundary] preview thunk failed:', err)
    reportCapturedError(err, 'stream-item-boundary:preview-thunk')
    return ''
  }
})

const { t } = useI18n()

const failed = ref(false)

onErrorCaptured((err, _instance, info) => {
  if (failed.value) return false
  failed.value = true
  // 记录与全局 errorHandler 同通道（D2 单一上报出口）：console 留现场 + 落盘取证
  console.error(`[StreamItemBoundary] item render failed (${info}):`, err)
  reportCapturedError(err, `stream-item-boundary:${info}`)
  // 阻断向全局 errorHandler 传播：单条故障不升级为整流故障，用户侧已有占位行显形
  return false
})

function retry(): void {
  failed.value = false
}
</script>
