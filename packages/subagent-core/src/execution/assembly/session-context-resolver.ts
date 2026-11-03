// src/core/session-context-resolver.ts
//
// resolveSessionContext 纯函数——解析 fork/worktree 意图，返回执行上下文。
// D-014: 零副作用，零 Pi import。只返回意图，不调 forkFrom/不创建 sessionDir。

import type { ResolvedSessionContext, SessionResolveInput } from "./types.ts";
import { ForkDepthExceededError } from "./types.ts";
import { getSubagentSessionDir } from "./path-encoding.ts";

/**
 * fork 深度硬限。export 供 session-runner 注入 LLM env block 时引用同一常量，
 * 避免硬限（拦截）与展示（`N/10`）两处 10 漂移。
 *
 * 生效护栏 = resolveSessionContext 的 fork 护栏（parentForkDepth >= MAX_FORK_DEPTH
 * → 拒）：只计 fork 链（fork=true 才递增 parentForkDepth），控 session 体积（每层
 * createBranchedSession）。允许深度 0..MAX_FORK_DEPTH（共 MAX+1 层），第 MAX+1 层
 * 被拒。原第 2 层「通用嵌套深度护栏」已随禁嵌套派发退役——被派发子进程经扩展
 * 精简装配无派发工具（见 subagent-workflow 扩展 setupChildProcessLifecycle），
 * 深度嵌套从能力上不存在，无需入口计数拦截。
 */
export const MAX_FORK_DEPTH = 10;

/**
 * 纯函数：解析 fork/worktree 意图 → 执行上下文。
 *
 * 只返回意图（shouldFork/forkSource/effectiveCwd/sessionDir），
 * 不调 forkFrom / 不创建 sessionDir / 不 git worktree add。
 *
 * @throws {ForkDepthExceededError} fork=true 且 parentForkDepth >= 10
 */
export function resolveSessionContext(input: SessionResolveInput): ResolvedSessionContext {
  const { fork, cwd, mainCwd, mainSessionFile, parentForkDepth, rootSessionId, worktreePath } =
    input;

  // fork 深度检查（D-007）
  if (fork && (parentForkDepth ?? 0) >= MAX_FORK_DEPTH) {
    throw new ForkDepthExceededError(
      `fork depth ${parentForkDepth ?? 0} >= ${MAX_FORK_DEPTH}, refusing to fork`,
    );
  }

  const shouldFork = fork === true;
  const forkSource = shouldFork ? mainSessionFile : undefined;

  // [MF#5] fork 显式请求但主 session 文件不可用（session_start 未缓存）时直接抛错，
  // 不静默降级到 from-scratch——否则用户显式 fork 却得到无继承 session，且无任何告警。
  if (shouldFork && !forkSource) {
    throw new Error(
      "fork requested but main session file is unavailable " +
        "(session_start did not cache it); cannot fork without a source session",
    );
  }

  // effectiveCwd: worktree 模式用 handle.path（真实 checkout，由调用方传入），
  // 否则用显式 cwd 或 mainCwd。worktreePath 与 worktree 标志同源（都来自 WorktreeHandle），
  // 不再靠 tmpdir 拼凑，保证 effectiveCwd 与实际 checkout 严格一致。
  const effectiveCwd = worktreePath ?? (cwd ?? mainCwd);

  // sessionDir 按 rootSessionId 树内分区（session-store-layout-inversion D2/D3：
  // 同一根会话的所有 subagent 存同一棵会话树，随会话删除整树回收）
  const sessionDir = getSubagentSessionDir(rootSessionId);

  return { shouldFork, forkSource, effectiveCwd, sessionDir };
}
