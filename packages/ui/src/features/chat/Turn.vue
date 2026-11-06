<template>
  <!-- split-justified: main 侧合并带入（turn 编排器，单语义域）；script 超 300 为存量——trace 窗口化编排已拆出 useTurnTrace composable（composables/use-turn-trace.ts）并被本组件消费，余量为主编排本体，不再规划拆分任务 -->
  <!--
    编排器 · Turn（message-stream 单个回合，W4 拆分后）。
    组合 UserBubble + TurnMeta + 两个 trace 渲染单元组件（TextRow / ProcessAggregateBlock）；
    hover actions 操作栏（TurnSummary）经 trace 末单元正文的 #turn-actions 插槽挂载
    （[actions-anchor]，流内固定行 = text 块下部一行，与 UserBubble hover actions 同族，
    见下方锚块注释；末单元非 text 时无挂载点、不渲染）。
    trace 区单元 = 正文块 + 聚合块两型（chat-flow-process-aggregate D1/D2/D5）：正文直渲染
    TextRow（.trace-blk / .trace-blk--text 类名契约挂 Turn.vue 单元 wrapper），过程段收进
    ProcessAggregateBlock 三态容器（进行中双窗 / 完成摘要 / 展开平铺）；折叠态 = 末位正文 +
    全部聚合块摘要行（D5）。
  -->
  <!-- 根元素 content-col（居中 + 封顶 --content-max-w，720px 内容列原语）：整 turn 居中（spec §6.1 R4）。
       轮次节奏（demo workbench.css 权威值）：gap-[12px] = 用户气泡→轮头 12px 紧凑档（.blk:has(+ .blk-compact)）；
       pb-5 = 轮边界 20px（--blk-gap，轮边界唯一贡献——trace 无 mb；末位 text 块内的
       TurnSummary 固定行（h-6+mt-1）只属于锚轮内部节奏，不计入轮边界）。
       [MF-1-33]（demo .blk:last-child margin-bottom:0，workbench.css:314）：末位 turn 去 pb-5——
       末轮底部留白只剩滚动容器的 24px（MessageStream pb-[24px]），非历史轮保持 20px 轮边界。
       [MF-1-35]（demo .blk scroll-margin-top:8px，workbench.css:313）：scrollIntoView 落点让出
       悬挂时间戳（DOM scrollIntoView 通路生效；virtua scrollToIndex 不读 scroll-margin，
       其落点补偿归 virtua API 侧）。 -->
  <div
    class="content-col flex flex-col gap-[12px] [scroll-margin-top:8px]"
    :class="isLastTurn ? '' : 'pb-5'"
    :data-testid="`turn-${turn.index}`"
  >
    <!-- 收纳完成通知的临时外部行：工作态按
         「现状外部形态」渲染在轮头行上方（inline 行距），settle 后消失——同一批通知在流内
         只出现一次（外部行与折叠标签不重复渲染）。bash 结构化行经 core isBashCompleteNotice
         判定过滤（判定单点不复制）；隐藏通知（subagent/workflow）无外部行。 -->
    <template v-if="isWorkingTurn">
      <SystemNotice
        v-for="m in workingBashNotices"
        :key="m.id"
        :message="m"
        inline
        data-testid="turn-folded-notice-external"
      />
    </template>

    <!-- user 区：UserBubble 子组件。
         [chat-flow-consistency U9 / S2] 交接指令提示行（锚位带 handoffInstruction 的
         system 行）不渲染 user 气泡——折叠为 SystemNotice 提示行（「交接指令（内部）」，
         悬停显指令原文），其后的 assistant 回合即交接文档（TurnMeta 挂「交接文档」标签）。 -->
    <SystemNotice
      v-if="turn.user && isHandoffInstructionNotice(turn.user)"
      :message="turn.user"
      data-testid="turn-handoff-instruction"
    />
    <UserBubble
      v-else-if="turn.user"
      :turn="turn"
      :session-id="sessionId"
      :can-edit="canEdit"
      :is-session-editable="isSessionEditable"
      @edit-state-change="emit('edit-state-change', $event)"
    />

    <!-- trigger 起点行（W4·D3 + U6·D5 聚合增强；[bg-notice-fold] settle 后退役）：无 user 起点的
         后台续跑 turn 仅在工作态渲染聚合行（「N 个后台任务完成 · M 失败 ●●● · 已继续处理 · 耗时」
         ——视觉语言对齐 SystemNotice 元信息行）。落成态聚合行摘除，数据已随分组层收进轮头行
         （TurnMeta 折叠分段标签 + 展开明细行）。assistant
         自启 turn（user:null 无 trigger）两者皆不渲染。 -->
    <div
      v-else-if="turn.trigger === 'bg-notify' && isWorkingTurn"
      class="mx-auto flex w-full min-w-0 items-center gap-2 py-1.5 animate-notice-in"
      data-testid="turn-trigger-bgnotify"
    >
      <span class="h-px flex-1 bg-[image:linear-gradient(to_right,transparent,var(--border-strong)_18%,var(--border-strong)_82%,transparent)]" />
      <component
        :is="notifyIcon"
        class="size-[13px] shrink-0"
        :class="notifyIconClass"
        stroke-width="2.2"
        data-testid="turn-trigger-bgnotify-icon"
      />
      <!-- 主文案/失败分句/状态点列/从文案/耗时 meta：片段数组单点 v-for（g9-F2），段间分隔点
           唯一渲染点在下方（sep 标记由 script 侧段规格按 D5 样本给出）。 -->
      <template v-for="seg in notifySegments" :key="seg.id">
        <span
          v-if="seg.sep"
          class="shrink-0 text-neutral-faint"
          data-testid="turn-trigger-bgnotify-sep"
        >·</span>
        <!-- 状态点列（D5）：≤8 逐点三色（成功绿 / 失败金 / 中性灰）；>8 只显计数不渲染点列 -->
        <span
          v-if="seg.dots"
          class="flex shrink-0 items-center gap-[3px]"
          data-testid="turn-trigger-bgnotify-dots"
        >
          <span
            v-for="(outcome, i) in seg.dots"
            :key="i"
            class="size-1.5 rounded-full"
            :class="NOTIFY_DOT_CLASS[outcome]"
            data-testid="turn-trigger-bgnotify-dot"
          />
        </span>
        <span
          v-else
          :class="seg.class"
          :data-testid="`turn-trigger-bgnotify-${seg.id}`"
        >{{ seg.text }}</span>
      </template>
      <span class="h-px flex-1 bg-[image:linear-gradient(to_right,transparent,var(--border-strong)_18%,var(--border-strong)_82%,transparent)]" />
    </div>

    <!-- assistant 区 -->
    <div class="group/ai flex flex-col gap-0 self-stretch">
      <!-- turn-meta：TurnMeta 子组件（展开态直接读 useTurnExpansion 共享 store）；
           foldedRows = 收纳明细行（core 单点派生），justDone = 落成瞬间一次性高亮信号 -->
      <TurnMeta
        :turn="turn"
        :is-working-turn="isWorkingTurn"
        :is-streaming="isStreaming"
        :think-count="thinkCount"
        :tool-count="toolCount"
        :elapsed="elapsed"
        :started-at="startedAt"
        :ended-at="endedAt"
        :is-live="isLive"
        :generated-tokens="generatedTokens"
        :folded-rows="foldedRows"
        :just-done="justDone"
        :turn-index="turn.index"
        :turn-key="turnStableId(turn)"
        :session-id="sessionId"
      />

      <!-- trace 容器：恒渲染（v-if 下沉单元级）。mt-[12px] = TurnMeta→首块 12px（原由首块
           py-2 顶距参与合成的节奏，块 padding 退役后归容器单值，ui-optimize-unified 决策 4）。
           行主体字号容器单点定档 text-md（15px）：行头/组头/工具行名等随容器继承，mono 摘要、
           行尾 meta 小字（耗时/时刻/计数徽标）与展开内容区在子元素显式声明各自档位。
           无 mb（demo 轮次边界唯一贡献 = 根元素 pb-5 的 20px；原 mb-1 为 TurnSummary 流内
           占位预留，TurnSummary 悬浮化后移除）。
           trace 区单元两分支（chat-flow-process-aggregate D1/D2/D5）：
           工作展开态（isWorkingTurn）渲染全部正文 + 全部聚合块（正文原生展示，聚合块按
             followedByText / turnWorking 自判进行中双窗或完成摘要）；
           折叠态/完成态/历史手动展开（!isWorkingTurn）渲染全部聚合块摘要行 + 末位正文
             （D5：每段一行保留过程存在信号，正文收敛到末位一条）。
           [动效裁决 2A] trace--just-done = 轮次落完成瞬间的换块落位标记（200ms 淡入 + 4px
           落位），仅刚落完成的轮次携带（justDone ref，见 script），历史轮不误标。
           正文块入场动效（D10，300ms 上移 5px 淡入）挂 TextRow 根（.agg-text-enter，
           aggregate-motion.css，CSS import 随挂点移入 TextRow.vue）：判据 =
           textUnitProps.entrance（回合流式 ∧ 文本未定稿，见 use-turn-trace 注释），TextRow
           setup 期捕获一次——钉挂集合只含 isStreaming 回合（useStreamingPin），流式回合不
           卸载、挂载即首次插入；等待态工作回合（ask-user/compacting：sessionActive ∧
           isLastTurn 而 isStreaming=false，不入钉挂集合）滚出视口卸载、滚回重挂时判据已翻
           false，不重放（D10：虚拟化卸载重挂载不得重放）。同块内容增长经 :key 保活 +
           v-memo 元素复用不重放；聚合块入场动效（340ms）由 ProcessAggregateBlock 自带
           （entranceClass 判据含 turnStreaming，同思路）。 -->
      <!-- [remote-use-mobile-v2 §6.2] 行主体字号随 density 切档：desktop 维持 text-md（15px，
           与原静态类同位同类，渲染串逐字一致——快照用例锁）；mobile 降 --m-text-sub（13px，
           工具行密度档），正文块由 TextRow 自行升回 --m-text-body。 -->
      <div class="trace mt-[12px] flex flex-col" :class="[traceDensityClass, { 'trace--just-done': justDone }]">
        <!-- 收纳完成通知展开明细行：展开区首行起逐条一行
             （低频查看区，行距紧凑、无横线装饰；成功弱档 dim / 失败 warn 不依赖 hover），
             其后才是本轮 trace。仅落成态展开时渲染（工作态通知还是外部行，无明细可看）。 -->
        <div
          v-if="!isWorkingTurn && foldedRows.length > 0"
          class="flex flex-col"
          data-testid="turn-folded-notices"
        >
          <div
            v-for="row in foldedRows"
            :key="`${row.type}:${row.id}`"
            class="flex items-baseline gap-2 py-[3px] text-[length:var(--text-xs)]"
            :data-testid="`turn-folded-notice-${row.type}`"
          >
            <component
              :is="FOLDED_TYPE_ICON[row.type]"
              class="size-[13px] shrink-0 self-center text-neutral-dim"
              stroke-width="1.6"
            />
            <span class="shrink-0 text-neutral-mid">{{ t(FOLDED_TYPE_WORD_KEY[row.type]) }}</span>
            <span
              class="min-w-0 flex-1 truncate font-mono text-neutral-dim"
              :title="row.fullText"
            >{{ row.summary }}</span>
            <span
              class="shrink-0 font-mono tabular-nums"
              :class="row.outcome === 'failed' ? 'text-warn' : 'text-neutral-dim'"
              data-testid="turn-folded-notice-status"
            >{{ foldedStatusText(row, t) }}</span>
            <span
              v-if="row.durationMs !== undefined"
              class="shrink-0 font-mono tabular-nums text-neutral-dim"
            >{{ formatDurationHms(row.durationMs) }}</span>
            <span class="ml-1 shrink-0 font-mono text-neutral-faint" data-testid="turn-folded-notice-id">{{ row.id }}</span>
          </div>
        </div>
        <!-- 单层 v-for 渲染 trace 区单元（正文块 + 聚合块两型）。:key 两型键空间不相交
             （use-turn-trace unitKey 注释）：正文 = flatIndex（数字）、聚合块 = 段 id seg:<n>
             （字符串，结构定位——流式段生长与新段出现均不改既有段 id，键抖 = remount = 展开
             态丢 + 滚动锚点跳，AX1）。v-memo deps 按单元类型二选一（unitMemoDeps）：
             聚合块键 = [members.length, 逐成员 ref 指纹, counts 三类步数/思考数/总耗时/失败数,
             followedByText, turnWorking]（段对象与 counts 对象每次切段都重建，禁止引用入键；
             逐项语义见 use-turn-trace unitMemoDeps 注释）；
             正文 deps = [块 ref, assistant 状态, assistant error, timestamp, textFinalized,
             isActionsAnchor]。working/streaming 按 textFinalized 逐消息派生
             （chat-flow-text-color D1，见 textUnitProps 注释）；回合落成的正文重渲染由
             assistantStatus / textFinalized 翻转承载（流式灰 → 定稿白同批切换）——正文入场
             类已一次性化（TextRow setup 捕获，见上方动效注释），落成摘类不再需要。
             [actions-anchor] 锚标记入 deps：流式追加使锚在正文块间移动时
             旧块摘插槽、新块挂插槽，漏了它被缓存的 vnode 不重渲染。sessionId 不入键：
             跨 session 时 renderKey 不同 → Turn 实例整体重建，不存在同实例跨 session 复用。 -->
        <div
          v-for="unit in traceUnits"
          :key="unitKey(unit)"
          v-memo="unitMemoDeps(unit)"
          class="trace-blk"
          :class="unit.kind === 'text' ? 'trace-blk--text' : ''"
        >
          <!-- 正文行 → TextRow 直渲染（不经壳透传）：turn-actions 锚行插槽直传，锚行开关 =
               isActionsAnchor（旧壳 $slots 判空语义的等价单点） -->
          <TextRow
            v-if="unit.kind === 'text'"
            v-bind="textUnitProps(unit.block)"
            :session-id="sessionId"
            :has-turn-actions="isActionsAnchor(unit)"
          >
            <template v-if="isActionsAnchor(unit)" #turn-actions>
              <TurnSummary
                :turn="turn"
                :session-id="sessionId"
                :last-assistant="lastAssistant"
              />
            </template>
          </TextRow>
          <!-- 过程段 → 聚合块（三态容器：进行中双窗 / 完成摘要 / 展开平铺；展开态为组件
               本地 ref——D6 不落 store 不持久化；单步详情经 open-detail 事件由抽屉接线层消费；
               turn-streaming = 入场一次性判据的「真实到达」信号，D10） -->
          <ProcessAggregateBlock
            v-else
            :segment="unit.segment"
            :turn-working="isWorkingTurn"
            :turn-streaming="isStreaming"
            :session-id="sessionId"
          />
        </div>
        <!-- streaming 光标：turn 内容区末尾独立元素（跟在所有 block 后，位置稳定不受 block 增删/折叠态影响）。
             mt-2 = 8px 光标底距（正文末块无 py 时为唯一贡献；MF-1-3 过程行恢复 py 5px 后，
             过程行末块后为 13px——光标场景以正文流式为主，按高频场景校准）。
             末位可见 block 为 running tool 时隐藏（工具自带 loader）。 -->
        <span v-if="showStreamingCursor" class="streaming-tail mt-2 ml-0.5 inline-block h-3.5 w-[7px] rounded-[1px] bg-accent align-middle animate-blink" />
      </div>

      <!-- [actions-anchor] 操作栏（TurnSummary）不渲染于 trace 尾部：挂载点 = trace 末单元且是
           正文块的 #turn-actions 插槽（上方单元 v-for 内；正文后跟了任何块则无锚、不渲染，
           防占位行夹在正文与后续块之间撑出空洞）——悬停区 = text 块行 + 固定行自身
           （TurnMeta/聚合块悬停不触发），流内固定行 = text 块下部一行（不遮正文）。 -->

      <!-- 变更集卡（W10，ADR-0024）：mt-3 = 12px 过程行节奏档（demo --blk-gap-tight） -->
      <ChangeSetCard
        v-if="changeSetFileChanges.length > 0"
        class="mt-3"
        :file-changes="changeSetFileChanges"
        :status="changeSetStatus"
        :session-id="sessionId"
      />
    </div>

    <!-- turn 内 notice（W4·D4）：仅 bash 执行记录（inline），按到达序在 turn 内部末尾渲染
         （不切断回合），复用 BashOutputBlock（既有 bash 消费点，取消按钮经 abortBash 仍可用）。
         liveOnly（stream_warn）经 [chat-flow-consistency C6] 独立成 systemNotice static 项
         （core 分组层规则 4b），由流层（ChatView static 分支）渲染，不进 turn.notices。
         wrapper 的 data-testid（turn-inline-bash / turn-inline-notice）是 W4 渲染契约——
         不落在子组件根上，避免覆盖 BashOutputBlock 自身的 bash-output-block testid。 -->
    <div
      v-for="n in turn.notices"
      :key="n.id"
      :data-testid="n.bashExecution ? 'turn-inline-bash' : 'turn-inline-notice'"
    >
      <BashOutputBlock v-if="n.bashExecution" :message="n" :session-id="sessionId" />
      <SystemNotice v-else :message="n" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bell, CheckCircle2, TriangleAlert } from '@lucide/vue'
