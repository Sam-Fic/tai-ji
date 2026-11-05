/**
 * IShellRunner port —— shell 脚本执行的唯一 seam（W1 worktree setup 钩子）。
 *
 * 🔒 三层架构：services 定义 port，infra/shell-runner.ts 实现（child_process.spawn）。
 * WorktreeService 创建 worktree 后经此 port 触发 `<bare>/custom-hooks/setup-worktree.sh`，
 * 不直接 spawn/exec。
 *
 * 与 IGitExecutor 的区别：
 * - IGitExecutor：execFileSync 跑 git 子命令（白名单 + 数组参数防注入），**同步语义**，非 0 原样返回。
 * - IShellRunner：spawn 跑任意 shell 脚本（用户的 setup-worktree.sh），**异步流式**，逐行回调 onOutput；
 *   ENOENT 抛 ShellRunnerError（执行失败而非业务失败），exitCode 非 0 由调用方判定。
 *
 * spawn 注入策略：构造函数接受 `{ spawn }`，production 由 index.ts 传 `child_process.spawn`，
 * 测试用 `vi.doMock('node:child_process')` 后传入 mock。此设计让 ShellRunner 单元测试无需真的 spawn。
 */
import type { spawn as spawnType } from 'node:child_process'

/** ShellRunner 失败分类错误。ENOENT → not_found。 */
export class ShellRunnerError extends Error {
  readonly code: 'not_found'
  constructor(code: 'not_found', message: string) {
    super(message)
    this.name = 'ShellRunnerError'
    this.code = code
  }
}

/** execute 参数。 */
export interface ShellRunnerExecuteOptions {
  /** 脚本绝对路径（如 `<bare>/custom-hooks/setup-worktree.sh`）。 */
  scriptPath: string
  /** 透传给脚本的参数数组（如 `[newWtPath]`）。 */
  args?: string[]
  /** 子进程 cwd（通常是新 worktree 目录）。 */
  cwd: string
  /** 逐行输出回调（每行 + 流标识）。setup 脚本的 stdout/stderr 实时反馈给前端用。 */
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void
}

/** execute 返回。 */
export interface ShellRunnerResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * shell 脚本执行 port。
 *
 * 实现约束（infra/shell-runner.ts）：
 * - `spawn(scriptPath, args, { cwd, stdio: ['pipe','pipe','pipe'] })`（不经 shell，避免命令注入）
 * - stdout/stderr 的 'data' 事件按 Buffer 解码 + split 行，每行调 onOutput；同时累积到 stdout/stderr
 * - child 'close' 事件收到 exitCode 后 resolve
 * - child 'error' 事件：ENOENT → reject ShellRunnerError('not_found')
 * - 无墙钟：setup 脚本（pnpm install / 二进制下载等分钟级操作）跑到 close 为止，不做时间阈值判死
 */
export interface IShellRunner {
  execute(opts: ShellRunnerExecuteOptions): Promise<ShellRunnerResult>
}

/** spawn 函数类型（用于依赖注入；与 node:child_process.spawn 签名对齐）。 */
export type SpawnFn = typeof spawnType
