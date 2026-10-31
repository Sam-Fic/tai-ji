/**
 * M0-6 契约测试：S2 会话条目 diff 白名单工具的 CLI 行为。
 *
 * 覆盖：
 * - 自检入口可跑（--self-check 绿）；
 * - 运行时直读基线清单（--baseline 覆盖即改变判定，证明工具侧无内嵌副本）；
 * - 白名单外条目 / scope 限制 / 畸形输入判违规；
 * - 两时点增量语义（before 指纹扣除后只判新增行）；
 * - 输入错误退出码 2、--help 退出码 0。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const TOOL_PATH = fileURLToPath(new URL('../../../../../scripts/s2-session-entry-diff.mjs', import.meta.url))
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)))

let workDir: string
let emptyBefore: string
let afterAllowed: string
let afterForbidden: string
let afterUnknown: string
let afterBashPending: string
let afterWorkflowPending: string
let probeBaseline: string
let probeBaselineMainOnly: string

const allowedEntry = { id: 'probe-1', type: 'custom', customType: 'probe:allowed' }
const forbiddenEntry = { id: 'forbid-1', type: 'custom', customType: 'workflow-record' }
const unknownEntry = { id: 'unknown-1', type: 'custom', customType: 'probe:unknown' }
const bashPendingEntry = {
  id: 'bash-1',
  type: 'custom',
  customType: 'pending:register',
  data: { id: 'bash-1', type: 'bash', name: 'bg task' },
}
const workflowPendingEntry = {
  id: 'wf-pending-1',
  type: 'custom',
  customType: 'pending:register',
  data: { id: 'wf-pending-1', type: 'workflow', name: 'workflow run' },
}

function writeJsonl(filePath: string, entries: readonly unknown[]): void {
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf8')
}

function runTool(args: readonly string[]) {
  return spawnSync(process.execPath, [TOOL_PATH, ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'taiji-s2-entry-diff-'))
  emptyBefore = path.join(workDir, 'empty-before.jsonl')
  writeFileSync(emptyBefore, '', 'utf8')
  afterAllowed = path.join(workDir, 'after-allowed.jsonl')
  writeJsonl(afterAllowed, [allowedEntry])
  afterForbidden = path.join(workDir, 'after-forbidden.jsonl')
  writeJsonl(afterForbidden, [forbiddenEntry])
  afterUnknown = path.join(workDir, 'after-unknown.jsonl')
  writeJsonl(afterUnknown, [unknownEntry])
  afterBashPending = path.join(workDir, 'after-bash-pending.jsonl')
  writeJsonl(afterBashPending, [bashPendingEntry])
  afterWorkflowPending = path.join(workDir, 'after-workflow-pending.jsonl')
  writeJsonl(afterWorkflowPending, [workflowPendingEntry])
  probeBaseline = path.join(workDir, 'probe-baseline.json')
  writeFileSync(
    probeBaseline,
    JSON.stringify({
      schemaVersion: 1,
      contractVersion: 1,
      categories: { probe: 'self-check 探针分类' },
      unknownPolicy: { verdict: 'violation', reason: '白名单外条目' },
      rules: [
        {
          id: 'probe-allow',
          match: { entryType: 'custom', customType: 'probe:allowed' },
          category: 'probe',
          verdict: 'allow',
          allowIn: ['main', 'child'],
          source: 'contract-test',
          note: '测试夹具：证明分类由清单数据驱动',
        },
      ],
    }),
    'utf8',
  )
  probeBaselineMainOnly = path.join(workDir, 'probe-baseline-main-only.json')
  writeFileSync(
    probeBaselineMainOnly,
    JSON.stringify({
      schemaVersion: 1,
      contractVersion: 1,
      categories: { probe: 'scope 探针分类' },
      unknownPolicy: { verdict: 'violation', reason: '白名单外条目' },
      rules: [
        {
          id: 'probe-main-only',
          match: { entryType: 'custom', customType: 'probe:allowed' },
          category: 'probe',
          verdict: 'allow',
          allowIn: ['main'],
          source: 'contract-test',
          note: '测试夹具：main-only 放行规则',
        },
      ],
    }),
    'utf8',
  )
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('工具自检入口', () => {
  it('--self-check 绿（清单结构 + 分类 + scope + 运行时读清单 + 增量算法）', () => {
    const result = runTool(['--self-check'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[s2-session-entry-diff] self-check PASS')
  })

  it('--help 退出码 0 且打印用法', () => {
    const result = runTool(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('用法')
    expect(result.stdout).toContain('main-session-entry-baseline.json')
  })
})

describe('运行时直读基线清单（无内嵌副本）', () => {
  it('替换清单后同一探针条目放行（--baseline 生效）', () => {
    const result = runTool(['--before', emptyBefore, '--after', afterAllowed, '--baseline', probeBaseline])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PASS')
  })

  it('默认清单下同一探针条目判 unknown（工具侧无放行副本）', () => {
    const result = runTool(['--before', emptyBefore, '--after', afterAllowed])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('unknown')
  })
})

describe('增量判定', () => {
  it('白名单外条目（v2 生命周期）判违规并给出规则 id', () => {
    const result = runTool(['--before', emptyBefore, '--after', afterForbidden])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('rule=workflow-record')
    expect(result.stdout).toContain('reason=forbidden')
  })

  it('两时点增量只判新增行（before 已有条目不计入增量）', () => {
    const before = path.join(workDir, 'increment-before.jsonl')
    const after = path.join(workDir, 'increment-after.jsonl')
    writeJsonl(before, [allowedEntry])
    writeJsonl(after, [allowedEntry, forbiddenEntry])
    const result = runTool(['--before', before, '--after', after, '--baseline', probeBaseline, '--json'])
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout) as {
      incrementCount: number
      violations: Array<{ type?: string; reason: string }>
    }
    expect(report.incrementCount).toBe(1)
    expect(report.violations).toHaveLength(1)
  })

  it('白名单外未知类型判违规（unknownPolicy=violation）', () => {
    const result = runTool(['--before', emptyBefore, '--after', afterUnknown])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('unknown')
  })
})

describe('scope 判定', () => {
  it('bash 类 pending 属域外保留：主 session 与子会话均放行', () => {
    const main = runTool(['--before', emptyBefore, '--after', afterBashPending, '--scope', 'main'])
    expect(main.status).toBe(0)
    const child = runTool(['--before', emptyBefore, '--after', afterBashPending, '--scope', 'child'])
    expect(child.status).toBe(0)
  })

  it('workflow 类 pending 在子会话判违规（M3-5 判据）', () => {
    const child = runTool(['--before', emptyBefore, '--after', afterWorkflowPending, '--scope', 'child'])
    expect(child.status).toBe(1)
    expect(child.stdout).toContain('rule=pending-register-workflow-subagent')
    expect(child.stdout).toContain('reason=forbidden')
  })

  it('allow 规则的 allowIn 不含当前 scope 判 scope_not_allowed', () => {
    const child = runTool(['--before', emptyBefore, '--after', afterAllowed, '--baseline', probeBaselineMainOnly, '--scope', 'child'])
    expect(child.status).toBe(1)
    expect(child.stdout).toContain('scope_not_allowed')
    const main = runTool(['--before', emptyBefore, '--after', afterAllowed, '--baseline', probeBaselineMainOnly, '--scope', 'main'])
    expect(main.status).toBe(0)
  })
})

describe('pending:unregister dataType 推导（注销条目无 type，由同文件 register id→type 映射补齐）', () => {
  it('workflow 类注销：同文件 register 推导出 workflow → 判违规（M3-5 注销侧判据）', () => {
    const before = path.join(workDir, 'unreg-wf-before.jsonl')
    const after = path.join(workDir, 'unreg-wf-after.jsonl')
    writeJsonl(before, [workflowPendingEntry])
    writeJsonl(after, [
      workflowPendingEntry,
      {
        id: 'wf-unreg-1',
        type: 'custom',
        customType: 'pending:unregister',
        data: { id: 'wf-pending-1', reason: 'settled', status: 'collected' },
      },
    ])
    const result = runTool(['--before', before, '--after', after])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('rule=pending-unregister-execution')
    expect(result.stdout).toContain('reason=forbidden')
  })

  it('bash 类注销：同文件 register 推导出 bash → 域外放行', () => {
    const before = path.join(workDir, 'unreg-bash-before.jsonl')
    const after = path.join(workDir, 'unreg-bash-after.jsonl')
    writeJsonl(before, [bashPendingEntry])
    writeJsonl(after, [
      bashPendingEntry,
      {
        id: 'bash-unreg-1',
        type: 'custom',
        customType: 'pending:unregister',
        data: { id: 'bash-1', reason: 'settled', status: 'collected' },
      },
    ])
    const result = runTool(['--before', before, '--after', after])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('rule=pending-unregister-domain-external')
  })

  it('注销条目同文件无 register 源：推导失败走 unknown → 判违规', () => {
    const after = path.join(workDir, 'unreg-ghost-after.jsonl')
    writeJsonl(after, [
      {
        id: 'ghost-unreg-1',
        type: 'custom',
        customType: 'pending:unregister',
        data: { id: 'ghost-1', reason: 'settled', status: 'collected' },
      },
    ])
    const result = runTool(['--before', emptyBefore, '--after', after])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('unknown')
  })
})

describe('机器可读输出与输入错误', () => {
  it('--json 输出结构化报告（ok / counts / violations）', () => {
    const result = runTool(['--before', emptyBefore, '--after', afterForbidden, '--json'])
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout) as {
      ok: boolean
      scope: string
      incrementCount: number
      counts: { allow: number; forbid: number; unknown: number }
      violations: Array<{ ruleId?: string; reason: string }>
    }
    expect(report.ok).toBe(false)
    expect(report.scope).toBe('main')
    expect(report.incrementCount).toBe(1)
    expect(report.counts.forbid).toBe(1)
    expect(report.violations[0]?.ruleId).toBe('workflow-record')
  })

  it('缺 --before/--after → 退出码 2（输入错误，不与违规混淆）', () => {
    const result = runTool(['--after', afterAllowed])
    expect(result.status).toBe(2)
  })

  it('非法 scope → 退出码 2', () => {
    const result = runTool(['--before', emptyBefore, '--after', afterAllowed, '--scope', 'global'])
    expect(result.status).toBe(2)
  })

  it('未知参数 / 缺取值 → 退出码 2（不静默落到默认行为）', () => {
    expect(runTool(['--before', emptyBefore, '--after', afterAllowed, '--scoep', 'main']).status).toBe(2)
    expect(runTool(['--before', emptyBefore, '--after']).status).toBe(2)
  })
})
