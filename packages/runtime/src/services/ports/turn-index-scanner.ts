/**
 * ITurnIndexScanner port —— turn 边界索引扫描 seam（C-comm-03：services 层 IO 须经 port）。
 *
 * infra 实装 = infra/pi/turn-index-scanner.ts（正序分块读 JSONL 的文件 IO 原语，非纯函数，
 * 不适用 §3 白名单登记出口）；services 侧消费方 turn-index-store（索引构建编排）与
 * history-reader（窗口 entryId 校验）经构造注入持有本 port，生产绑定在组合根 index.ts
 * （check_services_infra_import 扫描面之外）。接口方法名与 infra 导出函数同名，组合根
 * 直接以同名函数简写属性装配；chunkBytes 等测试标定入参不在 port 面（services 消费恒
 * 默认块大小）。
 *
 * 类型直接 import type 自 infra（type-only 不构成运行时耦合，check_services_infra_import
 * 与 check_no_service_cycle 同口径豁免）——这些类型的合法持有点本就在 infra/pi
 * （AGENTS.md 关键规则 5），port 层复制声明会制造双份漂移面，不复制。
 */
import type { TurnBoundaryVerifyFailure, TurnScanResume, TurnScanResult } from '../../infra/pi/turn-index-scanner.js'
import type { TurnIndexTurnRecord } from '../../infra/pi/turn-index-types.js'

export interface ITurnIndexScanner { // oe-exempt:20261103:framework:ports 契约先立、单实现常态（实现 = infra/pi/turn-index-scanner.ts）
  /**
   * 正序分块扫描 turn 边界（全量或从 resume 续扫）；null = 文件打开失败（ENOENT 等，
   * 调用方按空页/重建语义处置）。编排（stat 收敛判定、失配重建）在消费方，扫描器只
   * 忠实产出「打开时观察尾」的边界记录。
   */
  scanTurnBoundariesForward(filePath: string, resume?: TurnScanResume): Promise<TurnScanResult | null>

  /**
   * 实际 entryId 校验（D3/SI4）：按记录 byteOffset 逐条读边界行反证索引正确性；
   * 只读边界行本身，校验集合由调用方组装（选中窗口 turns + cursor turn）。
   */
  verifyTurnBoundaries(
    filePath: string,
    records: readonly TurnIndexTurnRecord[],
  ): Promise<{ ok: true } | TurnBoundaryVerifyFailure>
}
