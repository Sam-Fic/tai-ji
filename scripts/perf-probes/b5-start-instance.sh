#!/usr/bin/env bash
# 批5 干净测量实例启动（前台可见窗口 + production 模式 renderer bundle + 无 vite dev server）
#
# 与题面 8 条测量纪律的映射：
#   纪律1 prod 构建   → renderer 由 vite preview 静态伺服 apps/electron/renderer/dist（--minify false 保函数名）
#   纪律2 前台可见     → **不设 TAIJI_DEV_BACKGROUND**（设了才走 showInactive）
#   纪律3 无并存      → 探针 perf-clean-cpu.mjs 在采集前枚举并拒绝白名单外 Electron
#   纪律4 同运行三进程 → perf-clean-cpu.mjs 单次运行内采 renderer+runtime+pi
#
# 用法：FIXTURE=scripts/perf-probes/fixtures/original-45k.json DATA_DIR=~/.taiji-dev/verify-b5-final bash scripts/perf-probes/b5-start-instance.sh
# 停止：按全局击杀纪律（端口 + 明确路径 → 逐个打印 argv 甄别 → 一个一个 TERM/KILL）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA_DIR="${DATA_DIR:-$HOME/.taiji-dev/verify-b5-final}"
FIXTURE="${FIXTURE:-$REPO_ROOT/scripts/perf-probes/fixtures/original-45k.json}"
PREVIEW_PORT="${PREVIEW_PORT:-4173}"
CDP_PORT="${CDP_PORT:-9488}"
PORT_OFFSET="${PORT_OFFSET:-410}"      # runtime = 3210 + 410 = 3620
TPS="${TPS:-200}"

cd "$REPO_ROOT"

# ① 静态伺服（幂等：已占端口则跳过）
if ! lsof -ti ":$PREVIEW_PORT" -P >/dev/null 2>&1; then
  echo "[b5] starting vite preview on :$PREVIEW_PORT (serves apps/electron/renderer/dist)"
  nohup pnpm --filter @taiji/frontend exec vite preview --port "$PREVIEW_PORT" --strictPort \
    > "$DATA_DIR-preview.log" 2>&1 &
  for _ in $(seq 1 40); do
    curl -sf "http://localhost:$PREVIEW_PORT" >/dev/null 2>&1 && break
    sleep 0.5
  done
else
  echo "[b5] vite preview already on :$PREVIEW_PORT"
fi

# ② faux 数据目录（保留既有预置；只在缺 responses 时 seed）
if [ ! -f "$DATA_DIR/agent/faux-responses.json" ]; then
  node "$REPO_ROOT/.agents/skills/verify-taiji/scripts/seed-faux.mjs" "$REPO_ROOT" "$DATA_DIR" "$FIXTURE" --force
fi

# ③ dev Electron 壳（前台窗口；renderer 指向 preview 而非 vite dev server）
#    cwd 必须是 apps/electron：dev-electron.mjs 用 `require('electron')` 解析二进制，
#    electron 声明在 apps/electron/package.json（isolated linker 下根 node_modules 无此包）。
echo "[b5] launching dev electron (foreground window, renderer=http://localhost:$PREVIEW_PORT)"
cd apps/electron
# 宿主 env 剥离：本脚本常从打包版 TaiJi.app 的 agent 会话内执行，那里 ELECTRON_RUN_AS_NODE=1
# 会让 Electron 以纯 Node 运行（main.cjs 里 electron.protocol 为 undefined 直接崩），
# 其余 TAIJI_* 是宿主 agent 的运行态标记，必须剥干净（C-proc-09 纪律的同一精神）。
unset ELECTRON_RUN_AS_NODE
unset TAIJI_PRESET_FALLBACK_FROM TAIJI_PRESET_FALLBACK_TO TAIJI_SUBAGENT_CONTROL_SOCKET \
      TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID TAIJI_AGENT_ENGINE_ROOTS TAIJI_AGENT_ENGINE_NODE \
      TAIJI_AGENT_EXT_LOG TAIJI_E2E TAIJI_MOCK VITE_MOCK
TAIJI_AGENT_DATA_DIR="$DATA_DIR" \
TAIJI_AGENT_PORT_OFFSET="$PORT_OFFSET" \
TAIJI_CDP_PORT="$CDP_PORT" \
TAIJI_VITE_DEV_URL="http://localhost:$PREVIEW_PORT" \
TAIJI_FAUX_SCRIPT="$DATA_DIR/agent/faux-responses.json" \
TAIJI_EXTENSION_PATHS="$REPO_ROOT/e2e/fixtures/faux-provider-ext" \
TAIJI_FAUX_TPS="$TPS" \
TAIJI_DEV_EXTRA_CHROMIUM_FLAGS="--disable-backgrounding-occluded-windows --disable-renderer-backgrounding" \
node scripts/dev-electron.mjs .
