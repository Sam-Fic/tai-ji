#!/usr/bin/env python3
"""
shared 层 node 内置模块检查（C-state-05）——落实 ADR-0027 W1a 教训。

规则：扫描 packages/shared/src/ 的 TS 源码（排除 *.test.*、*.d.* 与 __tests__/），
以下三种 import 形态的说明符命中 node 内置模块即违规（node: 前缀与裸名同判据）：
  - 静态：`from 'node:fs'` / `from 'fs'`
  - side-effect：行首 `import 'node:fs'` / `import 'fs'`
  - 动态：`import('node:fs')` / `import('fs')`

判据数据（内置名单 + 存量白名单）= scripts/shared-node-builtin-rules.json，与
scripts/check-shared-module-admission.mjs 的检查 B 项共用同一份——C-state-05 只有
一套判据，两个执行点不得各自维护副本。shared 是浏览器/runtime 共享层，node 内置
模块在浏览器直接崩；node 专属路径工具归 runtime path-utils，纯计算函数放 shared
必须零 IO 零 node 依赖。

存量基线（2026-08-22 首次接入时登记，白名单随判据数据维护）：paths.ts（getConfigDir
等动态推导的实现处，import node:os/node:path）——疑似与 ADR-0027 冲突，待架构确认后
治理（挪 runtime 或拆分纯计算部分）；确认前不拦，其余文件违规即拦。

session-store-paths.ts（2026-10-20 登记，C-ext-31）：paths.ts 拆分出的纯计算半边
（session 存储树公式族，仅 import node:path 的 join、零 IO 零 env）——恰是本检查
治理方向「拆分纯计算部分」的产物；跨平台分隔符正确性需要 node:path，随 paths.ts
基线一同治理。

退出码: 0 通过 / 2 违规或判据数据不可用
"""

from __future__ import annotations
import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SHARED_SRC = PROJECT_ROOT / "packages/shared/src"
RULES_PATH = PROJECT_ROOT / "scripts/shared-node-builtin-rules.json"

SOURCE_SUFFIXES = {".ts", ".tsx", ".mts", ".cts"}
DECLARATION_RE = re.compile(r"\.d\.(?:ts|mts|cts)$")

# 三个 import 形态（与 check-shared-module-admission.mjs 的 IMPORT_SPEC_PATTERNS 同构）
IMPORT_SPEC_PATTERNS = [
    re.compile(r"""from\s+['"]([^'"]+)['"]"""),
    re.compile(r"""^\s*import\s*['"]([^'"]+)['"]""", re.MULTILINE),
    re.compile(r"""\bimport\s*\(\s*['"]([^'"]+)['"]"""),
]


def load_rules() -> tuple[set[str], set[str]]:
    data = json.loads(RULES_PATH.read_text(encoding="utf-8"))
    return set(data["builtinModules"]), set(data["allowlistFiles"])


def builtin_name(spec: str) -> str:
    return spec[len("node:"):] if spec.startswith("node:") else spec


def source_files():
    for f in sorted(SHARED_SRC.rglob("*")):
        if not f.is_file() or f.suffix not in SOURCE_SUFFIXES:
            continue
        if f.name.endswith(".test" + f.suffix) or DECLARATION_RE.search(f.name):
            continue
        if "__tests__" in f.parts:
            continue
        yield f


def main() -> int:
    try:
        builtin_modules, allowlist_files = load_rules()
    except (OSError, ValueError, KeyError) as err:
        print(f"[check_shared_node_builtin] 判据数据不可用：{RULES_PATH.relative_to(PROJECT_ROOT).as_posix()}（{err}）")
        print("修复动作：从 git 历史恢复该文件；它与 scripts/check-shared-module-admission.mjs 共用同一份判据。")
        return 2

    violations = []
    for f in source_files():
        if f.name in allowlist_files:
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        specs = {m.group(1) for pattern in IMPORT_SPEC_PATTERNS for m in pattern.finditer(text)}
        hits = sorted(spec for spec in specs if builtin_name(spec) in builtin_modules)
        if hits:
            violations.append(
                f"{f.relative_to(PROJECT_ROOT).as_posix()}: import node 内置模块 "
                f"{', '.join(hits)}（shared 是浏览器/runtime 共享层，C-state-05/ADR-0027）"
            )

    if violations:
        print("[check_shared_node_builtin] shared 层存在 node 内置 import（C-state-05/ADR-0027 W1a）：")
        for v in violations:
            print(f"  - {v}")
        print("修复方向：node 专属逻辑移至 runtime（path-utils 等）；shared 只留零 IO 纯计算。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
