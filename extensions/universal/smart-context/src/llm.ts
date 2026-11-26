/**
 * same-model 模式的 LLM 调用（D12 + D13-5 cache-key 一致性）。
 *
 * 不走 llm-shared callLLM：其 tools:[] 硬编码会破坏前缀缓存对齐（llm-shared call.ts）。
 * 此处复用会话原 system prompt + tools schema，并把 tools 与主会话对齐
 * （deepseek-harness summarizer 同款做法：system + tools + messages 全部复用做缓存对齐）。
 *
 * 调用通道（C-pi-19）：必须经 `ctx.modelRegistry`（= pi 的 ModelRuntime 门面），
 * **禁止直连 `@earendil-works/pi-ai/compat` 的 completeSimple**。compat 是静态目录分发层
 * （按 `model.api` 查 registry），不认识 provider-aggregation 注册的虚拟模型
 * （`api === "pi-virtual"`）：会话模型是聚合路由时 compat 恒抛
 * `No API provider registered for api: pi-virtual`，压缩连续失败三次即熔断。
 * `ModelRegistry.streamSimple` 才是虚拟模型感知路径（model-runtime.js 的
 * `if (isVirtualModel(model))` 分支：先 route 到物理端点、再转发，并丢弃不属于物理
 * 端点的调用方凭据）。物理模型路径下两条通道等价（同一 provider 实例）。
 *
 * cache-key 一致性约束（D13-5）：除末尾追加的压缩指令 user message 外，
 * systemPrompt / tools / messages 前缀与主会话完全一致；不设 maxTokens 覆盖
 * （Claude Code 教训：单独设置 maxOutputTokens 会造成 cache-key mismatch 前缀全 miss）。
 * reasoning 例外且必须显式透传会话档位：虚拟模型分支以 `options.reasoning ?? "off"`
 * 重新求值路由，缺省会把档位算成 off（端点不支持 off 时还会向上取档），与主会话请求
 * 档位不同 → 前缀缓存整体 miss。传 `ctx.thinkingLevel` 使两侧同值同源。
 */

import type {
	Context as LlmContext,
	Message,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	Tool as LlmTool,
} from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { isRecord, toErrorMessage } from "@zhushanwen/pi-ext-guards";

/**
 * ToolInfo → pi-ai Tool 派生视图：三字段直取。parameters 是 typebox schema（主会话同源对象，
 * 序列化后与主请求一致——缓存对齐的关键是不改造、原样透传）。
 */
export function projectTools(toolInfos: readonly ToolInfo[]): LlmTool[] {
	return toolInfos.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));
}

/**
 * 响应宽松形状（消费 stopReason / errorMessage / usage / content text）。
 *
 * content 声明为 unknown[] 而非 pi-ai 的 AssistantContent：调用方（含单测 mock）只按运行时
 * 形状收窄取 text（blockText），不在类型层依赖上游 block 联合的字段增减。
 * errorMessage 是 lazyStream setup 失败（路由失败 / 凭据缺失 / 请求装配异常）的唯一诊断
 * 载荷——该形态 content 为空、stopReason="error"，不取它错误原因即丢。
 */
interface SimpleResponseLike {
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
	};
	content: readonly unknown[];
}

/**
 * same-model 调用结果（判别联合）：成功携带摘要文本与 usage；失败仅携带 error
 * （调用方走 D7 回退），stopReason 两态均可携带（length 截断 fail-closed / 排查用）。
 */
export type SameModelCallResult =
	| {
		ok: true;
		/** 摘要文本（content 内全部 text block 拼接，D13-10 只取 text）。 */
		text: string;
		/** provider usage（cacheRead 供 R8 探针验证缓存命中）。 */
		usage?: SimpleResponseLike["usage"];
		/** stopReason（length = max-tokens 截断，D13-2 fail-closed 判据）。 */
		stopReason?: string;
	}
	| {
		ok: false;
		error: string;
		stopReason?: string;
	};