import type { FoldedNoticeRow, MessageTurn, NotifyOutcome } from '@taiji/core/domain/chat'
import {
  countThinking,
  countToolCalls,
  deriveFoldedNoticeRows,
  deriveTurnAggregates,
  isBashCompleteNotice,
  isHandoffInstructionNotice,
  turnStableId,
} from '@taiji/core/domain/chat'
import ChangeSetCard from './ChangeSetCard.vue'
import UserBubble from './UserBubble.vue'
import TurnMeta from './TurnMeta.vue'
import TurnSummary from './TurnSummary.vue'
import TextRow from './TextRow.vue'
import ProcessAggregateBlock from './ProcessAggregateBlock.vue'
import BashOutputBlock from './BashOutputBlock.vue'
import SystemNotice from './SystemNotice.vue'
import { FOLDED_TYPE_ICON, FOLDED_TYPE_WORD_KEY, foldedStatusText } from './folded-notice'
import { useTurnElapsed } from './composables/useTurnElapsed'
import { formatDurationHms } from './format-utils'
import { useChatViewDeps, useChatDensity } from './chat-view-deps'
import { useTurnTrace } from './composables/use-turn-trace'

const props = withDefaults(
  defineProps<{
    turn: MessageTurn
    sessionId: string
    canEdit?: boolean
    isSessionActive?: boolean
    /** 本 turn 是否为列表末位 turn（D1 折叠作用域修正，streaming-trace-window design §3.3）。
     *  由列表渲染器（MessageStream）按 turn === lastRenderTurn 传入；缺省 false。 */
    isLastTurn?: boolean
  }>(),
  { isSessionActive: undefined },
)

