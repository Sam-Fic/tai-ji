/**
 * 聚合块组件族 mount 测试（chat-flow-process-aggregate U2，fixture 驱动——不接线 Turn，
 * 编排切换在 u-wiring 单元；段对象按 core ProcessSegment 契约手工构造，切段纯函数的
 * 口径对账归 U1 单测）。
 *
 * 覆盖（任务书目标 3）：
 * - 三态翻转（事件驱动：followedByText / turnWorking，零 timer——ADR-0190）
 * - RL1：进行中占位不随步数增长（1→8→26 注入断言根元素 scrollHeight）
 * - RL4：三处失败计数对账（摘要行 = 组头 = 聚合条，口径 = core counts 单源）
 * - V8 组件侧：窗口可见性纯派生（延迟挂载 / 无空态 / 纯思考段 / 工具起始）
 * - RL6：入场动效一次性（初次挂载在场 / 卸载重挂不重放 / memo 失效重渲染不重放）
 * - 键稳定性：50 次流式增量无重挂载（段 id 结构定位，AX1）
 * - 展开平铺与交互（aria-expanded / 组头纯标题 / 单步行信息位 / 重试标记不渲染）
 * - 悬停浮层（tooltip / pointer-events:none / 滚动 / Esc / 点击消失）
 *
 * 运行：node scripts/run-domain-tests.mjs chat（域触发收集；本文件落 chat 切片 glob）。
 */
import enPanel from '../../../locale/en-US/panel';
import zhPanel from '../../../locale/zh-CN/panel';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type {
  FlatBlock,
  ProcessSegment,
  ProcessSegmentCounts,
  ProcessSegmentUnit,
  ProcessToolGroup,
  RunGroupBase,
} from '@taiji/core/domain/chat';
import type { ThinkingBlock, ToolCall } from '@taiji/shared';
import ProcessAggregateBlock from '../ProcessAggregateBlock.vue';
import { mockChatProvide } from './helpers';
import type { VueWrapper } from '@vue/test-utils';

// i18n：字典模式（键命中出文案，计数插值可断言）——vitest.setup.ts 的 key-echo 全局 mock
// 被 vi.mock 工厂覆盖（Turn.test.ts 同范式）。zh 口径文案 = locale 文件真实值来源。
vi.mock('vue-i18n', async () => {
  const { i18nMock } = await import('../../../__tests__/helpers/i18n-mock');
  return i18nMock({
    'panel.message.aggProcessLabel': '过程',
    'panel.message.aggGroupRunning': '进行中',
    'panel.message.aggRowFailed': '失败',
    'panel.message.aggStatusDone': '已完成',
    'panel.message.traceFailed': '含 {count} 次失败',
    'panel.message.runGroupExplore': '探索',
    'panel.message.runGroupEdit': '改动',
    'panel.message.runGroupExec': '执行命令',
    'panel.message.runGroupSteps': '{count} 步',
    'panel.message.thinkingBlock': '思考',
    'panel.message.thinkingDuration': '持续了 {duration}',
    'panel.message.expand': '展开',
    'panel.message.collapse': '收起',
    'panel.message.copy': '复制',
    'panel.message.expandReasoning': '展开思考',
    'panel.message.collapseReasoning': '收起思考',
  });
});

// ─── fixture 构造（段对象按 core process-segment.ts 契约手工声明；计数字段是测试作者
//     写定的事实声明，不在测试内复刻切段算法——切段口径归 U1 单测对账） ───────────

let seq = 0;
function nextId(prefix: string): string {
  return `${prefix}-${++seq}`;
}

let flatSeq = 0;
function makeThinkingFlat(
  content: string,
  over: Partial<ThinkingBlock> = {},
): FlatBlock {
  const th: ThinkingBlock = {
    id: nextId('th'),
    content,
    collapsed: true,
    startTime: 1000,
    endTime: 4000,
    ...over,
  };
  return {
    assistantId: 'a1',
    assistantStatus: 'streaming',
    block: { kind: 'thinking', ref: th },
    flatIndex: flatSeq++,
  };
}

