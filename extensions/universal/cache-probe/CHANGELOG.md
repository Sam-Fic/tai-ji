# @zhushanwen/pi-cache-probe

## 0.3.7

### Patch Changes

- d2b945a20: 导出函数 `extractSystem` 删除恒不命中的 Google 对象形态 `systemInstruction` 提取分支（pi-ai 1.0.0 实装对该字段恒传 string，对象形态仅手工伪造输入可达）：实装流量下 spFull 哨兵值行为不变（Google 口径仍为 no-system），提取口径按 README 已知限制收窄为三口径。

## 0.3.6

### Patch Changes

- 7babdefa7: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.4 → @zhushanwen/pi-ext-guards@0.5.0)

## 0.3.5

### Patch Changes

- 0c4bec66e: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.3 → @zhushanwen/pi-ext-guards@0.4.4)

## 0.3.4

### Patch Changes

- 802af968f: Pin the pi peer dependency range to ^1.0.0 (smart-context also pins typebox; stale pi implementation anchors in comments refreshed to 1.0.0). No behavior change.

## 0.3.3

### Patch Changes

- 50f31a73c: chore: refresh dependency range (triggered by @zhushanwen/pi-ext-guards@0.4.1 → @zhushanwen/pi-ext-guards@0.4.2)

## 0.3.2

### Patch Changes

- a59739edb: test(guard): unify vitest data-dir guard repo-wide via test-guard factory
