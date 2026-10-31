/**
 * run-affected-e2e-ci.mjs 单测：CI 执行消费者的清单过滤、计划分桶与失败归因。
 *
 * fixture 场景（纯函数直测 + --json-in 注入 + spawnSync 集成，不真跑 e2e 命令、
 * 不依赖仓库 git diff 状态）：
 *   - selectCiRunnable：on-diff × L1 消费面（always / L2 / L2.5 排除）
 *   - planExecution：e2e-map 条目 ci.runnable=false 分桶跳过（带理由），缺省 /
 *     ci.runnable=true 进 runnable
 *   - classifyFailure：用例失败（非零退出码）与无法执行（无退出码 / 126 / 127 /
 *     被信号终止）分桶，摘要单行截断
 *   - --dry-run --json-in：注入清单文件 → 输出执行/跳过计划、exit 0
 *   - --json-in 真实执行：失败 rule 判红、跳过项不执行、两类失败分开聚合
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { selectCiRunnable, planExecution, classifyFailure } from '../run-affected-e2e-ci.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(SCRIPT_DIR, '..', 'run-affected-e2e-ci.mjs')

const DESKTOP_SKIP = {
  runnable: false,
  skipReason: 'playwright electron project 需桌面环境（xvfb / mac runner）',
}

const RULES = [
  { id: 'E2E-ELECTRON-01', layer: 'L1', trigger: 'always', serial: false, run: 'r1', summary: 's' },
  { id: 'E2E-MOCK-02', layer: 'L1', trigger: 'on-diff', serial: false, run: 'r2', summary: 's' },
  { id: 'E2E-REAL-01', layer: 'L2', trigger: 'on-diff', serial: true, run: 'r3', summary: 's' },
  { id: 'E2E-SPAWNISOL-01', layer: 'L1', trigger: 'on-diff', serial: false, run: 'r4', summary: 's', ci: DESKTOP_SKIP },
  { id: 'E2E-PIPE-20', layer: 'L1', trigger: 'on-diff', serial: false, run: 'r6', summary: 's', ci: { runnable: true } },
  { id: 'E2E-EQUIV-01', layer: 'L2.5', trigger: 'on-diff', serial: true, run: 'r5', summary: 's' },
]

describe('selectCiRunnable：CI 消费面过滤', () => {
  it('只留 on-diff × L1', () => {
    expect(selectCiRunnable(RULES).map((r) => r.id)).toEqual([
      'E2E-MOCK-02',
      'E2E-SPAWNISOL-01',
      'E2E-PIPE-20',
    ])
  })
})

describe('planExecution：执行计划分桶', () => {
  it('ci.runnable=false 跳过且带登记理由，缺省与 ci.runnable=true 进 runnable', () => {
    const { runnable, skipped } = planExecution(selectCiRunnable(RULES))
    expect(runnable.map((r) => r.id)).toEqual(['E2E-MOCK-02', 'E2E-PIPE-20'])
    expect(skipped.map((s) => s.rule.id)).toEqual(['E2E-SPAWNISOL-01'])
    expect(skipped[0].reason).toBe(DESKTOP_SKIP.skipReason)
  })

  it('跳过理由缺失时输出显式告警文本（不静默 undefined）', () => {
    const { skipped } = planExecution([{ id: 'E2E-X-01', ci: { runnable: false } }])
    expect(skipped[0].reason).toContain('未登记 skipReason')
  })
})

describe('classifyFailure：用例失败 / 无法执行分桶', () => {
  it('非零退出码 = 用例失败（assert）', () => {
    const r = classifyFailure({ status: 1, signal: null, message: 'Command failed: node e2e/x.mjs' })
    expect(r.kind).toBe('assert')
    expect(r.detail).toContain('exit=1')
    expect(r.detail).toContain('Command failed')
  })

  it('无退出码（spawn 失败）= 无法执行（exec）', () => {
    const r = classifyFailure({ code: 'ENOENT', status: null, signal: null, message: 'spawn missing-cmd ENOENT' })
    expect(r.kind).toBe('exec')
    expect(r.detail).toContain('ENOENT')
  })

  it('被信号终止 = 无法执行（exec）', () => {
    const r = classifyFailure({ status: null, signal: 'SIGTERM', message: 'Command failed: sleep 1000' })
    expect(r.kind).toBe('exec')
    expect(r.detail).toContain('signal=SIGTERM')
  })

  it('126 / 127（POSIX shell 不可执行 / 找不到命令）= 无法执行（exec）', () => {
    expect(classifyFailure({ status: 126, message: 'Command failed' }).kind).toBe('exec')
    expect(classifyFailure({ status: 127, message: 'Command failed' }).kind).toBe('exec')
  })

  it('摘要单行化并截断到 400 字符', () => {
    const r = classifyFailure({ status: 2, message: `line1\n${'x'.repeat(500)}` })
    expect(r.detail.length).toBeLessThanOrEqual(400)
    expect(r.detail).not.toContain('\n')
  })
})

describe('--dry-run --json-in 集成', () => {
  let root
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'run-affected-ci-'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))

  it('注入清单 → 打印计划 exit 0，不真跑命令', () => {
    const jsonPath = join(root, 'rules.json')
    writeFileSync(jsonPath, JSON.stringify(RULES, null, 2))
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--dry-run', '--json-in', jsonPath], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('[run] E2E-MOCK-02')
    expect(r.stdout).toContain('[skip] E2E-SPAWNISOL-01')
    expect(r.stdout).toContain('xvfb')
    expect(r.stdout).toContain('未执行')
  })

  it('失败用例：exit 1，跳过项不执行，失败分桶标注「用例失败」', () => {
    const failing = [
      { id: 'E2E-FAIL-01', layer: 'L1', trigger: 'on-diff', serial: false, run: 'node -e "process.exit(3)"', summary: 's' },
      {
        id: 'E2E-SKIP-01',
        layer: 'L1',
        trigger: 'on-diff',
        serial: false,
        run: 'node -e "process.exit(9)"',
        summary: 's',
        ci: { runnable: false, skipReason: '登记跳过：验证跳过项不会被执行' },
      },
    ]
    const jsonPath = join(root, 'failing.json')
    writeFileSync(jsonPath, JSON.stringify(failing, null, 2))
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--json-in', jsonPath], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('----- [E2E-FAIL-01] FAIL（用例）')
    expect(r.stderr).toContain('exit=3')
    expect(r.stderr).toContain('用例失败（命令已执行并返回非零退出码）：E2E-FAIL-01')
    // 登记跳过项完全不执行（run 里的 exit 9 不会发生，也没有该 rule 的执行分段）
    expect(r.stdout).not.toContain('===== [E2E-SKIP-01]')
    expect(r.stdout).not.toContain('[E2E-SKIP-01] PASS')
  })
})