/** 密度档（§6.2）：setup 期一次 inject（inject 禁在 computed 内调用），派生类名按档切换 */
const density = useChatDensity()

/** trace 容器行主体字号（§6.2 密度维度）：desktop 档 = 原静态类原位，mobile 13px 密度档 */
const traceDensityClass = computed(() =>
  density === 'mobile'
    ? 'text-[length:var(--m-text-sub)]'
    : 'text-[length:var(--text-md)]',
)

/** trigger 起点行文案（W4·D3）：仅 bg-notify turn 渲染，见 template 注释。 */
const { t } = useI18n()

// ── trigger 起点行聚合展示（D5，U6）─────────────────────────────────────────
// 聚合口径全部在 core（domain/chat/notify-summary 的 NotifySummary，经分组层旁挂到 turn），
// 本组件只做「数字 → 文案/色」的展示映射：图标三态 + 主文案计数 + 失败分句 + 状态点列 + 耗时 meta。

/** 状态点列上限（D5）：≤8 逐点三色；>8 只显计数（点列过密不可读） */
const MAX_NOTIFY_DOTS = 8

/** 边界行三态（D5）：失败 / 中性（未判定——旧 session 无 details / cancelled，不冒充成功）/
 *  成功。count===0（全解析失败/中性，罕见）落中性档，只渲染图标 + 从文案。 */
