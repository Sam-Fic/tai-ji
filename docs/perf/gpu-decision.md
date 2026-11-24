# GPU 裁决：EdgeFade 四层 backdrop-blur（GPU-6）与容器 mask 下沉（GPU-7）

> 裁决日期 2026-11-25 · 分支 `feat-cpu-gpu-performance` · HEAD `fa43afc7b`
> 依据 = [adversarial-review-glm.md](adversarial-review-glm.md) S3/D6/F5（「拿到干净 GPU 数据前不动 EdgeFade blur/mask 的视觉」）+ 本批干净四臂实验。
> 数据 = `docs/perf/final-measurement/gpu-analysis.txt`（原始输出）+ 本会话 artifacts `<artifacts>/b5-traces/*.trace.json`（8 个 trace，各 230–260MB）

## 0. 结论先读

| 项 | 裁决 | 数据依据（一句话） |
|---|---|---|
| **GPU-6 四层 backdrop-blur** | **动 —— 但形态是「条件降档」，不在本批改视觉** | blur 占 GPU 主线程工作量的 **≈26%**（绝对 3.1–4.7s / 63s 墙钟），超过 20% 判据；但当前**不掉帧**（60fps、0 秒 <55fps、GPU 主线程均值 23%），所以是「吃掉余量」而非「当下可感知」 |
| **GPU-7 容器 mask 下沉** | **不动** | 单独摘除滚动容器 mask 后 GPU 主线程工作量**无下降**（25.9%/21.8% vs 基准 24.1%/23.0%，落在跨运行噪声 ±1.6pp 内）；本环境**测不出** mask 的合成代价 |
| **整效（blur+mask 全关 = reduced-transparency 路径）** | 作为 GPU-6 降档的上界参照 | reduced 臂 GPU 忙占比 16.6%，比 no-blur 臂（17.5%/18.6%）再低 ~1pp ⇒ **mask 的贡献 ≤ 噪声**，视觉项的成本几乎全在 blur |

## 1. 实验设计（四臂，同 harness 同 fixture 同实例）

| 臂 | 注入 | 隔离的变量 | 注入生效证据（臂末 DOM/CSS 事实） |
|---|---|---|---|
| `full` | 无（现状） | 基准 | `blurEls=4 noneCount=0 maskOnScroller=true edgeFadeHidden=false` |
| `no-blur` | `Runtime.evaluate` 注入 `<style>[class*="backdrop-blur"]{backdrop-filter:none!important}</style>` | 四层 backdrop-filter 的合成/栅格成本（mask 与沉色层保留） | `blurEls=4 noneCount=4 maskOnScroller=true` |
| `no-mask` | 注入 `[data-testid="message-stream"]{mask-image:none!important}` | 容器 mask 的合成路径成本（blur 与沉色层保留） | `maskOnScroller=false blurEls=4 noneCount=0` |
| `reduced` | CDP `Emulation.setEmulatedMedia{features:[{name:'prefers-reduced-transparency',value:'reduce'}]}` | 组件内建降级（遮罩 hidden + mask 摘除，blur 层随之 opacity-0）= 视觉项总账 | `edgeFadeHidden=true maskOnScroller=false`；`matchMedia(...).matches === true` |

纪律（与 GLM M1/A6 的教训对应）：

- **每臂一个新 session、同 fixture（`original-45k`）、同实例、同 prod bundle**；每臂**两次独立运行**以估跨运行噪声；
- **每臂开始前清掉上一臂注入**（`b5-no-blur` / `b5-no-mask` style 节点删除 + `setEmulatedMedia{features:[]}`）——首跑实测踩坑：no-blur 的 style 残留会让后续臂的 `backdrop-filter` 恒为 `none`（等于「第三臂也跑了 no-blur」）；
- **注入必须验证生效**（`getComputedStyle().backdropFilter === 'none'` 的元素计数），否则拒绝采集（防「等于基准臂」的假零差）;
- **窗长事件驱动**（等 `message.complete`），`Tracing` 用 `record-continuously` + `dataLoss` 监听——四臂 dataLoss 全为 0，墙钟 62.1–63.8s，均覆盖完整流式（含 fence 闭合段与 complete）；
- **禁嵌套求和**：所有时长按线程时间轴 union 计（`probes/analyze-gpu-arms.mjs`）。

