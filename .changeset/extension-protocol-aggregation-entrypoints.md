---
"@zhushanwen/extension-protocol": minor
---

Add public subpath exports `./aggregation` (model-routing domain contract: types + validation/pure functions) and `./provider-store-paths` (providers.json / quota-cache.json path formulas). Both modules moved from the private @taiji/shared so npm-published extensions can consume the same single source.
