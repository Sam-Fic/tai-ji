# 路由条件求值穷举矩阵（D5 裁决材料）

语义总则（矩阵的推导基础，含 UI 定稿 spec 引入的 mode 维度与特殊日期双型）：

1. 端点按配置顺序求值，命中第一个「条件全满足」的端点；无候选 → 路由失败（AX5，错误逐端点列明落选原因）。
2. 时间窗条件：墙钟（本地时区）落在该端点可用窗内 = 满足；特殊日期优先于周表——exclude 型该日全天判窗外，include 型该日仅指定区间判窗内、其余回落周表（D13 双型）；同一日期多条覆盖取第一条匹配。
   求值模式维度（D12）：simple 模式跳过全部条件判断，直接取第一个端点（下表仅适用于 advanced 模式）。
   burnt 软避让（总则 5）在 simple 模式下仍先生效——避让不是端点条件而是选择层偏好，D6 修订
   「每个请求（user / continuation / retry 同型）都按路由规则完整重算」未豁免 simple： burnt
   端点先被避让，之后才取第一个端点（route-matrix 测试「simple 模式下 burnt 软避让同样生效」按此断言）。
3. 额度条件：额度缓存的百分比是**已用口径**（shared quota-types.ts QuotaWindow.pct「已用百分比 0-100」；declarative-engine 各 via 全部转成已用落缓存，2026-11-07 真机核实 bigmodel percentage = 已用）——判定按剩余换算：**100 − 已用百分比 ≥ 阈值 = 满足**（阈值语义 = 剩余百分比 ≥ thresholdPercent 可选用；UI 与扩展两侧**条件维度**判定式同型，条件显示与条件生效同判）；**数据缺失或过期（新鲜度判定未通过）时该条件按满足处理**（fail-open 到可用，理由见 D5 不采用项——未知即切渠道的代价高于发出去吃一次失败，后者由 D6 修订的终局 failover 在下一轮纠正）。
   **口径边界（ burnt 软避让不进 UI 投影）**：两侧同判仅覆盖条件维度（时间窗 × 额度）。burnt 软避让与 rotateOldestBurnt 全 burnt 轮换（总则 5）是 pi 侧选择层重排，状态持久化于 pi session branch 的 virtual-model-state、renderer 无输入通道可见——故 UI「此刻命中」投影（路由页 chip / 选择器行徽标）按降级口径只宣称「条件命中」，不等于 burnt 生效期的实际路由端点。
4. 两条件并存（时间窗 + 额度）需同时满足。
5. 重试透传与终局 failover（D6 修订，方案 B）：reason=retry 的求值在闭包层**原样返回上一失败端点**——重试归属在途请求的延续，不复查条件（与直连模型同型），pi 的重试预算真正打到上游；终局失败由 decideRoute 的终局观察感知：预算用尽（链内失败计数 ≥ pi.getSettings().retry.maxRetries；重试停用 enabled=false 时预算读 0）→ 该端点 burnt（软避让 = 选择层偏好，不是端点条件），fail-fast（账户/凭据类，pi 压根没重试）→ 不 burnt（主端点错误持续可见，不向候选漂移）。完整状态机见「重试与 failover」章。retry 信号只在 pi 自动重试发生时出现，触发条件受错误分类约束（AS13：瞬态错误重试、配额耗尽文案不重试 fail-fast）。
6. 端点供给侧状态（凭据、provider 存在性）不在求值输入（AX3 最小输入清单）：端点照常参与求值。凭据类供给侧失败在其被命中后的出站层由 pi 透传并经 runtime 结构化呈现；provider 已删 / 模型已移除属配置层悬空端点，求值期闭包解析层按不可解析落选该候选、不发出站请求（AX5 分层）。

## 端点可选性矩阵（按条件类型 × 当前状态）

| 行 | 端点条件类型 | 时间窗状态 | 额度数据状态 | 该端点可选？ | 说明 |
|----|-------------|-----------|-------------|------------|------|
| 1 | 无条件 | —（不判断） | —（不判断） | 可选 | 兜底端点形态 |
| 2 | 仅时间窗 | 在窗内 | — | 可选 | |
| 3 | 仅时间窗 | 在窗外 | — | 不可选 | 落选原因「时间窗外」 |
| 4 | 仅额度阈值 | — | 剩余 ≥ 阈值（新鲜） | 可选 | |
| 5 | 仅额度阈值 | — | 剩余 < 阈值（新鲜） | 不可选 | 落选原因「额度低于阈值」 |
| 6 | 仅额度阈值 | — | 数据缺失 / 过期（未知） | 可选（fail-open） | 未知不判死；真耗尽由终局 failover 在下一轮纠正 |
| 7 | 时间窗 + 额度 | 在窗内 | 剩余 ≥ 阈值（新鲜） | 可选 | |
| 8 | 时间窗 + 额度 | 在窗内 | 剩余 < 阈值（新鲜） | 不可选 | 落选原因「额度低于阈值」 |
| 9 | 时间窗 + 额度 | 在窗外 | 剩余 ≥ 阈值（新鲜） | 不可选 | 落选原因「时间窗外」 |
| 10 | 时间窗 + 额度 | 在窗外 | 剩余 < 阈值（新鲜） | 不可选 | 落选原因「时间窗外 + 额度低于阈值」 |
| 11 | 时间窗 + 额度 | 在窗外 | 数据未知 | 不可选 | 时间窗确定性失败优先；额度未知不挽救 |
| 12 | 时间窗 + 额度 | 在窗内 | 数据未知 | 可选（fail-open） | 同行 6 逻辑 |