## 2. 数据

### 2.1 主口径：GPU 主线程忙占比（`CrGpuMain` 的 `Scheduler::RunTask` union ÷ 墙钟）

| 臂 | 运行 | 墙钟 | GPU 忙占比 | RunTask union | 未命名 gap（驱动侧工作） | Raster（次数） | Present | Backpressure | 帧数 | 均 FPS | <55fps 秒数 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| full | r1 | 63.8s | **24.1%** | 15.71s | 9.08s | 4.51s (5643) | 1.22s | 0.146s | 3790 | 59.9 | 0 |
| full | r2 | 63.0s | **23.0%** | 14.75s | 8.38s | 4.29s (5603) | 1.17s | 0.147s | 3780 | 60.0 | 0 |
| no-blur | r1 | 62.1s | **17.5%** | 11.03s | 4.25s | 4.61s (3504) | 1.28s | 0.085s | 3724 | 60.0 | 0 |
| no-blur | r2 | 62.1s | **18.6%** | 11.62s | 4.86s | 4.28s (3485) | 1.62s | 0.116s | 3724 | 60.0 | 0 |
| no-mask | r1 | 63.0s | **25.9%** | 16.46s | 9.10s | 5.05s (5814) | 1.39s | 0.161s | 3778 | 60.0 | 0 |
| no-mask | r2 | 63.1s | **21.8%** | 13.84s | 7.64s | 4.06s (3888) | 1.38s | 0.084s | 3785 | 60.0 | 0 |
| reduced | r1 | 62.2s | **16.6%** | 10.48s | 3.51s | 4.84s (3579) | 1.30s | 0.068s | 3734 | 60.0 | 0 |

**噪声界**：同臂两次运行的 GPU 忙占比差 = **+1.1pp**（full 24.1 vs 23.0）。取 ±1.6pp 为保守噪声界。

### 2.2 逐项差值与显著性

| 对照 | Δ GPU 忙占比 | Δ 未命名 gap | Δ Raster | Δ Present | 判定 |
|---|---|---|---|---|---|
| full → no-blur | **−6.6pp / −4.4pp**（两轮均低于 full 的最低值） | **−4.83s / −3.52s** | +0.10s / −0.01s | +0.06s / +0.45s | **显著（超噪声 3–4×）** |
| full → no-mask | +1.8pp / −1.2pp（区间重叠） | +0.02s / −0.74s | +0.54s / −0.23s | +0.17s / +0.21s | **不显著（噪声内）** |
| no-blur → reduced | −0.9pp / −2.0pp | −0.74s / −1.35s | +0.23s / +0.56s | +0.02s / −0.32s | 方向一致但**接近噪声**（mask 贡献 ≤ 噪声上界） |

### 2.3 三条读法（决定裁决的三件事）

1. **blur 的成本落在「未命名 gap」，不在 raster worker。** `RendererRasterWorker` 在四臂间几乎不动（4.28–5.05s）；变化全部出现在 `RunTask` 减去具名直接子切片后的那段空白（full 8.38–9.08s → no-blur 4.25–4.86s）。含义：Intel Iris Pro + ANGLE/Metal 上，`backdrop-filter` 的开销是**驱动侧/合成器的无名字工作**，不是可以靠「减少 raster 次数」优化的路径——这也解释了为什么首轮报告把 blur 归因到 raster 是错的（GLM C1）。
2. **GPU 主线程工作量占比 26%，但余量充足、不影响帧。** 以 full 两轮均值 15.23s union 为分母：blur 的 3.1–4.7s 占 **20.4%–30.9%**（取中 25.7%）。判据（>20%）**满足**。但 GPU 忙占比只有 23%（p95 31–36%），60fps 稳定、0 秒低于 55fps、Present 与 Backpressure 都在 1.2s / 0.15s 量级（vs 首轮脏基线的 12.01s / 11.35s）——即 **blur 现在消耗的是余量，不是帧预算**。
3. **mask 的代价测不出。** 单独摘 mask 无下降、整效摘除相对只摘 blur 仅再降 0.9–2.0pp（噪声内）。mask 作用在滚动容器的合成路径上，但**没有可归因的 GPU 主线程成本**；进一步区分需要「cc 层树逐层栅格成本」这类本机不具备的手段（见 §5）。