function makeToolFlat(over: Partial<ToolCall> = {}): FlatBlock {
  const tc: ToolCall = {
    id: nextId('tc'),
    toolName: 'read',
    input: { path: '/tmp/foo.txt' },
    status: 'completed',
    startTime: 1000,
    endTime: 5000,
    ...over,
  };
  return {
    assistantId: 'a1',
    assistantStatus: 'streaming',
    block: { kind: 'tool', ref: tc },
    flatIndex: flatSeq++,
  };
}

function makeGraphFlat(over: Partial<ToolCall> = {}): FlatBlock {
  return makeToolFlat({ toolName: 'subagent_task', ...over });
}

function emptyCounts(): ProcessSegmentCounts {
  return {
    categoryCounts: { explore: 0, edit: 0, exec: 0 },
    thinkingCount: 0,
    totalDurationMs: 0,
    failedCount: 0,
  };
}

function makeCounts(over: Partial<ProcessSegmentCounts> = {}): ProcessSegmentCounts {
  return { ...emptyCounts(), ...over };
}

function makeGroup(
  base: RunGroupBase,
  members: FlatBlock[],
  over: Partial<Omit<ProcessToolGroup, 'base' | 'members'>> = {},
): ProcessToolGroup {
  return { base, members, durationMs: 0, failedCount: 0, hasRunning: false, ...over };
}

/** 段构造：units 缺省 = 全成员独立成行（类型表外形态，合法段）；组形态经 over 显式传 */
function makeSegment(
  members: FlatBlock[],
  over: Partial<ProcessSegment> = {},
): ProcessSegment {
  return {
    id: over.id ?? `seg:${members[0]?.flatIndex ?? 0}`,
    members,
    groups: over.groups ?? [],
    units:
      over.units ??
      (members.map((b) => ({ kind: 'member', block: b })) as ProcessSegmentUnit[]),
    counts: over.counts ?? emptyCounts(),
    followedByText: over.followedByText ?? false,
  };
}

/** 探索段：stepCount 个 read 成员归一个 explore 组（真实链路同类型连续归组的形态） */
function makeExploreSegment(stepCount: number, over: Partial<ProcessSegment> = {}): ProcessSegment {
  const members = Array.from({ length: stepCount }, () => makeToolFlat({ toolName: 'read' }));
  const group = makeGroup('explore', members, { durationMs: stepCount * 100 });
  return makeSegment(members, {
    groups: [group],
    units: [{ kind: 'group', group }],
    counts: makeCounts({ categoryCounts: { explore: stepCount, edit: 0, exec: 0 }, totalDurationMs: stepCount * 100 }),
    ...over,
  });
}

/** mount 聚合块：turnStreaming 缺省 true（流式起步形态；等待态重挂形态显式传 false） */
function mountAgg(segment: ProcessSegment, turnWorking = true, turnStreaming = true): VueWrapper {
  return mount(ProcessAggregateBlock, {
    props: { segment, turnWorking, turnStreaming, sessionId: 'sess-agg-test' },
    global: {
      provide: mockChatProvide(),
      stubs: { MarkdownRenderer: { props: ['content', 'variant'], template: '<div class="stub-md" />' } },
    },
  });
}

/** 展开完成态段（点击摘要行）并返回 wrapper */
async function mountExpanded(segment: ProcessSegment): Promise<VueWrapper> {
  const wrapper = mountAgg(segment, false);
  await wrapper.find('[data-testid="agg-summary-row"]').trigger('click');
  return wrapper;
}

// ─── 三态翻转（事件驱动） ─────────────────────────────────────────