## 全体候选状态 → 路由结果矩阵（多端点叠加语义）

| 场景 | 路由结果 |
|------|---------|
| 存在 ≥1 个可选端点 | 命中偏好序最前的可选端点（未 burnt 候选按配置序优先，burnt 降序尾； burnt 只重排不删候选） |
| 全部端点不可选 | 路由失败：对话流结构化错误，逐端点列明落选原因 + 恢复指引（检查端点条件配置 / 凭据 / 额度） |
| retry 求值（reason=retry 且 failed ∈ 配置） | 透传：原样返回上一失败端点（不复查条件），链内失败计数 +1 |
| 非 retry 求值且终局失败（预算用尽） | 该端点 burnt（软避让）：后续求值中未 burnt 候选优先， burnt 候选降序尾 |
| 非 retry 求值且终局失败（fail-fast，无链内计数） | 不 burnt：主端点错误持续可见，下一轮仍选它 |
| 非 retry 求值且成功出站 | 清该端点 burnt + 计数（端点康复，重新成为首选） |
| 全部可选候选都已 burnt | 轮换重探：burn 序最旧的候选优先，移到 burn 序尾（坏端点交替，恢复者不被饿死） |
| 路由配置被禁用（enabled=false） | 扩展保持虚拟模型注册，route 闭包显式失败（错误注明「模型路由已停用，请在设置页重新启用或更换模型」，D9/AX5）——不静默回落；目录注入侧条目随启用状态消失 |
| 路由条目被删除 | 扩展在下次 route 求值前按 mtime 重读发现条目消失 → **本会话保持虚拟模型注册**、route 闭包显式失败（「模型路由已删除，请在设置页重新创建或更换模型」；不调 unregister，避免落到 pi 的 is not registered 原始错误，AS22）；用户更换模型后恢复；runtime 在同一保存内从 scopedModels 移除该路由复合串（D9/U9）→ 路由页无幽灵卡、默认模型 / landing fallback 不指向已删路由；目录注入侧条目随下次 listProviders 聚合消失；关闭重开会话按 resume 语义回落最后应答物理模型或默认模型（UD9） |
| 运行中会话新建路由（未到下次会话加载） | 求值前重读不新增注册（新 id 忽略，D1 ③）；runtime 目录注入即时可见 → 选择器出现该条目，但该会话 set_model 被 pi 以 Model not found 拒绝 → runtime 按路由条目分支映射为「该模型路由在当前会话尚不可用（pi 在会话加载时注册路由），请新建会话后使用」（不落 ENGINE_MODEL_MISSING 双因文案）；新建会话加载（工厂期注册）后可绑定并正常路由（D1 ③/D4） |

## 重试与 failover（D6 修订，方案 B）

**裁决（2026-11-24 用户拍板）**：先按照 pi 的重试规则重试当前真实模型；超过 pi 的重试次数，则 failover 到候选模型。取代原 D6「retry 求值排除上一失败端点」——后者对单端点路由把任何瞬态故障转成必然致命的掩盖性错误（「上一端点失败且无其他可用端点」盖住真实上游错误、重试预算被杀在 1/N），实机事故见 01a202a5 会话（opendesign/deepseek-v4.1-flash 持续 524）。

