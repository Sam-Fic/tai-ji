# 实机验收 case

每条 case 必须在真实宿主/真实进程上执行；命令不得是单测 runner 或 mock 形态（root gate 拒绝）。
真机 case 统一走开发实例装配（真 Electron + 真 pi 子进程 + 真扩展装载 + faux 演员），探针脚本内嵌装配/断言/收尾（scripts/acceptance/）。
预期判据用分号分隔：`exit:0`（缺省）、`contains:子串`、`not-contains:子串`。
关联列 = `trunk` 或枝名（与设计文档树形拆分一致）。
并发约束列 = 独占标记（真机探针 case 起独立开发实例，标「独占」避免并行互扰）；不填 = 可与其他 case 同时运行。

| 编号 | 场景 | 命令 | 预期 | 关联 | 并发约束 |
|---|---|---|---|---|---|
| AC-H12 | 真机：长回合里过程卡窗口不超过 12 行（卡片 ≤ 316px、窗口 ≤ 288px、行高 24px、行间无间隙、窗口内 12 整行可见） | node scripts/acceptance/tape-height.mjs | exit:0;contains:OK-H12 | trunk |
| AC-LOOK | 真机：过程卡长相对齐原型（卡片底色/圆角/内边距；卡头 24px、计数「N 步 · 思考 M」、箭头、无总耗时；行 24px 无间隙；命令行不带工具名、命令与耗时等宽 12px；无分组标题行；滚动条隐藏；进行中轮头亮度不变） | node scripts/acceptance/tape-look.mjs | exit:0;contains:OK-LOOK | tape-look |
| AC-MOTION | 真实浏览器（离线最小页）：带位移的入场动效会临时增大滚动容器的内容高度，只用透明度的动效不改变它 | node scripts/acceptance/motion-overflow.mjs | exit:0;contains:OK-MOTION | tape-look |
| AC-THINK | 真机：已结束的思考占一行且不带正文；点开后全文区在场；进行中的思考只露最新一行、无标签行 | node scripts/acceptance/tape-think.mjs | exit:0;contains:OK-THINK | tape-think |
| AC-CHIP | 真机：卡头活动 chip = 类型词 + 计时，计时随时间增长；窗口内没有第二个实时递增的计时（行内历史耗时不计） | node scripts/acceptance/tape-live.mjs | exit:0;contains:OK-CHIP | tape-live |
| AC-RUN | 真机：执行中的命令行行尾显示最新一行输出与光标 | node scripts/acceptance/tape-live.mjs | exit:0;contains:OK-RUN | tape-live |
| AC-LIVE | 真机：内容不满 12 行时无滚动提示；满 12 行后贴底跟随并提示「更早 N 条」；上滚后停吸并提示「回到最新」，点击恢复；上沿淡出在场 | node scripts/acceptance/tape-scroll.mjs | exit:0;contains:OK-LIVE | tape-scroll |
| AC-SETTLE | 真机：回合落成后过程卡收成一行；点卡头展开 12 行窗口并从第一条读起；再点收起 | node scripts/acceptance/tape-settle.mjs | exit:0;contains:OK-SETTLE | tape-settle |
| AC-DETAIL | 真机：窗口里点一条工具行，右侧详情抽屉打开 | node scripts/acceptance/tape-settle.mjs | exit:0;contains:OK-DETAIL | tape-settle |
| AC-MSW-REPLAY | 回放：真实 pi 会话文件经 reducer 派生出切换行，前后模型正确。场景是 25 个回合的会话（超过历史窗口的 20 个回合），重载后窗口不含文件头那条初始记录，切换行靠窗口起点处的生效模型补基线才出行 | node scripts/acceptance/msw-replay.mjs | exit:0;contains:OK-REPLAY | msw-replay | 独占 |
| AC-MSW-DEDUPE | 回放：会话首个 model_change（初始模型）不出行；同模型重复写入的 model_change 不出行 | node scripts/acceptance/msw-replay.mjs | exit:0;contains:OK-DEDUPE | msw-replay | 独占 |
| AC-MSW-LIVE | 真机：新会话的第一次切换不重载页面就出现切换行（横线分隔行族）；切到另一模型再出一条；切到当前模型不出行 | node scripts/acceptance/msw-live.mjs | exit:0;contains:OK-LIVE-MSW | msw-live | 独占 |
| AC-CORE-EQUIV | 同形：重载页面后对话流由会话文件回放，切换行的条数与前后模型与重载前一致（live ≡ reload） | node scripts/acceptance/msw-live.mjs | exit:0;contains:OK-EQUIV | msw-live | 独占 |
| AC-MSW-MID | 真机：回合进行中切换，切换行出现在该回合内部、新模型内容之前 | node scripts/acceptance/msw-mid.mjs | exit:0;contains:OK-MID | msw-ui | 独占 |
| AC-MSW-ICON | 真机：切换行行首图标为 box（非 cpu/双箭头） | node scripts/acceptance/msw-icon.mjs | exit:0;contains:OK-ICON | msw-ui | 独占 |
| AC-I18N | 静态：新增文案在中英两侧 key 对齐 | python3 .githooks/check_i18n_locale_sync.py | exit:0 | i18n-final |