type NotifyTone = 'failed' | 'neutral' | 'success'

const NOTIFY_ICON: Record<NotifyTone, Component> = {
  failed: TriangleAlert,
  neutral: Bell,
  success: CheckCircle2,
}

const NOTIFY_TONE_CLASS: Record<NotifyTone, string> = {
  failed: 'text-warn',
  neutral: 'text-neutral-mid',
  success: 'text-success',
}

/** 状态点三色（D5）：成功绿 / 失败金 / 中性灰 */
const NOTIFY_DOT_CLASS: Record<NotifyOutcome, string> = {
  success: 'bg-success',
  failed: 'bg-warn',
  neutral: 'bg-neutral-dim',
}

const notifyTone = computed<NotifyTone>(() => {
  const s = props.turn.notifySummary
  if (s && s.failedCount > 0) return 'failed'
  if (s && s.neutralCount > 0) return 'neutral'
  return 'success'
})

const notifyIcon = computed(() => NOTIFY_ICON[notifyTone.value])
const notifyIconClass = computed(() => NOTIFY_TONE_CLASS[notifyTone.value])

const notifyCount = computed(() => props.turn.notifySummary?.count ?? 0)

/** 状态点列（去重后逐 record；>8 只显计数不渲染点列） */
const notifyDots = computed<NotifyOutcome[]>(() => {
  const outcomes = props.turn.notifySummary?.outcomes ?? []
  return outcomes.length > MAX_NOTIFY_DOTS ? [] : outcomes
})

