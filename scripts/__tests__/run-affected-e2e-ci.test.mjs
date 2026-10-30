/**
 * run-affected-e2e-ci.mjs 单测：CI 执行消费者的清单过滤与计划分桶。
 *
 * fixture 场景（纯函数直测 + --json-in 注入 + --dry-run spawnSync 集成，
 * 不真跑 e2e 命令、不依赖仓库 git diff 状态）：
 *   - selectCiRunnable：on-diff × L1 消费面（always / L2 / L2.5 排除）
 *   - planExecution：SKIP_IN_CI 登记项分桶跳过（带理由）、未登记项进 runnable
 *   - --dry-run --json-in：注入清单文件 → 输出执行/跳过计划、exit 0
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { selectCiRunnable, planExecution, SKIP_IN_CI } from '../run-affected-e2e-ci.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(SCRIPT_DIR, '..', 'run-affected-e2e-ci.mjs')

const RULES = [
  { id: 'E2E-ELECTRON-01', layer: 'L1', trigger: 'always', serial: false, run: 'r1', summary: 's' },
  { id: 'E2E-MOCK-02', layer: 'L1', trigger: 'on-diff', serial: false, run: 'r2', summary: 's' },
  { id: 'E2E-REAL-01', layer: 'L2', trigger: 'on-diff', serial: true, run: 'r3', summary: 's' },
  { id: 'E2E-SPAWNISOL-01', layer: 'L1', trigger: 'on-diff', serial: false, run: 'r4', summary: 's' },
  { id: 'E2E-EQUIV-01', layer: 'L2.5', trigger: 'on-diff', serial: true, run: 'r5', summary: 's' },
]

describe('selectCiRunnable：CI 消费面过滤', () => {
  it('只留 on-diff × L1', () => {
    expect(selectCiRunnable(RULES).map((r) => r.id)).toEqual(['E2E-MOCK-02', 'E2E-SPAWNISOL-01'])
  })
})

describe('planExecution：执行计划分桶', () => {
  it('SKIP_IN_CI 登记项跳过且带理由，其余进 runnable', () => {
    const { runnable, skipped } = planExecution(selectCiRunnable(RULES))
    expect(runnable.map((r) => r.id)).toEqual(['E2E-MOCK-02'])
    expect(skipped.map((s) => s.rule.id)).toEqual(['E2E-SPAWNISOL-01'])
    expect(skipped[0].reason).toBe(SKIP_IN_CI['E2E-SPAWNISOL-01'])
    expect(SKIP_IN_CI['E2E-SPAWNISOL-01']).toContain('xvfb')
  })
})

describe('--dry-run --json-in 集成', () => {
  let root
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'run-affected-ci-'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true , maxRetries: 5, retryDelay: 20 }))

  it('注入清单 → 打印计划 exit 0，不真跑命令', () => {
    const jsonPath = join(root, 'rules.json')
    writeFileSync(jsonPath, JSON.stringify(RULES, null, 2))
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--dry-run', '--json-in', jsonPath], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('[run] E2E-MOCK-02')
    expect(r.stdout).toContain('[skip] E2E-SPAWNISOL-01')
    expect(r.stdout).toContain('未执行')
  })
})
