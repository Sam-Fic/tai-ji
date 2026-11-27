<script setup lang="ts">
// EdgeFade —— 滚动容器顶缘「渐焦」提示（demo chat spec 裁决 4B，OpenDesign edge-fade 同构）。
// 自包含：作为任意 overflow 滚动容器的前两个子元素挂载（一个贴顶哨兵 + sticky 渐焦带），消费方零配置。
// 渐焦 = 失焦 + 沉色双通道：四层渐高 blur 之上叠一层底色渐变（--edge-fade-sink，默认
// --surface，峰值浓度 75%：光晕基本压平且保留失焦感），暗色压住亮字模糊的泛白光晕、
// 亮色沉入纸白；底色非 --surface 的消费方在滚动容器上覆写 --edge-fade-sink。层遮罩与
// 容器 mask 用多 stop 近似 smoothstep 的平滑剖面（线性渐变人眼感知中段偏快，多 stop
// 消台阶感）。
// z-[3] 为容器内局部层级刻意值，不取 style.css z 档（对照 z 表：--z-sticky 1 / --z-popover 10）：
// 须高于滚动容器内 sticky 内容（同 z 值时按 DOM 序 sticky 项会盖住渐焦带、滚入带内逃逸
// 失焦+沉色），又须低于容器内交互控件（MessageStream 回到底部按钮走 --z-popover 同值
// 10 档）——装饰渐焦带夹两档之间。
// [贴顶前提] 消费方滚动容器禁设顶部 padding——sticky 带的正常流位置会被压到 padding 之下，
// 滚过 padding 前带悬浮于视口中部（顶缘露出未处理区）；顶部留白放滚动内容内（spacer）。
// 降级：prefers-reduced-motion 关过渡（motion-reduce 变体）；prefers-reduced-transparency
// 关整个渐焦效果（遮罩层隐藏 + 容器 mask 摘除）。
// [消费范围门禁] 仅对话流及其同族场景（经 MessageStream 复用：drawer subagent / 旁路提问 /
// workflow agent）可用；.githooks/check_edge_fade_scope.mjs 强制。
//
// [强制布局纪律 · batch2 F4] 离顶判定经**贴顶哨兵的 IntersectionObserver 投递**（布局后、绘制前），
// 不在 scroll 回调里读 scroller.scrollTop——后者在 DOM 刚被 delta 改脏时读几何量会触发强制同步布局
// （实测旧 sync 2.5ms/次）。IO 回调只把 isIntersecting 翻成 scrolledPast 布尔，mask 串按 on 翻转时
// （watch）套模块常量（N1），scroll/IO 回调全程零几何读。
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'

const reducedTransparency = ref(false)
/** sticky 渐焦带根（原 EdgeFade 单体，形态不变）。 */
const root = ref<HTMLElement | null>(null)
/** 贴顶哨兵：绝对定位（包含块 = position:relative 的滚动父级）、top-0、高 = 离顶阈值。
 *  随滚动内容滚出视口顶时 IO 投递 isIntersecting=false → 判定「已离顶」。absolute 不占流内空间。 */
const sentinel = ref<HTMLElement | null>(null)
/** 哨兵是否已滚离视口顶（IO 投递的事实，非 scroll 回调推测）。 */
const scrolledPast = ref(false)

let scroller: HTMLElement | null = null
let transparencyMedia: MediaQueryList | null = null
let sentinelIo: IntersectionObserver | null = null

/* [perf:animation] 2026-11 四层 backdrop-blur 减为一层（原 1/2/4/8px 四层叠在同一 40px 带上
   = 同一区域 4 次 backdrop 采样，是「动画期间成本放大器」的第二项；实测 blur 单独停掉零收益，
   但叠加在动画/滚动上时被连带计费）。现单层 blur-[4px] 全高 + 下面仍在的渐变遮罩层负责
   柔和度；分层梯度由 [mask-image] 的 4 stop 剖面继续承担，视觉差异极小。 */
const LAYERS = [
  { blur: 'h-full backdrop-blur-[4px]' },
] as const

/** 顶缘渐焦带高度（px），同时是容器 mask 的过渡段长度（demo 同值）。
 *  离顶判定阈值 = 哨兵高度（模板 h-1 = 4px，demo 同值）：哨兵滚出视口顶 ⇔ scrollTop 超过 4px。 */
const FADE_BAND_HEIGHT = 40
/** 容器 mask 多 stop 剖面的比例点（近似 smoothstep：40px 带上 13px/26px 两档过渡）。 */
const MASK_STOP_SOFT = 0.325
const MASK_STOP_FIRM = 0.65

