/**
 * 静默辅助提示呈现测试（pi-stall-detection U4，RL5 提示呈现用例——D0 约定文件名，
 * testCommand 确定性载体）。
 *
 * 覆盖（三视角，用户可见 DOM 断言优先——设计 D3 呈现形态：温和状态行文案、非红色警告、
 * 非弹窗；判定权在 runtime，renderer 只呈现 T_hint 到达广播）：
 * - 提示到达（active=true）→ ActivityStrip stall 行出现，文案含静默分钟数（zh-CN）；
 * - 帧流恢复清除（active=false 清除边沿）→ 行消失（「帧流恢复即清除」）；
 * - 判死后清除（active=false 同一清除边沿——V9 e 出现/清除两时序的呈现半边）；
 * - 分钟数换算（silentMs → 分钟，向上归 1）；
 * - 无提示态 → 行不渲染；
 * - i18n key 完整（zh/en 双侧定义——ActivityStrip.test.ts P5 同款判据）。
 *
 * 数据源 = core chat store stallHint 分区（session.stall_hint state topic 帧驱动，useChat
 * handler 写入——本测试直写 store 分区驱动组件，与生产写入路径同一写口 setStallHint）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stall-hint.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import zhPanel from '@taiji/ui/locale/zh-CN/panel'
import enPanel from '@taiji/ui/locale/en-US/panel'
import ActivityStrip from '@/components/panel/message-stream/ActivityStrip.vue'
import { useChatStore } from '@/stores/chat'

const SID = 'sess-stall-hint'

/** 组件黑盒 mount（真实 pinia chat store 驱动 stallHint 分区——与 ActivityStrip.test.ts
 *  mountStrip 同款：pinia 先 setActivePinia 再传入 app plugins，store 取用与组件挂载同
 *  pinia 实例——先取后挂会拿到 beforeEach 的旧实例，写入不传导，ActivityStrip.test.ts
 *  集成节同款陷阱注释）。返回 { wrapper, chat } 供写入驱动。 */
async function mountStrip(): Promise<{ wrapper: ReturnType<typeof mount>; chat: ReturnType<typeof useChatStore> }> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const chat = useChatStore()
  const wrapper = mount(ActivityStrip, {
    props: { sessionId: SID },
    global: { plugins: [pinia] },
  })
  await nextTick()
  return { wrapper, chat }
}

/** 写提示分区并触发响应式更新（生产写口 = core useChat handler 调 setStallHint）。 */
async function setHint(chat: ReturnType<typeof useChatStore>, payload: { active: boolean; silentMs: number }): Promise<void> {
  chat.setStallHint(SID, { sessionId: SID, active: payload.active, silentMs: payload.silentMs, phase: 'tool' })
  await nextTick()
}

beforeEach(() => {
  // 逐用例新 pinia：防跨用例 store 实例串扰（上例 mount 后 activePinia 停在其 pinia 上，
  // 无本钩子时后续用例 useChatStore() 会绑到上例实例——分区残留即假阳/假阴）。
  setActivePinia(createPinia())
})

describe('stall hint 呈现（RL5 提示呈现）', () => {
  it('提示到达（active=true）→ stall 行出现，温和文案含静默分钟数', async () => {
    const { wrapper, chat } = await mountStrip()
    // 先断言无提示态行不渲染（v-if=false 注释占位节点）
    expect(wrapper.find('[data-testid="activity-strip-row-stall"]').exists()).toBe(false)
    await setHint(chat, { active: true, silentMs: 14 * 60_000 })
    const row = wrapper.find('[data-testid="activity-strip-row-stall"]')
    expect(row.exists()).toBe(true)
    // 用户可见文案（zh-CN：温和状态行「已静默 N 分钟，可点停止或继续等待」——设计 D3 呈现形态）
    const text = wrapper.find('[data-testid="activity-strip-text-stall"]')
    expect(text.exists()).toBe(true)
    expect(text.text()).toContain('已静默 14 分钟')
    expect(text.text()).toContain('可点停止或继续等待')
    wrapper.unmount()
  })

  it('三点等待形态（无呼吸弧 spinner）——静默等待非活动指示，与 waiting 行同视觉族', async () => {
    const { wrapper, chat } = await mountStrip()
    await setHint(chat, { active: true, silentMs: 60_000 })
    const row = wrapper.find('[data-testid="activity-strip-row-stall"]')
    expect(row.find('[data-testid="activity-strip-dots-stall"]').exists()).toBe(true)
    expect(row.findAll('[data-testid="activity-strip-dots-stall"] i')).toHaveLength(3)
    expect(row.find('.animate-loader-spin').exists()).toBe(false)
    wrapper.unmount()
  })

  it('分钟数换算：silentMs=840000 → 14 分钟；向上归 1（61s → 1 分钟，不出现「0 分钟」）', async () => {
    const { wrapper, chat } = await mountStrip()
    await setHint(chat, { active: true, silentMs: 840_000 })
    expect(wrapper.find('[data-testid="activity-strip-text-stall"]').text()).toContain('已静默 14 分钟')
    await setHint(chat, { active: true, silentMs: 61_000 })
    expect(wrapper.find('[data-testid="activity-strip-text-stall"]').text()).toContain('已静默 1 分钟')
    wrapper.unmount()
  })

  it('帧流恢复清除（active=false 清除边沿）→ 行消失；再到达再出现（边沿幂等）', async () => {
    const { wrapper, chat } = await mountStrip()
    await setHint(chat, { active: true, silentMs: 840_000 })
    expect(wrapper.find('[data-testid="activity-strip-row-stall"]').exists()).toBe(true)
    // 清除边沿（帧流恢复 / 判死触发 / 回合收尾同一 active=false 形态）
    await setHint(chat, { active: false, silentMs: 0 })
    expect(wrapper.find('[data-testid="activity-strip-row-stall"]').exists()).toBe(false)
    // 再次到达（下一轮静默过 T_hint）：行随 last-value 帧再现
    await setHint(chat, { active: true, silentMs: 900_000 })
    expect(wrapper.find('[data-testid="activity-strip-row-stall"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('store 读口对称：getStallHint 无提示 = undefined、active=false 删除分区记录（不残留旧值）', async () => {
    const chat = useChatStore()
    expect(chat.getStallHint(SID)).toBeUndefined()
    await setHint(chat, { active: true, silentMs: 840_000 })
    expect(chat.getStallHint(SID)?.active).toBe(true)
    await setHint(chat, { active: false, silentMs: 0 })
    expect(chat.getStallHint(SID)).toBeUndefined()
  })
})

describe('stall hint i18n key 完整（zh/en 双侧）', () => {
  it('panel.message.stallHint 在 zh/en locale 均定义（P5 判据——locale 纯对象可安全导入）', () => {
    const zhMessage = zhPanel.message as Record<string, unknown>
    const enMessage = enPanel.message as Record<string, unknown>
    expect(zhMessage.stallHint, 'panel.message.stallHint 缺 zh-CN 定义').toEqual(expect.any(String))
    expect(enMessage.stallHint, 'panel.message.stallHint 缺 en-US 定义').toEqual(expect.any(String))
    expect(zhMessage.stallHint).toContain('{minutes}')
    expect(enMessage.stallHint).toContain('{minutes}')
  })
})
