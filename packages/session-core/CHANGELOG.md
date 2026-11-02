# @zhushanwen/session-core

## 0.13.0

### Minor Changes

- d2b945a20: 解析行为变更：会话 JSONL 中 message 存在但 role 不在合法词表（user/assistant/toolResult/system）时，从静默丢弃内容改为整文件解析抛 `UnknownMessageRoleError`（含行号、非法 role 值与恢复动作提示）。消费方需按解析失败处理该文件（升级 taiji 或人工修复该行），不再得到缺内容的成功解析结果。

## 0.12.0

### Minor Changes

- 802af968f: pi 1.0.0 adaptation batch: extension-protocol adds the subagent journal push-channel wire types (marker/report/ack); pi-rpc, subagent-core, session-delivery and zcode-subagent-cli retire the defensive timeout/backoff/retry timer families (finality is now event-driven per ADR-0112/ADR-0122, and session-delivery drops the dead sendAttempts field); pi-subagent-cli passes images and output text through to the subagent drawer projection; subagent-engine-sdk removes the crash-rebuild backoff defense from its surface; session-core accepts pi 1.0.0's four-value message roles so system messages are no longer silently dropped.

## 0.11.0

### Minor Changes

- 43a50ae2e: New package: canonical session model and zero-dependency JSONL primitives shared by session readers and importers. Exports the strict `Entry`/`ParseResult`/`SessionHeader`/`NormalizedSession` model, `parseSessionContent`/`parseSessionFile`, the pi-byte-compatible `serializeSession`, the `readFirstJsonlLine`/`readFirstJsonlLineSync` first-line byte primitive (CRLF/LF aware), the `sessionIdFromFileName` filename invariant, and the `normalizeZcodeRowId` zero-padded hex id normalizer. Header validity predicates are intentionally excluded — each consumer keeps its own thin wrapper.
