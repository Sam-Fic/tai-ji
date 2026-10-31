/**
 * M0-5 契约测试：stepKey 生成规则与 Run/Member/Attempt 身份契约。
 *
 * 权威：设计 D3（身份稳定化与恢复约束）+ 契约级终态裁决第 8 项（D17）：
 * stepKey = 脚本哈希 + 调用点静态路径归一 + 分支序号；脚本哈希变化即拒绝恢复并
 * 显式报告；静态解析不可得名的运行时实例归「未匹配组」显式呈现，不强行匹配。
 */

import { describe, expect, it } from 'vitest'

import {
  RUN_RESUME_REJECTION_CODES,
  STABLE_IDENTITY_FIELDS,
  STEP_KEY_UNMATCHED_GROUP,
  checkRunResume,
  computeStepKey,
  formatCallSite,
  normalizeCallSitePath,
  normalizeCallSiteRef,
  resolveStepKey,
} from '../identity'

describe('身份不变契约（runId / memberId / attemptId 创建后不变）', () => {
  it('稳定身份字段清单恰三项（stepKey 是派生键，不是实体身份）', () => {
    expect([...STABLE_IDENTITY_FIELDS]).toEqual(['runId', 'memberId', 'attemptId'])
  })
})

describe('stepKey 生成规则（D3 / D17 第 8 项）', () => {
  it('确定性：同输入同键（算法冻结在契约测试里，改算法即红）', () => {
    const input = { scriptHash: 'abc123', callSite: 'workflows/review.js:12:5', occurrence: 0 }
    expect(computeStepKey(input)).toBe('514ecb3589d03425')
    expect(computeStepKey(input)).toBe(computeStepKey(input))
  })

  it('三输入任一变化即不同键：occurrence / scriptHash / callSite', () => {
    const base = { scriptHash: 'abc123', callSite: 'workflows/review.js:12:5', occurrence: 0 }
    const keys = new Set([
      computeStepKey(base),
      computeStepKey({ ...base, occurrence: 1 }),
      computeStepKey({ ...base, scriptHash: 'abc124' }),
      computeStepKey({ ...base, callSite: 'workflows/review.js:13:5' }),
    ])
    expect(keys.size).toBe(4)
  })

  it('调用点长度前缀编码消除分隔符歧义（不同三元组不得碰撞）', () => {
    const a = computeStepKey({ scriptHash: 'ab', callSite: 'c:1:1', occurrence: 0 })
    const b = computeStepKey({ scriptHash: 'a', callSite: 'bc:1:1', occurrence: 0 })
    expect(a).not.toBe(b)
  })

  it('输出固定 16 位小写十六进制', () => {
    expect(computeStepKey({ scriptHash: 'x', callSite: 'y:1:1', occurrence: 0 })).toMatch(/^[0-9a-f]{16}$/)
  })

  it('非法输入 fail-fast：空 scriptHash / 空 callSite / 负或小数 occurrence', () => {
    expect(() => computeStepKey({ scriptHash: '', callSite: 'y:1:1', occurrence: 0 })).toThrow('scriptHash')
    expect(() => computeStepKey({ scriptHash: 'x', callSite: '', occurrence: 0 })).toThrow('callSite')
    expect(() => computeStepKey({ scriptHash: 'x', callSite: 'y:1:1', occurrence: -1 })).toThrow('occurrence')
    expect(() => computeStepKey({ scriptHash: 'x', callSite: 'y:1:1', occurrence: 1.5 })).toThrow('occurrence')
  })
})