**pi 契约依据（升级须复核，实装版 node_modules 核实）**：
- `resolveModel` 对 router 返回值的硬约束只有「已注册物理模型 + provider 有凭据」——**返回刚失败的同一个模型合法**，`failed` 是递给 router 的信息（`message` 带 stopReason/errorMessage）不是「必须换端点」的指令（model-runtime.js:744-750 / virtual-models.d.ts:33-54）；
- 终局失败消息**留在投影里**：只有被重试的中间 attempt 被 `_omitRecoveryAttempt` 剔除，预算耗尽那次不剔除，下一轮求值的 `messages` 可见（agent-session.js:2990-3011 `_prepareRetry`）；且 `convertToLlm` 对 assistant 消息原样透传，provider/model/stopReason 全量在场（core/messages.js:111-115）；
- 终局失败消息带物理模型标识，路由自身失败的消息带虚拟模型标识（失败消息由 `_state.model` 构造，路由时 selection 仍是虚拟模型——pi-agent-core agent.js:364-375 / pi-ai api/lazy.js:3-8 / agent-session.js:447-448）——两者可区分，日志实证（01a202a5：524 → opendesign/deepseek-v4.1-flash；路由抛错 → pi-virtual/aggregation/route-3）；
- 重试预算扩展可读：`pi.getSettings().retry?.maxRetries ?? 3`（settings-manager.js:659-666 getRetrySettings，getRetryEnabled 缺省 true）；`auto_retry` 事件族对扩展不可见（ExtensionEvent 联合无该族——extensions/types.d.ts:1038；扩展可见 message_end 但不可见重试决策 payload），「pi 重试了几次」只能由路由回调在 retry 求值时自己点数。

**状态机（三个求值时点）**：

| 时点 | 行为 |
|------|------|
| retry 求值（reason=retry 且 failed ∈ 配置且目录可解析） | **纯透传**：原样返回失败端点，不复查路由条件（重试归属在途请求的延续，直连模型同样不复查）；链内失败计数 +1（闭包内存）；不写 router state |
| 非 retry 求值（user / continuation） | 先**终局观察**后选择：见下表； burnt 变化才写 router state（返回 undefined = pi 不落 virtual-model-state 条目） |
| direct 求值（压缩摘要 / 扩展调用，pi 不传 state） | 不写 state（写了也被丢弃——summarization 路径只取 model/thinkingLevel）；**不做终局观察**（非链边界）：burnt 因 state 缺省退回配置序（边缘：压缩摘要请求可能路由到 burnt 端点一次，可接受）；闭包计数不被改写——链中压缩的 direct 求值夹在「retry bump」与「下一次 stream」之间，其 messages 已被 _omitRecoveryAttempt 剔除失败 attempt，按它观察会抹掉在途链的预算记账（修剪复审 F1，T12 锁定） |

**终局观察**（`request.messages` 从尾向前找最近一条**物理模型** assistant 消息——跳过 provider = AGGREGATION_PROVIDER_ID 的虚拟模型消息，使观察在连续多轮路由失败后凭更早的物理结局**幂等重导**，burn 不因选择层抛错而丢、不需闭包镜像）：

| 最近物理结局 | 动作 |
|-------------|------|
| error + 成员 F，链内计数 ≥ maxRetries（预算真用尽） | burnt F（计数保留作重导证据） |
| error + 成员 F，计数 < maxRetries（fail-fast：401/402/配额类，pi 没重试） | 不 burnt、计数作废——主端点错误持续可见，不向候选漂移（方案 B 与「任何终局错误即换」的分界） |
| stop/toolUse/length（成功出站） | 清 F 的 burnt + 计数（端点康复，重新成为首选） |
| aborted（用户取消在途链） | 计数作废，burnt 不动（取消不是端点事实） |
| 非本路由成员（用户中途换过模型） | 无观察——计数整体退役（本路由的链已终断：孤立旧计数会把后续账户类 fail-fast 误判成「预算用尽」→ 误 burn + 漂移，修剪发现 P1），burnt 保持入参 |
| 未知 stopReason 值（pending/deferred/未来新增值） | 不猜测：不清 burnt（不反向清理偏好）、计数退役（pi-ai StopReason 值域见 fact-check 接口表） |
| 观察作用域（链边界） | 终局观察**只在链边界求值跑**（user / continuation：新回合起点）。retry 落 normal-selection 的求值与 direct 求值（链中压缩 / 扩展调用）不是边界——它们在途投影上看不到刚失败的 attempt（_omitRecoveryAttempt 已剔除），按它迁移状态会抹掉活链记账或按陈旧结局反向清 burn（修剪复审 F1，T12 锁定） |
| 全部消息都是虚拟 error | 无物理结局可观察，burnt 保持入参 |

**选择**：条件求值（硬闸，矩阵 12 行语义不变）→ 候选集内 burnt 软避让（未 burnt 按配置序优先、burnt 降序尾；首选全部悬空时闭包层仍可按序落到 burnt 端点，AX5 韧性不变）→ 全部候选 burnt → 轮换重探（burn 序最旧的候选优先并移到序尾——有序 Set 的 delete+add；坏端点交替重探，恢复即被成功观察清 mark，无时间机制）。