export interface SameModelCallOptions {
	model: Model<never> | Model<string> | undefined;
	/** 会话原 system prompt（ctx.getSystemPrompt()——缓存对齐必要条件）。 */
	systemPrompt: string;
	/** 完整上下文 messages + 末尾已追加的压缩指令 message。 */
	messages: Message[];
	/** 主会话工具派生视图（缓存对齐）。 */
	tools: LlmTool[];
	/**
	 * 会话当前思考档位（cache-key 一致性：与主会话请求同值，见文件头 reasoning 段）。
	 * 用 ModelThinkingLevel（pi-agent-core 的 ctx.thinkingLevel 同域类型，含 "off"）；
	 * "off" 在构造 options 时映射为不传字段（provider 默认），与主会话请求同形状。
	 */
	reasoning?: ModelThinkingLevel;
	signal?: AbortSignal;
	sessionId?: string;
	/**
	 * 依赖注入（单测 mock 点）。生产路径缺省经 ctx.modelRegistry（虚拟模型感知），
	 * 不得改回 pi-ai/compat（见文件头调用通道段）。
	 */
	deps?: {
		getApiKeyAndHeaders?: (model: Model<never> | Model<string>) => Promise<{ ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } | { ok: false; error: string }>;
		call?: (model: Model<never> | Model<string>, context: LlmContext, options: SimpleStreamOptions) => Promise<SimpleResponseLike>;
	};
}

/**
 * content block 的 text 提取（in-guard：联合中 ThinkingContent/ToolCall 无 text 字段）。
 * 与 llm-shared extractText 刻意不同：不过滤 block type、join 用 "\n"——摘要需保留
 * 多段换行结构（extractText 过滤 type==="text" 且 join 空格，语义是单段纯文本）。
 */
function blockText(block: unknown): string {
	if (!isRecord(block)) return "";
	return typeof block.text === "string" ? block.text : "";
}

/** 失败诊断文本：content 文本优先（provider 把错误写进 text 块的既有形态），空则回落 errorMessage（setup 失败唯一载荷），再回落 stopReason。 */
function failureText(resp: SimpleResponseLike): string {
	const contentText = resp.content.map(blockText).join(" ").trim();
	if (contentText !== "") return contentText;
	if (typeof resp.errorMessage === "string" && resp.errorMessage.trim() !== "") return resp.errorMessage.trim();
	return resp.stopReason ? `stopReason=${resp.stopReason}` : "unknown error";
}

/**
 * 发起 same-model 压缩调用。失败归一为 {ok:false, error}（调用方走 D7 回退），不抛错。
 * max-tokens 截断（stopReason === "length"）返回 ok:true + stopReason 由调用方 fail-closed。
 */
export async function callSameModelCompaction(
	ctx: ExtensionContext,
	opts: SameModelCallOptions,
): Promise<SameModelCallResult> {
	const deps = opts.deps ?? {};
	const getAuth = deps.getApiKeyAndHeaders ?? ((m: Model<never> | Model<string>) => ctx.modelRegistry.getApiKeyAndHeaders(m));
	// 生产通道 = ctx.modelRegistry.streamSimple（虚拟模型感知；见文件头「调用通道」段）。
	// 同步调用、异步求值：streamSimple 返回 lazyStream，信号与路由求值都在其内部进行。
	const call = deps.call ?? ((m: Model<never> | Model<string>, c: LlmContext, o: SimpleStreamOptions) => ctx.modelRegistry.streamSimple(m, c, o).result());
	try {
		if (!opts.model) {
			return { ok: false, error: "no current model" };
		}
		const auth = await getAuth(opts.model);
		if (!auth.ok) {
			return { ok: false, error: auth.error };
		}
		const context: LlmContext = {
			systemPrompt: opts.systemPrompt,
			messages: opts.messages,
			tools: opts.tools,
		};
		// cache-key 一致性（D13-5）：不设 maxTokens 覆盖——差异会使前缀缓存整体失效。
		// reasoning 与会话同值透传（虚拟模型分支用它求路由档位；缺省会被算成 off，
		// 与主会话请求档位不同 → 前缀缓存 miss）。"off" 映射为不传（= provider 默认）。
		const options: SimpleStreamOptions = {
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			...(opts.reasoning && opts.reasoning !== "off" ? { reasoning: opts.reasoning } : {}),
			...(opts.signal ? { signal: opts.signal } : {}),
			...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
		};
		const resp = await call(opts.model, context, options);
		if (resp.stopReason === "error" || resp.stopReason === "aborted") {
			return { ok: false, error: failureText(resp), stopReason: resp.stopReason };
		}
		const text = resp.content.map(blockText).join("\n").trim();
		return { ok: true, text, usage: resp.usage, stopReason: resp.stopReason };
	} catch (error) {
		return { ok: false, error: toErrorMessage(error) };
	}
}
