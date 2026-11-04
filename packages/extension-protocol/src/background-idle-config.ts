/**
 * base-tool-enhance 空闲转后台阈值（idleBackgroundSec）跨层契约（跨层 SSOT）。
 *
 * 契约两端：
 *  - 配置权威侧：@zhushanwen/pi-base-tool-enhance extension（config.ts
 *    loadBaseToolEnhanceConfig；键级 warn/文案属扩展配置系统 UX，留扩展侧——
 *    本文件只承载值语义，anomaly 字段供扩展侧生成 warn）。
 *  - 消费侧 1：包装脚本 --idle 参数（bash 文本协议，只接受非负整数秒——小数放行会
 *    使配置层值空间与执行层可接受值空间出现差集，差集配置下全部前台命令 exit 64，
 *    故归一化收敛为整数且 floor 后 <1 抬到 1：--idle 0 语义是「首轮监控即转后台」，
 *    不是亚秒阈值的合理近似）。
 *  - 单一消费方：包装脚本 --idle 参数。禁止在别处镜像副本实现同一归一化
 *    （历史事故：两侧手抄归一化无机器绑定，超大值 clamp 语义漂移）。
 *
 * 显式 null 与 undefined 分流的理由：undefined = 未配置（默认开启 600）；显式 null =
 * 用户关闭（透传 null，下游据此回落 pi 官方原生无限等待）；坏值 = 回退默认而非关闭
 * （显式 null 是唯一关闭通道，坏值不得意外关闭机制）。
 */

/** setTimeout 延迟上限（int32 ms）：秒数换算毫秒后的 clamp 上限。 */
const INT32_MAX_MS = 2_147_483_647;
const MS_PER_SECOND = 1000;

/**
 * idleBackgroundSec 默认值（秒）：正常工具调用分钟级、编译静默常见 1-5 分钟，10 分钟
 * 输出静默在交互会话已是强异常信号。
 */
export const DEFAULT_IDLE_BACKGROUND_SEC = 600;

/**
 * 归一化结果：value 恒为可直接消费的生效值（合法输入 = 非负整数秒；显式 null = null；
 * undefined/坏值 = 默认 600）；anomaly 非空表示输入异常（调用方据此落 warn，不据此
 * 改值——value 已是回退/截断后的生效值）。
 *  - 'invalid'：类型错/负数/0/非有限 → 回退默认（value = DEFAULT_IDLE_BACKGROUND_SEC）
 *  - 'clamped'：换算毫秒超 int32 上限 → 截断（value = floor(int32 ms 对应秒数)）
 */
export interface IdleBackgroundSecNormalization { // oe-exempt:20261102:framework:extension-protocol SDK 跨层契约返回形状（跨层 SSOT 禁镜像，唯一实现 normalizeIdleBackgroundSec 属设计内单实现）
  value: number | null
  anomaly: 'invalid' | 'clamped' | null
}

/**
 * idleBackgroundSec 归一化（跨层唯一实现，禁镜像）：
 * undefined → 默认 600（未配置）；null → null（显式关闭）；正有限数 → floor ≥ 1 的
 * 整数秒（换算毫秒超 int32 上限先截断，anomaly = 'clamped'）；其余坏值 → 默认 600
 * （anomaly = 'invalid'）。
 */
export function normalizeIdleBackgroundSec(raw: unknown): IdleBackgroundSecNormalization {
  if (raw === null) return { value: null, anomaly: null }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const ms = raw * MS_PER_SECOND
    if (ms > INT32_MAX_MS) {
      return { value: Math.floor(INT32_MAX_MS / MS_PER_SECOND), anomaly: 'clamped' }
    }
    return { value: Math.max(1, Math.floor(raw)), anomaly: null }
  }
  if (raw !== undefined) return { value: DEFAULT_IDLE_BACKGROUND_SEC, anomaly: 'invalid' }
  return { value: DEFAULT_IDLE_BACKGROUND_SEC, anomaly: null }
}
