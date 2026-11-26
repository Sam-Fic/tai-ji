---
"@zhushanwen/pi-smart-context": patch
"@zhushanwen/pi-llm-shared": patch
---

压缩/标题/分类器的 LLM 调用改经 `ctx.modelRegistry.streamSimple`（虚拟模型感知通路），不再直连 `pi-ai/compat`

会话模型是 provider-aggregation 的模型路由（`api === "pi-virtual"`）时，原先的 `completeSimple` 直连会恒抛 `No API provider registered for api: pi-virtual`：后台压缩连续失败三次熔断、标题生成与权限分类器静默降级。两条通道对虚拟模型的感知能力不对称（compat 是静态 api 目录分发层；`ModelRegistry.streamSimple` 内部先 route 到物理端点再转发），现已统一走 registry 门面，cross-mode 的 `compact()` 也显式传入该 streamFn。附带修复：失败诊断取 `errorMessage`（`lazyStream` setup 失败的唯一载荷），不再只剩「摘要生成未返回结果」。
