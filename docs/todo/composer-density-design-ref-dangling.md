# mode-system-composer-density 设计档引用悬空（存量注释债，D5 扫描发现）

状态：未解决（2026-11-04 D5 终态同步 R1 机械信号立项；存量债非本设计引入——blame 证实三处引用 2026-09-19/20 u7/u-tray-entry 时代引入）——单列清理待排期。

## 现象

三处注释以「设计 mode-system-composer-density §6.7 D7」作设计依据引用，该设计档名五路检索零命中（仓库 docs/ 与全 git 历史 `git log --all -S`、docs/design 目录（已整体退役 36d9ee6ca）、skill-data tech-design、.zcode、.zcode/v2/visualizations 内容级均无），且无「已删除，git 可追溯」标注。同文件对 composer-task-tray.md 的引用带该标注（仓内先例在案）。

## 位置

- packages/renderer/src/components/panel/tray/ComposerTray.vue:426
- packages/renderer/src/i18n/locales/zh-CN/tray.ts:100
- packages/renderer/src/i18n/locales/en-US/tray.ts:103
- 跨模块同族（D5 扫描标注待一并清理）：packages/renderer/src/components/panel/ModeDeclarationRow.vue:5、packages/renderer/src/__tests__/panel/tray/tray-native-bundle.test.ts

## 量级

纯注释检索死胡同（设计依据不可达），行为零影响；后来者按注释找设计依据耗时重建上下文或误判档案丢失。

## 恢复路径

三处（及同族两处）补「（已退役，不可达，git 可追溯）」式标注，或改写为不依赖该档名的自包含表述（设计依据要点在 git 可追溯的交付 commit 9e11fda4c 等在案）。

## 判定

可接受暂缓：composer-tray-protocol D5 修复循环不扩波及（存量债 + 跨模块 5 文件），单列清理。

## 重审触发

清理注释债的专项 pass（如顺带重构批次）时一并处理；或该注释再次误导排障时提前。
