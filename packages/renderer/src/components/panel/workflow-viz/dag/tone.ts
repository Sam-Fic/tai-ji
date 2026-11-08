/**
 * workflow-viz DAG 状态点着色的单一事实源（workflow-overlay-refine D4；2026-11
 * 方案 C 收窄：卡片本体中性化后只剩 dot 着色）。
 *
 * 实例行（WorkflowVizDagNode）与状态图例（WorkflowVizOverlay 壳内图例段）共同消费
 * dotTone——「图例 = DAG 的图例」的同源性由类名同源构造性保证：图例 dot 直接取
 * dotTone 的返回类，实例行小点同源取色，不平行手写第二份色值。未触发态（0 实例
 * 占位卡 dot 与图例「未触发」条目）单源导出 UNTRIGGERED_DOT_TONE，同规则构造性
 * 同源。方案 C 退役了节点整卡着色（nodeTone）：调用点卡片恒中性，状态语义归实例
 * 行 dot。
 */

import type { WorkflowVizDagNodeStatus, WorkflowVizDagStopTone } from './types'

/**
 * dot 静态色类（无脉冲）——图例七态与节点 dot 的共同颜色事实源。
 * 每个状态恰好返回一个 fill 类（pending 显式返回中性灰，消费方不得再挂基础 fill
 * 类）：Tailwind 同属性任意值工具类按值字母序发射（accent < danger < neutral-dim
 * < success < warn），「基础类 + tone 类」并存时 neutral-dim 后发覆盖 tone 色——
 * 单 fill 类消竞争（D3 剧本实锤的 running/failed dot 渲染中性灰根因）。
 * 停止叠加（stopTone）优先于七态：run 停止时在途节点不脉冲、着色随 run 级形态。
 */
export function dotTone(status: WorkflowVizDagNodeStatus, stopTone?: WorkflowVizDagStopTone): string {
  if (stopTone === 'neutral') return 'fill-[var(--neutral-dim)]'
  if (stopTone === 'failed') return 'fill-[var(--danger)]'
  switch (status) {
    case 'running':
      return 'fill-[var(--accent)]'
    case 'done':
      return 'fill-[var(--success)]'
    case 'failed':
      return 'fill-[var(--danger)]'
    case 'retrying':
      return 'fill-[var(--warn)]'
    case 'cancelled':
    case 'pending':
    case 'skipped':
    default:
      return 'fill-[var(--neutral-dim)]'
  }
}

/**
 * 未触发态 dot 类（占位卡无实例状态，不进 dotTone 七态词表）：0 实例占位卡 dot
 * 与状态图例「未触发」条目共同消费——中性色 + opacity-60 淡化，与实例行实色 dot
 * 区分（「未触发 = 无实例」的视觉语义）。
 */
export const UNTRIGGERED_DOT_TONE = 'fill-[var(--neutral-dim)] opacity-60'
