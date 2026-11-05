/**
 * steer 记账状态机——structured_output 调用结果的进程内记账（soft gate 数据源）。
 *
 * 通道选型（设计 §6.3；pi 0.84.1 实装，登记 PS-20）：
 *   参数层失败（事故主形态）在 pi-ai validateToolArguments 抛错（validation.js:272-273）、
 *   走 agent-loop 的 immediate error 路径（agent-loop.js:404 校验 → :445-451 catch）
 *   ——execute 不被调用、beforeToolCall 永不触发；唯一可靠
 *   的计数通道是 tool_execution_end 事件（sequential/parallel 两路径的 immediate
 *   分支均 emitToolExecutionEnd：agent-loop.js:277/:318/:348/:358）。
 *
 * 记账转移（onToolExecEnd / onTurnEnd，转移表锁定于 retry-state.test.ts）：
 *   - 失败：soCallCount++ / lastSchemaError 记录（turn_end steer 的回灌文案原料）。
 *   - 成功：soSucceededEver=true（终态，后续 turn_end 不再干预）。
 *   - onTurnEnd 仅重置 steer 侧（soCallCount=0 / hookRetryCount++ / lastSchemaError=null）。
 *
 * 有意决策：连续失败只记账、不熔断杀子进程——失败循环的终止交由 steer 重试上限
 * （MAX_HOOK_RETRIES，workflow-hook）与 workflow 层 maxTurns 兜底。
 *
 * 与 workflow-hook 的关系：本文件导出状态机，装配唯一入口在
 * workflow-hook.setupWorkflowHook（单 listener：每个事件至多一个 listener）。
 */

/**
 * structured_output 调用记账状态机（纯逻辑，可单测）。
 */
export class WorkflowGate {
	soCallCount = 0;
	soSucceededEver = false;
	hookRetryCount = 0;
	lastSchemaError: string | null = null;

	/**
	 * 记录一次 structured-output tool 执行结果。hasError = event.isError === true。
	 * 无返回值——steer 决策不经返回值表达：turn_end 时刻由 shouldSkipSteer 按
	 * 状态字段推导（tool_execution_end 时刻无消费者，返回值只会是死字段）。
	 */
	onToolExecEnd(hasError: boolean, errorText?: string): void {
		this.soCallCount++;
		if (!hasError) {
			this.soSucceededEver = true;
		} else {
			this.lastSchemaError = errorText ?? "structured-output call failed";
		}
	}

	/**
	 * turn 收尾（仅当要 steer 且发送成功时调用）：重置本 turn 计数、累计重试次数、
	 * 清空错误。
	 */
	onTurnEnd(): void {
		this.soCallCount = 0;
		this.hookRetryCount++;
		this.lastSchemaError = null;
	}
}
