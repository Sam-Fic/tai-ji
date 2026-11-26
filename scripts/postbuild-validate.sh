#!/bin/bash
# scripts/postbuild-validate.sh — 打包后产物验证
#
# 检查项：
# 1. 产物存在性（dmg/exe/AppImage）
# 2. macOS/Windows unpacked app 结构（main executable, asar, runtime, native resources）
# 3. asar 内容正确性
# 4. renderer/mobile WASM chunk 检查（CSP 能力防线：产物级拦截依赖暗藏的可执行 WASM）
# 5. 产物大小合理性
#
# 用法: ./scripts/postbuild-validate.sh [--ci] [--dir-only]（参数顺序无关）

set -euo pipefail

# 检查失败原则：任何非 0 退出都输出（不管从哪个 exit 点）
trap '[ $? -ne 0 ] && echo "[原则] 无论是否本次改动引入的问题，都必须当场直接修复解决，不允许跳过。" >&2' EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 参数解析（位置无关：循环遍历所有 args，任意顺序解析结果一致）：
# - --dir-only：只验证 unpacked 目录（跳过安装器产物检查）
# - --ci：接受的 no-op flag。原 CI_MODE 变量自 main 起设置后全脚本无读取点
#   （死变量，grep 全仓确认），已删除；build.yml 调用仍传 --ci，保留解析以兼容。
DIR_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --dir-only) DIR_ONLY=true ;;
        --ci) ;; # no-op（原 CI_MODE 死变量已删）
        *) echo "未知参数: ${arg}（支持: --ci --dir-only），已忽略" >&2 ;;
    esac
