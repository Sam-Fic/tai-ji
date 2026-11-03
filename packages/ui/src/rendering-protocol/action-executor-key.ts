/**
 * action-bar 执行器注入 key —— rendering-protocol 交互原语与宿主壳层的注入契约
 * （设计 AP-3：GuiComponent 协议首个交互原语）。
 *
 * action-bar 的点击统一走宿主命令链（commandRegistry.execute → WS
 * plugin.executeCommand，设计 §3.3 D2——只复用既有命令链，不新增回调通道）。
 * commandRegistry 权威在 core，由壳层 provide 真实实现（对齐 PRIMITIVE_RENDER_KEY /
 * VIEW_HOST_SOURCE_KEY 既有注入范式）；@taiji/ui 只定义此最小结构接口，core/renderer
 * 侧实现结构兼容即可——本文件不 import core 类型，避免 ui→core 反向依赖
 * （设计 §5.2 检查点 3 裁决）。
 */
import type { InjectionKey } from 'vue'

/** 操作参数——与 GuiComponentProps['action-bar'] items[].args 同形（只许标量，防注入结构化 payload） */
export type ActionArgs = Record<string, string | number | boolean>

/** 最小结构接口：壳层命令执行器的兼容范围（core commandRegistry.execute 结构兼容此形状）。
 *  execute 返回 boolean | void | Promise<boolean | void>：
 *  - 同步 boolean：命中 true；命令缺失（壳层命令表查无此 id）false 供原语本地置灰——
 *    tray-panel-interact §4.2 RL2「误指/未注册 commandId 不静默失效」，先例 = HeaderActionsHost
 *    E3（useExtensionHostBridge HEADER_ACTIONS_SOURCE_KEY.executeCommand 同款「缺失也走
 *    execute（内部 emit ERR6 出声）+ 返回 false 供组件置灰」）。
 *  - Promise 回执（壳层 action-bar 执行器形态）：resolve 的布尔同同步语义；reject = RPC
 *    失败（WS 断连等）——confirm 两段式在途态的 settle 信号（§3.3 D5）：reject 或 resolve
 *    false 时原语把相位从 in-flight 复位 idle 并走置灰通道，防按钮永久滞留转圈+禁用。
 *  - void：执行器不回报可用性（如 settings 挂载位的插件 fork 直发执行器），置灰半边不
 *    生效、行为不变。 */
export interface ActionExecutor {
  execute(id: string, args?: ActionArgs): boolean | void | Promise<boolean | void>
}

export const ACTION_EXECUTOR_KEY: InjectionKey<ActionExecutor> = Symbol('action-executor')
