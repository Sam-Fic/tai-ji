/**
 * route-editor-ops 纯函数单测（卡片重排数据层）。
 *
 * moveCardToSlot 是卡片拖拽排序（HTML5 DnD drop 落点 → 插入槽位）的数据层落点：
 * DOM 事件模拟覆盖交互接线（model-route-page.test.ts），本文件锁定数组重排语义矩阵
 * （全部第①档同步逻辑：函数进、返回值出，零 mount / 零 IO）。
 */
import { describe, it, expect } from 'vitest'
import { moveCardToSlot } from '../provider/route-editor-ops'

describe('moveCardToSlot 卡片重排数据层（拖拽排序落点）', () => {
  it('后方卡片前移：from=3 slot=1 → 摘除后插到下标 1', () => {
    expect(moveCardToSlot(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('前方卡片后移：from=0 slot=3（末槽位）→ 摘除后插到尾部', () => {
    expect(moveCardToSlot(['a', 'b', 'c'], 0, 3)).toEqual(['b', 'c', 'a'])
  })

  it('相邻槽位无位移：slot === from 与 slot === from + 1 都返回等值新数组', () => {
    const list = ['a', 'b', 'c']
    const same = moveCardToSlot(list, 1, 1)
    const next = moveCardToSlot(list, 1, 2)
    expect(same).toEqual(list)
    expect(next).toEqual(list)
    // 返回新数组（不共享引用）——调用方可据内容等值跳过标脏，数据层不就地改
    expect(same).not.toBe(list)
    expect(next).not.toBe(list)
    expect(list).toEqual(['a', 'b', 'c'])
  })

  it('越界 from / slot 返回原样副本（不抛错）', () => {
    const list = ['a', 'b']
    expect(moveCardToSlot(list, 5, 0)).toEqual(list)
    expect(moveCardToSlot(list, 0, 9)).toEqual(list)
    expect(moveCardToSlot(list, -1, 1)).toEqual(list)
  })

  it('空数组安全', () => {
    expect(moveCardToSlot([], 0, 0)).toEqual([])
  })

  it('不修改入参数组（纯函数）', () => {
    const list = ['a', 'b', 'c', 'd']
    moveCardToSlot(list, 3, 0)
    expect(list).toEqual(['a', 'b', 'c', 'd'])
  })
})
