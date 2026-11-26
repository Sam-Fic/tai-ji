# @zhushanwen/pi-llm-shared

## 0.13.1

### Patch Changes

- 2cffda2dc: 压缩/标题/分类器的 LLM 调用改经 `ctx.modelRegistry.streamSimple`（虚拟模型感知通路），不再直连 `pi-ai/compat`

  会话模型是 provider-aggregation 的模型路由（`api === "pi-virtual"`）时，原先的 `completeSimple` 直连会恒抛 `No API provider registered for api: pi-virtual`：后台压缩连续失败三次熔断、标题生成与权限分类器静默降级。两条通道对虚拟模型的感知能力不对称（compat 是静态 api 目录分发层；`ModelRegistry.streamSimple` 内部先 route 到物理端点再转发），现已统一走 registry 门面，cross-mode 的 `compact()` 也显式传入该 streamFn。附带修复：失败诊断取 `errorMessage`（`lazyStream` setup 失败的唯一载荷），不再只剩「摘要生成未返回结果」。

## 0.13.0

### Minor Changes

- ada38ebfc: 新增 `./ui-dictionary` 导出：UI 词典模板渲染机制单点（`t` / `dictionaryKeys`，回落链当前 locale → en-US → 键名），plan / scheduler / subagent-workflow 等 extension 的 i18n 层经 `createUiDictionary` 消费同一实现，各自只持有词典数据。

## 0.12.1

### Patch Changes

- d2b945a20: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.5.0 → @zhushanwen/pi-ext-guards@0.5.1)

## 0.12.0

### Minor Changes

- df839883b: 新增目录缓存判据模块 catalog-overlay：taiji 目录缓存与 pi store 两份缓存文件的解析、条目级新者胜合并、三态判定（fresh / expired / never-seen）与注入集并集计算，纯函数零 IO——扩展侧目录投喂的判据单点；导出面新增 getTaijiOverlayCachePath / getPiStorePath / getCatalogOverlayState / getCatalogGeneratedAt / mergeEntriesNewerWins / parseOverlayCache / computeInjectionSet 及配套类型。

## 0.11.3

### Patch Changes

- 7babdefa7: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.4 → @zhushanwen/pi-ext-guards@0.5.0)

## 0.11.2

### Patch Changes

- 0c4bec66e: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.3 → @zhushanwen/pi-ext-guards@0.4.4)

## 0.11.1

### Patch Changes

- 802af968f: (no changeset body; patch version bump)

## 0.11.0

### Minor Changes

- 0d36077d4: thinkingLevel 校验改为归一透传：移除 `isThinkingLevel` 七值白名单谓词，新增 `normalizeThinkingLevel`（非空字符串原样返回，其余返回 undefined）。不再自持档位词表——配置合法性的判定归属写入侧 UI 与 pi 运行时按模型 supportedLevels 判定，词表外档位不再被本层静默换成默认档。

## 0.10.1

### Patch Changes

- 50f31a73c: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.1 → @zhushanwen/pi-ext-guards@0.4.2)

## 0.10.0

### Minor Changes

- 43a50ae2e: Consolidates the duplicated `readUiLocale` implementation (mtime+size cached read of `<dataDir>/ui-preferences.json` with en-US fallback) that existed verbatim in both the plan and scheduler extensions into a single shared implementation in `@zhushanwen/pi-llm-shared`, exported from the new `./ui-locale` subpath (`readUiLocale`, `DEFAULT_UI_LOCALE`, `UiLocale`). The subpath entry keeps the locale reader free of the `@earendil-works/pi-ai` imports carried by the main barrel, so consumers without an LLM runtime resolve it cleanly. plan and scheduler now import the shared reader; behavior (locale values, cache semantics, fallback chain, `@data-owner #39` annotation) is unchanged. Also in `@zhushanwen/pi-llm-shared`: the `callLLM` success result now carries an optional terminal `stopReason` (additive, present only when reported), letting callers distinguish `length` budget truncation from a normally empty completion on `stop`.

## 0.9.0

### Minor Changes

- 8285841af: Consolidates the duplicated `readUiLocale` implementation (mtime+size cached read of `<dataDir>/ui-preferences.json` with en-US fallback) that existed verbatim in both the plan and scheduler extensions into a single shared implementation in `@zhushanwen/pi-llm-shared`, exported from the new `./ui-locale` subpath (`readUiLocale`, `DEFAULT_UI_LOCALE`, `UiLocale`). The subpath entry keeps the locale reader free of the `@earendil-works/pi-ai` imports carried by the main barrel, so consumers without an LLM runtime resolve it cleanly. plan and scheduler now import the shared reader; behavior (locale values, cache semantics, fallback chain, `@data-owner #39` annotation) is unchanged.

## 0.8.1

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