done

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# staged 引擎 CLI 包完整性校验（W9，设计 §3.7 Electron 打包态，三平台共用）：
# bundle-extensions.mjs 预 bundle 到 resources/engines/<id>/ + electron-builder
# extraResources 拷贝。断言：目录存在、每引擎 index.js 存在且可执行（发现器
# canExecute 判据）、package.json 的 manifest id == 目录名、bin 映射指向 ./index.js。
# 任一失败 = 打包配置回归（bundle 脚本漏跑 / yml extraResources 漏拷 / staged 退化）。
check_staged_engines() {
    local engines_dir="$1"
    if [ ! -d "$engines_dir" ]; then
        echo -e "  ${RED}✗${NC} engines 目录缺失: ${engines_dir}（检查 bundle-extensions.mjs 引擎 staging + electron-builder.yml extraResources）"
        return 1
    fi
    local failed=0 count=0
    for engine_dir in "$engines_dir"/*/; do
        [ -d "$engine_dir" ] || continue
        count=$((count + 1))
        local engine_id; engine_id="$(basename "$engine_dir")"
        if [ ! -x "${engine_dir}index.js" ]; then
            echo -e "  ${RED}✗${NC} engine ${engine_id} 缺可执行 index.js: ${engine_dir}index.js"
            failed=1
            continue
        fi
        if ! node -e '
            const fs = require("fs");
            const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            const m = pkg["taiji"]?.subagentEngine;
            const ok = m?.id === process.argv[2]
                && typeof m?.bin === "string" && m.bin !== ""
                && pkg.bin?.[m.bin] === "./index.js";
            process.exit(ok ? 0 : 1);
        ' "${engine_dir}package.json" "$engine_id" 2>/dev/null; then
            echo -e "  ${RED}✗${NC} engine ${engine_id} staged package.json manifest/bin 无效（id≠目录名 或 bin 未指向 ./index.js）"
            failed=1
        fi
    done
    if [ "$count" -eq 0 ]; then
        echo -e "  ${RED}✗${NC} engines 目录为空: ${engines_dir}（packages/*-subagent-cli 未 staged）"
        return 1
    fi
    if [ "$failed" -ne 0 ]; then return 1; fi
    echo -e "  ${GREEN}✓${NC} staged engines 完整性校验通过（$count engines: ${engines_dir}）"
    return 0
}

# renderer/mobile WASM chunk 扫描（CSP 能力防线，产物级，桌面与移动壳共用）。
# 用法: check_wasm_chunks <产物 assets 目录> <对应 index.html> <产物标签> <构建命令提示>
# CSP script-src 放行 eval/wasm 时该能力合法，跳过；否则白名单外含 WebAssembly
# 的 chunk 即失败（防「依赖暗藏 WASM → CSP CompileError → 功能静默降级」）。
check_wasm_chunks() {
    local dist_assets="$1" index_html="$2" label="$3" build_hint="$4"
    if [ ! -d "$dist_assets" ]; then
        echo -e "  ${RED}✗ ${label} 产物缺失: ${dist_assets}（先 ${build_hint}）"
        return 1
    fi
    # 判定基准 = CSP meta 的 content 值（不能 grep 全文件——index.html 注释里出现
    # 'wasm-unsafe-eval' 字样会被误判成放行，防线恒跳过；与
    # .githooks/check_csp_compatibility.py 的 parse_csp_script_sources 同语义）
    local csp_content
    csp_content="$(node -e '
        const html = require("fs").readFileSync(process.argv[1], "utf8");
        const tag = html.match(/<meta\b[^>]*Content-Security-Policy[^>]*>/i);
        const c = tag && tag[0].match(/content=(["\x27])(.*?)\1/i);
        process.stdout.write(c ? c[2] : "");
    ' "$index_html")"
    if [[ "$csp_content" == *"wasm-unsafe-eval"* || "$csp_content" == *"unsafe-eval"* ]]; then
        echo -e "  ${YELLOW}⚠ ${label} CSP 已放行 eval/wasm，WASM 是被允许的能力，跳过本检查${NC}"
        return 0
    fi
    # 基名 = chunk 文件名去掉末段 8 位 hash（如 shiki-DeyQNefO → shiki）
    local allowlist='^(shiki|wasm|wit|onig|markdown)$'
    local violations="" total=0 base js
    for js in "$dist_assets"/*.js; do
        [ -e "$js" ] || continue
        grep -q "WebAssembly" "$js" 2>/dev/null || continue
        total=$((total + 1))
        base="$(basename "$js" .js | sed -E 's/-[A-Za-z0-9_-]{8}$//')"
        echo "$base" | grep -qE "$allowlist" && continue
        violations="$violations $base($(basename "$js"))"
    done
    if [ -n "$violations" ]; then
        echo -e "  ${RED}✗ ${label} 产物新增含 WebAssembly 的 chunk（不在白名单）:$violations"
        echo -e "        CSP script-src 'self' 下 WebAssembly.instantiate 运行时抛 CompileError → 功能静默降级"
        echo -e "        修复：改用无 WASM 实现（参考 markdown.ts 的 createJavaScriptRegexEngine）；"
        echo -e "        或确认必需后改对应 index.html CSP 加 'wasm-unsafe-eval' 并同步更新本函数白名单"
        return 1
    fi
    echo -e "  ${GREEN}✓${NC} ${label} WASM chunk 检查通过（$total 个白名单 chunk 含 WebAssembly dead-code 残留）"
    return 0
}

# 内置 pi 扩展资产存活 + 发现范围完整性（2026-10-03 B′ 事故护栏，三平台共用）
#
# 背景：打包态扩展是 esbuild 自包含 bundle（@zhushanwen/subagent-core 被 inline），
# staged 布局无 node_modules ⇒ `require.resolve` 锚点必败。修复路径 = 回退到 staged
# scope 根（`<Resources>/extensions/@zhushanwen`）作 npm 槽根，靠约定目录扫描命中
# `pi-subagent-workflow/{workflows,agents}`（见 pi-host.stagedScopeRootFromModuleUrl）。
# 因此产物里这两个目录必须真实存在，且不得被 electron-builder 滤镜静默剪掉任何文件
# ——历史上 `!**/README.md` 的**递归**语义删掉了 workflows/README.md（当时是解析锚点
# 本体），且“文件在包里=完整”的错觉让该失效静默一个版本。
#
# 断言三层：① 两目录存在；② 数量与源（packages/subagent-core）一致（不写死数字）；
# ③ 存活 diff——pre-package staged 与 post-package 产物文件集做差，任何删除必须落在
# 白名单（精确模式；包根文档严格限于 `./<scope>/<pkg>/README.md` 两级，不得写成递归），
# 否则红。
check_builtin_ext_assets() {
    local staged_root="$1" packaged_root="$2"
    local core_src="packages/subagent-core"
    local failed=0

    if [ ! -d "$staged_root" ]; then
        echo -e "  ${YELLOW}⚠${NC} 跳过内置扩展资产校验（pre-package staged 目录不存在: ${staged_root}）"
        return 0
    fi
    if [ ! -d "$packaged_root" ]; then
        echo -e "  ${RED}✗${NC} 产物内置扩展目录缺失: ${packaged_root}"
        return 1
    fi

    local sw="$packaged_root/pi-subagent-workflow"
    local wf_src wf_pkg ag_src ag_pkg
    wf_src=$(find "$core_src/workflows" -maxdepth 1 -name '*.js' ! -name '_*' 2>/dev/null | wc -l | tr -d ' ')
    wf_pkg=$(find "$sw/workflows" -maxdepth 1 -name '*.js' ! -name '_*' 2>/dev/null | wc -l | tr -d ' ')
    ag_src=$(find "$core_src/agents" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
    ag_pkg=$(find "$sw/agents" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')

    # ① + ② 发现范围内的资产存在且与源同量（口径：workflows 只算 .js 且排除 `_` 前缀；agents 算 .md）
    if [ "$wf_src" -gt 0 ] && [ "$wf_pkg" = "$wf_src" ]; then
        echo -e "  ${GREEN}✓${NC} 内置 workflow 资产齐备（$wf_pkg 个，与源同量）"
    else
        echo -e "  ${RED}✗${NC} 内置 workflow 资产缺量: 产物 ${wf_pkg} / 源 ${wf_src}（→ subagents 批量工具将报 'batch is not available'）"
        failed=1
    fi
    if [ "$ag_src" -gt 0 ] && [ "$ag_pkg" = "$ag_src" ]; then
        echo -e "  ${GREEN}✓${NC} 内置 agent 资产齐备（$ag_pkg 个，与源同量）"
    else
        echo -e "  ${RED}✗${NC} 内置 agent 资产缺量: 产物 ${ag_pkg} / 源 ${ag_src}（→ <available_subagents> 缺内置角色）"
        failed=1
    fi

    # ③ 存活 diff：任何非白名单删除都是滤镜/拷贝回归
    local tmp_pre tmp_post deleted
    tmp_pre="$(mktemp)"
    tmp_post="$(mktemp)"
    (cd "$staged_root" && find . -type f) | sort > "$tmp_pre"
    (cd "$packaged_root" && find . -type f) | sort > "$tmp_post"
    # 白名单（精确模式）：包根文档仅 `./<pkg>/README.md|ARCHITECTURE.md` 一级（传入根已为
    # scope 目录；**非递归**，不得写成 `**/`）+ sourcemap / 类型声明 / 测试基建 /
    # tree-sitter 源码与 debug wasm（与 electron-builder.yml 排除项一致）
    local allowed='^\./[^/]+/(README|ARCHITECTURE)\.md$|\.map$|\.d\.ts$|/__tests__/|\.test\.|/tree-sitter-bash/src/|/tree-sitter-bash/grammar\.js$|/web-tree-sitter/debug/'
    deleted=$(comm -23 "$tmp_pre" "$tmp_post" | grep -vE "$allowed" || true)
    rm -f "$tmp_pre" "$tmp_post"
    if [ -n "$deleted" ]; then
        echo -e "  ${RED}✗${NC} 产物删除了非白名单文件（滤镜/拷贝回归）:"
        echo "$deleted" | sed 's/^/      /' >&2
        failed=1
    else
        echo -e "  ${GREEN}✓${NC} 资产存活 diff 通过（无白名单外删除）"
    fi

    if [ "$failed" -ne 0 ]; then return 1; fi
    return 0
}

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}[Postbuild Validation]${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

OUTPUT_DIR="$PROJECT_ROOT/apps/electron/dist/builder-output"
FAILED=0

# ── 1. 产物存在性 ──────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[1/6] Build artifacts...${NC}"

if [ "$DIR_ONLY" = true ]; then
    # dir-only 模式：跳过安装器产物检查，只验证 unpacked 目录存在
    UNPACKED_COUNT=0
    [ -d "$OUTPUT_DIR/mac-arm64" ] && UNPACKED_COUNT=$((UNPACKED_COUNT + 1))
    # mac = x64 dmg 交叉构建的 unpacked 目录名（electron-builder 惯例：x64 用裸 mac）
    [ -d "$OUTPUT_DIR/mac" ] && UNPACKED_COUNT=$((UNPACKED_COUNT + 1))
    [ -d "$OUTPUT_DIR/win-unpacked" ] && UNPACKED_COUNT=$((UNPACKED_COUNT + 1))
    [ -d "$OUTPUT_DIR/linux-unpacked" ] && UNPACKED_COUNT=$((UNPACKED_COUNT + 1))
    if [ "$UNPACKED_COUNT" -eq 0 ]; then
        echo -e "  ${RED}✗ dir-only 模式：未找到任何 unpacked 目录${NC}"
        FAILED=1
    else
        echo -e "  ${GREEN}✓ dir-only 模式：找到 $UNPACKED_COUNT 个 unpacked 目录${NC}"
    fi
else
    ARTIFACT_COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 \( -name "*.dmg" -o -name "*.exe" -o -name "*.AppImage" \) | wc -l | tr -d ' ')
    if [ "$ARTIFACT_COUNT" -eq 0 ]; then
        echo -e "  ${RED}✗ 未找到任何构建产物${NC}"
        FAILED=1
    else
        echo -e "  ${GREEN}✓ 找到 $ARTIFACT_COUNT 个产物${NC}"
    fi
fi

# ── 2. macOS app 结构 ──────────────────────────────────────────────
# 双架构循环：mac-arm64（arm64 原生）与 mac（Intel x64 交叉构建）各验一遍——
# 同一次构建只会有其一（arm64 job / mac-x64 job 分开跑），存在性门控天然分流。
MAC_UNPACKED_SEEN=0
for MAC_UNPACKED_DIR in mac-arm64 mac; do
    [ -d "$OUTPUT_DIR/$MAC_UNPACKED_DIR" ] || continue
    MAC_UNPACKED_SEEN=$((MAC_UNPACKED_SEEN + 1))
    # 目录名 → 期望架构：mac-arm64 → arm64；mac → x64（后续 main exe/pi 二进制/
    # node-pty prebuilds/dmg 文件名的架构断言全部以它为锚。
    MAC_ARCH="arm64"
    [ "$MAC_UNPACKED_DIR" = "mac" ] && MAC_ARCH="x64"
    echo ""
    echo -e "${BLUE}[2/6] macOS app structure (${MAC_ARCH}, ${MAC_UNPACKED_DIR})...${NC}"

    # 期望 dmg 文件名（非 dir-only）：TaiJi-<v>-mac-<arch>.dmg。交叉构建链路里若 CLI
    # dmg:x64 被静默忽略（回退成 arm64 构建），产物名会变成 -mac-arm64.dmg，此处
    # 第一时间拦住（release 尾部的 verify 只查「至少一个 dmg」，拦不住错架构）。
    if [ "$DIR_ONLY" != true ]; then
        if ls "$OUTPUT_DIR"/TaiJi-*-mac-"$MAC_ARCH".dmg >/dev/null 2>&1; then
            echo -e "  ${GREEN}✓${NC} dmg 产物名含正确架构段: TaiJi-*-mac-${MAC_ARCH}.dmg"
        else
            echo -e "  ${RED}✗${NC} 未找到 TaiJi-*-mac-${MAC_ARCH}.dmg（${MAC_UNPACKED_DIR} 对应架构的 dmg 缺失——CLI dmg:x64 被忽略/文件名模板回退？）"
            FAILED=1
        fi
    fi

    APP_PATH=$(find "$OUTPUT_DIR/$MAC_UNPACKED_DIR" -name "*.app" -maxdepth 1 | head -1)

    if [ -n "$APP_PATH" ] && [ -d "$APP_PATH" ]; then
        # Info.plist
        if [ -f "$APP_PATH/Contents/Info.plist" ]; then
            echo -e "  ${GREEN}✓${NC} Info.plist"
        else
            echo -e "  ${RED}✗${NC} Info.plist 缺失"
            FAILED=1
        fi

        # main executable
        MAIN_EXE=$(find "$APP_PATH/Contents/MacOS" -type f -maxdepth 1 | head -1)
        if [ -n "$MAIN_EXE" ]; then
            echo -e "  ${GREEN}✓${NC} Main: $(basename "$MAIN_EXE")"
            # main executable 架构断言：交叉构建链路的硬证据——x64 job 若被静默
            # 回退成 arm64 构建（CLI flag 失效等），此处第一时间拦截（Mach-O 头不会
            # 说谎；file 输出 arm64 → "arm64"，x64 → "x86_64"）。
            MAIN_EXE_FILE=$(file -b "$MAIN_EXE" 2>/dev/null || echo "")
            case "$MAC_ARCH" in
                arm64) EXPECTED_MACHO="arm64" ;;
                *)      EXPECTED_MACHO="x86_64" ;;
            esac
            if echo "$MAIN_EXE_FILE" | grep -q "$EXPECTED_MACHO"; then
                echo -e "  ${GREEN}✓${NC} Main executable 架构 = ${MAC_ARCH}（${MAIN_EXE_FILE%%,*}）"
            else
                echo -e "  ${RED}✗${NC} Main executable 架构与 ${MAC_UNPACKED_DIR} 期望（${MAC_ARCH}）不符: ${MAIN_EXE_FILE}"
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} 无 main executable"
            FAILED=1
        fi

        # asar
        if [ -f "$APP_PATH/Contents/Resources/app.asar" ]; then
            echo -e "  ${GREEN}✓${NC} app.asar"

            # 检查关键文件在 asar 内
            if npx asar list "$APP_PATH/Contents/Resources/app.asar" 2>/dev/null | grep -q "dist/main/main.cjs"; then
                echo -e "  ${GREEN}✓${NC} dist/main/main.cjs in asar"
            else
                echo -e "  ${RED}✗${NC} dist/main/main.cjs NOT in asar"
                FAILED=1
            fi

            if npx asar list "$APP_PATH/Contents/Resources/app.asar" 2>/dev/null | grep -q "dist/preload/preload.cjs"; then
                echo -e "  ${GREEN}✓${NC} dist/preload/preload.cjs in asar"
            else
                echo -e "  ${RED}✗${NC} dist/preload/preload.cjs NOT in asar"
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} app.asar 缺失"
            FAILED=1
        fi

        # asar.unpacked
        if [ -d "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime" ]; then
            echo -e "  ${GREEN}✓${NC} runtime in app.asar.unpacked"
            RUNTIME_SIZE=$(du -sm "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime" | cut -f1)
            echo -e "  ℹ  Runtime size: ${RUNTIME_SIZE}MB"

            if [ -f "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime/index.cjs" ]; then
                echo -e "  ${GREEN}✓${NC} runtime/index.cjs"
            else
                echo -e "  ${RED}✗${NC} runtime/index.cjs 缺失"
                FAILED=1
            fi

            if [ -f "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime/plugin-bootstrap.cjs" ]; then
                echo -e "  ${GREEN}✓${NC} runtime/plugin-bootstrap.cjs"
            else
                echo -e "  ${RED}✗${NC} runtime/plugin-bootstrap.cjs 缺失"
                FAILED=1
            fi

            # plugin-bootstrap-process.cjs：sandbox 子进程（fork）入口，重构 3 新增产物。
            # 缺失则 sandbox 插件子进程无法启动（host-process resolveAndValidateFile 定位失败）。
            if [ -f "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime/plugin-bootstrap-process.cjs" ]; then
                echo -e "  ${GREEN}✓${NC} runtime/plugin-bootstrap-process.cjs"
            else
                echo -e "  ${RED}✗${NC} runtime/plugin-bootstrap-process.cjs 缺失"
                FAILED=1
            fi

            # plugin-esm-loader.cjs：sandbox 子进程 ESM resolve hook（execArgv --import 注入）。
            # 缺失则 sandbox ESM import 绕过未封堵（node:fs 等越权 import 放行），
            # plugin-service.resolveEsmLoaderExecArgv fail-open 仅 console.error 不阻断启动。
            if [ -f "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime/plugin-esm-loader.cjs" ]; then
                echo -e "  ${GREEN}✓${NC} runtime/plugin-esm-loader.cjs"
            else
                echo -e "  ${RED}✗${NC} runtime/plugin-esm-loader.cjs 缺失"
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} app.asar.unpacked/dist/runtime 缺失"
            FAILED=1
        fi

        # node-pty helperPath guard — 防 postinstall patch 静默失效
        # scripts/fix-node-pty-permissions.sh 给 node-pty lib/unixTerminal.js 加
        # helperPath 二次 asar 替换 guard（等价上游 PR #924）。该 patch 用 grep
        # 匹配源文件，node-pty 升级若改了行格式则匹配失败——patch 脚本只 warn 不
        # fail（postinstall 不应阻断 install），patch 静默未应用，打包后终端重新
        # 坏掉但 CI 无感知。此处检查产物 unixTerminal.js 含 guard 标记，捕获此类
        # 静默回归。整个 node-pty 被 asarUnpack，runtime 实际加载的就是 unpacked
        # 这份（app.asar 内的副本不会被加载），故只查 app.asar.unpacked 副本。
        UNIX_TERMINAL_IN_APP="$APP_PATH/Contents/Resources/app.asar.unpacked/node_modules/node-pty/lib/unixTerminal.js"
        if [ -f "$UNIX_TERMINAL_IN_APP" ]; then
            echo -e "  ℹ  node-pty helperPath guard..."
            if grep -q "helperPath.indexOf('app.asar.unpacked')" "$UNIX_TERMINAL_IN_APP"; then
                echo -e "  ${GREEN}✓${NC} unixTerminal.js 含 helperPath guard（postinstall patch 生效）"
            else
                echo -e "  ${RED}✗${NC} unixTerminal.js 缺 helperPath guard — postinstall patch 可能未应用（node-pty 升级？）"
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} app.asar.unpacked/node_modules/node-pty/lib/unixTerminal.js 缺失（无法验证 helperPath guard）"
            FAILED=1
        fi

        # node-pty prebuilds 平台裁剪检查 — u2（设计 batch3 §3.2.2）靠 electron-builder.yml
        # mac 平台段 files 排除 win32-* prebuilds（darwin-* 双架构随包，见 yml mac 段注释：
        # x64 dmg 的运行时 fallback）。yml 回退或 electron-builder 升级改变 files 匹配语义
        # 时，win32 prebuilds 会静默回到产物（死重 + 体积回涨），CI 无感。产物级断言：
        # prebuilds 目录仅含 darwin-*（本架构目录必须在位且 pty.node/spawn-helper 齐全，
        # 被误裁时 S5 冒烟前在此捕获——node-pty loadNativeModule 先 build/Release 后
        # prebuilds，交叉重建失败时 prebuilds 是唯一可用源）。node-pty 整包 asarUnpack，
        # prebuilds 目录本身缺失亦属回归。
        PTY_PREBUILDS_DIR="$APP_PATH/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds"
        if [ -d "$PTY_PREBUILDS_DIR" ]; then
            PTY_FOREIGN_PLATFORMS=$(find "$PTY_PREBUILDS_DIR" -mindepth 1 -maxdepth 1 -type d ! -name 'darwin-*' -exec basename {} \;)
            if [ -n "$PTY_FOREIGN_PLATFORMS" ]; then
                echo -e "  ${RED}✗${NC} node-pty prebuilds 含非 darwin 平台目录:$(echo "$PTY_FOREIGN_PLATFORMS" | tr '\n' ' ')"
                echo -e "        u2 平台裁剪疑似被回退——检查 electron-builder.yml mac 段 files 的 prebuilds 排除行（设计 batch3 §3.2.2）"
                FAILED=1
            elif [ -f "$PTY_PREBUILDS_DIR/darwin-$MAC_ARCH/pty.node" ] && [ -f "$PTY_PREBUILDS_DIR/darwin-$MAC_ARCH/spawn-helper" ]; then
                echo -e "  ${GREEN}✓${NC} node-pty prebuilds 仅 darwin-*（darwin-$MAC_ARCH pty.node + spawn-helper 在位）"
            else
                echo -e "  ${RED}✗${NC} node-pty darwin-$MAC_ARCH native 缺失（pty.node/spawn-helper）: $PTY_PREBUILDS_DIR/darwin-$MAC_ARCH"
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} node-pty prebuilds 目录缺失: $PTY_PREBUILDS_DIR"
            FAILED=1
        fi

        # extraResources (pi binary)
        if [ -d "$APP_PATH/Contents/Resources/pi" ]; then
            echo -e "  ${GREEN}✓${NC} pi binary in Resources"

            # pi 二进制架构断言（双架构 mac 产物）：Resources/pi/pi-darwin-<MAC_ARCH> 必须在位
            # 且 Mach-O 架构匹配。这是交叉构建链路的硬证据——prepare 脚本 --arch 传错/被
            # 忽略、或缓存串桶时，Intel dmg 里会只有 arm64 二进制（运行时 find-pi-executable
            # 按 process.arch 找不到文件，pi 子进程全体哑火），必须在发布前拦住。
            # `pi` PATH 别名（symlink）指向同目录 staged 二进制，随 staged 架构正确。
            PI_BIN="$APP_PATH/Contents/Resources/pi/pi-darwin-$MAC_ARCH"
            if [ -f "$PI_BIN" ]; then
                PI_BIN_FILE=$(file -b "$PI_BIN" 2>/dev/null || echo "")
                case "$MAC_ARCH" in
                    arm64) EXPECTED_PI_MACHO="arm64" ;;
                    *)      EXPECTED_PI_MACHO="x86_64" ;;
                esac
                if echo "$PI_BIN_FILE" | grep -q "$EXPECTED_PI_MACHO"; then
                    echo -e "  ${GREEN}✓${NC} pi-darwin-$MAC_ARCH 架构匹配（$(echo "$PI_BIN_FILE" | cut -d, -f1)）"
                else
                    echo -e "  ${RED}✗${NC} pi-darwin-$MAC_ARCH Mach-O 架构不符（期望含 $EXPECTED_PI_MACHO）: $PI_BIN_FILE"
                    FAILED=1
                fi
            else
                echo -e "  ${RED}✗${NC} pi-darwin-$MAC_ARCH 缺失: $PI_BIN（交叉构建 staged 架构错误？）"
                FAILED=1
            fi

            # 致命：pi 目录中不能有指向 bundle 外部的 symlink。同目录相对 symlink 合法
            # （prepare-pi-resources.sh 的 pi PATH 别名 = pi -> pi-darwin-<arch>，拷贝进
            # bundle 后仍指向同目录二进制，自包含；判定语义与 scripts/check-pi-resources-links.mjs
            # 构建前检查一致——目标 resolve 后落在 pi 目录内部即放行）。原「find -type l
            # 全拦」实现比注释意图严，pi 别名引入后误伤 CI（2026-10-22）。
            PI_EXTERNAL_LINK=""
            # 前缀双侧归一化：APP_PATH 本身可能含 symlink 段（如 macOS /tmp -> /private/tmp），
            # 只归一化目标不归一化前缀会前缀失配误拦
            PI_DIR_REAL=$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$APP_PATH/Contents/Resources/pi")
            while IFS= read -r PI_LINK; do
                [ -z "$PI_LINK" ] && continue
                PI_TARGET=$(python3 -c 'import os, sys; print(os.path.realpath(os.path.join(os.path.dirname(sys.argv[1]), sys.argv[2])))' "$PI_LINK" "$(readlink "$PI_LINK")")
                case "$PI_TARGET" in
                    "$PI_DIR_REAL"/*) ;; # bundle 内自包含，合法
                    *) PI_EXTERNAL_LINK="$PI_LINK"; break ;;
                esac
            done < <(find "$APP_PATH/Contents/Resources/pi" -maxdepth 1 -type l 2>/dev/null)
            if [ -n "$PI_EXTERNAL_LINK" ]; then
                echo -e "  ${RED}✗${NC} Resources/pi 存在指向 bundle 外部的 symlink: $(basename "$PI_EXTERNAL_LINK") -> $(readlink "$PI_EXTERNAL_LINK")"
                FAILED=1
            else
                LINK_COUNT=$(find "$APP_PATH/Contents/Resources/pi" -maxdepth 1 -type l 2>/dev/null | wc -l | tr -d ' ')
                echo -e "  ${GREEN}✓${NC} Resources/pi symlink 均为 bundle 内相对链接（${LINK_COUNT} 个，含 pi PATH 别名）"
            fi
        fi

        # extraResources: bin/taiji-settings CLI（tsup 打包的 cli.cjs，pi Skill 引用）
        # 与两个 extension.js 同模式校验（electron-builder from 错误只警告不失败）。
        if [ -f "$APP_PATH/Contents/Resources/bin/taiji-settings" ]; then
            echo -e "  ${GREEN}✓${NC} bin/taiji-settings in Resources"
        else
            echo -e "  ${RED}✗${NC} bin/taiji-settings 缺失（检查 electron-builder.yml from 路径 dist/runtime/cli.cjs）"
            FAILED=1
        fi
        # builtin pi extensions 完整性校验（index.js 存在 / 无 .ts 残留 R3 / permission wasm / dry-run import）
        # prepare-builtin-extensions.sh 部署 + electron-builder extraResources 拷贝。
        # 复用 verify-staged-extensions.mjs：文件级校验 + import dry-run（external 缺失降级，
        # prod 环境无 node_modules 属预期，pi runtime 提供）。--engines-dir 让 C-ext-31
        # 门禁与构建期 bundle-extensions.mjs 覆盖对齐：引擎 staged 产物同扫。
        BUILTIN_EXT_DIR="$APP_PATH/Contents/Resources/extensions/@zhushanwen"
        BUILTIN_ENGINES_DIR="$APP_PATH/Contents/Resources/engines"
        if [ -d "$BUILTIN_EXT_DIR" ]; then
            if node "$PROJECT_ROOT/scripts/verify-staged-extensions.mjs" --staged-dir "$BUILTIN_EXT_DIR" --engines-dir "$BUILTIN_ENGINES_DIR" > /tmp/ext-verify-mac.log 2>&1; then
                echo -e "  ${GREEN}✓${NC} builtin ext 完整性校验通过（verify-staged）"
            else
                echo -e "  ${RED}✗${NC} builtin ext 完整性校验失败（缺 index.js / 残留 .ts / 缺 wasm）:"
                sed 's/^/    /' /tmp/ext-verify-mac.log
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} builtin ext 目录缺失: ${BUILTIN_EXT_DIR}（检查 prepare-builtin-extensions.sh + electron-builder.yml）"
            FAILED=1
        fi
        # staged subagent 引擎 CLI（W9，三平台共用 check_staged_engines）
        if ! check_staged_engines "$APP_PATH/Contents/Resources/engines"; then
            FAILED=1
        fi
        # 内置 pi 扩展资产存活 + 发现范围完整性（B′ 事故护栏）
        if ! check_builtin_ext_assets "apps/electron/resources/extensions/@zhushanwen" "$BUILTIN_EXT_DIR"; then
            FAILED=1
        fi
        # 移动壳 dist（remote-access 静态托管资源）：packages/mobile-renderer 的 vite
        # web 构建（build 编排 build:mobile 先行产出）+ electron-builder extraResources
        # 复制 → <Resources>/mobile-dist。index.html 是 runtime 同源静态托管入口，
        # 缺失 = 构建编排漏跑 build:mobile 或 extraResources 漏配（supervisor prod 分支
        # 拼 --mobile-dist 时 runtime 启动会报 E5 静态范围禁用，这里在产物级提前拦截）。
        MOBILE_DIST_DIR="$APP_PATH/Contents/Resources/mobile-dist"
        if [ -f "$MOBILE_DIST_DIR/index.html" ]; then
            grep -q "Content-Security-Policy" "$MOBILE_DIST_DIR/index.html" \
                && echo -e "  ${GREEN}✓${NC} mobile-dist/index.html in Resources（含 CSP meta）" \
                || { echo -e "  ${RED}✗${NC} mobile-dist/index.html 缺 CSP meta（packages/mobile-renderer/index.html 回归）"; FAILED=1; }
        else
            echo -e "  ${RED}✗${NC} mobile-dist/index.html 缺失: ${MOBILE_DIST_DIR}（检查 build 编排 build:mobile + electron-builder.yml extraResources）"
            FAILED=1
        fi
        # builtin taiji plugins 完整性校验（resources/plugins/<name>）
        # prepare-builtin-plugins.sh 预编译 index.js + electron-builder extraResources 拷贝。
        # registry 打包后扫描 <cwd>/resources/plugins；缺入口文件则插件静默不被发现或
        # 激活必炸（ERR_UNSUPPORTED_DIR_IMPORT——插件目录只有 ts 源、无编译产物时）。
        # 入口 SSOT = 各插件 package.json 的 taijiPlugin.main（缺省 index.js）。
        BUILTIN_PLUGINS_DIR="$APP_PATH/Contents/Resources/resources/plugins"
        if [ -d "$BUILTIN_PLUGINS_DIR" ]; then
            PLUGINS_MISSING=0
            for plugin_dir in "$BUILTIN_PLUGINS_DIR"/*/; do
                plugin_name="$(basename "$plugin_dir")"
                main_entry=$(node -e "const p=require(process.argv[1]);process.stdout.write(p.taijiPlugin?.main ?? 'index.js')" "${plugin_dir}package.json" 2>/dev/null || echo "")
                if [ -z "$main_entry" ] || [ ! -f "${plugin_dir}${main_entry}" ]; then
                    echo -e "  ${RED}✗${NC} builtin plugin ${plugin_name} 缺入口 ${main_entry:-<manifest 无效>}"
                    PLUGINS_MISSING=1
                fi
            done
            if [ "$PLUGINS_MISSING" -ne 0 ]; then
                FAILED=1
            else
                PLUGIN_COUNT=$(find "$BUILTIN_PLUGINS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
                echo -e "  ${GREEN}✓${NC} builtin plugins 完整性校验通过（$PLUGIN_COUNT plugins）"
            fi
        else
            echo -e "  ${RED}✗${NC} builtin plugins 目录缺失: ${BUILTIN_PLUGINS_DIR}（检查 prepare-builtin-plugins.sh + electron-builder.yml）"
            FAILED=1
        fi
    else
        echo -e "  ${YELLOW}⚠ 未找到 .app 目录${NC}"
    fi
done
# 两类 mac unpacked 目录都不在（win/linux 构建，或 dir-only 缺产物）→ 跳过提示
if [ "$MAC_UNPACKED_SEEN" -eq 0 ]; then
    echo ""
    echo -e "${YELLOW}[2/6] macOS 结构跳过（非 macOS 构建）${NC}"
fi

# ── Windows unpacked app structure ───────────────────────────────────
if [ -d "$OUTPUT_DIR/win-unpacked" ]; then
    echo ""
    echo -e "${BLUE}[2/6] Windows unpacked app structure...${NC}"
    WIN_ROOT="$OUTPUT_DIR/win-unpacked"
    WIN_RESOURCES="$WIN_ROOT/resources"
    WIN_UNPACKED="$WIN_RESOURCES/app.asar.unpacked"

    for required in \
        "$WIN_ROOT/TaiJi.exe" \
        "$WIN_UNPACKED/dist/runtime/index.cjs" \
        "$WIN_UNPACKED/dist/runtime/plugin-bootstrap.cjs" \
        "$WIN_UNPACKED/dist/runtime/plugin-bootstrap-process.cjs" \
        "$WIN_UNPACKED/dist/runtime/plugin-esm-loader.cjs" \
        "$WIN_RESOURCES/pi/pi-windows-x64.exe" \
        "$WIN_RESOURCES/bin/taiji-settings" \
        "$WIN_RESOURCES/mobile-dist/index.html"; do
        if [ -f "$required" ]; then
            echo -e "  ${GREEN}✓${NC} ${required#$WIN_ROOT/}"
        else
            echo -e "  ${RED}✗${NC} ${required#$WIN_ROOT/} 缺失"
            FAILED=1
        fi
    done
    # builtin pi extensions（Windows 同 mac 校验，复用 verify-staged；--engines-dir 同扫引擎产物 C-ext-31）
    WIN_BUILTIN="$WIN_RESOURCES/extensions/@zhushanwen"
    if [ -d "$WIN_BUILTIN" ]; then
        if node "$PROJECT_ROOT/scripts/verify-staged-extensions.mjs" --staged-dir "$WIN_BUILTIN" --engines-dir "$WIN_RESOURCES/engines" > /tmp/ext-verify-win.log 2>&1; then
            echo -e "  ${GREEN}✓${NC} builtin ext 完整性校验通过（verify-staged）"
        else
            echo -e "  ${RED}✗${NC} builtin ext 完整性校验失败:"
            sed 's/^/    /' /tmp/ext-verify-win.log
            FAILED=1
        fi
    else
        echo -e "  ${RED}✗${NC} builtin ext 目录缺失: $WIN_BUILTIN"
        FAILED=1
    fi
    # staged subagent 引擎 CLI（W9，三平台共用 check_staged_engines）
    if ! check_staged_engines "$WIN_RESOURCES/engines"; then
        FAILED=1
    fi
    # 内置 pi 扩展资产存活 + 发现范围完整性（B′ 事故护栏）
    if ! check_builtin_ext_assets "apps/electron/resources/extensions/@zhushanwen" "$WIN_BUILTIN"; then
        FAILED=1
    fi
    # builtin taiji plugins（Windows 同 mac 校验：每插件 manifest main 入口存在）
    WIN_PLUGINS_DIR="$WIN_RESOURCES/resources/plugins"
    if [ -d "$WIN_PLUGINS_DIR" ]; then
        WIN_PLUGINS_MISSING=0
        for plugin_dir in "$WIN_PLUGINS_DIR"/*/; do
            plugin_name="$(basename "$plugin_dir")"
            main_entry=$(node -e "const p=require(process.argv[1]);process.stdout.write(p.taijiPlugin?.main ?? 'index.js')" "${plugin_dir}package.json" 2>/dev/null || echo "")
            if [ -z "$main_entry" ] || [ ! -f "${plugin_dir}${main_entry}" ]; then
                echo -e "  ${RED}✗${NC} builtin plugin ${plugin_name} 缺入口 ${main_entry:-<manifest 无效>}"
                WIN_PLUGINS_MISSING=1
            fi
        done
        if [ "$WIN_PLUGINS_MISSING" -ne 0 ]; then
            FAILED=1
        else
            echo -e "  ${GREEN}✓${NC} builtin plugins 完整性校验通过"
        fi
    else
        echo -e "  ${RED}✗${NC} builtin plugins 目录缺失: $WIN_PLUGINS_DIR"
        FAILED=1
    fi

    WINDOWS_PTY_PREBUILDS="$WIN_UNPACKED/node_modules/node-pty/prebuilds/win32-x64"
    WINDOWS_PTY_MISSING=0
    for required_native in \
        "$WINDOWS_PTY_PREBUILDS/conpty.node" \
        "$WINDOWS_PTY_PREBUILDS/pty.node"; do
        if [ -f "$required_native" ]; then
            echo -e "  ${GREEN}✓${NC} node-pty Windows native: ${required_native#$WIN_ROOT/}"
        else
            echo -e "  ${RED}✗${NC} node-pty Windows native 缺失: ${required_native#$WIN_ROOT/}"
            WINDOWS_PTY_MISSING=1
        fi
    done
    if [ "$WINDOWS_PTY_MISSING" -ne 0 ]; then
        FAILED=1
    fi
fi

# ── Linux unpacked app structure ─────────────────────────────────────
# dir-only 模式（ci.yml）也执行本段：只要 linux-unpacked 目录存在就校验结构，
# 否则 linux 平台打包回归（tsup noExternal 缺失、extraResources from 路径错等）
# CI 捕获不到，延迟到 release 才暴露。
# 布局依据：executableName 动态读自 electron-builder.yml（曾硬编码旧 bin 名，
# 2026-08 TaiJi 品牌重命名后 CI 断裂——禁止再硬编码可执行名）；
# asarUnpack dist/runtime/**/* 与 win 段同构；pi binary 名 prepare-pi-resources.sh
# BINARY_NAME="pi-linux-${PI_ARCH}"（linux target arch x64）。
if [ -d "$OUTPUT_DIR/linux-unpacked" ]; then
    echo ""
    echo -e "${BLUE}[2/6] Linux unpacked app structure...${NC}"
    LINUX_ROOT="$OUTPUT_DIR/linux-unpacked"
    LINUX_RESOURCES="$LINUX_ROOT/resources"
    LINUX_UNPACKED="$LINUX_RESOURCES/app.asar.unpacked"
    LINUX_EXECUTABLE="$(grep -E '^executableName:' apps/electron/electron-builder.yml | head -1 | awk '{print $2}')"

    if [ -z "$LINUX_EXECUTABLE" ]; then
        echo -e "  ${RED}✗${NC} 无法从 apps/electron/electron-builder.yml 解析 executableName"
        FAILED=1
    else
        for required in \
            "$LINUX_ROOT/$LINUX_EXECUTABLE" \
            "$LINUX_UNPACKED/dist/runtime/index.cjs" \
            "$LINUX_UNPACKED/dist/runtime/plugin-bootstrap.cjs" \
            "$LINUX_RESOURCES/pi/pi-linux-x64" \
            "$LINUX_RESOURCES/bin/taiji-settings" \
            "$LINUX_RESOURCES/mobile-dist/index.html"; do
            if [ -f "$required" ]; then
                echo -e "  ${GREEN}✓${NC} ${required#$LINUX_ROOT/}"
            else
                echo -e "  ${RED}✗${NC} ${required#$LINUX_ROOT/} 缺失"
                FAILED=1
            fi
        done
    fi
    # builtin pi extensions（Linux 同 mac/win 校验，复用 verify-staged；--engines-dir 同扫引擎产物
    # C-ext-31）。builtin 迁移 npm 包化（2026-08）时 mac/win 补了本校验、linux 覆盖丢失
    # （PR #185 review S1），extraResources from 路径错等 linux 专属回归将静默漏检。
    LINUX_BUILTIN="$LINUX_RESOURCES/extensions/@zhushanwen"
    if [ -d "$LINUX_BUILTIN" ]; then
        if node "$PROJECT_ROOT/scripts/verify-staged-extensions.mjs" --staged-dir "$LINUX_BUILTIN" --engines-dir "$LINUX_RESOURCES/engines" > /tmp/ext-verify-linux.log 2>&1; then
            echo -e "  ${GREEN}✓${NC} builtin ext 完整性校验通过（verify-staged）"
        else
            echo -e "  ${RED}✗${NC} builtin ext 完整性校验失败:"
            sed 's/^/    /' /tmp/ext-verify-linux.log
            FAILED=1
        fi
    else
        echo -e "  ${RED}✗${NC} builtin ext 目录缺失: ${LINUX_BUILTIN}（检查 prepare-builtin-extensions.sh + electron-builder.yml）"
        FAILED=1
    fi
    # staged subagent 引擎 CLI（W9，三平台共用 check_staged_engines）
    if ! check_staged_engines "$LINUX_RESOURCES/engines"; then
        FAILED=1
    fi
    # 内置 pi 扩展资产存活 + 发现范围完整性（B′ 事故护栏）
    if ! check_builtin_ext_assets "apps/electron/resources/extensions/@zhushanwen" "${LINUX_BUILTIN}"; then
        FAILED=1
    fi
fi
# ── 3. renderer/mobile WASM chunk 检查（CSP 能力防线，产物级）────────
# 背景：桌面 renderer 与移动壳 CSP script-src 均为 'self' 不放行 WASM。shiki 已换
# createJavaScriptRegexEngine（markdown.ts），但 bundle-full 入口仍静态携带 oniguruma
# loader（dead code，tree-shake 边界）——白名单放行其 chunk 基名。新增依赖若把可执行
# WASM 带进任一壳产物（基名不在白名单），在此拦截，防止「依赖暗藏 WASM → CSP
# CompileError → 功能静默降级」复发（2026-08 v0.9.3+ 事故：全部 markdown 渲染退化为
# 纯文本、换行丢失；mobile-dist 产物同形态曾无机器拦截）。
# 白名单维护原则：确认该 chunk 的 WASM 路径运行时不可达（如显式传入 JS engine 后的
# dead loader）才可加入；真正需要 WASM 时改对应 index.html CSP（加 'wasm-unsafe-eval'）并
# 同步本检查与 .githooks/check_csp_compatibility.py（源码级防线）。
echo ""
echo -e "${BLUE}[3/6] renderer/mobile WASM chunk check (CSP guard)...${NC}"
# 桌面产物 = apps/electron/renderer/dist（electron 加载链源头）；移动壳产物源头 =
# packages/mobile-renderer/dist（vite outDir）＝ Resources/mobile-dist 的
# extraResources 复制源（electron-builder.yml from: ../../packages/mobile-renderer/dist），
# 扫描源头即覆盖打包产物内容；mobile-dist 落位存在性已在 [2/6] 平台段校验。
if ! check_wasm_chunks \
    "$PROJECT_ROOT/apps/electron/renderer/dist/assets" \
    "$PROJECT_ROOT/packages/renderer/index.html" \
    "renderer" \
    "pnpm --filter @taiji/frontend run build"; then
    FAILED=1
fi
if ! check_wasm_chunks \
    "$PROJECT_ROOT/packages/mobile-renderer/dist/assets" \
    "$PROJECT_ROOT/packages/mobile-renderer/index.html" \
    "mobile-renderer" \
    "pnpm --filter @taiji/mobile-renderer run build（或编排 build:mobile）"; then
    FAILED=1
fi

echo -e "${BLUE}[4/6] Artifact sizes...${NC}"

for f in "$OUTPUT_DIR"/*.dmg "$OUTPUT_DIR"/*.exe "$OUTPUT_DIR"/*.AppImage; do
    if [ -f "$f" ]; then
        SIZE_MB=$(du -m "$f" | cut -f1)
        echo -e "  ℹ  $(basename "$f"): ${SIZE_MB}MB"

        if [[ "$f" == *.dmg ]] && [ "$SIZE_MB" -gt 800 ]; then
            echo -e "  ${YELLOW}⚠ DMG 超过 800MB，检查是否有多余文件${NC}"
        fi
    fi
done

# ── 4. Smoke test ──────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[5/6] Smoke test (optional)...${NC}"

if [ "$(uname)" = "Darwin" ]; then
    # 双架构目录逐一探测（find 对不存在目录返回非零，set -e 下会炸——不能两个目录
    # 一次传给 find）；arm64 job 只有 mac-arm64，mac-x64 job 只有 mac。
    APP_BUNDLE=""
    for _mac_dir in mac-arm64 mac; do
        [ -d "$OUTPUT_DIR/$_mac_dir" ] || continue
        _found=$(find "$OUTPUT_DIR/$_mac_dir" -name "*.app" -maxdepth 1 2>/dev/null | head -1)
        if [ -n "$_found" ]; then APP_BUNDLE="$_found"; break; fi
    done
    if [ -n "$APP_BUNDLE" ]; then
        echo -e "  ${YELLOW}⚠ Smoke test 需要手动执行：open -a \"$APP_BUNDLE\"${NC}"
    fi
fi

# ── 5. 代码签名状态 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[6/6] Code signature...${NC}"

if [ "$(uname)" = "Darwin" ] && [ -n "${APP_BUNDLE:-}" ]; then
    if command -v codesign &>/dev/null; then
        if codesign --verify --verbose=0 "$APP_BUNDLE" 2>&1; then
            echo -e "  ${GREEN}✓ 代码签名有效${NC}"
        else
            echo -e "  ${YELLOW}⚠ 未签名（本地开发正常，分发需签名）${NC}"
        fi
    else
        echo -e "  ${YELLOW}⚠ codesign 不可用${NC}"
    fi
fi

# ── 结果 ───────────────────────────────────────────────────────────
echo ""
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}[OK] Postbuild 验证全部通过${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 0
else
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}[FAIL] Postbuild 验证有失败项${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 1
fi