/**
 * 失败分句（D5「· M 失败」）：专用键 `panel.message.turnTriggerBgNotifyFailed`（zh「{count} 失败」）。
 * 不复用聚合块的 `traceFailed`（「含 {count} 次失败」/「{count} failed」）——两者
 * 语义域不同（边界行失败分句 vs 过程段失败计数句式），复用会致 zh 呈现与设计字面不符。
 */
const notifyFailedText = computed(() => {
  const failedCount = props.turn.notifySummary?.failedCount ?? 0
  return failedCount > 0 ? t('panel.message.turnTriggerBgNotifyFailed', { count: failedCount }) : ''
})

/** 耗时 meta（D5）：去重后含 endedAt 值记录的 max(endedAt) − min(startedAt)；无值不显。
 *  格式化单点在 format-utils.formatDurationHms（补零口径 26m03s，design §3.1 样本锚定）。 */
const notifyDuration = computed(() => {
  const ms = props.turn.notifySummary?.durationMs
  return ms === undefined ? '' : formatDurationHms(ms)
})

// ── 边界行片段（g9-F2）──────────────────────────────────────────────────────
// 段序 = D5 设计样本「N 个后台任务完成 · M 失败 ●●● · 已继续处理 · 26m03s」：计数 / 失败分句 /
// 状态点列 / 从文案 / 耗时。段集合与各段前置分隔点在 script 侧单点产出（模板只留一个 v-for +
// 一个分隔点渲染位），不再由模板内 5 段 v-if 各自拼装。
// 分隔点规则（与既有 DOM 逐字一致）：失败分句与耗时前置点无条件；从文案仅在有主文案时带前导点
// （D5「无主文案时不带前导点」）；计数与点列段无前置点（点列恒紧贴前段，不单独成段群）。

