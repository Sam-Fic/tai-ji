/**
 * system-storage 单测：getSystem 分区字号默认档位一次性迁移。
 *
 * 背景：启动链（settings-lifecycle.init → setSystem → updateSystem）把合并默认后的
 * 完整对象幂等写回 storage，存量实例的 fontScales.sidebar='large'（旧默认）已落盘，
 * 仅改 DEFAULT_FONT_SCALES 对它们不生效——getSystem 读侧执行一次性迁移：
 * 未标记 + sidebar 等于旧默认 large → 回落新默认并置位 fontScalesDefaultMigrated；
 * 置位后显式选择（含 large）不再被改写。
 */
import { describe, it, expect } from 'vitest'
import { getSystem, SYSTEM_KEY } from '../system-storage'
import { InMemoryStorage } from './helpers/in-memory-storage'

function seed(fontScales: unknown, migrated?: boolean): InMemoryStorage {
  const storage = new InMemoryStorage()
  const payload: Record<string, unknown> = { theme: 'dark', fontScales }
  if (migrated !== undefined) payload.fontScalesDefaultMigrated = migrated
  storage.set(SYSTEM_KEY, JSON.stringify(payload))
  return storage
}

/** 任意 payload 落盘（字体逐字段形状检查用例用；其余字段给一个可辨识的合法值）。 */
function seedPayload(payload: Record<string, unknown>): InMemoryStorage {
  const storage = new InMemoryStorage()
  storage.set(SYSTEM_KEY, JSON.stringify({ theme: 'light', locale: 'en-US', ...payload }))
  return storage
}

describe('getSystem 分区字号默认档位一次性迁移', () => {
  it('未标记 + sidebar=large（旧默认写回形态）→ 回落新默认 medium + 置位迁移标记', async () => {
    const storage = seed({ sidebar: 'large', chat: 'medium', drawer: 'medium' })
    const system = await getSystem(storage)
    expect(system.fontScales?.sidebar).toBe('medium')
    expect(system.fontScalesDefaultMigrated).toBe(true)
  })

  it('未标记 + sidebar=small（显式非旧默认档）→ 档位原样保留 + 置位迁移标记', async () => {
    const storage = seed({ sidebar: 'small', chat: 'xlarge' })
    const system = await getSystem(storage)
    expect(system.fontScales?.sidebar).toBe('small')
    expect(system.fontScales?.chat).toBe('xlarge')
    expect(system.fontScalesDefaultMigrated).toBe(true)
  })

  it('已标记 + sidebar=large（迁移后显式选回）→ 原样保留（尊重显式选择，一次性语义）', async () => {
    const storage = seed({ sidebar: 'large', chat: 'medium', drawer: 'medium' }, true)
    const system = await getSystem(storage)
    expect(system.fontScales?.sidebar).toBe('large')
    expect(system.fontScalesDefaultMigrated).toBe(true)
  })

  it('无存量数据 → 新默认生效（sidebar=medium，chat=small，drawer=medium）', async () => {
    const system = await getSystem(new InMemoryStorage())
    expect(system.fontScales?.sidebar).toBe('medium')
    expect(system.fontScales?.chat).toBe('small') // chat-font-default-small：chat 默认小档
    expect(system.fontScales?.drawer).toBe('medium')
  })

  it('迁移标记不落盘前重复读取幂等（读侧迁移不写 storage，写入仍由启动链负责）', async () => {
    const storage = seed({ sidebar: 'large', chat: 'medium', drawer: 'medium' })
    await getSystem(storage)
    const second = await getSystem(storage)
    // 幂等 = 重复读稳定回落同一档位（读侧无累进状态），且全程不写 storage（落盘归启动链）
    expect(second.fontScales?.sidebar).toBe('medium')
    expect(storage.peek(SYSTEM_KEY)).not.toContain('fontScalesDefaultMigrated')
  })
})

describe('getSystem 字体槽位逐字段形状检查（font-system D2）', () => {
  it('两槽位都是字符串 → 原样保留', async () => {
    const system = await getSystem(seedPayload({ fonts: { ui: 'Maple Mono', mono: 'Fira Code' } }))
    expect(system.fonts).toEqual({ ui: 'Maple Mono', mono: 'Fira Code' })
  })

  it('ui 坏（非字符串）→ 只丢 ui，mono 保留', async () => {
    const system = await getSystem(seedPayload({ fonts: { ui: 42, mono: 'Fira Code' } }))
    expect(system.fonts).toEqual({ mono: 'Fira Code' })
    // 坏字段不污染其余设置（逐字段语义，不整体回退）
    expect(system.theme).toBe('light')
    expect(system.locale).toBe('en-US')
  })

  it('mono 坏（非字符串）→ 只丢 mono，ui 保留', async () => {
    const system = await getSystem(seedPayload({ fonts: { ui: 'Maple Mono', mono: null } }))
    expect(system.fonts).toEqual({ ui: 'Maple Mono' })
  })

  it('两槽位都坏 → fonts 整体丢弃（等价未选择，回落构建期字体栈）', async () => {
    const system = await getSystem(seedPayload({ fonts: { ui: [], mono: {} } }))
    expect(system.fonts).toBeUndefined()
    expect('fonts' in system).toBe(false)
  })

  it('fonts 整个不是对象（字符串 / 数组 / null）→ 回落到默认（无 fonts）', async () => {
    for (const bad of ['Maple Mono', ['ui'], null]) {
      const system = await getSystem(seedPayload({ fonts: bad }))
      expect(system.fonts, `fonts=${JSON.stringify(bad)}`).toBeUndefined()
    }
  })

  it('坏字体字段不阻止形状检查外的既有字段生效（主题/字号/迁移标记照常）', async () => {
    const system = await getSystem(seedPayload({
      fonts: 'not-an-object',
      fontSize: 'large',
      fontScales: { sidebar: 'small' },
    }))
    expect(system.fonts).toBeUndefined()
    expect(system.fontSize).toBe('large')
    expect(system.fontScales?.sidebar).toBe('small')
    expect(system.fontScalesDefaultMigrated).toBe(true)
  })
})
