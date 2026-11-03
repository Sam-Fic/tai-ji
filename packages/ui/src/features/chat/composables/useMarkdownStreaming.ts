/**
 * useMarkdownStreaming —— MarkdownRenderer 的 D-5 增量流式渲染状态机（从 MarkdownRenderer.vue
 * 拆出：vue_rules_checker 的 <script setup> ≤300 行上限处方「提取 composable」，W23 review 修复
 * 叠加后组件 script 超限。本文件是原组件内逻辑的零行为迁移，测试覆盖见
 * __tests__/media-suite.test.ts / markdown.test.ts）。
 *
 * 职责（markdown 流式消费编排，展示层不感知）：
 * - 渲染模式：deps.renderMarkdownIncremental（前缀段引用恒等缓存 + tail 段每帧重建 +
 *   streaming-fence 占位，D-5/W23）。
 * - rAF trailing 节流（H2）：每帧多次 content 变化合并为单次渲染；序号检查防旧覆盖；
 *   失败降级转义纯文本（console.error 出声，不静默）+ 增量缓存作废重建。
 * - latest-wins 串行（W23）：增量缓存是单个可变对象（W22 原地更新），并发调用会交叉改写
 *   （旧渲染 resume 后按陈旧 boundary 追加 → 前缀段重复，append-only 校验对「重复但文本一致」
 *   无法自愈）→ in-flight 期间新请求合并为待执行项（queuedRender 覆盖），完成后只跑最新一条。
 * - streaming-fence 占位 finalize（D-5/W23，R-20；审计候选 3 契约化）：未结束 fence 流式期
 *   不跑 shiki/mermaid，以占位呈现；finalize 只由确定性事件触发——消息 complete
 *   （props.streaming 翻 false，经下方 streaming watch 重渲染使判定生效）。fence 结束标记
 *   到达无需判定层参与：闭行后扫描器 openFence 消失，占位分支不进入、tail 自然完整渲染。
 *   流中 token 停顿（任意时长）不 finalize——占位保持到 complete，最终渲染结果与提前
 *   finalize 逐字节一致。
 * - 生命周期：实例生命周期与所属消息的组件子树一致——同一条消息流式期间跨 content 变化
 *   保活（增量缓存持续累积），卸载即弃。无跨 session 残留的依据不是本 composable 自身机制，
 *   而是壳层 MessageStream 的 <Virtualizer :key="sessionId">（session 切换整树强制重建）
 *   （对比 TurnRenderCache 需 per-session 分区——MessageStream 实例不随 session 销毁，ADR-0049）。
 *   卸载（onScopeDispose，W23 review Fix-3）：置 disposed 短路 in-flight 结果应用与 finally
 *   分支的 queued 消费 + 丢弃 queued + 取消 pending rAF。
 *
 * 不含：段 DOM 渲染/复制按钮/歧义文件浮层（展示关注点，留 MarkdownRenderer.vue）。
 */