/** 主文案（D3）：text-sm + --fw-mid 字重 + fg 提色 */
const NOTIFY_COUNT_CLASS = 'shrink-0 text-[length:var(--text-sm)] [font-weight:var(--fw-mid)] text-neutral-fg'
/** 失败分句（D3）：text-xs + mid 提色 */
const NOTIFY_FAILED_CLASS = 'shrink-0 text-[length:var(--text-xs)] text-neutral-mid'
/** 从文案（D3）：faint 弱化 */
const NOTIFY_CONTINUED_CLASS = 'shrink-0 text-neutral-faint'
/** 耗时 meta（D3 meta 规格，钉右）：mono + tabular-nums + dim */
const NOTIFY_DURATION_CLASS =
  'shrink-0 font-mono text-[length:var(--text-2xs)] font-medium tabular-nums text-neutral-dim'

/** 边界行片段：id 即 data-testid 后缀（turn-trigger-bgnotify-<id>；dots 段为点列容器） */
interface NotifySegment {
  id: 'count' | 'failed' | 'dots' | 'continued' | 'duration'
  /** 段前置分隔点（D5「·」） */
  sep: boolean
  /** 文本段文案（dots 段无） */
  text?: string
  /** 文本段 class（dots 段无） */
  class?: string
  /** 状态点列段（≤8 逐点三色；>8 由 notifyDots 归空 → 段不产出） */
  dots?: NotifyOutcome[]
}

/** 边界行片段数组（渲染序）：空段由 null + filter 剔除，模板不判空 */
const notifySegments = computed<NotifySegment[]>(() => {
  const count = notifyCount.value
  const failed = notifyFailedText.value
  const dots = notifyDots.value
  const duration = notifyDuration.value
  const segments: Array<NotifySegment | null> = [
    count > 0
      ? {
        id: 'count',
        sep: false,
        text: t('panel.message.turnTriggerBgNotifySummary', { count }),
        class: NOTIFY_COUNT_CLASS,
      }
      : null,
    failed ? { id: 'failed', sep: true, text: failed, class: NOTIFY_FAILED_CLASS } : null,
    dots.length > 0 ? { id: 'dots', sep: false, dots } : null,
    {
      id: 'continued',
      sep: count > 0,
      text: t('panel.message.turnTriggerBgNotifyContinued'),
      class: NOTIFY_CONTINUED_CLASS,
    },
    duration ? { id: 'duration', sep: true, text: duration, class: NOTIFY_DURATION_CLASS } : null,
  ]
  return segments.filter((seg): seg is NotifySegment => seg !== null)
})

/**
 * B9：编辑状态变化通知父组件。
 * [pin-identity D2/D7] 负载扩展为 {editing, turnKey}（turnKey = turnStableId(turn)，身份由
 * 事件源 UserBubble 携带，父组件不再持数组位置快照）；Turn 只透传不解读（模板
 * `emit('edit-state-change', $event)` 原样不动），仅 emits 类型声明随负载扩展——编排器不解析领域语义。
 */
const emit = defineEmits<{
  'edit-state-change': [{ editing: boolean; turnKey: string }]
}>()

const deps = useChatViewDeps()
const { getChangeSetStatus, isActive } = deps

/** 最后一条 assistant */
const lastAssistant = computed(() => {
  const as = props.turn.assistants
  return as[as.length - 1] ?? null
})

/**
 * isStreaming（turn 级）：文本正在流式生成。
 * sessionActive（session 级）：对话进行中（含 streaming/ask-user/subagent/compacting 等）。
 */
const isStreaming = computed(() => props.turn.isStreaming)
const sessionActive = computed(() => props.isSessionActive ?? props.turn.isStreaming)
/**
 * 本 turn 是否为「工作 turn」（D1：折叠作用域降到 turn 级）。
 * [chat-flow-consistency D2] 判定放宽为 `sessionActive ∧ (isLastTurn ∨ isStreaming)`：
 * 插话回流开出新回合后，旧回合的 assistant 在定稿收尾（回合级 message.complete）前仍是
 * streaming——旧回合保持工作展开态与计时，与新回合双工作态并存（期望形态），complete 到达
 * 两者同时落定（收起为纯派生态：isWorkingTurn 翻 false，trace 区转折叠形态——末位正文 +
 * 全部聚合块摘要行）。
 */
