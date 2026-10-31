/**
 * data-source-registry —— 数据源登记表 schema（startup-readiness-and-current-state
 * 设计 §7.4 数据源登记层，u-m0 M0 契约期 M0-3）。
 *
 * 本文件落「本设计侧形状」：DataSourceDescriptor 形状 SSOT + 数据源读载体的公共
 * 字段形态（加载态）。桌面 4 处拉取 watch + settings 域 + 移动端三件套统一迁入同一
 * 登记表的实装随 u-m2（quota presets 首个数据源接入）与 u-m3（主体搬迁）波次交付；
 * M0 契约期先行定形——后续波次编译消费本形状，防各波次自造描述符漂移。
 *
 * 消费端三段式（设计 D1）：连接后拉 readiness 快照并触发已满足项 → 订阅能力边沿
 * （runtime.readinessChanged）→ 重连后重拉。调度器输入两类：能力边沿（契约三件套）
 * + 本地边沿（焦点会话 store 变更、路由可见性 hooks——core 内现成事件源，只登记
 * 不新造）。
 *
 * 机器看守（设计 §7.4，随 u-m3 落地）：登记对账测试（两壳的进程级拉取点全在登记表
 * 内，删一条登记即红）+ lint 规则（启动路径禁止直连 RPC 请求层）。
 */
import type { RemoteCapability } from '@taiji/shared'

/**
 * 数据源描述符（设计 §7.4 形状块逐字段）：登记表范围 = 拉取型数据源
 * （`load: () => Promise<void>` 语义）。桌面与移动共用同一登记表（core 层）。
 */
export interface DataSourceDescriptor { // oe-exempt:20261031:framework:数据源登记表跨壳契约（core 单源 ports 层，桌面与移动共用，实现随 u-m2/u-m3 波次接线）
  /** 登记条目唯一 id（对账测试与 lint 的看守锚点）。 */
  id: string
  /** 触发作用域：global（连接边沿触发）/ session（焦点会话边沿触发）。 */
  scope: 'global' | 'session'
  /**
   * 触发依赖集合：跨进程能力（shared RemoteCapability 四值）+ 本地依赖维度
   * （focusedSession = 焦点会话 store 变更、viewOpen = 路由可见性——core 内现成
   * 事件源，在 core 组合、不进协议包，设计 §7.1）。
   */
  requires: (RemoteCapability | 'focusedSession' | 'viewOpen')[]
  /** 拉取动作（仅拉取型；本设计不登记发送型/本地镜像/世代混合数据源——D6 不采用栏）。 */
  load: () => Promise<void>
  /** 失败语义：拉取失败保留旧数据并告警（不静默吞错、不阻断其余数据源）。 */
  failure: 'keep-old-warn'
  /** 仅启动编排真要等的（如 project 域）——whenSettled 消费点（connection-edge-sync
   * 首次落定 promise 既有机制）需要显式声明。 */
  settle?: boolean
}

/**
 * 数据源读载体公共字段形态（M0 契约：登记表各数据源的拉取 reply / 推送快照的公共
 * 尾字段）。独立成形状的原因：不同数据源的载荷主体各异，公共尾字段是消费端统一
 * 判据（骨架屏 / 旧修订拒绝）的挂载点。
 *
 * - batchInProgress：加载态字段（D10：「加载态」概念以登记表 schema 字段形态进重写
 *   M0 契约，不随过渡期实现退场消失）——true = 本载荷可能是部分数据，消费端对无旧
 *   数据的分区显示骨架屏（SC7/SC8/SC9 消费语义见设计 §2.5 / D10）。字段名沿用
 *   U1-lite 已交付的协议 additive 字段（protocol.ts session.subagents /
 *   session.workflows 两帧 + 读 RPC 响应，缺省 false）——过渡期协议形态与 M0 契约
 *   形状同词表；终态由执行域重写快照通道承载同名字段语义，过渡期实现随重写 M5
 *   退场、本形状保留。
 * - revision / generation：修订号 + 世代（重写设计 D5 快照契约词汇：快照与增量消息
 *   都带 revision = 最后事件 seq 与 generation，renderer 只接受更高 revision）。
 *   **只引用不实现**：修订号契约权威方 = 执行域重写（契约归属表「修订号 + 世代快照
 *   机制词汇 → 权威方本设计（重写）D5」），其类型落点 = 重写侧 u-m0 的
 *   packages/shared/src/execution 契约（另一分支，本波不 import、不落字段）——本侧
 *   登记表消费点（拉取回执与推送快照的旧修订拒绝）在重写契约并入后由 u-m2/u-m3
 *   波次接线，届时本注释替换为对该契约的类型引用。
 */
export interface DataSourcePayloadFields { // oe-exempt:20261031:framework:数据源载荷公共尾字段跨壳契约（core 单源 ports 层，消费端统一判据挂载点，实现随 u-m2/u-m3 波次接线）
  batchInProgress?: boolean
}
