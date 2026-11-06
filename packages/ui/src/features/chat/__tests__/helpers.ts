/**
 * chat 组件测试 helper（w6 chat-ui-and-shell T7）。
 *
 * 提供 mock ChatViewDeps 的 provide 对象构造，供迁移的行为型测试 mount 组件时注入
 * （替代 renderer 旧 vi.mock(store/composable) 模式）；以及行组件测试的共享 stub /
 * ToolCall fixture / mount 编排（ToolRow 形态测试公共样板）。
 */
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import { vi } from 'vitest'
import { ChatViewDepsKey } from '@taiji/ui'
import type { ChatViewDeps } from '@taiji/ui'
import type { ToolCall } from '@taiji/shared'
import ToolRow from '../ToolRow.vue'

/** 构造 mock ChatViewDeps（所有字段 vi.fn 或合理默认，零真 store；ChatViewDeps 全字段必填） */
export function createMockDeps(overrides: Partial<ChatViewDeps> = {}): ChatViewDeps {
  return {
    isActive: () => false,
    isHandingOff: () => false,
    getChangeSetStatus: () => undefined,
    isExpanded: () => false,
    // [D3] submitEdit 双发锁默认放行（不互斥）；互斥用例经 overrides 注入
    isPendingSend: () => false,

    sessionCwdOf: () => undefined,
    // ai-voice-tts §5.1：朗读按钮默认可渲染（idle 态）；「未 provide 不渲染」用例经
    // overrides 显式传 undefined 注销
    onSpeak: vi.fn(),
    speakStateOf: () => 'idle',

    toggleExpand: vi.fn(),
    // [chat-flow-consistency C3] ChatViewDeps.collapse 已随 Turn.vue onComplete 接线退役删除
    abortBash: vi.fn(),
    editAndResend: vi.fn(),
    // [U5 消息撤回 D6] 撤回统一单入口（路由判定在 core，mock 默认 spy——用例直取断言）
    onRevokeMessage: vi.fn(),
    onForkAsk: vi.fn(),
    onHandoffAsk: vi.fn(),
    openDrawer: vi.fn(),
    openBrowser: vi.fn(),
    onFileClick: vi.fn(),
    loadFileCandidates: vi.fn().mockResolvedValue([]),
    renderMarkdown: vi.fn().mockResolvedValue([]),
    renderMarkdownIncremental: vi.fn().mockResolvedValue({
      prefixSegments: [],
      tailSegments: [],
      stableBoundary: 0,
      mode: 'incremental',
      cache: { boundary: 0, prefixText: '', prefixSegments: [], nextSegId: 0 },
    }),
    renderMermaid: vi.fn().mockResolvedValue({ svg: '' }),
    ...overrides,
  }
}

/** 构造 provide 对象（ChatViewDepsKey → mock），供 mount global.provide 用 */
export function mockChatProvide(overrides: Partial<ChatViewDeps> = {}) {
  return {
    [ChatViewDepsKey as symbol]: createMockDeps(overrides),
  }
}

// ── 行组件测试共享 stub（挂载即暴露 data-testid，可检测组件是否尝试渲染）──

export const GuiStub = {
  name: 'GuiComponentRenderer',
  props: { component: { type: Object, default: undefined } },
  setup() {
    return () => h('div', { 'data-testid': 'gui-renderer-stub' })
  },
}

export const AnsiStub = {
  name: 'AnsiText',
  props: { content: { type: String, default: '' } },
  setup() {
    return () => h('div', { 'data-testid': 'ansi-text-stub' })
  },
}

export const MdStub = {
  name: 'MarkdownRenderer',
  props: { content: { type: String, default: '' }, variant: { type: String, default: undefined } },
  setup() {
    return () => h('div', { class: 'stub-md-render' })
  },
}

/** 默认 ToolCall fixture（read 工具 completed 形态）；workflow 等专属 fixture 经 over 覆写构造。 */
export function makeToolCall(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    toolName: 'read',
    input: { path: '/tmp/foo.txt' },
    status: 'completed',
    startTime: 1000,
    endTime: 5000,
    ...over,
  }
}

/** mount 工具行（stub 掉 Gui/Ansi/Md 子渲染，隔离 header/交互断言）。
 *  extraProps：追加 props 覆写（如 sessionId——workflow chips 反查按块归属 session 分区）。
 *  provideOverrides：ChatViewDeps 字段覆写（如 toolDetailRenderer——tool-detail-rich 路由）。
 *  provide mockChatProvide：ToolRow 经 useChatViewDeps inject 消费壳依赖（ui-optimize-unified
 *  N1 文件 chip 起），直接 mount 必须注入 mock deps——与 Turn 链测试的 provide 口径一致。
 *  [chat-flow-process-aggregate U3] Block 转发壳退役后本编排直挂 ToolRow（行组件本体保留、
 *  被聚合块复用）：旧壳根的 .trace-blk 类名契约与 block-tool-<id> testid 挂点随壳退役
 *  （类名归 Turn.vue 单元 wrapper；聚合块内成员行形态由 SegmentToolRow 承载）。 */
export function mountToolRow(
  tool: ToolCall,
  extraProps: Record<string, unknown> = {},
  provideOverrides: Partial<ChatViewDeps> = {},
) {
  return mount(ToolRow, {
    props: { tool, ...extraProps },
    global: {
      provide: mockChatProvide(provideOverrides),
      stubs: {
        GuiComponentRenderer: GuiStub,
        AnsiText: AnsiStub,
        MarkdownRenderer: MdStub,
      },
    },
  })
}
