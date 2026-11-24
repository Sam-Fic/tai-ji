# 实机验收 case

每条 case 必须在真实宿主/真实进程上执行；命令不得是单测 runner 或 mock 形态（root gate 拒绝）。
真机 case 统一走开发实例装配（真 Electron + 真 pi 子进程 + 真扩展装载 + faux 演员），探针脚本内嵌装配/断言/收尾（scripts/acceptance/）。
预期判据用分号分隔：`exit:0`（缺省）、`contains:子串`、`not-contains:子串`。
关联列 = `trunk` 或枝名（与设计文档树形拆分一致）。

| 编号 | 场景 | 命令 | 预期 | 关联 |
|---|---|---|---|---|
| AC-H12 | 真机：长回合里过程卡窗口不超过 12 行（高度 ≤ 316px、行高 24px、组标题行计入） | node scripts/acceptance/tape-height.mjs | exit:0;contains:OK-H12 | trunk |
| AC-LIVE | 真机：进行中窗口贴底跟随；上滚后卡头出现「回到最新」，点击恢复；滚出的行数写在「更早 N 条」 | node scripts/acceptance/tape-scroll.mjs | exit:0;contains:OK-LIVE | tape-scroll |
| AC-CHIP | 真机：卡头活动 chip（类型词 + 计时）随时间增长；窗口内不存在第二个计时 | node scripts/acceptance/tape-chip.mjs | exit:0;contains:OK-CHIP | tape-chip |
| AC-SETTLE | 真机：回合落成后过程卡收成一行；点卡头展开 12 行窗口；再点收起 | node scripts/acceptance/tape-settle.mjs | exit:0;contains:OK-SETTLE | tape-settle |
| AC-DETAIL | 真机：窗口里点一条工具行，右侧详情抽屉打开 | node scripts/acceptance/tape-detail.mjs | exit:0;contains:OK-DETAIL | tape-settle |
| AC-THINK | 真机：思考在窗口里只占一行（含进行中）；点开后在窗口内展开全文 | node scripts/acceptance/tape-think.mjs | exit:0;contains:OK-THINK | tape-settle |
| AC-MSW-REPLAY | 回放：真实 pi session JSONL 经 core reducer 派生切换行，前后模型正确 | node scripts/acceptance/msw-replay.mjs | exit:0;contains:OK-REPLAY | msw-replay |
| AC-MSW-DEDUPE | 回放：同模型重复写入的 model_change 不出行；会话首个 model_change 不出行 | node scripts/acceptance/msw-replay.mjs | exit:0;contains:OK-DEDUPE | msw-replay |
| AC-CORE-EQUIV | 同形：实时合成 entry 与真实 entry 派生出的切换行字段一致（live ≡ reload） | node scripts/acceptance/msw-equivalence.mjs | exit:0;contains:OK-EQUIV | msw-replay |
| AC-MSW-LIVE | 真机：切换模型成功后，回合之间出现切换行（横线分隔行族） | node scripts/acceptance/msw-live.mjs | exit:0;contains:OK-LIVE-MSW | msw-live |
| AC-MSW-MID | 真机：回合进行中切换，切换行出现在该回合内部、新模型内容之前 | node scripts/acceptance/msw-mid.mjs | exit:0;contains:OK-MID | msw-ui |
| AC-MSW-ICON | 真机：切换行行首图标为 box（非 cpu/双箭头） | node scripts/acceptance/msw-icon.mjs | exit:0;contains:OK-ICON | msw-ui |
| AC-I18N | 静态：新增文案在中英两侧 key 对齐 | python3 .githooks/check_i18n_locale_sync.py | exit:0 | i18n-final |
