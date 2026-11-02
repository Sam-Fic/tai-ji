---
"@zhushanwen/session-core": minor
---

解析行为变更：会话 JSONL 中 message 存在但 role 不在合法词表（user/assistant/toolResult/system）时，从静默丢弃内容改为整文件解析抛 `UnknownMessageRoleError`（含行号、非法 role 值与恢复动作提示）。消费方需按解析失败处理该文件（升级 taiji 或人工修复该行），不再得到缺内容的成功解析结果。