// N1: 容器 mask 两态串提为模块级常量（active/inactive 只依赖 on 布尔 + 上述常量，编译期定值；
// 等价重构——0.86s 旧成本实为 scrollTop 强制布局而非字符串，常量提取本身收益≈0，勿记为收益）。
const MASK_ACTIVE = `linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.4) ${Math.round(FADE_BAND_HEIGHT * MASK_STOP_SOFT)}px, rgba(0,0,0,0.8) ${Math.round(FADE_BAND_HEIGHT * MASK_STOP_FIRM)}px, #000 ${FADE_BAND_HEIGHT}px)`
const MASK_INACTIVE = ''

/** 渐焦激活 = 哨兵滚离顶 ∧ ¬reducedTransparency。 */
const on = computed(() => scrolledPast.value && !reducedTransparency.value)

/** on 翻转时把 mask 常量套到滚动容器（CSSOM 读写，无几何量读取、不触发 reflow）。 */
function applyMask(): void {
  if (!scroller) return
  const next = on.value ? MASK_ACTIVE : MASK_INACTIVE
  if (scroller.style.maskImage !== next) scroller.style.maskImage = next
}
watch(on, applyMask)

function onTransparencyChange(): void {
  reducedTransparency.value = transparencyMedia?.matches ?? false
}

function unbind(): void {
  sentinelIo?.disconnect()
  sentinelIo = null
  if (scroller) scroller.style.maskImage = ''
  scroller = null
  scrolledPast.value = false
}

function bind(el: HTMLElement | null): void {
  if (scroller === el) return
  unbind()
  scroller = el
  // 无滚动父级 / 无哨兵 / 宿主无 IntersectionObserver（happy-dom 等）：降级为不激活（on 恒 false），
  // 绝不回退到 scroll 回调读 scrollTop（那正是要消除的强制布局源）。
  if (!scroller || !sentinel.value || typeof IntersectionObserver === 'undefined') {
    scrolledPast.value = false
    applyMask()
    return
  }
  sentinelIo = new IntersectionObserver((entries) => {
    const e = entries[entries.length - 1]
    if (e) scrolledPast.value = !e.isIntersecting
  }, { root: scroller, threshold: 0 })
  sentinelIo.observe(sentinel.value)
  applyMask()
}

onMounted(() => {
  // matchMedia 缺失环境（happy-dom 等测试宿主）跳过 transparency 监听：reducedTransparency
  // 保持 false = 渐焦全功能生效（检查降级而非崩溃，onTransparencyChange 已容 null media）
  if (typeof window.matchMedia === 'function') {
    transparencyMedia = window.matchMedia('(prefers-reduced-transparency: reduce)')
    transparencyMedia.addEventListener('change', onTransparencyChange)
    onTransparencyChange()
  }
  bind(root.value?.parentElement ?? null)
})

onBeforeUnmount(() => {
  transparencyMedia?.removeEventListener('change', onTransparencyChange)
  unbind()
})
</script>

<template>
  <!-- 贴顶哨兵：绝对定位、top-0、高 4px（= 离顶阈值）。随滚动内容滚出视口顶时 IO 投递
       isIntersecting=false 激活渐焦。absolute 不占流内空间（零布局扰动），置于渐焦带之前
       保证仍是滚动容器首个元素子节点。 -->
  <div
    ref="sentinel"
    data-testid="edge-fade-sentinel"
    aria-hidden="true"
    class="pointer-events-none absolute inset-x-0 top-0 h-1 max-w-none"
  />
  <div
    ref="root"
    data-testid="edge-fade"
    aria-hidden="true"
    class="pointer-events-none sticky top-0 z-[3] -mb-[40px] h-[40px] max-w-none"
    :class="reducedTransparency ? 'hidden' : ''"
  >
    <i
      v-for="(l, i) in LAYERS"
      :key="i"
      class="absolute inset-x-0 top-0 block [mask-image:linear-gradient(to_bottom,#000_12%,rgba(0,0,0,0.78)_34%,rgba(0,0,0,0.42)_62%,transparent_88%)] transition-opacity duration-[140ms] ease-[var(--ease-out)] motion-reduce:transition-none"
      :class="[l.blur, on ? 'opacity-100' : 'opacity-0']"
    />
    <i
      aria-hidden="true"
      class="absolute inset-x-0 top-0 block h-full bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--edge-fade-sink,var(--surface))_75%,transparent),transparent)] transition-opacity duration-[140ms] ease-[var(--ease-out)] motion-reduce:transition-none"
      :class="on ? 'opacity-100' : 'opacity-0'"
    />
  </div>
</template>
