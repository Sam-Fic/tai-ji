/**
 * routes → pi 注册条目集派生纯函数（设计 D4 ⑤/D7；RL1/A9 目录一致性对账单源）。
 *
 * RL1 断言形态（设计 §4.2：同一配置 fixture 喂注入器与扩展注册器，断言两侧条目集相等）
 * 的扩展注册器半边：注册条目的派生规则只活在本模块——provider 承载（AGGREGATION_PROVIDER_ID）、
 * id/name 直投、thinkingLevels 端点档位并集（unionThinkingLevels 单源，空并集省略）、
 * contextWindow 端点最小值（任一端点不可解析或值非正 → 省略）。扩展工厂（index.ts 的
 * 三处注册时点：工厂期 / session_start 对账 / route 求值前重读）与 m8 的目录一致性对账
 * 测试（runtime aggregation-catalog-consistency.test）都从本模块取注册条目集——派生
 * 规则漂移时对账测试必变红，不存在可发散的第二实现。
 *
 * 零 IO、零时钟、零 pi 运行态依赖（AX3 同族：目录快照由调用方注入）——pi 环境无关，
 * 可被 runtime 测试进程直接 import。
 */

import type { ExtensionVirtualModel } from "@earendil-works/pi-coding-agent";
import { AGGREGATION_PROVIDER_ID, type AggregationRoute } from "@taiji/shared/aggregation";
import { unionThinkingLevels } from "./router.ts";

/** 注册条目元数据形状（ExtensionVirtualModel 去 route 闭包——派生面只覆盖静态元数据，
 * route 回调由扩展工厂绑定求值上下文，不属于配置派生）。 */
export type AggregationVirtualModelDefinition = Omit<ExtensionVirtualModel, "route">

/** contextWindow 解析器形态（buildVirtualModelDefinitions 可选注入——工厂期无目录不解析）。 */
export type ResolveAggregationContextWindow = (route: AggregationRoute) => number | undefined

/** 模型目录快照的最小读取接口（contextWindow 解析的输入；pi ExtensionContext.modelRegistry
 * 与对账测试的 fixture 桩共同满足——结构化类型，不绑定 pi 类）。 */
export interface AggregationModelDirectorySnapshot { // oe-exempt:20261107:framework:pi modelRegistry 最小结构化端口——生产实现由 pi SDK 对象结构化满足（不写 implements），测试侧 fixture 桩，端口契约单实现常态
	find(providerId: string, modelId: string): { contextWindow?: number } | undefined
}

/**
 * 端点 contextWindow 最小值（D7）：全部端点可解析且 >0 → 最小值；任一端点不在目录或
 * 值非正 → undefined（省略声明 = pi 合成 0 未知——保守前提：显示与压缩判定不得高估
 * 容量，含未知端点时取已知最小值会高估该路由容量）。
 */
export function resolveContextWindowFromDirectory(directory: AggregationModelDirectorySnapshot, route: AggregationRoute): number | undefined {
	let min: number | undefined
	for (const member of route.members) {
		const contextWindow = directory.find(member.providerId, member.modelId)?.contextWindow
		if (typeof contextWindow !== "number" || contextWindow <= 0) return undefined
		min = min === undefined ? contextWindow : Math.min(min, contextWindow)
	}
	return min
}

/**
 * routes → pi 注册条目集（RL1/A9 对账的注册器半边单源）。每条路由一个条目，含
 * enabled=false——注册侧停用 = 保持注册 + route 闭包显式失败「已停用」（D9/AS22），
 * 启停投影由消费侧做（对账测试按 fixture enabled 投影后与注入条目集比对）：
 * - provider = AGGREGATION_PROVIDER_ID、id/name = 路由字段直投；
 * - thinkingLevels = 端点档位并集（null 键 = 不支持、非法档位字面量过滤——
 *   unionThinkingLevels 单源）；空并集省略字段（pi 缺省 ["off"]——档位未声明不猜测）；
 * - contextWindow = resolveContextWindow?.(route)，undefined 省略字段（pi 合成 0）。
 */
export function buildVirtualModelDefinitions(
	routes: readonly AggregationRoute[],
	resolveContextWindow?: ResolveAggregationContextWindow,
): AggregationVirtualModelDefinition[] {
	return routes.map(route => {
		const definition: AggregationVirtualModelDefinition = {
			provider: AGGREGATION_PROVIDER_ID,
			id: route.id,
			name: route.name,
		}
		const levels = unionThinkingLevels(route.members)
		if (levels.length > 0) definition.thinkingLevels = levels
		const contextWindow = resolveContextWindow?.(route)
		if (contextWindow !== undefined) definition.contextWindow = contextWindow
		return definition
	})
}
