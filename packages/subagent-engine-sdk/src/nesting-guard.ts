// src/nesting-guard.ts
//
// 嵌套 spawn env 构造原语（自 core execution/engine/common/nesting-guard.ts 迁入
// @zhushanwen/subagent-engine-sdk，实现体逐字等价）。
//
// 机制：统一 TAIJI_AGENT_SUBAGENT=1 标记（所有引擎 spawn 都注入，供 isSubagentProcess
// 判定与下游观测识别子代理进程）+ 剥离各引擎原生标记（CC 的 CLAUDECODE / zsub 的
// ZSW_NESTED / pi 的 PI_SUBAGENT_*）防继承泄漏——子代理环境的旧标记会让孙代理误判
// 自己已在嵌套层。
//
// 为什么 env 标记是唯一跨引擎可靠手段（不采用的方案见设计）：「隔离目录里不装扩展」
// 依赖配置洁癖，且 opencode/CC 会吃项目级配置；env 由宿主显式控制，随 spawn 必达。
//
// 原「检测到标记即拒绝递归派发」的 assertNotNestedSpawn / NestedSpawnRejectedError
// 已随禁嵌套派发删除——从未接线（零生产调用方），且现行防线 = 被派发子进程经扩展
// 精简装配无派发工具（subagent-workflow 扩展 setupChildProcessLifecycle），无需
// env 检测式拒绝。
//
// [D3-⑤ 嵌套防护合一] 进程内执行嵌套上下文（原 SubagentService.execCtxAls，pi 路径
// 私有）并入本文件。设计权威源：docs/design/dual-track（已删 git 可追溯）§3.3 D3-⑤
// + 双轨清单 #10。

import { AsyncLocalStorage } from "node:async_hooks";

/** 统一嵌套标记 env 名（D8）。值恒 '1'。 */
export const NESTED_SPAWN_ENV = "TAIJI_AGENT_SUBAGENT";

/** 需剥离的引擎原生嵌套标记（精确名）。 */
const NATIVE_NESTED_KEYS: readonly string[] = ["CLAUDECODE", "ZSW_NESTED"];

/** 需剥离的引擎原生嵌套标记前缀（pi 家族）。 */
const NATIVE_NESTED_PREFIXES: readonly string[] = ["PI_SUBAGENT_"];

/** env 对象形状（NodeJS.ProcessEnv 的结构子集，测试可传普通对象）。 */
export type SpawnEnv = Record<string, string | undefined>;

/**
 * 构造子代理 spawn env：注入 TAIJI_AGENT_SUBAGENT=1 + 剥离引擎原生嵌套标记。
 * 返回新对象，不改入参（spawn env 组装链中的多层 spread 安全）。
 */
export function buildNestedSpawnEnv(baseEnv: SpawnEnv): SpawnEnv {
  const env: SpawnEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (NATIVE_NESTED_KEYS.includes(key)) continue;
    if (NATIVE_NESTED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  env[NESTED_SPAWN_ENV] = "1";
  return env;
}

// ============================================================
// [D3-⑤] 进程内执行嵌套上下文（原 SubagentService.execCtxAls 下沉）
// ============================================================

/** 执行嵌套状态：当前正在跑的 record 身份 + 递归深度（身份归属域的计数载体）。 */
export interface ExecutionNestingState {
  recordId: string | undefined;
  depth: number;
}

/**
 * 进程内执行嵌套上下文（[D3-⑤] 从 SubagentService 的 execCtxAls 私有字段并入公共层）。
 *
 * 机制（原样迁移，行为零变化）：
 *   - ALS 按异步调用链传递当前 record 身份：B run() 期间包 this 上下文，B 内创建 C 时
 *     读到 B → C.parentRecordId=B.id、C.depth=B.depth+1；主 session 链上无 store → 顶层。
 *   - 进程级基线兜底 [ALS 断裂修复]：pi RPC mode 的 stdin JSONL 是事件回调式
 *     （attachJsonlLineReader stream.on("data")），每个命令是独立异步链，enterWith 的
 *     store 不会贯穿到后续 tool 调用事件（实测：递归第二层 parentRecordId/depth 丢失
 *     而 rootSessionId 正确）。基线 = 本进程自己的身份（initSession 从 env 读取）：
 *     读 ALS store 失败时兜底，保证「本进程派发的 subagent 都是本进程记录的孩子」。
 *
 * 实例归属：per-Service（基线随宿主进程身份而异），Service 构造时创建并持有。
 * 深度上限判据（MAX_FORK_DEPTH）留在调用方——上限常量属 execution 层
 * （session-context-resolver），公共层只提供状态存取单点。
 */
export class ExecutionNestingContext {
  private readonly als = new AsyncLocalStorage<ExecutionNestingState>();
  private baselineState: ExecutionNestingState | null = null;

  /** 建立进程级基线（initSession：有 env 自我标记 → env 身份；根进程 → null 顶层）。 */
  setBaseline(state: ExecutionNestingState | null): void {
    this.baselineState = state;
  }

  /** 读当前嵌套状态：ALS store 优先，断裂时基线兜底（顶层 = null）。 */
  current(): ExecutionNestingState | null {
    return this.als.getStore() ?? this.baselineState;
  }

  /**
   * 读进程级基线（与 current() 的差异：不看 ALS store——直接父归属校验等场景要的是
   * 「本进程自己的身份」而非「当前异步链正在跑的 record 身份」）。
   */
  baseline(): ExecutionNestingState | null {
    return this.baselineState;
  }

  /** 包裹执行（B run() 期间挂 B 身份——内层创建 C 时 current() 读到 B）。 */
  run<T>(state: ExecutionNestingState, fn: () => T): T {
    return this.als.run(state, fn);
  }

  /** 顶层 enterWith（initSession 建立基线身份后挂入当前异步链）。 */
  enterWith(state: ExecutionNestingState): void {
    this.als.enterWith(state);
  }
}
