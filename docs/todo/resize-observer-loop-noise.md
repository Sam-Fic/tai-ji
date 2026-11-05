# ResizeObserver loop 告警刷屏（归因探针已交付，触发源治理待数据）

状态：探针已交付——dev-only 归因探针 `packages/renderer/src/boot/resize-observer-probe.ts`（2026-10-30，分支 fix-console-problem），真机数据未回收；触发源治理（第 2 步）与聚合分支退役（第 3 步）以探针数据为前提，未完成。

## 背景与现状

Chromium 在单帧观察者广播超限时经 window-onerror 派发一条无堆栈固定告警（`ResizeObserver loop completed with undelivered notifications`）。该告警在流式高频场景持续出现，聚合降噪机制（error-reporter.ts 的 D5 聚合分支）已生效并收益实证：

- **聚合前**：renderer-error 日志每天 1477~4467 条逐条错误，真实错误被淹没；
- **聚合后**：命中条目只入窗计数，窗尾（60s）输出一条含次数的汇总——console 汇总收敛为每天 10~30 起（近一日实测 43 波，每波 1~70 次命中）。

聚合是降噪，不是修复：RO loop 事件本身照常发生，只是输出形态收敛。

## 已确认事实 vs 推断

| 陈述 | 类别 | 依据 |
|------|------|------|
| 告警文本固定、无堆栈、由浏览器在帧边界派发 | 已确认事实 | error-reporter.ts 的 `isRoLoopNoiseHit` 判据（window-onerror ∧ 无堆栈 ∧ 规范化全等）；带堆栈的同文本错误不被聚合即实证 |
| 聚合窗计数与窗尾汇总行为 | 已确认事实 | error-reporter.ts `countRoLoopNoise` / `flushRoLoopNoiseAggregate` 实装 + 单测 13 例 |
| 触发源 = virtua 测量环 | 推断（未核实） | 候选观察点含 virtua 0.50.0 库内部 RO（`node_modules/virtua/lib/index.js:375`）与业务 composable 若干（`useMessageStreamFollowTriggers.ts` 的 wrapRo/scrollRo、`tray/use-composer-bar-density.ts`、`drawer/useDrawerSplitWidth.ts`、`terminal/useTerminalXterm.ts`、`browser/useBrowserRectSync.ts`）；原始告警无堆栈、帧边界派发，无法归因到具体观察者——这正是归因探针要回答的问题 |
| 告警量级与 RO 活动频次的对应关系 | 推断（未核实） | 待探针数据回收后对照验证（同一 60s 窗内探针 top 注册点回调次数 vs 聚合汇总次数） |

## 长期方案（三步）

1. **归因探针（本次交付）**：包装全局 ResizeObserver 构造器（dev-only，`import.meta.env.DEV` 提前 return + 死代码消除，prod 零执行零影响），按注册点（构造调用栈派生，覆盖库内部实例）统计每个观察点的回调触发次数，每 60s 窗 console.debug 输出 top 10（一行一条，含注册点文件:行:列）。挂载点 = `main.ts`（mount 前，与 error-reporter 三件套同处）；不改任何既有逻辑，聚合分支保持原样。
2. **按归因修触发源**：探针数据指明高频注册点后，修触发源（如 virtua 测量环的高度抖动、业务观察点的非必要 observe），使 RO loop 告警归零。治理判据 = 真机验证该告警归零。
3. **告警归零后删聚合分支**：退役条件已登记在 error-reporter.ts 的 D5 聚合 section 注释——「数据信号主触发落地且真机验证该告警归零后，随下一次 error-reporter 维护删除本聚合分支」。删除范围 = `isRoLoopNoiseHit` / `countRoLoopNoise` / `flushRoLoopNoiseAggregate` 及相关常量与测试镜像。

## 通道卫生不是修复

把聚合汇总从 console.error 降级为 console.debug / warn（或进一步静默）只是通道卫生：它改变告警的输出级别与可见性，不减少 RO loop 事件的发生，也不降低 renderer-error 落盘量级之外的任何成本。此类调整不触达修复判据（告警归零），不构成第 2 步的替代。

## 探针使用（真机数据回收）

```bash
cd <worktree> && pnpm run dev
```

1. 启动后打开 DevTools（Cmd+Option+I）→ Console 面板；启动即见一行 `[ro-probe] installed (dev-only): ...`——这行是探针生效的确认依据（看不到即探针未装或 dev 标志丢失）。
2. 正常使用触发 RO 的场景（对话流式输出、切换 session、开关 drawer/terminal 等）。
3. 每 60s 窗，Console 输出零到多条 `[ro-probe] 60s window #N: X callbacks, M instance(s), from <文件:行:列>`（按回调次数降序，一行一条；空窗不输出）。若 Console 默认过滤看不到，在左侧级别栏勾选 Verbose。
4. 判读：`#1` 行的注册点即最高频观察点候选；把窗口输出与同时段的聚合汇总（`ResizeObserver loop completed with undelivered notifications xN within 60s (aggregated summary)`）对照，确认量级对应关系。
5. 依赖库（virtua）在 vite dev 下经依赖预构建，stack 帧可能显示为优化 chunk 名而非源文件路径——届时按 chunk 名反查预构建产物定位库，或对该依赖关闭预构建后重取。
6. 复制 Console 输出（含 installed 行）回贴，作为第 2 步的归因输入。
