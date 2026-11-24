# 仓库事故与抢救记录（REPOSITORY-RECOVERY）

> 日期 2026-11-24 · 分支 `feat-cpu-gpu-performance` · 关联交付 = perf 批2（契约层更新跳过 + 强制布局纪律）

## 1. 事故经过

- 本工作区以**非 bare 主仓 + worktree** 形态组织：主仓 `/Users/zhushanwen/Code/tai-ji`，worktree `worktrees/tai-ji/feat-cpu-gpu-performance` 与 `worktrees/tai-ji/dev-0.13.2` 的 `.git` 文件均指向 `Code/tai-ji/.git/worktrees/<name>`。
- **主仓 `Code/tai-ji`（含 `.git`）被外部删除**（本任务未执行任何删除操作；同期该路径有另一 session 的 `vitest --coverage` 在跑）。删除后两个 worktree 的 git 链接全部断裂。
- 批1（`a8549c5e2→9678ab9e7→c33e76136→0ba734372→2f20e85f9` 5 commit）与批2 trunk（`adc94c8b1→6e4a03f2d→85f659f8f` 3 commit）为**本地 commit，从未推送 GitHub**，其对象库随主仓消亡。

## 2. 不可恢复性（恢复手段全部试过）

| 手段 | 结果 |
|---|---|
| `~/.Trash` | 无 tai-ji（`rm -rf` 类删除，绕过废纸篓） |
| `tmutil listlocalsnapshots /` | 无本地快照 |
| 全盘 `find` 批1/批2 commit 对象（`2f/20e85f9`、`85/f659f8`、`a8/549c5e`） | 零命中；无 `.bare`/其他 tai-ji `.git` |
| `git ls-remote github` | 批1/批2 不在远端（remote `main`=eff28e4a5，无 feat 分支） |

## 3. 抢救内容

- **git 重建**：`rm .git && git init && git remote add origin https://github.com/zhushanwen321/tai-ji && git fetch origin main`。
- **工作树整提为一个 commit `3dc7ae791`**（parent = origin/main `eff28e4a5`），承载全部成果：
  - 批1 delivered：rail 流式冻结 + preview 懒计算 + truncate 码点级 early-exit（派生归零）。
  - 批2 trunk：5 个真机验收探针（`probes/perf-component-render.mjs`、`perf-forced-layout.mjs`、`follow-health.mjs`、`edge-fade-mask.mjs` + 既有 `perf-derivatives.mjs`）+ 共享 `probes/lib/harness.mjs` + 四份 tree-plant 文档（`docs/tp-{design,acceptance,api,fact-check}-batch2.md`）+ `.tree-plant.json`（docs 路径覆写 + `--testTimeout=30000`）。
  - B-props：`Turn.vue`→`UserBubble`（`:user`+标量）/`TurnSummary`（`lastAssistantId`+`isStreaming`+`resolveLastAssistant`）稳定引用 props + 单测（`stable-ref-props.test.ts` + 更新 chat-view-suite/happy-dom-54）。
- **远端保护分支**：`git push origin HEAD:refs/heads/perf-batch-rescue-20261124` = `3dc7ae791`（已验证）。
- **本地 tar 备份**：`/tmp/b2-worktree-backup-*.tar.gz`（179MB，排除 node_modules/.run/dist）。

## 4. 后续影响

- **批1/批2 的细粒度提交历史丢失**（8 个 commit 的对象与 reflog 消亡）——代码内容零丢失，但 git 历史粒度不可复原。
- **tree-plant gate 基线重建**：`.run/root.json` 原基线 `2f20e85f9` 已失效，重跑 root 以 `3dc7ae791`（恢复态全量代码）为新基线；trunk gate 已在 `3dc7ae791` 上重跑通过。此后 branch 的 scope 核对以 `3dc7ae791` 为基准（B-props 已含于该基线，经 T2/T3 真机 case 验证；B-layout/B-polish 为其上的新 commit）。
- 环境修复随抢救保留：`.tree-plant.json` 的 `--testTimeout=30000`（治外部 CPU 争抢下的每例 5s 超时）与 tree-plant gate `CASE_TIMEOUT_MS` 300s→900s（治 3 包 suite 总时长）——非本任务代码，属共享机踩坑后的测试基建调整。

## 5. 状态与续作

- 工作树 clean；`3dc7ae791` 已远端化。
- 续作（从 `3dc7ae791` 重启 tree-plant）：B-props branch gate（T2/T3 真机）→ B-layout（EdgeFade IO 哨兵 + `endOffset+=headOffset` 修 gap + RO 回调几何读清理）→ B-polish（N1 mask 常量）→ leaf → prune → harvest → 回填 `docs/perf/batch2-comparison.md` after 列。
