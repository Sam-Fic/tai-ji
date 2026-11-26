// src/model-param.ts — create_managed_session 的 `model` 参数前置校验
//
// 分层定位：协议层（@zhushanwen/extension-protocol 的 SessionManagerCreateParams.model）
// 只做类型范围检查；**存在性校验在本文件**，因为权威清单不是静态词表而是「子进程实际
// 解析的模型目录」——与发起方 pi 进程同 agentDir 派生，运行时才可得。

/** 错误信息里列出的可用模型上限（防超长清单撑爆 LLM 上下文；超出以省略号截断）。
 *
 * 形参 source 的 duck 类型（与 pi SDK `ModelRegistry.getAvailable()` 返回元素结构兼容——
 * 只消费 provider/id 两字段）内联在函数签名上而非单立接口：本函数是唯一消费点，按
 * Rule of Three 不值得为先立的名字付抽象成本；测试传 `{ getAvailable: () => [...] }`
 * 对象字面量即满足结构，无需装配真 registry。
 */
const MODEL_LIST_LIMIT = 20

/**
 * `model` 参数前置校验：非空即须与可用目录**全等精确匹配**（provider 与 id 均区分
 * 大小写），否则同步 throw——调用方（agent）拿到可自纠的错误文本重发即可，不产生
 * runtime 往返、不创建会话。
 *
 * 为什么必须校验（而不是「pi 自己会报错」）：子会话由 runtime 以 `--model <provider/id>`
 * spawn，而 pi CLI 的模型解析是**模糊引擎**——`resolveCliModel` 先按 `provider/id`
 * 归一化全等找，找不到再子串匹配，provider 命中但 id 未命中时
 * `buildFallbackModel` 会**伪造一个自定义模型条目**让进程正常起来（pi 1.0.0 实装
 * dist/core/model-resolver.js resolveCliModel 末段 warning "Using custom model id"）。
 * 无校验就把「以为用了 X 实际用 Y」的静默错模会话送进侧栏，首条消息才在 provider 侧
 * 404——故障点离原因点隔了一整个会话创建流程。
 *
 * 为什么是全等而非模糊：与 subagent 派发同宗的裁决口径（shared/model-ref.ts
 * assertCanonicalModelRef「零宽容」原则）——模糊匹配只用于生成纠错候选，永不参与采纳；
 * 系统绝不代改输入。大小写敏感是因为 registry 自身大小写即契约（pi 的模糊分支会把
 * `DeepSeek/x` 解析到 `deepseek/x`，agent 侧放行等于把歧义留给引擎）。
 *
 * 数据源 = `ctx.modelRegistry.getAvailable()`（pi 进程内 auth 可用目录快照）：
 * - 与子进程同源——两者同 agentDir（PI_CODING_AGENT_DIR 隔离）读同一份
 *   models.json / auth.json，目录一致；
 * - 覆盖聚合路由条目——provider-aggregation 扩展在工厂期 `registerVirtualModel`，
 *   路由模型（`aggregation/<routeId>`）与物理模型同在清单内，不会被误判「不存在」；
 * - auth 可用语义——无凭据 provider 的模型不在清单内，此类请求在创建前即被拒
 *   （否则子进程起得来、首条消息才死于凭据缺失）。
 *
 * fail-open（宁漏不误杀，对齐 runtime isModelInRegistry 同款保守方向）：清单不可得
 * （source 缺席 / getAvailable 抛错 / 空目录）时**不阻断创建**——无法证明模型无效就
 * 不能把宿主故障升级成参数错误，交由子进程自己的模型错误 surfaced。
 */
export function assertModelAvailable(
	model: string | undefined,
	source: { getAvailable(): readonly { provider: string; id: string }[] } | undefined,
): void {
	if (model === undefined) return
	let available: readonly { provider: string; id: string }[]
	try {
		available = source?.getAvailable() ?? []
	} catch {
		// 清单读取失败 = 无法判定 → 放行（不把宿主故障包装成参数错误）
		return
	}
	if (available.length === 0) return
	const refs = available.map((m) => `${m.provider}/${m.id}`)
	if (refs.includes(model)) return
	const shown = refs.slice(0, MODEL_LIST_LIMIT).join(", ")
	throw new Error(
		`create_managed_session: model "${model}" is not an available model. `
		+ `The value must equal an available "provider/modelId" exactly (case-sensitive). `
		+ `Available models (${refs.length}): ${shown}${refs.length > MODEL_LIST_LIMIT ? ", …" : ""}. `
		+ `Omit "model" to create the session with the default model.`,
	)
}