const isWorkingTurn = computed(
  () => sessionActive.value && ((props.isLastTurn ?? false) || isStreaming.value),
)

/**
 * trace 区渲染单元（正文块 + 聚合块两型）派生（useTurnTrace，从本组件 script 拆出——
 * script 超 vue_rules_checker 500 行绝对上限，按 split-justified 登记既定方向拆分）。
 * traceUnits / unitKey / unitMemoDeps / textUnitProps 供模板 v-for 消费；
 * lastUnitIsRunningTool 供 streaming-tail 光标显隐消费。turnStreaming getter 供正文入场
 * 一次性判据（D10，见 textUnitProps / TextRow entrance 注释）。
 */
const {
  traceUnits,
  isActionsAnchor,
  unitKey,
  unitMemoDeps,
  textUnitProps,
  lastUnitIsRunningTool,
} = useTurnTrace(() => props.turn, () => isWorkingTurn.value, () => isStreaming.value)

const thinkCount = computed(() => countThinking(props.turn))
const toolCount = computed(() => countToolCalls(props.turn))

// ── 收纳完成通知
// 明细行经 core deriveFoldedNoticeRows 单点派生（载荷解析 SSOT，渲染层零解析零回扫）；
// 工作态临时外部行只取 bash 结构化行（隐藏通知无外部行形态——工作态走 D5 聚合行）。

/** 收纳明细行（TurnMeta 折叠标签/解释卡 + 展开区明细行的共同数据源） */
const foldedRows = computed<FoldedNoticeRow[]>(() =>
  deriveFoldedNoticeRows(props.turn.foldedNotices ?? []),
)

/** 工作态临时外部行消息（bash 结构化行；settle 后本列表不再渲染） */
const workingBashNotices = computed(() =>
  (props.turn.foldedNotices ?? []).filter(isBashCompleteNotice),
)

/**
 * 整个 agent-turn 的聚合事实（core 纯函数，live 与 reload 同一公式）：
 * 起点 / 最后一次产出结束 / 已上报的真实生成 token 总量。状态行（时长、时刻区间、tokens）统一读它。
 */
const turnAggregates = computed(() => deriveTurnAggregates(props.turn))

/**
 * 本 turn 是否仍在进行（驱动秒级 tick 与「（进行中）」）= 工作 turn。
 *
 * [口径修正 2026-09] 判据从「末位 assistant 仍在 streaming」改为「turn 进行中」：
 * 整 turn 墙钟口径要求含**等待**（用户裁决「ask-user 等待也计入」），而 ask-user 等待期间
 * pi 已 agent_end（assistant 转 complete）但会话仍在进行（sessionActive=true）——旧判据下
 * 计时冻在 agent_end 那刻，作答后才跳变（定格值含等待，显示不含）。改后 live 连续、
 * 定格时直接接到权威 endedAt（无跳变）。
 * 工具执行期间两种判据同值（pi 整轮才 agent_end，assistant 保持 streaming）。
 */
const isTurnRunning = computed(() => isWorkingTurn.value)

/**
 * [动效裁决 2A] 换块落位标记（demo t.justDone 同构）：turn 从工作态落完成的一瞬置位，驱动
 * trace--just-done ——该轮各块播 200ms 淡入落位（配合单元内图标交叉切换构成换块感知）。
 * 短窗清除（900ms > 动画 200ms）：虚拟化下完成 turn 不在 keepMounted，滚出视口卸载/滚回
 * 重挂会重实例化组件（ref 归 false 不重播），但保活期间的重挂（如展开态切换 remount）会
 * 重播——落位是「落成瞬间」的一次性信号，播完即清。历史/重开轮组件初值恒 false 不误标。
 */
/** 落位标记清除窗（ms）：须 > 动画时长 200ms，播完即清（防保活期间重挂重播） */
const JUST_DONE_CLEAR_MS = 900
const justDone = ref(false)
let justDoneTimer: ReturnType<typeof setTimeout> | null = null
watch(isWorkingTurn, (working, prev) => {
  if (prev && !working) {
    justDone.value = true
    if (justDoneTimer) clearTimeout(justDoneTimer)
    justDoneTimer = setTimeout(() => { justDone.value = false }, JUST_DONE_CLEAR_MS)
  } else if (working) {
    // 复工作（streaming 重开）即撤销未播完的落位标记
    justDone.value = false
    if (justDoneTimer) { clearTimeout(justDoneTimer); justDoneTimer = null }
  }
})


/**
 * 整 turn 墙钟 live 计时 + 整 turn 生成 token 总量（聚合事实在 core deriveTurnAggregates）。
 * [chat-flow-consistency C3] onComplete collapse 接线已退役：工作回合的收起由派生完成
 * （isWorkingTurn 翻 false），手动展开态的唯一清除路径 = 磁盘重载基线接管点清分区
 * （turn-expansion 两段式契约）与 session 销毁清分区。
 */
