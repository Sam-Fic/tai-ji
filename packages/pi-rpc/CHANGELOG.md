# @zhushanwen/pi-rpc

## 1.4.0

### Minor Changes

- d2b945a20: 杀链完成判别改为三值：`killPiProcess` 返回新导出的 `KillOutcome`（already-dead / signal-delivered），发信号失败（进程仍活）改为 reject 新导出的 `KillSignalError`（携带 pid/reason/errno 诊断字段），不再吞错后按成功 resolve——杀失败不再折叠成假成功（下游 pending 永挂、收割计数虚高）。

- d2b945a20: spawn argv 判据常量导出为单源 `PI_SPAWN_MODE_ARGS` / `PI_SPAWN_NO_EXTENSIONS` / `PI_SPAWN_SKILL_FLAG` / `PI_SPAWN_EXTENSION_FLAG`，runtime 按 argv 形态识别 pi 进程的孤儿收割判据与 spawn 构造同引这组常量，避免构造侧改动 flag 后收割判据静默失效。

## 1.3.0

### Minor Changes

- 993ee907f: Main-agent spawn template now loads the builtin tool-search extension (`--extension builtin:tool-search`), enabling on-demand activation of exposure-deferred tools via tool_search; the subagent template keeps the explicit whitelist.

## 1.2.0

### Minor Changes

- 32854b942: Add a runtime model-switch (setModel) protocol across the subagent engine stack. subagent-engine-sdk grows the engine contract: a `setModel` forward method, an optional `capabilities.setModel` flag ("native" | "unsupported"), a dedicated error-code vocabulary (`engine_model_not_in_snapshot`, `engine_credential_missing`, `engine_state_readback_failed`) plus the `engine_run_not_active` not-active code. pi-rpc adds `buildSetModelCommandFrame` for the pi `set_model` RPC command; pi-subagent-cli implements the pi-side control channel (control responses, engine setModel path, stdin writer). zcode-subagent-cli wires the same method through its app-server launcher. subagent-core orchestrates per-record and run-level switches (chat + workflow re-dispatch, override persistence and aggregate replies) and exports the new switch services and types from its barrel.

## 1.1.0

### Minor Changes

- 802af968f: pi 1.0.0 adaptation batch: extension-protocol adds the subagent journal push-channel wire types (marker/report/ack); pi-rpc, subagent-core, session-delivery and zcode-subagent-cli retire the defensive timeout/backoff/retry timer families (finality is now event-driven per ADR-0112/ADR-0122, and session-delivery drops the dead sendAttempts field); pi-subagent-cli passes images and output text through to the subagent drawer projection; subagent-engine-sdk removes the crash-rebuild backoff defense from its surface; session-core accepts pi 1.0.0's four-value message roles so system messages are no longer silently dropped.

## 1.0.0

### Major Changes

- 0d36077d4: Removes the ThinkingLevel literal-whitelist type members: the spawn layer now passes thinking levels through as validated strings (vocabulary single-sourced from @taiji/shared at the host entry layer, which validates before this layer runs).

## 0.3.0

### Minor Changes

- 50f31a73c: The subagent spawn-args template no longer assembles the pi base flags: the `mirrorFlags` parameter and the `PiMirrorFlags` type are removed from `buildPiSubagentSpawnArgs`, which now never emits `--no-extensions` / `--approve` / `--extension` / `--no-context-files` — that responsibility moved to the engine-side spawn chain, which owns `extensionPaths` as an explicit protocol field. In-workspace callers are migrated in the same change; external callers passing `mirrorFlags` must drop the parameter.

## 0.2.3

### Patch Changes

- 8285841af: Spawn args gain an `appendSystemPrompt` option that mirrors `systemPrompt` and emits `--append-system-prompt`, and inline values for both prompt flags now get a leading newline. The prefix constructively distinguishes literal prompt text from pi's argument resolution: pi treats a prompt flag value matching an existing relative path (relative to the session cwd, i.e. the user's project dir) as a file and injects the file's whole content as the prompt, so a mode prompt that happens to equal `AGENTS.md` or `.env` would otherwise be silently replaced by that file — UI shows the intended text while the file content (potentially carrying secrets) is what reaches the model.

## 0.2.2

### Patch Changes

- a59739edb: refactor: drop dead shells and share runtime/subagent primitives
