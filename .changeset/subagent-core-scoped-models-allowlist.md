---
"@zhushanwen/subagent-core": minor
---

派发模型校验新增 scoped-models 白名单：显式指定的模型（工具参数 / agent frontmatter / 用户热切覆盖）须落在 `<agentDir>/config/providers.json` 的 `scopedModels` 清单内（空清单 = 未启用，ctxModel 继承层不拦），并新增导出 `scopedModelKey` / `assertModelWithinScoped` / `readScopedModels` / `getScopedModelsPath` 与 `ModelConfigService.getScopedModels()`。