const { elapsed, startedAt, endedAt, isLive, generatedTokens } = useTurnElapsed(
  () => turnAggregates.value,
  () => isTurnRunning.value,
)

/** 变更集卡（W10） */
const changeSetFileChanges = computed(() => lastAssistant.value?.fileChanges ?? [])
const changeSetStatus = computed(() => {
  const msg = lastAssistant.value
  if (!msg) return undefined
  return getChangeSetStatus(props.sessionId, msg.id)
})

/** 本 session 是否可编辑 */
const isSessionEditable = computed(() => isActive(props.sessionId))

/**
 * streaming-tail 光标显隐（IF2/ES1）：isStreaming && 末单元不是「进行中的工具活动」。
 * 末单元是聚合块且段内末成员为 running 工具 → 隐藏（聚合窗自带进行中信号，lastUnitIsRunningTool）；
 * 其余（末单元是正文 / 无任何单元的防御性兜底 ES1）→ 显示。
 */
const showStreamingCursor = computed(() => {
  if (!isStreaming.value) return false
  return !lastUnitIsRunningTool()
})
</script>

<style scoped>
/* 块间节奏（MF-1-3，demo workbench.css 机制同构复刻）：demo = .line py 5px（workbench.css:353，
   仅过程行挂，参与块间与两处容器边界）+ --blk-gap-tight 12 / --blk-gap 20（tokens.css:75-76）
   两档 margin；real 同构——过程行块 py 由容器选择器恢复（.trace-blk--text 正文块无 py），
   块间 margin 两档（flex 容器内不折叠，后块 margin-top 承载）：
   - 默认 12px：聚合块↔聚合块有效 5+12+5=22、聚合块→正文 5+12=17、正文→聚合块 12+5=17；
   - 正文↔正文 20px（覆盖默认，须置后）。
   容器边界由聚合块 wrapper 的 py 自动参与（单值化路线只校准块间的残留差收齐）：轮头
   （TurnMeta py-[4px]）→首聚合块 4+12+5=21、末位聚合块→轮界 5+20=25，demo 同值。
   - streaming-tail 光标非块，不命中（mt-2 对正文末块维持 8px 观感；聚合块末块后为 13px，
     光标场景以正文流式为主）。聚合块内部行（展开区成员行等）非 .trace 直子，不受本组规则影响。
   escape hatch 依据：结构选择器属 scoped 样式准许形态（项目样式三层规范）。 */
.trace > .trace-blk:not(.trace-blk--text) {
  padding-top: 5px;
  padding-bottom: 5px;
}
.trace > .trace-blk + .trace-blk {
  margin-top: 12px;
}
.trace > .trace-blk--text + .trace-blk--text {
  margin-top: 20px;
}

/* ── 块动效（demo chat spec 动效裁决 2A + chat-flow-process-aggregate D10）──
   正文块入场（D10，300ms 上移 5px 淡入）挂 TextRow 根（.agg-text-enter 类，形态在
   process-aggregate/aggregate-motion.css——keyframes 全局注入，scoped 编译器哈希改名后
   跨组件不可命中；CSS import 随挂点移入 TextRow.vue）。判据 = textUnitProps.entrance
   （回合流式 ∧ 文本未定稿，TextRow setup 期捕获一次）：钉挂集合只含 isStreaming 回合
   （useStreamingPin streamingTurnIdxs）——流式回合不卸载、挂载即首插；等待态工作回合
   （ask-user/compacting，isStreaming=false 不入集合）滚出视口卸载、滚回重挂时判据已翻
   false，不重放。聚合块入场（340ms）/ 聚合窗挂载浮现（300ms）由 ProcessAggregateBlock
   族自管（entranceClass 判据含 turnStreaming，同思路）。
   trace--just-done（2A）：落完成瞬间各块 200ms 淡入 + 4px 落位（出半 = 单元内图标交叉
   切换），仅刚落完成轮次携带；落位动画在本 wrapper、正文入场动画在 TextRow 根（不同元素，
   入场已播毕停常态帧），900ms 清除后归无动画，不构成入场重放。
   --ease-out-soft 令牌待 tokens 域补登记（style.css 现缺），fallback --ease-out 就近生效。
   prefers-reduced-motion 由 style.css 全局兜底（duration 0.01ms + iteration 1
   → 瞬达终态静态）。escape hatch：animation + 状态类组合，Tailwind 无法表达。 */
.trace--just-done .trace-blk {
  animation: tblk-swap-in 200ms var(--ease-out-soft, var(--ease-out));
}
@keyframes tblk-swap-in {
  from { opacity: 0; transform: translateY(4px); }
}
</style>