describe('process-aggregate-block tri-state (event-driven)', () => {
  it('进行中（turnWorking ∧ !followedByText）→ 摘要行 live 变体在场 + 12 行窗口默认展开（窗口 12 行裁决）', () => {
    const wrapper = mountAgg(makeSegment([makeThinkingFlat('推理中')], { followedByText: false }), true);
    // 卡头恒在场（展开交互的可见入口；live 变体 = 呼吸弧行首）
    expect(wrapper.find('[data-testid="agg-summary-row"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="agg-summary-live-loader"]').exists()).toBe(true);
    // 进行中默认展开窗口（旧的「双窗」已由窗口取代）
    expect(wrapper.find('[data-testid="agg-tape"]').exists()).toBe(true);
  });

  it('进行中点击卡头 → 窗口收起成一行；再点展开', async () => {
    const wrapper = mountAgg(makeSegment([makeThinkingFlat('推理中')], { followedByText: false }), true);
    await wrapper.find('[data-testid="agg-summary-row"]').trigger('click');
    expect(wrapper.find('[data-testid="agg-tape"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="agg-expanded"]').exists()).toBe(false);
    await wrapper.find('[data-testid="agg-summary-row"]').trigger('click');
    expect(wrapper.find('[data-testid="agg-tape"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="agg-expanded"]').exists()).toBe(true);
  });

  it('回合工作态落下（turnWorking 翻 false）→ live 变体切完成形态（呼吸弧摘除、双窗收成摘要行；展开态 ref 共用不跳变）', async () => {
    const wrapper = mountAgg(makeSegment([makeThinkingFlat('推理')], { followedByText: false }), true);
    expect(wrapper.find('[data-testid="agg-summary-row"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="agg-summary-live-loader"]').exists()).toBe(true);
    await wrapper.setProps({ turnWorking: false });
    expect(wrapper.find('[data-testid="agg-summary-row"]').exists()).toBe(true);
    // 完成形态：呼吸弧摘除（Layers 静态字形回归）
    expect(wrapper.find('[data-testid="agg-summary-live-loader"]').exists()).toBe(false);
    // 落成且用户没点过 → 自动收成一行（窗口摘除）
    expect(wrapper.find('[data-testid="agg-tape"]').exists()).toBe(false);
  });

  it('纯思考段摘要：零分类不渲染（v-if 省略，真机剧本 agg-tf-1 抓的 v-show 残留缺陷），只列思考计数', () => {
    const wrapper = mountAgg(
      makeSegment([makeThinkingFlat('纯推理')], {
        followedByText: true,
        counts: {
          categoryCounts: { explore: 0, edit: 0, exec: 0 },
          thinkingCount: 1,
          totalDurationMs: 3000,
          failedCount: 0,
        },
      }),
      true,
    );
    const row = wrapper.find('[data-testid="agg-summary-row"]');
    expect(row.exists()).toBe(true);
    expect(row.findAll('[data-testid^="agg-summary-cat-"]').length).toBe(0);
    expect(wrapper.find('[data-testid="agg-summary-thinking"]').exists()).toBe(true);
  });

  it('段后出现 text（followedByText=true）→ 段已封闭，回合仍在进行也显摘要行', async () => {
    const wrapper = mountAgg(makeSegment([makeThinkingFlat('推理')], { followedByText: true }), true);
    expect(wrapper.find('[data-testid="agg-summary-row"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="agg-tape"]').exists()).toBe(false);
  });

  it('摘要行 aria-expanded 随展开/收起同步（真实 button 承载展开行为）', async () => {
    const wrapper = mountAgg(makeSegment([makeToolFlat()], { followedByText: true }), false);
    const row = wrapper.find('[data-testid="agg-summary-row"]');
    expect(row.attributes('aria-expanded')).toBe('false');
    await row.trigger('click');
    expect(wrapper.find('[data-testid="agg-summary-row"]').attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('[data-testid="agg-expanded"]').exists()).toBe(true);
    await wrapper.find('[data-testid="agg-summary-row"]').trigger('click');
    expect(wrapper.find('[data-testid="agg-expanded"]').exists()).toBe(false);
  });
});

// ─── 窗口高度封顶（12 行 × 24px）──────────────────────────────────