describe('调用点静态路径归一', () => {
  it('反斜杠 → /、剥前导 ./、折叠重复 /、去尾部 /', () => {
    expect(normalizeCallSitePath('.\\workflows\\\\review.js')).toBe('workflows/review.js')
    expect(normalizeCallSitePath('././workflows//review.js/')).toBe('workflows/review.js')
  })

  it('不解析 ..（不做文件系统归一，保证跨机器一致）', () => {
    expect(normalizeCallSitePath('workflows/../review.js')).toBe('workflows/../review.js')
  })

  it('结构化调用点格式化为 path:line:column（1 基行列）', () => {
    expect(formatCallSite({ scriptPath: './workflows/review.js', line: 12, column: 5 })).toBe('workflows/review.js:12:5')
  })

  it('绝对路径 / 盘符路径 / 非法行列 fail-fast（stepKey 必须跨机器一致）', () => {
    expect(() => formatCallSite({ scriptPath: '/abs/review.js', line: 1, column: 1 })).toThrow('绝对路径')
    expect(() => formatCallSite({ scriptPath: 'C:/abs/review.js', line: 1, column: 1 })).toThrow('绝对路径')
    expect(() => formatCallSite({ scriptPath: 'review.js', line: 0, column: 1 })).toThrow('line')
    expect(() => formatCallSite({ scriptPath: 'review.js', line: 1, column: 0 })).toThrow('column')
  })

  it('字符串调用点只做路径归一，保留已有行列后缀', () => {
    expect(normalizeCallSiteRef('./workflows//review.js:12:5')).toBe('workflows/review.js:12:5')
    expect(() => normalizeCallSiteRef('/abs/review.js:12:5')).toThrow('绝对路径')
  })

  it('空串 / 仅 ./ 前缀 fail-fast（严格归一层；未匹配容错由 resolveStepKey 入口承担）', () => {
    expect(() => normalizeCallSiteRef('')).toThrow('调用点为空')
    expect(() => normalizeCallSiteRef('./')).toThrow('调用点为空')
  })
})

describe('未匹配组（静态解析不可得名实例不强行匹配）', () => {
  it('callSite 缺省 → unmatched 组，且不产 stepKey', () => {
    const resolution = resolveStepKey({ scriptHash: 'abc123', occurrence: 0, label: 'callId-3' })
    expect(resolution).toEqual({
      kind: 'unmatched',
      group: STEP_KEY_UNMATCHED_GROUP,
      occurrence: 0,
      label: 'callId-3',
    })
    expect(STEP_KEY_UNMATCHED_GROUP).toBe('unmatched')
  })

  it('callSite 空串 / 仅 ./ 前缀（归一后为空）→ unmatched 组（字符串形态的静态解析不可得）', () => {
    for (const callSite of ['', './']) {
      expect(resolveStepKey({ scriptHash: 'abc123', callSite, occurrence: 2, label: 'callId-5' })).toEqual({
        kind: 'unmatched',
        group: STEP_KEY_UNMATCHED_GROUP,
        occurrence: 2,
        label: 'callId-5',
      })
    }
  })

  it('callSite 可得 → 静态解析出稳定键', () => {
    const resolution = resolveStepKey({
      scriptHash: 'abc123',
      callSite: { scriptPath: './workflows/review.js', line: 12, column: 5 },
      occurrence: 0,
    })
    expect(resolution).toMatchObject({
      kind: 'static',
      callSite: 'workflows/review.js:12:5',
      occurrence: 0,
      stepKey: '514ecb3589d03425',
    })
  })
})

describe('resume 契约（脚本哈希一致 + run 为 interrupted）', () => {
  it('哈希一致且 interrupted → 接受', () => {
    expect(checkRunResume({ status: 'interrupted', scriptHash: 'h1', recordedScriptHash: 'h1' })).toEqual({ ok: true })
  })

  it('哈希不一致 → resume_script_mismatch（显式错误码，不静默重放）', () => {
    expect(checkRunResume({ status: 'interrupted', scriptHash: 'h2', recordedScriptHash: 'h1' })).toEqual({
      ok: false,
      code: 'resume_script_mismatch',
    })
  })

  it('哈希一致但非 interrupted → run_not_interrupted', () => {
    expect(checkRunResume({ status: 'running', scriptHash: 'h1', recordedScriptHash: 'h1' })).toEqual({
      ok: false,
      code: 'run_not_interrupted',
    })
    expect(checkRunResume({ status: 'done', scriptHash: 'h1', recordedScriptHash: 'h1' })).toEqual({
      ok: false,
      code: 'run_not_interrupted',
    })
  })

  it('哈希不一致优先报告身份不匹配（即便状态也不合法）', () => {
    expect(checkRunResume({ status: 'running', scriptHash: 'h2', recordedScriptHash: 'h1' })).toEqual({
      ok: false,
      code: 'resume_script_mismatch',
    })
    expect([...RUN_RESUME_REJECTION_CODES]).toEqual(['resume_script_mismatch', 'run_not_interrupted'])
  })
})
