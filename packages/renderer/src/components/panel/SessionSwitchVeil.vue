<template>
  <!--
    展示组件 · session-switch-veil（会话切换幕布过渡）：sidebar 点击 session 后、切换
    promise settle 前的过渡呈现层。锚定模式同 ToastContainer（挂 main-area 内、absolute
    贴最近 positioned 祖先）。三段视觉（对齐 demo 形态）：
    - 压暗幕布：--scrim-veil（弱于 modal 的 --scrim）+ backdrop-blur，盖住对话流与 composer
      （等待期不该输入），header 保持在幕布之上（组件定位从卡头 40px 下沿起）；
    - 顶部细进度线：2px accent 横扫，抄 MessageStream .hist-line-sweep 模式（keyframes
      scoped 自足，跨文件引用才需进全局 SSOT）；
    - 状态 chip：bg-bg + border + shadow-2（SessionItem hover 详情卡同源视觉档）+
      三点跳动，role="status" 供屏幕阅读器播报。
    淡入淡出走 Transition（进 ease-out / 出 ease-in，E5 分向纪律）；leave 同时过渡
    backdrop-filter 到 blur(0)，避免底色已淡而 blur 突消的跳变。
    reduced-motion 由 style.css 全局兜底承接（扫线/跳动冻结为静止、过渡保留 opacity）。
  -->
  <Transition name="veil-fade">
    <div
      v-if="state.phase === 'visible'"
      data-testid="session-switch-veil"
      role="status"
      class="absolute inset-x-0 bottom-0 top-[40px] z-[var(--z-overlay)] bg-[var(--scrim-veil)] backdrop-blur-[3px]"
    >
      <div class="veil-line absolute inset-x-0 top-0 block h-0.5 overflow-hidden" />
      <div class="absolute inset-x-0 top-6 flex justify-center">
        <div
          class="flex items-center gap-2 rounded-full border border-border bg-bg px-4 py-1.5 text-[length:var(--text-xs)] text-neutral-fg-2 shadow-2"
          data-testid="session-switch-veil-chip"
        >
          <span class="truncate">{{ t('sidebar.switchingTo', { name: state.targetLabel }) }}</span>
          <span class="veil-dots inline-flex shrink-0 gap-[3px]" aria-hidden="true"><i /><i /><i /></span>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useSessionSwitchVeilState } from '@/composables/features/sidebar/useSessionSwitchVeil'

const { t } = useI18n()
const state = useSessionSwitchVeilState()
</script>

<style scoped>
/* 顶部细进度线（抄 MessageStream .hist-line-sweep：::after 芯横扫、外层裁切） */
.veil-line::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  animation: veil-line-sweep 1.05s linear infinite;
}
@keyframes veil-line-sweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }

/* chip 三点跳动（进度暗示；hop 位移 + 透明度呼吸；声明单行含 animation 走动画豁免） */
.veil-dots i { width: 4px; height: 4px; border-radius: 9999px; background: var(--accent); animation: veil-dot-hop 1.1s ease-in-out infinite; }
.veil-dots i:nth-child(2) { animation-delay: 150ms; }
.veil-dots i:nth-child(3) { animation-delay: 300ms; }
@keyframes veil-dot-hop { 0%, 70%, 100% { transform: translateY(0); opacity: 0.45; } 30% { transform: translateY(-4px); opacity: 1; } }

/* 显隐过渡（E5 分向：进 ease-out / 出 ease-in）+ blur 同步消散（Vue Transition 约定类） */
.veil-fade-enter-active {
  transition: opacity var(--duration) var(--ease-out);
}

.veil-fade-leave-active {
  transition:
    opacity var(--duration) var(--ease-in),
    backdrop-filter var(--duration) var(--ease-in);
}

.veil-fade-enter-from {
  opacity: 0;
}

.veil-fade-leave-to {
  opacity: 0;
  backdrop-filter: blur(0px);
}
</style>
