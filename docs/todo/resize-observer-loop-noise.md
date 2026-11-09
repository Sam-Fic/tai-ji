# ResizeObserver loop 告警刷屏（归因已完成：环主体在 virtua 库内部，业务侧不可归零）

状态：**归因完成（2026-11-08，分支 fix-quota-refresh-probe-trigger）**——dev 实例探针真机数据回收，流式期 top 注册点 = useMessageStreamFollowTriggers 的 wrap RO（14 回调/60s 窗）与 virtua 库内部 RO（10 回调/窗），告警计数（x10~x12/窗）与两者活动量成正比（restore 期 3+4 回调对告警 x2，同比例关系）。两项修复真机实测后告警量级不变，环主体定位在 **virtua 库内部测量-写入模型**（其 RO 回调同步写 spacer/transform，扰动同帧内其他被观察元素），业务侧不可归零；聚合降噪分支（error-reporter D5）按「告警归零才退役」条件**保留为终态**。

已落地的两项改善（均真机验证不劣化、测试全绿）：

1. **virtua 0.50.0 → 0.54.2**：吸收上游 0.54.0 的 loop 告警抑制（PR #952，机制 = RO 回调期间新订阅延迟一帧 observe——只防库内部新 observe 环，防不了跨观察者帧内反馈，故告警量级未降，但升级本身正向且用法面窄：Virtualizer 组件 + handle 类型，5 文件）。
2. **wrap RO 回调零强制布局读**：tailEl 纳入同一 RO（box:'border-box'，高度语义 = offsetHeight），tailHeight 直接取 entry，消除回调内 offsetHeight 同步读（RO 回调内同步读其他元素几何会 flush 待处理布局——结构上正确的修复，实测非告警成因）。

后续方向（未做，超出业务侧修复射程）：向上游 inokawa/virtua 反馈跨观察者帧内反馈形态（流式追加 + 外层 wrapper RO 联动的 undelivered 告警，0.54.2 suppress 未覆盖）；或评估替换虚拟列表实现。

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
| 高频注册点 = wrap RO（useMessageStreamFollowTriggers）+ virtua 库内部 RO | 已确认事实（2026-11-08 探针真机数据） | 流式期窗：wrap RO 14 回调、virtua 10 回调，其余注册点 ≤3；同窗聚合告警 x10~x12，量级随两者活动同涨落（restore 期 3+4 回调对 x2） |
| 环主体在 virtua 库内部（RO 回调同步写 spacer/transform 扰动同帧被观察元素） | 已确认事实（排除法实证） | 业务侧回调全只读 + rAF 延迟写；升级 virtua 0.54.2（含上游 suppress）与消除回调内强制布局读两项修复后，真机流式窗告警量级均不变（x12） |

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