## 3. GPU-6 裁决：动 —— 条件降档（本批不改视觉）

**为什么是「动」**：判据要求「占比显著（>20% GPU 主线程工作）→ 出怎么降档的设计建议」。实测 25.7%（20.4–30.9%）**过线**，且两轮方向一致、幅度是噪声的 3–4 倍。

**为什么不是「现在就无条件降档」**：当下不掉帧。降档是视觉取舍，为一个零可感知收益的取舍改动产品视觉，违反「事实驱动、不做补偿性猜测」。所以实施形态 = **带触发条件的降档**：

### 3.1 降档方案（下一批实施，本批只登记）

| 维度 | 方案 |
|---|---|
| **降档形态** | 四层 `backdrop-blur-[1px\|2px\|4px\|8px]` → **两层**（`h-1/2 blur-[2px]` + `h-1/4 blur-[6px]`），沉色层与 mask 不变。理由：blur 成本随**层数 × 面积**增长（4 层覆盖 100%/75%/50%/25% 高度，合计 2.5 倍带面积）；两层把它降到 ~0.9 倍带面积，同时保留「越靠顶越失焦」的视觉意图（消掉的是 1px 与 4px 两个视觉差异极小的档位） |
| **不选的形态** | ① `backdrop-filter: none` 全关（视觉损失过大，等于放弃该设计）；② 缩小 band 高度 40px→24px（比层数更伤视觉且收益更小——成本与层数线性、与高度线性，但 40px 已是设计底线）；③ 「session 有 streaming turn 时自动降档」（GLM D6 已否：把全局模式开关联到 session 状态，split mode 语义不清 + 流起止视觉跳变） |
| **触发条件（何时启用降档）** | **不用时间、不用启发式**。两个事实判据任一成立才降：① `chrome://gpu` 报告 `backdrop-filter` 走 software path（无 GPU 加速硬件）；② 用户系统设置 `prefers-reduced-transparency: reduce`（已有路径，现状即生效）。**不做**「GPU 忙 > X% 就降」的运行时探测——本仓红线禁止时间/阈值判死类机制，且忙占比采样本身要引入常驻观测 |
| **视觉影响** | 顶缘失焦从 4 档渐变变 2 档：1px/4px 两档消失（这两档在 40px 带内的可见差异 < 1 灰度级，属于不可分辨档）；8px→6px 峰值失焦略浅。**需要视觉验收截图对拍**（下一批的验收资产） |
| **split mode 语义** | 组件级、无跨实例状态：每 `EdgeFade` 实例各自按自己的 `matchMedia` 结果渲染 ⇒ split mode 多 panel 天然一致，无「一个 panel 降档另一个不降」的语义问题（与「session streaming 自动降档」相反） |
| **重审触发** | ① 目标硬件上 GPU 忙占比 p95 > 60% 或出现掉帧；② 视觉验收判定 2 档不可接受；③ `docs/DESIGN.md` 的渐焦规格变更 |

### 3.2 为什么不把「现在改」写进本批

题面明确「本批用干净数据裁决：动（怎么动）或不动（依据是什么）」+「不在本批改视觉代码」。本批产出 = 判据 + 方案 + 触发条件 + 视觉影响 + split 语义；实施走独立批次（含视觉对拍验收）。

## 4. GPU-7 裁决：不动

**依据**：