import { onScopeDispose, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { ChatViewDeps } from '../chat-view-deps'
import type { IncrementalMarkdownCache, MarkdownSegment } from '../markdown-types'

/** HTML 特殊字符转义（渲染失败降级路径用）：deps 抛错时把原始 content 转义后作为单个
 *  text segment 回填——保证消息气泡可读。 */
function escapeHtmlForFallback(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function useMarkdownStreaming(
  props: { content: string; sessionId?: string | null; streaming?: boolean },
  deps: ChatViewDeps,
): { segments: Ref<MarkdownSegment[]> } {
  const segments = ref<MarkdownSegment[]>([])
  let renderSeq = 0

  // ── D-5 增量渲染状态（W23）──
  // 前缀缓存是 opaque 句柄（创建/原地更新都在壳的 renderIncremental 内），本 composable 只持有透传。
  let incrementalCache: IncrementalMarkdownCache | null = null
  /** 卸载标志（W23 review Fix-3）：短路 in-flight 渲染结果应用与 finally 分支的 queued 消费 */
  let disposed = false

  // ── H2 流式 markdown 渲染 rAF trailing 节流 ──
  // 每个 text_delta token 触发 watch → 增量渲染。rAF trailing 把一帧内
  // 多次 content 变化合并为单次渲染，消除流式卡顿。D-5 增量渲染（前缀缓存 + tail 段）叠加在该
  // 节流之上：每帧渲染的只是稳定边界之后的 tail。
  let rafId: number | null = null
  let pendingContent = ''

  /**
   * 实际执行 markdown 渲染（D-5 增量消费，W23）——latest-wins 串行入口（见文件头「串行」段）。
   */
  let renderInFlight = false
  let queuedRender: { text: string } | null = null

  function doRender(text: string): void {
    if (renderInFlight) {
      queuedRender = { text }
      return
    }
    renderInFlight = true
    void runRender(text).finally(() => {
      renderInFlight = false
      // 卸载后不消费 queued（W23 review Fix-3）：in-flight 完成时组件可能已 dispose
      if (!disposed && queuedRender) {
        const next = queuedRender
        queuedRender = null
        doRender(next.text)
      }
    })
  }

  /**
   * 渲染执行体（编排）：空文本重置 → 序号取号 → 增量渲染（D-5）→ 失败降级。
   * 序号检查 + 失败降级转义纯文本语义在 runIncrementalRender / handleRenderFailure。
   */
  async function runRender(text: string): Promise<void> {
    if (disposed) return
    if (!text.trim()) {
      resetForEmptyText()
      return
    }
    const seq = ++renderSeq
    try {
      await runIncrementalRender(deps.renderMarkdownIncremental, text, seq)
    } catch (e) {
      handleRenderFailure(e, text, seq)
    }
  }

  /** 空文本重置：清段 + 作废增量缓存 */
  function resetForEmptyText(): void {
    segments.value = []
    incrementalCache = null
  }

  /** 增量路径（D-5/W23）：finalize 判定（complete 单触发源，见文件头「finalize」段）→
   *  壳增量渲染 → 序号检查应用 */
  async function runIncrementalRender(
    renderIncremental: ChatViewDeps['renderMarkdownIncremental'],
    text: string,
    seq: number,
  ): Promise<void> {
    // complete 语义：streaming !== true（false/undefined = 消息完成或静态内容，占位判定直接 finalize）
    const finalize = props.streaming !== true
    const r = await renderIncremental(text, incrementalCache, props.sessionId ?? undefined, {
      finalizeOpenFence: finalize,
    })
    incrementalCache = r.cache
    // 卸载后不应用结果（W23 review Fix-3）
    if (disposed) return
    if (seq === renderSeq) {
      segments.value = [...r.prefixSegments, ...r.tailSegments]
    }
  }

  /** 渲染失败降级：出声 + 卸载/序号检查内转义纯文本回填 + 作废缓存 */
  function handleRenderFailure(e: unknown, text: string, seq: number): void {
    // [HISTORICAL] 降级必须出声（2026-08 CSP 拦截 shiki WASM 事故：此 catch 曾静默吞错，
    // 全部 markdown 渲染无声退化纯文本，线上多版本无任何日志可查）。降级行为保留
    // （保证消息可读），但每次失败都打 error，错误可见才可诊断。
    console.error('[chat/markdown] render failed, fallback to escaped plain text:', e)
    if (!disposed && seq === renderSeq) {
      segments.value = [{ type: 'text', content: escapeHtmlForFallback(text) }]
      // 增量缓存可能已被半途污染（renderIncremental 抛错前原地改写），作废重建保证下帧正确
      incrementalCache = null
    }
  }

  /** rAF 回调：执行 pending 渲染（延迟求值检查，一帧内多次 content 变化只渲染末次值） */
  function flushRender(): void {
    rafId = null
    void doRender(pendingContent)
  }

  /** 调度一次渲染（存 pending → 若无挂起 rAF 则 requestAnimationFrame） */
  function scheduleRender(text: string): void {
    pendingContent = text
    if (rafId === null) rafId = requestAnimationFrame(flushRender)
  }

  // content 变化（流式增量）→ rAF 节流渲染
  watch(
    () => props.content,
    (text) => {
      scheduleRender(text)
    },
    { immediate: true },
  )

  // streaming true→false（消息 complete）：finalize 判定翻真的唯一触发沿——content 未变，
  // 无此 watch 则占位停在屏幕上。重渲染一次使 finalizeOpenFence:true 生效（fence 已结束的
  // 消息该帧输出与前一帧等价，仅未结束 fence 占位转完整）
  watch(
    () => props.streaming,
    (s, prev) => {
      if (prev === true && s !== true) {
        scheduleRender(props.content)
      }
    },
  )

  // 卸载时置 disposed（短路 in-flight 结果应用与 queued 消费，W23 review Fix-3）+
  // 丢弃 queued + 取消 pending rAF
  onScopeDispose(() => {
    disposed = true
    queuedRender = null
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  })

  return { segments }
}
