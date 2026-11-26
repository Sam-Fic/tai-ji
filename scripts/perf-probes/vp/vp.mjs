#!/usr/bin/env node
/**
 * vp（verify primitive）CLI 仓内入口——纯委托，零 runner 逻辑。
 *
 * [单源权威声明（branch-review dmg-r1-3）] runner 唯一实现在
 * `.agents/skills/verify-taiji/scripts/`（vp.mjs + lib/*），经 worktree 顶层
 * `.agents -> ../.agents` symlink 可达（git-cwt 工作区布局自带）。本文件只保留仓内
 * 稳定调用路径（docs/acceptance.md 等验收命令写死 `node scripts/perf-probes/vp/vp.mjs`）；
 * 能力/协议/证据装配变更一律改 skill 侧，禁止在本文件或 scripts/perf-probes/vp/lib 下复制副本
 * （同步义务 = 结构性消灭，仓内无第二份 runner 实体可漂移）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const authority = path.resolve(here, '../../../.agents/skills/verify-taiji/scripts/vp.mjs')

if (!fs.existsSync(authority)) {
  console.error(
    `[vp] runner 权威副本缺失: ${authority}\n` +
      '本入口委托 skill 实体（.agents -> ../.agents symlink）；worktree 缺 symlink 或实体不在位时 runner 不可用，按 git-cwt 工作区布局修复后重试。',
  )
  process.exit(2)
}

await import(pathToFileURL(authority).href)
