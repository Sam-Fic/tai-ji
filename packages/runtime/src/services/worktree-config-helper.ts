/**
 * Worktree 偏好配置 helper（git-cwt-anywhere：root dir / setup 脚本 / 默认
 * base branch），从 config-service.ts 抽出，控 max-lines 500。
 *
 * 经注入的 AppConfigAccessors 读写，落在 app config.json 顶层字段。本模块只负责
 * 字段级读写 + 校验，不关心 config.json 的落盘细节（由 load/save 回调负责，避免
 * 循环依赖 + 不暴露 ConfigService 的私有方法）。
 *
 * 本文件曾混入 auto-rename / rename-session / smart-context 三个配置域（P1-7 名实
 * 拆分前），已各归其位：rename-session-config.ts（auto-rename 开关 + rename model/
 * mode）、smart-context-config.ts（smart-context 快照），共享 RMW 基建在
 * ext-config-rmw.ts。本文件回归文件名语义 = worktree 偏好单一职责。
 */
import type { SaveAppConfigResult } from './app-config-store.js'
import { AUTO_BASE_BRANCH } from './worktree/default-base-resolver.js'

/**
 * app config.json 的 load/save 能力（ConfigService 注入，避免暴露其私有方法）。
 * save 结果携带 {ok, code, error}：config.json 损坏降级态下拒绝空骨架覆写（M4/RT-7#1），
 * setter 必须把失败透传给 RPC 层（sendError），不得静默呈「已保存」。
 */
export type AppConfigAccessors = {
  /** 读 app config.json（不存在 / 损坏返回 {}——损坏已隔离，见 app-config-store）。 */
  load(): Record<string, unknown>
  /** 全量覆写 app config.json（降级态下拒绝写入并返回失败原因）。 */
  save(config: Record<string, unknown>): SaveAppConfigResult
}

/** 默认 worktree 根目录（~/worktrees，与原 ConfigService 内联值一致）。 */
const DEFAULT_WORKTREE_ROOT_DIR = '~/worktrees'
/** 默认 setup 脚本相对路径（裸仓 / 普通仓共用同一默认）。 */
const DEFAULT_SETUP_SCRIPT = 'custom-hooks/setup-worktree.sh'
/**
 * 默认 base branch：'auto' 哨兵——create 时按仓库远端实况动态推导（checkout.defaultRemote →
 * origin → 单一远端 → 清单首个；无远端退本地 main/master，恒经 rev-parse 验证，见
 * default-base-resolver）。不再硬编码 'origin/main'：bare workspace 远端可叫别的名字，且
 * refs/remotes/origin/* 可能残留无更新通道的死数据（2026-10-20 事故：镜像冻结三天，新
 * worktree 落后 271 提交）。
 */
const DEFAULT_BASE_BRANCH = AUTO_BASE_BRANCH

export function getWorktreeRootDir(app: AppConfigAccessors): string {
  const val = app.load()['worktreeRootDir']
  return typeof val === 'string' ? val : DEFAULT_WORKTREE_ROOT_DIR
}

export function setWorktreeRootDir(app: AppConfigAccessors, dir: string): SaveAppConfigResult {
  if (!dir || !dir.trim()) {
    throw new Error('worktreeRootDir cannot be empty')
  }
  const config = app.load()
  config['worktreeRootDir'] = dir
  return app.save(config)
}

export function getSetupScript(app: AppConfigAccessors): string {
  const val = app.load()['setupScript']
  return typeof val === 'string' ? val : DEFAULT_SETUP_SCRIPT
}

export function setSetupScript(app: AppConfigAccessors, dir: string): SaveAppConfigResult {
  if (dir.includes('..')) {
    throw new Error('setupScript path cannot contain ..')
  }
  const config = app.load()
  config['setupScript'] = dir
  return app.save(config)
}

export function getBareSetupScript(app: AppConfigAccessors): string {
  const val = app.load()['bareSetupScript']
  return typeof val === 'string' ? val : DEFAULT_SETUP_SCRIPT
}

export function setBareSetupScript(app: AppConfigAccessors, script: string): SaveAppConfigResult {
  // 与 setSetupScript 同款防线：裸仓 setup 脚本与普通仓脚本同语义（经 shell 执行），
  // `..` 路径穿越风险情形相同，校验与错误信息形态逐字对齐。
  if (script.includes('..')) {
    throw new Error('bareSetupScript path cannot contain ..')
  }
  const config = app.load()
  config['bareSetupScript'] = script
  return app.save(config)
}

export function getDefaultBaseBranch(app: AppConfigAccessors): string {
  const val = app.load()['defaultBaseBranch']
  return typeof val === 'string' ? val : DEFAULT_BASE_BRANCH
}

export function setDefaultBaseBranch(app: AppConfigAccessors, baseBranch: string): SaveAppConfigResult {
  const config = app.load()
  config['defaultBaseBranch'] = baseBranch
  return app.save(config)
}
