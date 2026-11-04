// src/shared/timer-delay.ts
//
// setTimeout 安全域上限单源（Shared 层，无 Pi 依赖）。
//
// [时间机制删除后残形] 原消费者（idle timer 的 assertSafeTimerDelay、workflow run
// 级时间预算的 budgetTimeMs 校验、dialog 队列上界 clamp）已随各自时间机制删除；
// 本文件仅存 Node setTimeout 上限常量（壳 tool schema 文案消费——「hard ceiling
// 2^31-1 ms」的用户可见上界表述）。
//
// 背景知识（留给未来 timer 消费者）：Node 的 setTimeout 对超出 2^31-1 的 delay
// 会把定时器置为 1ms 立即触发——语义完全反转：调用方想表达的「近乎不限时」变成
// 立即触发。setTimeout(fn, NaN) 同样被 Node 塌缩为 1ms 立即触发。

/** Node setTimeout delay 的安全上限（2^31 - 1，超出的 delay 被置 1ms 立即触发）。 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
