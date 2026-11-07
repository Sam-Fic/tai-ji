/**
 * 时间窗维度常量跨实现对拍（对照验证，differential testing；provider-aggregation F1-25
 * 收敛防线）：坐标契约「7 行（周一..周日）× 48 列（半小时格）」在两侧求值路径独立生效——
 * UI 侧（@taiji/ui route-preview：DAY_COUNT / SLOT_COUNT 为 shared 别名、格宽由
 * SLOT_COUNT 推导）与 pi 扩展侧（router.ts：格宽由 TIME_WINDOW_SLOTS_PER_DAY 推导、
 * 落格模数由 TIME_WINDOW_DAYS 派生）的 slot 分钟数 / 每天格数 / 每周天数必须同值，
 * 且同 shared 单源（packages/shared aggregation.ts TIME_WINDOW 常量）。任一侧维度
 * 换算漂移（格宽手抄、取模天数、列坐标错位）对拍必红。
 *
 * 形态先例 = 同目录 route-preview-differential.test.ts（跨包相对路径 import 的对拍
 * 装配；宿主选 runtime 同该先例）。本文件补**坐标维度**半边，求值语义半边由该先例
 * 承载。探测方式 = 导出纯函数行为探测（不触两侧私有常量）：UI 侧经 fmtSlot /
 * fmtSlotRange 读数推导格宽与全天覆盖；扩展侧经 isWithinTimeWindow 边界时刻落格
 * 推导格宽、末格与 ISO 行序。
 */
import { describe, expect, it } from 'vitest'
import type { AggregationMember, AggregationRoute, AggregationTimeWindowTable } from '@taiji/shared'
import { TIME_WINDOW_DAYS, TIME_WINDOW_SLOTS_PER_DAY } from '@taiji/shared'
import {
  blankWindowTable,
  DAY_COUNT,
  fmtSlot,
  fmtSlotRange,
  SLOT_COUNT,
} from '../../../../../packages/ui/src/features/settings/provider/route-preview.ts'
import { isWithinTimeWindow } from '../../../../../extensions/universal/provider-aggregation/src/router.ts'

/** 固定探测墙钟（2026-05-11 周一 / 2026-05-17 周日；边界时刻取格缝两侧）。 */
const MON_1029 = new Date(2026, 4, 11, 10, 29) // 当日 629 分 → 格 20
const MON_1030 = new Date(2026, 4, 11, 10, 30) // 当日 630 分 → 格 21（格缝右侧）
const MON_2359 = new Date(2026, 4, 11, 23, 59) // 当日 1439 分 → 末格
const SUN_1029 = new Date(2026, 4, 17, 10, 29) // 同周周日同一时刻

/** `HH:mm` 解析回当日分钟数（fmtSlot 读数换算的测试侧钟表锚）。 */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

function windowMemberOf(table: AggregationTimeWindowTable): AggregationMember {
  return { id: 'm1', providerId: 'prov-a', modelId: 'm-a', type: 'window', window: table }
}

function routeOf(member: AggregationMember): AggregationRoute {
  return {
    id: 'route-x',
    name: 'Route X',
    modelId: 'route-x',
    enabled: true,
    mode: 'advanced',
    specials: [],
    members: [member],
  }
}

/**
 * 扩展侧落格探测：表内唯一 true 格（day, slot）是否覆盖给定墙钟。表由 UI 侧
 * blankWindowTable 按 shared 坐标契约构造（7 行 × SLOT_COUNT 列）——扩展落格公式
 * 必须在同一坐标系上命中同格，维度不一致即交叉断言红灯。
 */
function extCovers(day: number, slot: number, now: Date): boolean {
  const table = blankWindowTable()
  table[day]![slot] = true
  return isWithinTimeWindow(routeOf(windowMemberOf(table)), windowMemberOf(table), now)
}

describe('时间窗维度常量跨实现对拍（UI ⇔ 扩展 ⇔ shared 单源三方同值）', () => {
  it('slot 分钟数：UI 格宽读数 30 ⇔ 扩展 629/630 分边界落相邻格', () => {
    // UI：格 1 起点 − 格 0 起点 = 格宽（fmtSlot 读数推导），且同 shared 单源推导值。
    const uiSlotWidthMinutes = minutesOf(fmtSlot(1)) - minutesOf(fmtSlot(0))
    expect(uiSlotWidthMinutes).toBe(30)
    expect(uiSlotWidthMinutes).toBe((24 * 60) / TIME_WINDOW_SLOTS_PER_DAY)
    // 扩展：629 分落格 20、630 分落格 21（边界 630 = 21 × 30）——格宽同为 30。
    expect(extCovers(0, 20, MON_1029)).toBe(true)
    expect(extCovers(0, 21, MON_1029)).toBe(false)
    expect(extCovers(0, 20, MON_1030)).toBe(false)
    expect(extCovers(0, 21, MON_1030)).toBe(true)
  })

  it('每天格数：UI SLOT_COUNT=48 且末格封口 24:00 ⇔ 扩展 1439 分落末格 47', () => {
    // UI：SLOT_COUNT 是 shared TIME_WINDOW_SLOTS_PER_DAY 别名；末格区间封口 '24:00'
    // → SLOT_COUNT × 格宽 = 一天分钟数（格数覆盖全天）。
    expect(SLOT_COUNT).toBe(TIME_WINDOW_SLOTS_PER_DAY)
    expect(minutesOf(fmtSlot(SLOT_COUNT - 1))).toBe((SLOT_COUNT - 1) * 30)
    expect(fmtSlotRange(SLOT_COUNT - 1)).toBe('23:30–24:00')
    // 扩展：当日 1439 分落末格 SLOT_COUNT−1、不落前一格——列坐标同 shared。
    expect(extCovers(0, SLOT_COUNT - 1, MON_2359)).toBe(true)
    expect(extCovers(0, SLOT_COUNT - 2, MON_2359)).toBe(false)
  })

  it('每周天数：UI DAY_COUNT=7 ⇔ 扩展周一落行 0、周日落行 6（ISO 序）', () => {
    expect(DAY_COUNT).toBe(TIME_WINDOW_DAYS)
    // 扩展：同一列坐标下周一格与周日格按各自墙钟命中、交叉不命中——行数与 ISO 行序同 shared。
    expect(extCovers(0, 20, MON_1029)).toBe(true)
    expect(extCovers(6, 20, SUN_1029)).toBe(true)
    expect(extCovers(6, 20, MON_1029)).toBe(false)
    expect(extCovers(0, 20, SUN_1029)).toBe(false)
  })
})
