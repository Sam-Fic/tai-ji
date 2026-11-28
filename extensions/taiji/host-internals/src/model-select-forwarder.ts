/**
 * 模型切换转发（taiji:model-select）：pi `setModel` 只在模型真实变化时向扩展发 `model_select`，
 * 该事件不经 RPC 转发——这里把「切换成功」发成一条隐藏的 custom message（display:false），
 * runtime 分诊后广播 message.modelSwitch 帧，前端合成 model_change entry 喂同一 reducer。
 * 隐藏的原因：回放侧 pi 落盘的同一 custom message 由分组层按 display:false 透明跳过，
 * 切换行只由 model_change entry 派生（live ≡ reload，不重行）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { MODEL_SELECT_CUSTOM_TYPE } from "@zhushanwen/extension-protocol";

export function registerModelSelectForwarder(pi: ExtensionAPI): void {
	pi.on("model_select", (event) => {
		const next = event.model;
		const previous = event.previousModel;
		if (next.id === "") return;
		if (previous !== undefined && previous.provider === next.provider && previous.id === next.id) return;
		const source = typeof event.source === "string" ? event.source : undefined;
		pi.sendMessage(
			{
				customType: MODEL_SELECT_CUSTOM_TYPE,
				content: "",
				display: false,
				details: {
					provider: next.provider,
					modelId: next.id,
					...(previous !== undefined && {
						previousProvider: previous.provider,
						previousModelId: previous.id,
					}),
					...(source !== undefined && { source }),
				},
			},
			{ triggerTurn: false },
		);
	});
}
