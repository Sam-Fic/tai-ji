# 真机性能测量工具族（perf-probes toolkit）

> 真机性能测量（CPU profile / GPU trace / TTFT / 滚动行为）共用的探针资产族。本文档是资产
> 清单的 SSOT；脚本本体在 `scripts/perf-probes/`（与本文档同 commit 维护，见下方 closeout
> 纪律）。来源：`feat-cpu-gpu-performance` 分支 tree-plant perf 测量活动的收尾收编登记
> （branch-review dmg-r1-4——原仓库根 `probes/` 一次性脚本族迁入本族并登记）。

## 与 render-sampling 的边界

- [render-sampling](./render-sampling.md)：**渲染形态采样**——页面渲染结果长什么样（DOM 形态 / 截图），服务视觉验收。
- perf-probes（本族）：**性能成本测量**——渲染/运行成本是多少（CDP Profiler / Tracing / metrics 采样），服务性能验收与优化复算。
- 两条管线测量协议不同（Profiler/Tracing 采集 vs DOM 采样），各自独立登记；连接类原语各自维护（render-sampling/lib.mjs 的 `connectPage` 走 Page 域采样连接；本族 harness 走 WS-RPC + Profiler 域），不在对方射程内强行合并。

## harness 单源（连接/校验/拒绝纪律唯一实装）

`lib/harness.mjs` 是本族全部 WS-RPC / CDP 连接、GUI 在场校验、流式窗 CPU profile 采集、
cpuprofile 双口径聚合（inclusive 沿 parent 链 + self-time 帧）的**唯一实装**；族内探针
（perf-derivatives 等）一律消费方，禁止另设连接副本。拒绝纪律（防「没测到东西」也 PASS）：

- GUI 不在目标 session / 窗内采样不足或无渲染活动 → exit 3（DOM 事实判据，非时间推测）；
- 流式未在显式 timeout 内完成 → exit 3（超时值是用户显式传入参数，只弃测，绝不杀进程）；
- PASS/FAIL 只在测量有效后判定 → exit 0/1。

## 数据纪律：原始采集物不入库 + 归档对账

- 原始 CPU 采集物（pi/runtime `.cpuprofile` 内嵌 worktree 绝对路径，rule-22①）**不入库**
  （`.gitignore` `*.cpuprofile`），本体归档会话 artifacts；去向对账清单 =
  [docs/perf/final-measurement/raw-artifacts-manifest.json](../perf/final-measurement/raw-artifacts-manifest.json)（md5/bytes），
  GPU trace 同模式见同目录 `gpu-trace-manifest.json`。
- 门禁（check-final-reports / check-clean-artifacts）经
  `lib/archive-manifest.mjs` 按清单定位归档本体并当场复算 md5——**归档漂移 = 红灯**；
  会话树被人工清理（归档不可达）时按回收容忍显式降级（与 gpu-trace 清单同形态），不静默 PASS。
- 报告与复算命令的 SSOT = [docs/perf/final-summary.md](../perf/final-summary.md) §6-§7。

## 资产清单表（SSOT；closeout 时逐行核对）

| 资产 | 层 | 说明 |
|------|----|------|
| `lib/harness.mjs` | 原语单源 | runtime WS / renderer CDP 连接、GUI 在场校验、流式窗 CPU profile 采集、cpuprofile inclusive/self-time/windowStats 聚合、node inspector 连接；拒绝纪律唯一实装 |
| `lib/archive-manifest.mjs` | 归档对账 | 出库采集物定位（MEAS 原位 → 清单扫描会话树）+ md5 复算；check-* 两门禁共用 |
| `perf-clean-cpu.mjs` / `perf-derivatives.mjs` / `perf-ttft.mjs` / `perf-pi-coldstart.mjs` / `perf-component-render.mjs` / `perf-forced-layout.mjs` / `perf-shiki-worker.mjs` / `perf-ignore-match.mjs` | 采集探针 | 真机流式窗测量（三进程 profile / 派生族 / TTFT / 冷启动 / 组件 / 强制布局 / shiki worker / ignore 匹配），PASS/FAIL 阈值断言 |
| `gpu-trace.mjs` / `gpu-compare.mjs` | GPU 采集 | CDP Tracing 采集（arm 化）与对比；trace 本体归档会话 artifacts |
| `analyze-clean-cpu.mjs` / `analyze-gpu-arms.mjs` / `analyze-gpu-union.mjs` / `analyze-renderer-native.mjs` / `analyze-component-attribution.mjs` / `analyze-original-baseline.mjs` / `cpuprofile-to-folded.mjs` / `deriv-family.mjs` / `shiki-family.mjs` | 离线复算 | 报告数字的机器来源（纯离线，零实例依赖）；cpuprofile-to-folded 产折叠栈（火焰图） |
| `check-clean-artifacts.mjs` / `check-final-reports.mjs` | 验收门禁 | 归档有效性 / 报告↔分析输出数字双向对账（报告数字与落盘分析逐项钉死） |
| `scroll-churn.mjs` / `scroll-count.mjs` / `follow-health.mjs` | 行为探针 | 滚动写归因 / 贴底红线断言（gap ≤4px 违规 exit 5）/ 流式期日志 delta |
| `edge-fade-mask.mjs` / `rail-visual-diff.mjs` / `streaming-placeholder.mjs` / `shiki-html-diff.mjs` / `shiki-fallback-probe.mjs` / `csp-worker-probe.cjs` / `tree-flags-probe.mjs` / `ignore-match-fuzz.mjs` | 场景探针 | batch2-4 验收 case 的单场景断言（EdgeFade mask / rail golden 对拍 / 占位行为 / shiki 对拍与降级 / CSP worker 形态 / tree flags / ignore fuzz） |
| `pi-profile-launcher.mjs` / `b5-start-instance.sh` / `vp/vp.mjs` / `fixtures/` / `golden/` | 辅助 | pi 置换 launcher（macOS `sample` 直采 Bun SEA）/ 隔离实例启动（env 装配）/ verify-taiji runner 的仓内稳定调用路径（纯委托，权威在 `.agents/skills/verify-taiji/scripts/`）/ 合成语料与 golden 基准 |

## 使用

```bash
# 离线复算（报告数字的复现入口，完整命令见 docs/perf/final-summary.md §7）
node scripts/perf-probes/analyze-clean-cpu.mjs baseline=docs/perf/final-measurement final=docs/perf/final-measurement

# 门禁（离线可跑；归档采集物经清单定位 + md5 对账）
node scripts/perf-probes/check-final-reports.mjs
node scripts/perf-probes/check-clean-artifacts.mjs

# 真机采集（需隔离 dev 实例；启动与纪律见 docs/tp-api-batch5.md）
bash scripts/perf-probes/b5-start-instance.sh
```

## closeout 纪律

改族内脚本/新增探针时同 commit 更新本表；`docs/perf/*.md` 与 `tp-*.md` 报告中的调用路径
引用随之同步（路径即本表 SSOT 的投影，禁止报告里出现指向不存在资产的路径）。
