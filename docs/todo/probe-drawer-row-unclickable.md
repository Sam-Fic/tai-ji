# probe 抽屉面板行不可点（存量交付缺陷，composer-tray-protocol A5 走查发现）

状态：未解决（2026-11-04 登记）——存量缺陷，非 composer-tray-protocol 引入；单独修复。

## 现象

probe-container-plugin 的右抽屉面板树（探针面板标签页）行不可点击：其推树的行动作声明在 payload 顶层 `hostAction` 字段，与 list-tree v7 的行动作契约（`TreeItem.actions` 行内槽，条目形状 ActionBarItem）脱节——渲染层没有顶层 hostAction 的兼容读取通道，行渲染为纯展示。

## 量级

probe 自该插件交付起「双向导航」（设计 §8.2 S3）即失效，非本次回退。受影响面 = 内置验收插件自身（用户路径零触达）；第三方插件按现行协议（actions 行内槽）声明行动作不受影响。

## 恢复路径

二选一：① probe payload 改嵌套形态（行动作迁 `TreeItem.actions`）；② 渲染层补顶层 hostAction 的兼容读取。

## 判定

可接受暂缓：验收夹具域缺陷，不触达用户路径。

## 重审触发

probe 容器验收需要行导航断言时，或出现第三方插件依赖顶层 hostAction 形态的用法报告。

证据：composer-tray-protocol 验收档案 a5-old-ext-walkthrough 节点 `evidence-final/probe-action-shape-diag.txt`（dev-flow fix-plugin-composer-7f6b6fb7 档案段）。