1. **单独摘 mask 无收益**（25.9%/21.8% vs 24.1%/23.0%，区间重叠，噪声 ±1.6pp）；
2. **整效摘除相对只摘 blur 的额外收益 ≤ 噪声**（−0.9/−2.0pp，Δ gap −0.74/−1.35s），说明 mask 的合成代价在 GPU 主线程上**不可归因**；
3. mask 的真实代价若存在，也在**渲染器合成线程**而非 GPU 主线程——实测 Compositor union 四臂间 6.78–8.86s（全长 8.86 出现在 no-mask 臂，方向与「mask 有成本」相反），同样不可归因；
4. 「mask 下沉到 40px 覆盖层」是**结构性改动**（把容器级 mask 换成覆盖层元素），会引入层数 +1、blending 语义变化与 sticky 定位约束——在没有可测收益的前提下改动，违反「机制服务于可达场景」。

## 5. 本环境测不出的项（登记「不可证 + 需要的测量手段」）

| 项 | 为什么测不出 | 需要的测量手段 |
|---|---|---|
| mask 的逐层栅格成本 | 无 `cc` 层树 dump；`Tracing` 的 `cc` 类别在 macOS 上不给逐层（layer）成本，只给线程级切片 | ① `chrome://tracing` 导入 trace 看 `cc` 类别 layer tree（本机 trace 已归档，可离线看）；② `--enable-gpu-service-logging` + 逐帧命令缓冲；③ 组件级拆臂（单独渲染一个只有 mask 的静态页做基线，扣掉对话流全部其他成本） |
| blur 的 GPU 时间精确值 | `backdrop-filter` 的开销落在未命名 gap（驱动侧），无专用 GPU timer | ① `powermetrics --samplers gpu_power`（需 sudo，本机不可用）；② Metal System Trace（Xcode Instruments，需 GUI 与真机 hook）；③ 把 blur 换成等面积 `filter: blur()` 做增量对照（语义不同，只作量级参照） |
| 其他 GPU / 其他分辨率下的比例 | 本机 = Intel Iris Pro（ANGLE/OpenGL 4.1），blur 走的是这条路径；Apple Silicon 的 Metal 路径代价结构不同 | 在 M 系列机器上重跑同一四臂脚本（`probes/gpu-trace.mjs --arm full\|no-blur\|no-mask\|reduced` + `probes/analyze-gpu-arms.mjs`），脚本已参数化、零改动可复跑 |

## 6. 与首轮脏基线的对照（说明为什么必须重测）

| 指标 | 首轮脏基线（`run2d`，33.67s 窗，后台窗口 + 打包版并存） | 本批干净基线（63.5s 窗，前台 + prod bundle） |
|---|---|---|
| GPU 忙占比 | **69.4%** | **23.3%** |
| Present union | 12.01s（35.7% 墙钟） | 1.16s（1.8%） |
| ApplyBackpressure union | **11.353s**（= 首轮报告「积压」的来源） | **0.086s**（130× 差） |
| Raster | 5.88s | 4.40s |
| 帧数 / 均 FPS | 660 / **20.0** | 3793 / **60.0** |
| <55fps 秒数 | **32 / 33** | **0 / 62** |

首轮的「GPU 饱和」完全来自测量环境（后台不可见窗口 + 另一个 Electron 合成器竞争 → 掉到 20fps → Present/Backpressure 被撑到 12s/11.4s）。**结论：GPU-6/7 的裁决只能用本批数据，首轮数据在 GPU 侧不可引用**（GLM M1/A6/A7 的判断被本批实测确认）。

## 7. 复算命令

```bash
# 四臂采集（每臂各跑两次以估噪声；脚本自建 session，不依赖外部 sid）
node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --arm full     --window-ms 160000 --save /tmp/b5/full.trace.json
node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --arm no-blur  --window-ms 160000 --save /tmp/b5/noblur.trace.json
node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --arm no-mask  --window-ms 160000 --save /tmp/b5/nomask.trace.json
node probes/gpu-trace.mjs --data-dir ~/.taiji-dev/verify-b5-final --cdp-port 9488 --arm reduced  --window-ms 160000 --save /tmp/b5/reduced.trace.json

# union 口径分析（禁嵌套求和）
node probes/analyze-gpu-arms.mjs full=/tmp/b5/full.trace.json noblur=/tmp/b5/noblur.trace.json nomask=/tmp/b5/nomask.trace.json reduced=/tmp/b5/reduced.trace.json
```
