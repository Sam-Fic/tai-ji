/**
 * check-shared-module-admission.mjs 单测：shared 模块准入检查逻辑。
 *
 * fixture 场景（纯函数直测 + --root 注入 tmpdir fixture 树 spawnSync 集成，
 * mkdtempSync 自建自删，不触真实仓库状态）：
 *   - 依赖方向：@taiji/* import / 跨包相对 import 检出
 *   - IO 禁令：禁用内置（node:fs 等）检出；纯模块（node:path / node:os）放行
 *   - 登记完备：未登记模块 / 死登记 / 空 purpose 检出；双向一致通过
 *   - main --root：干净树绿 / 违规树红（exit 1）/ 目录缺失 exit 2
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  BANNED_BUILTINS,
  scanSourceViolations,
  reconcileRegistry,
  listTopModules,
} from '../check-shared-module-admission.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(SCRIPT_DIR, '..', 'check-shared-module-admission.mjs')

describe('scanSourceViolations：依赖方向与 IO 禁令', () => {
  it('import workspace 包与跨包相对路径检出', () => {
    const vs = scanSourceViolations([
      ['a.ts', `import { x } from '@taiji/shared/foo'`],
      ['b.ts', `import { y } from '../../../core/src/bar'`],
    ])
    expect(vs.some((v) => v.includes('a.ts') && v.includes('@taiji/'))).toBe(true)
    expect(vs.some((v) => v.includes('b.ts') && v.includes('跨包相对'))).toBe(true)
  })

  it('禁用内置检出，纯模块放行', () => {
    const vs = scanSourceViolations([
      ['c.ts', `import { readFileSync } from 'node:fs'`],
      ['ok.ts', `import { join } from 'node:path'`],
      ['ok2.ts', `import { homedir } from 'node:os'`],
    ])
    expect(vs).toEqual(['c.ts: 禁用内置 import node:fs（shared 纯模块形态，规则 3）'])
    expect(BANNED_BUILTINS).toContain('node:child_process')
  })

  it('干净源码零违规', () => {
    expect(scanSourceViolations([['clean.ts', `export const a = 1`]])).toEqual([])
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
})

describe('listTopModules', () => {
  it('只收顶层 .ts/.json 文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'shared-list-'))
    try {
      mkdirSync(join(root, '__tests__'))
      writeFileSync(join(root, 'a.ts'), '')
      writeFileSync(join(root, 'b.json'), '')
      writeFileSync(join(root, 'c.vue'), '')
      mkdirSync(join(root, 'sub'))
      writeFileSync(join(root, 'sub', 'd.ts'), '')
      expect(listTopModules(root)).toEqual(['a.ts', 'b.json'])
    } finally {
      rmSync(root, { recursive: true, force: true , maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('main --root 集成（tmpdir fixture 树）', () => {
  let root
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'shared-admission-'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true , maxRetries: 5, retryDelay: 20 }))

  const run = (dir) => spawnSync(process.execPath, [SCRIPT_PATH, '--root', dir], { encoding: 'utf8' })

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

  it('IO 内置违规 → exit 1 且指明文件', () => {
    const r = run(buildTree('violation', { withViolation: true }))
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('node:fs')
  })

  it('未登记模块 → exit 1', () => {
    const r = run(buildTree('unregistered', { registerAll: false }))
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('b.ts')
  })

  it('shared 目录缺失 → exit 2', () => {
    const empty = join(root, 'empty')
    mkdirSync(empty)
    const r = run(empty)
    expect(r.status).toBe(2)
  })
})
