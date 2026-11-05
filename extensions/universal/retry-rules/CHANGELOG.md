# @zhushanwen/pi-retry-rules

## 0.2.2

### Patch Changes

- ada38ebfc: chore: refresh dependency range (triggered by @zhushanwen/pi-extension-logger@0.6.2 → @zhushanwen/pi-extension-logger@0.7.0, @zhushanwen/pi-llm-shared@0.12.1 → @zhushanwen/pi-llm-shared@0.13.0)

## 0.2.1

### Patch Changes

- d2b945a20: Added a vocabulary parity test that machine-locks the retryable-error anchors against the current pi AI vocabulary, so a pi upgrade that changes the word list turns the suite red instead of silently un-matching. No behavior change.

## 0.2.0

### Minor Changes

- da658a786: 新增 retry-rules 扩展：对限流类 provider 错误在 message_end 改写错误分类以触发 pi 原生重试循环，规则支持内置基线、远程覆盖与用户自定义三层合并，正则匹配带 ReDoS 防护。