describe('process-aggregate-block window cap: 12 rows × 24px', () => {
  it('窗口的 max-height = 12 行 × 24px（CSS 令牌承载），行数增长不改变高度档', async () => {
    const wrapper = mountAgg(makeExploreSegment(1, { followedByText: false, id: 'seg:0' }), true);
    const scroll = wrapper.find('[data-testid="agg-tape-scroll"]');
    expect(scroll.exists()).toBe(true);
    expect(scroll.classes()).toEqual(
      expect.arrayContaining(['max-h-[calc(var(--proc-tape-rows)*var(--proc-tape-row-h))]', 'overflow-y-auto']),
    );
    await wrapper.setProps({ segment: makeExploreSegment(8, { followedByText: false, id: 'seg:0' }) });
    await wrapper.setProps({ segment: makeExploreSegment(26, { followedByText: false, id: 'seg:0' }) });
    // 高度档不随步数变化（下限仍由 CSS 上限承载；真实像素由真机 AC-H12 断言）
    expect(wrapper.find('[data-testid="agg-tape-scroll"]').classes()).toEqual(
      expect.arrayContaining(['max-h-[calc(var(--proc-tape-rows)*var(--proc-tape-row-h))]']),
    );
    // 行数增长 = 段成员增量（窗口内容随步骤增加）
    const rows = wrapper.findAll('[data-testid="agg-expanded"] > [data-testid^="agg-row-"]');
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ─── RL4：三处失败计数对账 ───────────────────────────────────────

/** 含 1 次 bash 失败的段（组 failedCount=1，段 counts.failedCount=1——同一事实两处声明） */
function makeFailedSegment(over: Partial<ProcessSegment> = {}): ProcessSegment {
  const ok = makeToolFlat({ toolName: 'bash', input: { command: 'pnpm test' }, status: 'completed' });
  const bad = makeToolFlat({
    toolName: 'bash',
    input: { command: 'pnpm lint' },
    status: 'error',
    error: 'exit 1',
    endTime: 3200,
  });
  const group = makeGroup('exec', [ok, bad], { durationMs: 2200, failedCount: 1 });
  return makeSegment([ok, bad], {
    groups: [group],
    units: [{ kind: 'group', group }],
    counts: makeCounts({ categoryCounts: { explore: 0, edit: 0, exec: 2 }, failedCount: 1, totalDurationMs: 2200 }),
    ...over,
  });
}

describe('process-aggregate-block RL4: failure count agrees across summary / group head / live strip', () => {
  it('进行中窗口即时报「含 1 次失败」（组头在窗口内，无需点开）', () => {
    const wrapper = mountAgg(makeFailedSegment(), true);
    expect(wrapper.find('[data-testid="agg-tape"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('含 1 次失败');
  });

  it('完成态摘要行「含 1 次失败」；展开态组头「含 1 次失败」——同一 fixture 三处恒等', async () => {
    const segment = makeFailedSegment();
    // 完成态：摘要行
    const done = mountAgg({ ...segment, followedByText: true }, false);
    expect(done.find('[data-testid="agg-summary-failed"]').text()).toBe('含 1 次失败');
    // 展开态：组头
    const expanded = await mountExpanded({ ...segment, followedByText: true });
    expect(expanded.find('[data-testid="agg-group-failed"]').text()).toBe('含 1 次失败');
    // 口径恒等：三处文本同串（段级 counts 与组级 failedCount 声明同值）
    expect(expanded.find('[data-testid="agg-summary-failed"]').text()).toBe(
      done.find('[data-testid="agg-summary-failed"]').text(),
    );
  });
});

// ─── 窗口内容随段成员增量（纯派生）──────────────────────────────

describe('process-aggregate-block window content: derived from segment units', () => {
  it('纯思考段：窗口里只有思考行，无工具行；追加思考后行数增长', async () => {
    const wrapper = mountAgg(makeSegment([makeThinkingFlat('先想后做')], { followedByText: false }), true);
    expect(wrapper.find('[data-testid="agg-expanded"]').text()).toContain('先想后做');
    expect(wrapper.find('[data-testid="agg-group-head"]').exists()).toBe(false);
    await wrapper.setProps({
      segment: makeSegment([makeThinkingFlat('先想后做'), makeThinkingFlat('第二段推理')], { followedByText: false }),
    });
    const rows = wrapper.findAll('[data-testid="agg-expanded"] > [data-testid^="agg-row-"]');
    expect(rows.length).toBe(2);
    expect(wrapper.text()).not.toContain('等待工具调用');
  });

  it('首个工具步骤出现 → 窗口里出现工具行（无空态占位、无 timer）', () => {
    const wrapper = mountAgg(makeSegment([makeToolFlat()], { followedByText: false }), true);
    expect(wrapper.find('[data-testid="agg-expanded"]').exists()).toBe(true);
    const rows = wrapper.findAll('[data-testid="agg-expanded"] > [data-testid^="agg-row-"]');
    expect(rows.length).toBe(1);
    expect(wrapper.text()).not.toContain('等待工具调用');
  });
});

// ─── RL6：入场动效一次性 ─────────────────────────────────────────

describe('process-aggregate-block RL6: entrance animation plays once across remount', () => {
  it('初次挂载（进行中、单成员增量起点）→ 入场动画类在场', () => {
    const wrapper = mountAgg(makeExploreSegment(1, { followedByText: false }), true);
    expect(wrapper.find('[data-testid="process-aggregate"]').classes()).toContain('agg-enter');
  });

  it('卸载重挂载（virtua 回收形态：完成态全量渲染）→ 入场动画不在场', () => {
    const segment = makeExploreSegment(8, { followedByText: true });
    const first = mountAgg(segment, false);
    first.unmount();
    const second = mountAgg(segment, false);
    expect(second.find('[data-testid="process-aggregate"]').classes()).not.toContain('agg-enter');
    second.unmount();
  });

  it('等待态工作回合重挂（virtua 回收形态：turnWorking=true 而回合不流式——ask-user/compacting 不入钉挂集合，滚出卸载滚回重挂）→ 入场动画不在场', () => {
    const wrapper = mountAgg(makeSegment([makeThinkingFlat('等待前思考')], { followedByText: false }), true, false);
    expect(wrapper.find('[data-testid="process-aggregate"]').classes()).not.toContain('agg-enter');
  });

  it('同实例增量重渲染（memo 失效形态）→ class 恒定 + 元素引用恒定（animation 不重启）', async () => {
    const wrapper = mountAgg(makeExploreSegment(1, { followedByText: false }), true);
    const rootEl = wrapper.find('[data-testid="process-aggregate"]').element as HTMLElement;
    const before = rootEl.className;
    await wrapper.setProps({ segment: makeExploreSegment(2, { followedByText: false }) });
    expect((wrapper.find('[data-testid="process-aggregate"]').element as HTMLElement).className).toBe(before);
    expect(wrapper.find('[data-testid="process-aggregate"]').element).toBe(rootEl);
  });
});

// ─── 键稳定性：50 次流式增量无重挂载 ─────────────────────────────

describe('process-aggregate-block key stability: 50 streaming increments without remount', () => {
  it(':key=segment.id 的列表 harness 下 50 次增量追加，组件 DOM 元素引用恒定（AX1 段 id 结构定位）', async () => {
    const Harness = defineComponent({
      props: {
        segments: { type: Array, required: true },
        turnWorking: { type: Boolean, required: true },
      },
      setup(compProps) {
        return () =>
          h(
            'div',
            (compProps.segments as ProcessSegment[]).map((s) =>
              h(ProcessAggregateBlock, { key: s.id, segment: s, turnWorking: compProps.turnWorking }),
            ),
          );
      },
    });
    const initial = makeExploreSegment(1, { followedByText: false, id: 'seg:0' });
    const wrapper = mount(Harness, {
      props: { segments: [initial], turnWorking: true },
      global: {
        provide: mockChatProvide(),
        stubs: { MarkdownRenderer: { props: ['content', 'variant'], template: '<div class="stub-md" />' } },
      },
    });
    let el = wrapper.find('[data-testid="process-aggregate"]').element;
    for (let step = 2; step <= 50; step++) {
      const grown = makeExploreSegment(step, { followedByText: false, id: 'seg:0' });
      // 段 id 在流式生长中稳定（core 契约：派生自段首位置，成员追加不改 id）
      expect(grown.id).toBe('seg:0');
      await wrapper.setProps({ segments: [grown] });
      if (step % 10 === 0) {
        const current = wrapper.find('[data-testid="process-aggregate"]').element;
        expect(current).toBe(el);
      }
    }
    expect(wrapper.findAll('[data-testid="process-aggregate"]').length).toBe(1);
  });
});

// ─── 展开平铺与交互 ──────────────────────────────────────────────

describe('process-aggregate-block expanded body (flat units)', () => {
  /** 交替形态段：思考 + 探索组 + 思考 + 独立 bash 行（真实顺序平铺的验证输入） */
  function makeMixedSegment(): ProcessSegment {
    const th1 = makeThinkingFlat('先读');
    const exploreMembers = [makeToolFlat({ toolName: 'read' }), makeToolFlat({ toolName: 'grep' })];
    const exploreGroup = makeGroup('explore', exploreMembers, { durationMs: 800 });
    const th2 = makeThinkingFlat('再跑');
    const bashRow = makeToolFlat({ toolName: 'bash', input: { command: 'pnpm test' } });
    return makeSegment(
      [th1, ...exploreMembers, th2, bashRow],
      {
        groups: [exploreGroup],
        units: [
          { kind: 'member', block: th1 },
          { kind: 'group', group: exploreGroup },
          { kind: 'member', block: th2 },
          { kind: 'member', block: bashRow },
        ],
        counts: makeCounts({
          categoryCounts: { explore: 2, edit: 0, exec: 1 },
          thinkingCount: 2,
          totalDurationMs: 1300,
        }),
        followedByText: true,
      },
    );
  }

  it('units 按真实顺序平铺：思考行 / 工具组 / 思考行 / 独立行交替（GL3 无二次折叠）', async () => {
    const wrapper = await mountExpanded(makeMixedSegment());
    const rows = wrapper.findAll('[data-testid="agg-expanded"] > [data-testid^="agg-row-"]');
    expect(rows.length).toBe(4);
    expect(rows[0].find('.trace-think').exists()).toBe(true);
    expect(rows[1].find('[data-testid="agg-tool-group"]').exists()).toBe(true);
    expect(rows[2].find('.trace-think').exists()).toBe(true);
    expect(rows[3].find('[data-testid="agg-tool-row"]').exists()).toBe(true);
  });

  it('组头是纯标题（div、无 role=button、无 tabindex——组级无折叠入口，D1 裁决）', async () => {
    const wrapper = await mountExpanded(makeMixedSegment());
    const head = wrapper.find('[data-testid="agg-group-head"]');
    expect(head.element.tagName).toBe('DIV');
    expect(head.attributes('role')).toBeUndefined();
    expect(head.attributes('tabindex')).toBeUndefined();
    expect(head.text()).toContain('探索');
    expect(head.text()).toContain('2 步');
  });

  it('单步行显示工具名 / 参数 / diff 摘要 / 耗时 / 失败标记；无「更早 N 步」入口', async () => {
    const segment = makeFailedSegment({ followedByText: true });
    segment.units = [...segment.units];
    const wrapper = await mountExpanded(segment);
    const okRow = wrapper.findAll('[data-testid="agg-tool-row"]')[0];
    expect(okRow.text()).toContain('bash');
    expect(okRow.find('[data-testid="agg-tool-param"]').text()).toBe('pnpm test');
    expect(okRow.find('[data-testid="agg-tool-duration"]').text()).not.toBe('');
    const failRow = wrapper.findAll('[data-testid="agg-tool-row"]')[1];
    expect(failRow.find('[data-testid="agg-tool-failed"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('更早');
    expect(wrapper.text()).not.toContain('重试');
  });

  it('edit 行 diff 摘要（+N −N，core diffStat 口径）', async () => {
    const edit = makeToolFlat({ toolName: 'edit', input: { path: '/tmp/a.ts' }, diffStat: { additions: 12, deletions: 8 } });
    const wrapper = await mountExpanded(makeSegment([edit], { followedByText: true }));
    expect(wrapper.find('[data-testid="agg-tool-diffstat"]').text()).toBe('+12 −8');
  });

  it('agentgraph 成员独立成行（类型表外安全降级 = 原样成行，AX4）', async () => {
    const graph = makeGraphFlat({ status: 'completed' });
    const wrapper = await mountExpanded(makeSegment([graph], { followedByText: true }));
    expect(wrapper.find('[data-testid="agg-tool-row"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="agg-tool-row"]').text()).toContain('subagent_task');
  });

  it('counts 全 0 的摘要行只显主词（分类 / 思考 / 耗时 / 失败按 0 省略）', () => {
    const wrapper = mountAgg(makeSegment([makeToolFlat({ toolName: 'custom_tool' })], { followedByText: true }), false);
    const row = wrapper.find('[data-testid="agg-summary-row"]');
    expect(row.text()).toContain('过程');
    expect(row.find('[data-testid="agg-summary-failed"]').exists()).toBe(false);
    expect(row.find('[data-testid="agg-summary-duration"]').exists()).toBe(false);
    expect(row.find('[data-testid="agg-summary-thinking"]').exists()).toBe(false);
  });
});

// ─── 悬停浮层 ────────────────────────────────────────────────────

describe('process-aggregate-block hover card', () => {
  it('悬停单步行 → 浮层在场：role=tooltip、pointer-events:none、参数与输出（≤8 行）', async () => {
    const tool = makeToolFlat({
      input: { path: '/tmp/long/path/x.ts' },
      output: Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n'),
    });
    const wrapper = await mountExpanded(makeSegment([tool], { followedByText: true }));
    await wrapper.find('[data-testid="agg-tool-row"]').trigger('mouseenter');
    const card = wrapper.find('[data-testid="agg-hover-card"]');
    expect(card.exists()).toBe(true);
    expect(card.attributes('role')).toBe('tooltip');
    expect(card.classes()).toContain('pointer-events-none');
    expect(card.find('[data-testid="agg-hover-param"]').text()).toContain('/tmp/long/path/x.ts');
    const outputText = card.find('[data-testid="agg-hover-output"]').text();
    expect(outputText).toContain('line8');
    expect(outputText).not.toContain('line9');
    await wrapper.find('[data-testid="agg-tool-row"]').trigger('mouseleave');
    expect(wrapper.find('[data-testid="agg-hover-card"]').exists()).toBe(false);
  });

  it('窗口滚动 / Esc / 行点击三路都收浮层（开抽屉时消失路径 = 点击）', async () => {
    const wrapper = await mountExpanded(makeSegment([makeToolFlat({ input: { pattern: 'p' } })], { followedByText: true }));
    const row = () => wrapper.find('[data-testid="agg-tool-row"]');
    // 滚动（capture 监听 window scroll——dispatchEvent 冒泡形态触发）
    await row().trigger('mouseenter');
    expect(wrapper.find('[data-testid="agg-hover-card"]').exists()).toBe(true);
    window.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(wrapper.find('[data-testid="agg-hover-card"]').exists()).toBe(false);
    // Esc
    await row().trigger('mouseenter');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(wrapper.find('[data-testid="agg-hover-card"]').exists()).toBe(false);
    // 点击（开抽屉触发点）：抽屉经 teleport 打开在 body（U4 接线——open-detail 事件在
    // 展开区本地消费、不再冒泡到本组件顶层，u-wiring 的 Turn 挂载点不监听该事件），
    // 浮层收起；断言后 Esc 关抽屉防 teleport 残留污染后续用例
    await row().trigger('mouseenter');
    await row().trigger('click');
    expect(document.body.querySelector('[data-testid="tool-detail-drawer"]')).not.toBeNull();
    expect(wrapper.find('[data-testid="agg-hover-card"]').exists()).toBe(false);
    // unmount 连带移除 teleport 内容（Esc 卸载经关闭动画延迟、DOM 卸载时机不可靠——
    // 开/关与 Esc emit 的完整交互契约由 process-aggregate-drawer.test.ts 承载）
    wrapper.unmount();
    expect(document.body.querySelector('[data-testid="tool-detail-drawer"]')).toBeNull();
  });

  it('失败行输出兜底 error 文本（displayContent 同口径）', async () => {
    const bad = makeToolFlat({ toolName: 'bash', status: 'error', error: 'ENOENT', output: '' });
    const wrapper = await mountExpanded(makeSegment([bad], { followedByText: true }));
    await wrapper.find('[data-testid="agg-tool-row"]').trigger('mouseenter');
    expect(wrapper.find('[data-testid="agg-hover-output"]').text()).toContain('ENOENT');
  });
});

// ─── i18n：zh / en 双侧键对齐 ────────────────────────────────────

describe('process-aggregate i18n keys (zh + en)', () => {
  const AGG_KEYS = ['aggProcessLabel', 'aggGroupRunning', 'aggRowFailed', 'aggStatusDone'] as const;

  it('新键 zh / en 双侧登记（message 段）；重试标记键不登记（D4 裁决）', () => {
  const zh = (zhPanel as unknown as { message: Record<string, string> }).message;
  const en = (enPanel as unknown as { message: Record<string, string> }).message;
    for (const key of AGG_KEYS) {
      expect(zh[key], `zh 缺键 ${key}`).toBeTruthy();
      expect(en[key], `en 缺键 ${key}`).toBeTruthy();
    }
    expect(zh['aggRowRetry']).toBeUndefined();
    expect(en['aggRowRetry']).toBeUndefined();
  });
});