**状态分工**：burnt（跨轮次路由偏好，历史里只有最后一跳结局、更早的 burn 不可从 messages 重导）走 **router state**（pi 持久化在 session branch，`pi.virtual-model-state` 条目，落盘条件 = 返回值 !== undefined 且 !== 入参 state——引用比较，agent-session.js:460-465；写回前裁剪到当前配置成员，手改/fork 注入的非配置 ref 不放大携带——修剪发现 P4）；链内失败计数（生命周期 = 活跃重试链，秒级）活**闭包内存**，不落 session 历史——计数只在「最近物理结局 = 该成员终局 error」时是活的，其余一切形态（成功/取消/未知/非成员/无物理消息）整体退役；burn 时保留该成员计数作重导证据（已 burnt 的重导幂等）。退役只在链边界求值发生（user/continuation）——链中压缩的 direct 求值不碰计数（T12）。进程重启（resume）丢计数：旧终局错误按 fail-fast 重导一次（不 burnt）→ 重选死端点→再烧一轮预算→才 burnt，代价一轮。分支切换/fork 语义（修剪登记）：burnt 与为其背书的终局 error 同 branch 共业——fork 到 burn 前则首轮看不到 burnt、第二轮从 fork 自己的历史重导；原分支 burn 条目隔离不受影响。

**行为后果（预期管理）**：pi 的重试链归 pi 所有，预算耗尽即终局——扩展无法往链里注入额外 attempt，故 failover 落在**下一轮第一个请求**：烧掉预算的那一轮呈现**真实上游错误全文**（修复的核心收益），下一轮起走候选端点。单端点路由在该语义下 ≡ 直连模型（每轮都真试、错误真实呈现）。maxRetries=0（显式设 0 或 retry 停用 enabled=false——停用即零次重试，预算读 0）→ 任何终局 error 即 burnt，failover 即时生效。

**实现落点**：纯函数 `decideRoute` + `parseFailoverState`（router.ts，零 IO——messages/failures/maxRetries 全注入）；闭包层 retry 透传 + `readMaxRetries` + `bumpChainFailure`（index.ts）；单测 route-matrix.test.ts「D6 修订」+「parseFailoverState」两组、端到端 aggregation-hot-reload.test.ts「D6 修订 retry 透传端到端 / failover 端到端 / fail-fast 不换端点端到端 / retry 停用端到端」。实机验收（tree-plant，pi 1.0.0 rpc + 故障注入上游）见 docs/tree-plant/acceptance.md T1-T8。

## 同系统内未穷举的组合清单（诚实登记）

以下组合本矩阵未覆盖，均登记为「当前设计不支持、发生时显式失败或按既有链路语义」：

1. **路由端点引用另一个模型路由作为另一条模型路由的端点**——outOfScope 显式排除；配置校验拒绝该引用。
2. **端点的 provider 被禁用 / 删除**——不在路由求值输入（本表总则第 6 条），两者行为分型（AS16）：禁用（enabled=false）后端点照常出站成功——pi 引擎零消费 enabled，与物理模型会话行为一致，路由不引入特殊拦截；**责任语义（用户裁决 2026-11-06）：引用被禁用 provider 的路由端点必须由用户手动停用路由配置才会停止生效，系统不自动级联**，编辑器标记提示该责任。删除（provider 移除）= models.json 条目随 removeProvider 同步清理（pi-provider-store），端点成为配置层悬空引用——**不出站**：求值期闭包解析层按「不可解析」落选该候选、不发出站请求（pi 虚拟模型契约要求 route 返回已注册物理模型，index.ts evaluateAndRoute；AX5 实施期细化；部分候选不可解析时静默落选、无单独呈现，其余可解析候选按候选序正常命中），全部候选不可解析时结构化错误（buildUnresolvableError）+ 恢复指引（检查路由端点引用的 provider 与模型是否仍然存在）；目录注入侧路由条目本身不受端点级状态阻断（悬空端点由读取侧悬空标记呈现）。
3. **同一端点重复出现在端点列表**——配置校验拒绝保存（重复端点无语义）。
4. **时间窗跨午夜时段**（如 22:00-02:00）——无跨午夜区间语义：specials include 区间由读取侧校验强制同日内（from < to；from ≥ to 判配置损坏，aggregation.ts isValidSpecialDate）；weekly 表是 7×48 布尔网格逐格判断、无区间概念——跨午夜时段由编辑器跨两天格涂抹表达（次日凌晨段登记在次日行的对应格），求值按判断时刻所在格落表（矩阵行 2/3 的「在窗内」判断同此）。
5. **额度 fetcher 本身查询失败**（区别于数据过期）——该端点额度条件按「数据未知」处理（同行 6/12 逻辑）；QuotaService 失败原因透传浮层展示，不进路由决策。
6. **系统时钟回拨 / 时区变更**——时间窗按墙钟即时求值，回拨期间行为跟随墙钟（不做单调性防护；窗口粒度半小时，回拨影响窗口边缘一次判断）。
