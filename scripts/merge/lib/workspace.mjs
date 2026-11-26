/**
 * workspace 定位（bare-workspace + 普通仓库双布局的唯一实现）。
 *
 * 曾在 6 处脚本各内联一份「向上查找含 .bare 的目录」循环，布局漂移时逐份修
 * （固定层数推导失效事故的修法当时也是逐份打的）。收敛为一份。
 *
 * 双布局（v0.13.4 发布期仓库迁普通布局致工具链整体不可运行，2026-11 修复）：
 * - bare-workspace 布局：workspace 根 = 含 .bare/ 的容器目录；main worktree =
 *   <根>/main；feature worktree 为根的直接子目录；.merge-state / .agents 在根下
 * - 普通仓库布局：workspace 根 = 主 worktree 根（.git 所在仓库根）；main worktree =
 *   workspace 根本身；feature worktree 经 git worktree list 登记、可在任意路径；
 *   .merge-state 落主 worktree 根（与 bare 布局同级语义）
 *
 * 判定顺序：先 .bare 向上（bare 布局，不依赖 git 可执行文件；从 .agents 实体向上
 * 也可命中——实体在 bare 容器根），未命中回退 `git rev-parse --git-common-dir`
 * （普通布局；在主 worktree 或任意链接 worktree 内均解析到主仓 .git）。注意普通
 * 布局下 .agents 实体在仓外（仓内是指向实体的 symlink），从实体路径锚定解析不到
 * 仓库——shell 侧调用恒以仓内 cwd 为锚（SKILL 调用模板自带 cd 前缀）。
 * git 分支返回的路径是 git 视角（可能含 symlink 展开，如 macOS /var → /private/var），
 * 与调用方词面路径可能不同形——消费方只用它做 git -C / join / existsSync，无词面比较。
 */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** bare-workspace 布局：从 startDir 逐级向上找含 .bare/ 的目录；到根仍无返回 null。 */
function findBareWorkspaceRoot(startDir) {
  let cur = startDir
  for (;;) {
    if (existsSync(join(cur, '.bare'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/**
 * 普通仓库布局：git-common-dir 解析主 worktree 根（startDir 在主 worktree 或任意
 * 链接 worktree 内均命中主仓 .git）。不在仓内 / git 不可用 / 旧 git 不认识
 * --path-format（回退相对形态重试一次）均不抛，最终未命中返回 null。
 */
function findNormalRepoRoot(startDir) {
  const argForms = [
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    ['rev-parse', '--git-common-dir'],
  ]
  for (const argv of argForms) {
    let out
    try {
      out = execFileSync('git', ['-C', startDir, ...argv], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      continue
    }
    if (!out) continue
    return dirname(isAbsolute(out) ? out : resolve(startDir, out))
  }
  return null
}

/**
 * workspace 根（双布局）：bare 布局 = .bare 容器目录；普通布局 = 主 worktree 根
 * （仓库根）。从 startDir 逐级向上；到根仍无则返回 null。
 */
export function findWorkspaceRoot(startDir = process.cwd()) {
  const bare = findBareWorkspaceRoot(startDir)
  if (bare !== null) return bare
  return findNormalRepoRoot(startDir)
}

/**
 * main worktree 路径（sync/发布阶段的目标 worktree）：bare 布局 = <根>/main；
 * 普通布局 = workspace 根本身（主 worktree 即仓库根）。判别锚 = 根下有无 .bare/
 * （findWorkspaceRoot 的 bare 分支恒以此形态返回，普通分支根下只有 .git）。
 */
export function mainWorktreePath(root) {
  return existsSync(join(root, '.bare')) ? join(root, 'main') : root
}
