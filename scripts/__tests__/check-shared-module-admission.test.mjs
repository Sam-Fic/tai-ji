/**
 * check-shared-module-admission.mjs 单测：shared 模块准入检查逻辑。
 *
 * fixture 场景（纯函数直测 + --root 注入 tmpdir fixture 树 spawnSync 集成，
 * mkdtempSync 自建自删，不触真实仓库状态）：
 *   - 依赖方向：@taiji/* 与 @zhushanwen/* workspace import 检出（豁免表内的两个
 *     契约包放行）/ 跨包相对 import 检出
 *   - node 内置禁令：C-state-05 唯一判据——node: 前缀与裸名（fs / fs/promises）同判据，
 *     node:path / node:url / node:os 等纯计算内置同样在禁列；存量白名单
 *     （paths.ts / session-store-paths.ts）放行
 *   - 登记完备：未登记模块 / 死登记 / 空 purpose 检出；双向一致通过；子目录按目录级条目对账
 *   - 判据数据：shared-node-builtin-rules.json 的内置名单与 Node module.builtinModules 等值
 *   - main --root：干净树绿 / 违规树红（exit 1）/ 目录缺失 exit 2 / 子目录未登记红
 *   - isMain：脚本路径含 # 时仍正常执行（pathToFileURL 归一化，不再空转 exit 0）
 *   - pre-commit hook（.githooks/check_shared_node_builtin.py）：tmp mirror + spawnSync
 *     锁定「两条检查同源 + 裸名同判据」——hook 读同一份判据数据，node 前缀 / 裸名 /
 *     三种 import 形态 / 存量白名单 / 判据数据缺失全场景（C-state-05 只有一套判据）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  ALLOWED_WORKSPACE_DEPS,
  BUILTIN_MODULES,
  NODE_BUILTIN_ALLOWLIST_FILES,
  scanSourceViolations,
  reconcileRegistry,
  listSharedModules,
} from '../check-shared-module-admission.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(SCRIPT_DIR, '..', 'check-shared-module-admission.mjs')
const RULES_PATH = join(SCRIPT_DIR, '..', 'shared-node-builtin-rules.json')

describe('scanSourceViolations：依赖方向与 node 内置禁令', () => {
  it('@taiji/* 与跨包相对路径检出', () => {
    const vs = scanSourceViolations([
      ['a.ts', `import { x } from '@taiji/shared/foo'`],
      ['b.ts', `import { y } from '../../../core/src/bar'`],
    ])
    expect(vs.some((v) => v.includes('a.ts') && v.includes('@taiji/'))).toBe(true)
    expect(vs.some((v) => v.includes('b.ts') && v.includes('跨包相对'))).toBe(true)
  })

  it('@zhushanwen/* 与 @taiji/* 同判据：豁免表内放行，表外报红', () => {
    const vs = scanSourceViolations([
      ['c.ts', `import { x } from '@zhushanwen/subagent-core'`],
      ['d.ts', `import { y } from '@zhushanwen/random-helper'`],
      ['ok.ts', `import type { FailureCause } from '@zhushanwen/subagent-engine-sdk'`],
      ['ok2.ts', `import { SUBAGENT_DIRECTIVE_CUSTOM_TYPE } from '@zhushanwen/extension-protocol'`],
      ['ok3.ts', `import type { X } from '@zhushanwen/extension-protocol/background-task'`],
    ])
    expect(vs.some((v) => v.includes('c.ts') && v.includes('@zhushanwen/subagent-core'))).toBe(true)
    expect(vs.some((v) => v.includes('d.ts') && v.includes('@zhushanwen/random-helper'))).toBe(true)
    expect(vs.some((v) => v.includes('ok.ts'))).toBe(false)
    expect(vs.some((v) => v.includes('ok2.ts'))).toBe(false)
    expect(vs.some((v) => v.includes('ok3.ts'))).toBe(false)
    expect(ALLOWED_WORKSPACE_DEPS.has('@zhushanwen/extension-protocol')).toBe(true)
    expect(ALLOWED_WORKSPACE_DEPS.has('@zhushanwen/subagent-engine-sdk')).toBe(true)
  })

  it('node 内置检出（node: 与非 IO 内置同判据），存量白名单文件放行', () => {
    const vs = scanSourceViolations([
      ['c.ts', `import { readFileSync } from 'node:fs'`],
      ['io2.ts', `import { join } from 'node:path'`],
      ['io3.ts', `import { homedir } from 'node:os'`],
      ['io4.ts', `import { pathToFileURL } from 'node:url'`],
      ['paths.ts', `import { join } from 'node:path'`],
      ['session-store-paths.ts', `import { join } from 'node:path'`],
    ])
    expect(vs).toContain('c.ts: 禁用内置 import node:fs（C-state-05：shared 零 node 依赖，规则 3）')
    expect(vs.some((v) => v.includes('io2.ts') && v.includes('node:path'))).toBe(true)
    expect(vs.some((v) => v.includes('io3.ts') && v.includes('node:os'))).toBe(true)
    expect(vs.some((v) => v.includes('io4.ts') && v.includes('node:url'))).toBe(true)
    expect(vs.some((v) => v.includes('paths.ts'))).toBe(false)
    expect(vs.some((v) => v.includes('session-store-paths.ts'))).toBe(false)
    expect(BUILTIN_MODULES.has('child_process')).toBe(true)
    expect(NODE_BUILTIN_ALLOWLIST_FILES).toEqual(new Set(['paths.ts', 'session-store-paths.ts']))
  })

  it('裸内置说明符（无 node: 前缀）同样检出', () => {
    const vs = scanSourceViolations([
      ['c.ts', `import { readFileSync } from 'fs'`],
      ['d.ts', `import fs from 'fs/promises'`],
      ['e.ts', `import 'child_process'`],
      ['f.ts', `const m = import('os')`],
      ['ok.ts', `import { debounce } from 'lodash-es'`],
      ['ok2.ts', `export { z } from './local-thing'`],
    ])
    expect(vs.some((v) => v.includes('c.ts') && v.includes(' fs（'))).toBe(true)
    expect(vs.some((v) => v.includes('d.ts') && v.includes('fs/promises'))).toBe(true)
    expect(vs.some((v) => v.includes('e.ts') && v.includes('child_process'))).toBe(true)
    expect(vs.some((v) => v.includes('f.ts') && v.includes('os'))).toBe(true)
    expect(vs.some((v) => v.includes('ok.ts'))).toBe(false)
    expect(vs.some((v) => v.includes('ok2.ts'))).toBe(false)
  })

  it('side-effect 与动态 import 形态同判据检出', () => {
    const vs = scanSourceViolations([
      ['d.ts', `import 'node:fs'`],
      ['e.ts', `await import('node:child_process')`],
      ['f.ts', `const m = import("node:http")`],
      ['g.ts', `import('@taiji/shared/thing')`],
      ['ok3.ts', `import './side-effect-only'`],
    ])
    expect(vs.some((v) => v.includes('d.ts') && v.includes('node:fs'))).toBe(true)
    expect(vs.some((v) => v.includes('e.ts') && v.includes('node:child_process'))).toBe(true)
    expect(vs.some((v) => v.includes('f.ts') && v.includes('node:http'))).toBe(true)
    expect(vs.some((v) => v.includes('g.ts') && v.includes('@taiji/'))).toBe(true)
    expect(vs.some((v) => v.includes('ok3.ts'))).toBe(false)
  })

  it('干净源码零违规', () => {
    expect(scanSourceViolations([['clean.ts', `export const a = 1`]])).toEqual([])
  })
})

describe('判据数据（shared-node-builtin-rules.json）', () => {
  it('内置名单与 Node module.builtinModules 等值（去 node: 前缀）', () => {
    const rules = JSON.parse(readFileSync(RULES_PATH, 'utf8'))
    const nodeBuiltins = new Set(builtinModules.map((m) => m.replace(/^node:/, '')))
    expect(new Set(rules.builtinModules)).toEqual(nodeBuiltins)
  })
})

describe('reconcileRegistry：登记完备对账', () => {
  it('未登记与死登记分桶', () => {
    const r = reconcileRegistry(['a.ts', 'new.ts'], ['a.ts', 'gone.ts'])
    expect(r.unregistered).toEqual(['new.ts'])
    expect(r.dead).toEqual(['gone.ts'])
  })

  it('双向一致零差异', () => {
    const r = reconcileRegistry(['a.ts'], ['a.ts'])
    expect(r.unregistered).toEqual([])
    expect(r.dead).toEqual([])
  })

  it('目录级条目参与双向对账', () => {
    const r = reconcileRegistry(['a.ts', 'sub/'], ['a.ts', 'old-dir/'])
    expect(r.unregistered).toEqual(['sub/'])
    expect(r.dead).toEqual(['old-dir/'])
  })
})

describe('listSharedModules', () => {
  let root
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'shared-list-'))
    mkdirSync(join(root, '__tests__'))
    writeFileSync(join(root, '__tests__', 'ignored.ts'), '')
    writeFileSync(join(root, 'a.ts'), '')
    writeFileSync(join(root, 'b.json'), '')
    writeFileSync(join(root, 'c.vue'), '')
    writeFileSync(join(root, 'e.tsx'), '')
    writeFileSync(join(root, 'f.mts'), '')
    writeFileSync(join(root, 'g.cts'), '')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'd.ts'), '')
    mkdirSync(join(root, 'nested', 'deep'), { recursive: true })
    writeFileSync(join(root, 'nested', 'deep', 'x.ts'), '')
    mkdirSync(join(root, 'empty-dir'))
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'dep.ts'), '')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  it('递归发现模块：顶层按文件名、一级子目录按目录级条目（目录内文件不再逐个登记）', () => {
    expect(listSharedModules(root)).toEqual([
      'a.ts',
      'b.json',
      'e.tsx',
      'f.mts',
      'g.cts',
      'nested/',
      'sub/',
    ])
  })
})

describe('main --root 集成（tmpdir fixture 树）', () => {
  let root
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'shared-admission-'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  const run = (dir, script = SCRIPT_PATH) =>
    spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8' })

  const buildTree = (sub, { withViolation = false, registerAll = true } = {}) => {
    const dir = join(root, sub)
    mkdirSync(join(dir, 'packages', 'shared', 'src'), { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'packages/shared/src/a.ts'), 'export const a = 1')
    writeFileSync(
      join(dir, 'packages/shared/src/b.ts'),
      withViolation ? `import { readFileSync } from 'node:fs'` : 'export const b = 2',
    )
    const modules = registerAll
      ? [
          { file: 'a.ts', purpose: 'A 的跨包契约' },
          { file: 'b.ts', purpose: 'B 的跨包契约' },
        ]
      : [{ file: 'a.ts', purpose: 'A 的跨包契约' }]
    writeFileSync(join(dir, 'scripts/shared-module-registry.json'), JSON.stringify({ modules }, null, 2))
    return dir
  }

  it('干净树 → exit 0', () => {
    const r = run(buildTree('clean'))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('node 内置违规 → exit 1 且指明文件', () => {
    const r = run(buildTree('violation', { withViolation: true }))
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('node:fs')
  })

  it('未登记模块 → exit 1', () => {
    const r = run(buildTree('unregistered', { registerAll: false }))
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('b.ts')
  })

  it('子目录模块未登记 → exit 1 且报目录级条目', () => {
    const dir = buildTree('subdir-unregistered')
    mkdirSync(join(dir, 'packages/shared/src/feature'))
    writeFileSync(join(dir, 'packages/shared/src/feature/x.ts'), 'export const x = 1')
    const r = run(dir)
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('feature/')
  })

  it('子目录模块已按目录级条目登记 → exit 0', () => {
    const dir = buildTree('subdir-registered')
    mkdirSync(join(dir, 'packages/shared/src/feature'))
    writeFileSync(join(dir, 'packages/shared/src/feature/x.ts'), 'export const x = 1')
    writeFileSync(
      join(dir, 'scripts/shared-module-registry.json'),
      JSON.stringify(
        {
          modules: [
            { file: 'a.ts', purpose: 'A 的跨包契约' },
            { file: 'b.ts', purpose: 'B 的跨包契约' },
            { file: 'feature/', purpose: 'feature 目录的跨包契约' },
          ],
        },
        null,
        2,
      ),
    )
    const r = run(dir)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('shared 目录缺失 → exit 2', () => {
    const empty = join(root, 'empty')
    mkdirSync(empty)
    const r = run(empty)
    expect(r.status).toBe(2)
  })

  it('脚本路径含 # 时仍执行（pathToFileURL 归一化）', () => {
    // realpath 去掉 tmpdir 的符号链接前缀：import.meta.url 是解析后的真实路径，
    // 只留下 # 这一个变量，确保测的是 URL 编码而不是 symlink 差异
    const weird = mkdtempSync(join(realpathSync(tmpdir()), 'shared-admission-#-'))
    try {
      const scriptCopy = join(weird, 'check-shared-module-admission.mjs')
      copyFileSync(SCRIPT_PATH, scriptCopy)
      copyFileSync(RULES_PATH, join(weird, 'shared-node-builtin-rules.json'))
      const r = run(buildTree('hash-path'), scriptCopy)
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('PASS')
    } finally {
      rmSync(weird, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('check_shared_node_builtin.py（tmp mirror × spawnSync）', () => {
  const HOOK_SRC = join(SCRIPT_DIR, '..', '..', '.githooks', 'check_shared_node_builtin.py')

  /** <tmp>/.githooks/ 放 hook 副本、<tmp>/scripts/ 放判据数据（PROJECT_ROOT 解析即 <tmp>），
   *  fixture 为 { packages/shared/src 内相对路径: 内容 }。 */
  const makeHookFixture = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'shared-node-builtin-'))
    mkdirSync(join(root, '.githooks'), { recursive: true })
    mkdirSync(join(root, 'scripts'), { recursive: true })
    copyFileSync(HOOK_SRC, join(root, '.githooks', 'check_shared_node_builtin.py'))
    copyFileSync(RULES_PATH, join(root, 'scripts', 'shared-node-builtin-rules.json'))
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, 'packages/shared/src', rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    return {
      root,
      run: () =>
        spawnSync('python3', [join(root, '.githooks', 'check_shared_node_builtin.py')], {
          encoding: 'utf-8',
          timeout: 30_000,
        }),
      cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
    }
  }

  it('裸内置说明符（fs / fs/promises / child_process）→ exit 2 且指明文件', () => {
    const fx = makeHookFixture({
      'bare-fs.ts': `import { readFileSync } from 'fs'`,
      'bare-promises.ts': `import fs from 'fs/promises'`,
      'bare-side-effect.ts': `import 'child_process'`,
    })
    try {
      const r = fx.run()
      expect(r.status).toBe(2)
      expect(r.stdout).toContain('bare-fs.ts')
      expect(r.stdout).toContain('bare-promises.ts')
      expect(r.stdout).toContain('bare-side-effect.ts')
    } finally {
      fx.cleanup()
    }
  })

  it('node: 前缀（含 node:path 纯计算内置）→ exit 2', () => {
    const fx = makeHookFixture({
      'io.ts': `import { join } from 'node:path'`,
    })
    try {
      const r = fx.run()
      expect(r.status).toBe(2)
      expect(r.stdout).toContain('node:path')
    } finally {
      fx.cleanup()
    }
  })

  it('存量白名单与测试文件放行 → exit 0', () => {
    const fx = makeHookFixture({
      'paths.ts': `import { join } from 'node:path'`,
      'session-store-paths.ts': `import { join } from 'node:path'`,
      'plain.ts': `import { debounce } from 'lodash-es'`,
      '__tests__/helper.ts': `import { readFileSync } from 'fs'`,
      'io.test.ts': `import { readFileSync } from 'fs'`,
    })
    try {
      const r = fx.run()
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    } finally {
      fx.cleanup()
    }
  })

  it('判据数据缺失 → exit 2 且给出恢复动作（两条检查同源，不得各自维护副本）', () => {
    const fx = makeHookFixture({ 'a.ts': `export const a = 1` })
    try {
      rmSync(join(fx.root, 'scripts', 'shared-node-builtin-rules.json'))
      const r = fx.run()
      expect(r.status).toBe(2)
      expect(r.stdout).toContain('shared-node-builtin-rules.json')
      expect(r.stdout).toContain('修复动作')
    } finally {
      fx.cleanup()
    }
  })
})
