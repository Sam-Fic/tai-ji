// src/execution/engine/inflight-snapshot.ts
//
// core→壳在途事件出口（u7a，设计权威源：docs/architecture/crash-forensics-and-watchdog.md
// §3.3 D5「在途判定谓词 + 求值位置」）。
//
// 在途状态（spawnedChildren Map）真实存在于本包（随 subagent-workflow
// extension 加载进 pi 进程），runtime 无法直查——D5 裁决为 extension 聚合上报：壳层
// （extensions/universal/subagent-workflow 的 host/inflight-reporter）经 select 通道
// 把绝对计数推给 runtime。本模块是这条通道的 core 侧出口：
//   - 求值位置 = 状态所在的 pi 进程（本模块 getInFlightSnapshot——双判据过滤：
//     hasLiveProcessHandle && inRound，只把「正在执行」计为在途；chat 轮终保活
//     （inRound=false）不计。原「hasIdleTimer 反向判据」随 idle timer 机制删除，
//     由镜像的轮在途记账位（markRecordRoundActive）承接同一语义）；
//   - 事件产生点 = 引擎域内的状态迁移点（镜像注册/置死、chat 轮在途翻边），
//     迁移后调 notifyInFlightChanged() 把最新快照推给壳层监听者；
//   - core 闭包红线：本模块零 pi SDK import（只 import 本包 lifecycle 记账侧），
//     壳层经包根 barrel 消费 setInFlightListener / getInFlightSnapshot（exports 面
//     收窄后壳侧生产消费必须走 barrel，无深路径豁免）。
//
// 回调注入形态（RunContext 回调先例）：监听者由壳层注册，core 同步调用、绝不 await
// 返回值——满足 D5 接线约束①「上报不阻塞生命周期主链、不 await 进 agent_settled
// handler 链」。

import { coreSpawnedChildrenMirror } from "./host/spawned-children.ts";

/** 在途快照（绝对计数，供壳层 reporter 发送时刻现取）。 */
export interface InFlightSnapshot {
  /** 当前非 idle 句柄数（绝对计数，非增量）。 */
  inFlight: number;
}

/** 壳层注册的监听回调（同步、fire-and-forget；core 不 await 不重试）。无参数——
 *  帧内容须为发送时刻快照，监听者（host/inflight-reporter）自行 getInFlightSnapshot
 *  现取（2026-09-13 oe-audit：原 snapshot 参数自交付起无任何监听者消费）。 */
export type InFlightListener = () => void;

/**
 * 进程级单监听者（非 per-session 状态——在途计数本身是 pi 进程级模块状态
 * （spawnedChildren/idleTimers 均模块级 Map），出口与之同域；壳层 reporter 持有
 * 当前 session 上下文负责归属，与本出口无关）。后注册覆盖先注册（jiti 模块重载
 * /多 factory 实例场景幂等），null 注销。
 */
let listener: InFlightListener | null = null;

/** 壳层注册监听（extension factory 装配点调用；传 null 注销）。 */
export function setInFlightListener(next: InFlightListener | null): void {
  listener = next;
}

/**
 * 当前在途快照（纯读，无副作用）：遍历活句柄记账（spawnedChildren 的 recordId 键集），
 * 按双判据过滤——活句柄（child 存在且未 killed）且该 record 轮在途（inRound）。
 *
 * SSOT 复用：判据取镜像既有记账位，不复制判定逻辑。活句柄记账的写方分两路，均落同一
 * 镜像：local 形态引擎进程由本进程 spawn（镜像事件 + 反向通道上报其任务 pi 子进程）；
 * 托管态（M3）引擎进程归 runtime 所有，extension 仅经反向通道记账引擎 spawn 的任务
 * pi 子进程。因此本模块统计的是「本会话仍存活的任务子进程」，不表达引擎进程所有权。
 */
export function getInFlightSnapshot(): InFlightSnapshot {
  return { inFlight: countInFlight() };
}

/**
 * 状态迁移点调用：把最新快照同步推给监听者。约束（D5 接线①）：
 *   - 同步 void 语义——调用方（含 agent_settled handler 链内的迁移点）
 *     不 await 本函数的任何下游（监听者内部自行 fire-and-forget）；
 *   - 监听者异常不反噬 core（壳层 bug 不得打断生命周期主链），catch 后照常返回。
 */
export function notifyInFlightChanged(): void {
  if (listener === null) return;
  try {
    listener();
  // eslint-disable-next-line taste/no-silent-catch -- 上报出口故障刻意静默（D5 约束①）：壳层 bug 不得打断生命周期主链；绝对计数语义下后续事件自愈，丢失单帧无累积误差，记日志徒增 core logger 噪音面
  } catch {
    // 同上：静默是接受的。
  }
}

/** 双判据过滤的绝对计数（getInFlightSnapshot 与 notifyInFlightChanged 共用）。 */
function countInFlight(): number {
  let count = 0;
  for (const entry of coreSpawnedChildrenMirror().snapshot()) {
    if (!entry.killed && entry.inRound) count++;
  }
  return count;
}
