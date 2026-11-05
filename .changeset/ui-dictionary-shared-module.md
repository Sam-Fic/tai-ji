---
"@zhushanwen/pi-llm-shared": minor
---

新增 `./ui-dictionary` 导出：UI 词典模板渲染机制单点（`t` / `dictionaryKeys`，回落链当前 locale → en-US → 键名），plan / scheduler / subagent-workflow 等 extension 的 i18n 层经 `createUiDictionary` 消费同一实现，各自只持有词典数据。
