/**
 * 模型切换行的回合归属判定（chat-flow-v2 G9，规则 4c 判定机制；message-turns 分组主循环消费）。
 * 独立成模块：message-turns 有效行数贴近 max-lines 上限，新增规则的判定机制整体落位此处。
 */
import type { Message } from '@taiji/shared'
import { COMPLETE_NOTIFY_CUSTOM_TYPES } from '@taiji/shared'
import type { TurnGroup } from './message-turns'

/** 隐藏完成通知判定（D3 边界触发器）：display===false 且 customType 属完成通知 SSOT 常量集
 *  （与 apply-entry 覆写 / registry 同一常量源——分组侧不引入第二份判定）。
 *  规则 4c 的向后看判定同样消费它（隐藏完成通知边界 = 回合已终），判定单点随本模块共享。 */
export function isHiddenCompleteNotify(msg: Message): boolean {
  return (
    msg.display === false &&
    msg.customType !== undefined &&
    COMPLETE_NOTIFY_CUSTOM_TYPES.has(msg.customType)
  )
}

/** 回合是否仍在进行（规则 4c 判定用）：末位 assistant 流式中或带 running 工具调用 = 推进中；
 *  user 锚待首回复按「等待延续」读作进行中；空 trigger 组与纯隐藏通知组非进行中。 */
function isTurnGroupActive(group: TurnGroup): boolean {
  if (group.user !== null && group.assistants.length === 0) return true
  const last = group.assistants[group.assistants.length - 1]
  if (!last) return false
  return last.status === 'streaming' || (last.toolCalls?.some((tc) => tc.status === 'running') ?? false)
}

/** 模型切换行的回合归属判定（规则 4c，G9）：向后看下一条非透明消息——assistant = 切换落在
 *  回合中段；连续切换行相互跳过（同属中段）；user / 可见 system / 隐藏完成通知边界 = 回合
 *  已终。数组末尾窗口（切换之后还没有新消息）按回合活动信号判定。纯读取：全量与增量两条
 *  分组路径从任意下标重跑都读到同一未来，判定恒一致。 */
export function isMidTurnSwitch(messages: Message[], index: number, current: TurnGroup): boolean {
  for (let j = index + 1; j < messages.length; j++) {
    const next = messages[j]
    if (next.role === 'assistant') return true
    if (next.modelSwitch !== undefined) continue
    if (next.role !== 'user' && next.display === false && !isHiddenCompleteNotify(next)) continue
    return false
  }
  return isTurnGroupActive(current)
}
