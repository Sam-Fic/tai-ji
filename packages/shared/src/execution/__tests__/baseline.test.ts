/**
 * M0-2 契约测试：主 session JSONL 条目类型基线清单。
 *
 * 断言三件事：
 * ① 清单是机器可读数据文件、结构合法（校验器 = S2 diff 工具的同一实现）；
 * ② 设计点名的写点全部登记（goal:log / 投递日志 / v2 生命周期 / pi-scheduler /
 *    workflow-subagent pending）；
 * ③ 工具运行时直读本文件（DEFAULT_BASELINE_PATH 指向它），工具源码零内嵌白名单副本。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

interface BaselineRule { // oe-exempt:20261031:framework:测试内 fixture 类型（基线清单形状描述，无 implements/extends 语义）
  id: string
  match: Record<string, unknown>
  category: string
  verdict: 'allow' | 'forbid'
  allowIn: string[]
  source: string
  note: string
}

interface BaselineDocument { // oe-exempt:20261031:framework:测试内 fixture 类型（基线清单形状描述，无 implements/extends 语义）
  schemaVersion: number
  contractVersion: number
  categories: Record<string, string>
  rules: BaselineRule[]
  unknownPolicy: { verdict: string; reason: string }
}

interface S2ToolModule { // oe-exempt:20261031:framework:测试内 fixture 类型（基线清单形状描述，无 implements/extends 语义）
  validateBaseline(baseline: unknown): string[]
  DEFAULT_BASELINE_PATH: string
}

const BASELINE_URL = new URL('../main-session-entry-baseline.json', import.meta.url)
const TOOL_URL = new URL('../../../../../scripts/s2-session-entry-diff.mjs', import.meta.url)
const tool = (await import(TOOL_URL.href)) as unknown as S2ToolModule

const baselineText = readFileSync(BASELINE_URL, 'utf8')
const baseline = JSON.parse(baselineText) as unknown as BaselineDocument

function ruleById(id: string): BaselineRule {
  const rule = baseline.rules.find((candidate) => candidate.id === id)
  if (!rule) throw new Error(`基线清单缺少规则：${id}`)
  return rule
}

describe('M0-2 条目类型基线清单（机器可读数据文件）', () => {
  it('清单结构合法（S2 工具校验器零错误）', () => {
    expect(tool.validateBaseline(baseline)).toEqual([])
  })

  it('schemaVersion / contractVersion / 四类分类 / unknownPolicy 就位', () => {
    expect(baseline.schemaVersion).toBe(1)
    expect(baseline.contractVersion).toBe(1)
    expect(Object.keys(baseline.categories).sort()).toEqual([
      'conversation',
      'deliveryLog',
      'executionState',
      'extensionState',
    ])
    expect(baseline.unknownPolicy.verdict).toBe('violation')
  })

  it('工具默认读取路径 = 本清单（运行时直读单源）', () => {
    expect(tool.DEFAULT_BASELINE_PATH).toBe(fileURLToPath(BASELINE_URL))
  })

  it('工具源码零内嵌白名单副本（清单值不得出现在工具代码里）', () => {
    const toolSource = readFileSync(TOOL_URL, 'utf8')
    for (const literal of ['goal:log', 'workflow-record', 'subagent-record', 'subagent-identity', 'pi-scheduler:']) {
      expect(toolSource).not.toContain(literal)
    }
  })

  it('设计点名的扩展写点已登记：goal:log 五处写点 + 投递日志', () => {
    expect(ruleById('goal-log').match.customType).toBe('goal:log')
    expect(ruleById('goal-log').verdict).toBe('allow')
    expect(ruleById('goal-log').note).toContain('agent-end.ts:207/255/279/304')
    expect(ruleById('delivery-port-ack').verdict).toBe('allow')
    expect(ruleById('delivery-port-outbox').category).toBe('deliveryLog')
  })

  it('v2 生命周期条目全部判禁止：subagent-record / workflow-record / subagent-identity', () => {
    for (const id of ['subagent-record', 'workflow-record', 'subagent-identity']) {
      const rule = ruleById(id)
      expect(rule.verdict).toBe('forbid')
      expect(rule.category).toBe('executionState')
      expect(rule.allowIn).toEqual([])
    }
  })

  it('pi-scheduler 只拦 custom entry（dispatch 注入的 custom_message 属对话类）', () => {
    const rule = ruleById('pi-scheduler-execution-custom')
    expect(rule.match.entryType).toBe('custom')
    expect(rule.match.customTypePrefix).toBe('pi-scheduler:')
    expect(rule.verdict).toBe('forbid')
    expect(ruleById('pi-custom-message').verdict).toBe('allow')
  })

  it('workflow/subagent 类 pending 禁止；bash/session 类 pending 属域外保留（主子会话均放行）', () => {
    const executionPending = ruleById('pending-register-workflow-subagent')
    expect(executionPending.verdict).toBe('forbid')
    expect(executionPending.match.dataType).toEqual(['workflow', 'subagent'])
    const domainExternal = ruleById('pending-register-bash-session')
    expect(domainExternal.verdict).toBe('allow')
    expect(domainExternal.allowIn).toEqual(['main', 'child'])
    expect(domainExternal.match.dataType).toEqual(['bash', 'session'])
    expect(ruleById('pending-unregister-execution').verdict).toBe('forbid')
    expect(ruleById('pending-unregister-domain-external').verdict).toBe('allow')
  })

  it('清单不含本机绝对路径（仓库内容纪律）', () => {
    expect(baselineText).not.toMatch(/\/Users\/[^/]+\//)
    expect(baselineText).not.toMatch(/[A-Za-z]:\\\\/)
  })

  it('规则 id 全局唯一（校验器之外再锁一次运行级）', () => {
    const ids = baseline.rules.map((rule) => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
