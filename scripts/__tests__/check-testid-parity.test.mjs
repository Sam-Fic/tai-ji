/**
 * check-testid-parity.mjs 单测：spec testid 引用 × renderer 实现对账逻辑。
 *
 * fixture 场景（内联源码片段，不依赖真实 renderer/e2e 的内容漂移）：
 *   - 实现提取三形态：静态属性 / 动态模板前缀 / 动态绑定字面量（三元）
 *   - 实现提取剥注释：JSDoc / 行注释 / 模板注释里的 data-testid 不算实现（PresetChip.vue 形态）
 *   - spec 引用形态：[data-testid="X"] / getByTestId('X')（单双引号）/ [data-testid^="P"] /
 *     模板字面量 `P${...}`（取静态前缀）/ 正则字面量 /^P.../（取字面前缀）/ 无插值模板按 exact
 *   - 变量形态 getByTestId(变量) 不可检测：不计入引用集
 *   - 精确引用被动态前缀覆盖（`turn-${...}` 族产出 turn-1）
 *   - 前缀引用被实现前缀 / exact 前缀命中覆盖
 *   - 悬空精确 / 悬空前缀判红；KNOWN_DANGLING 豁免分桶；stale 豁免（恢复实现且引用仍在）检出
 * 末组烟测 spawnSync --root 注入 tmpdir fixture 树（mkdtempSync 自建自删）直测
 * main 的退出码链路（绿 / 悬空红 / 实现目录缺失 2 / spec 目录缺失 2 / 目录存在但零 spec 2）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  extractImpls,
  extractSpecRefs,
  mergeExtracts,
  exactCovered,
  prefixCovered,
  parityCheck,
  collectSourceFiles,
  collectSpecFiles,
} from '../check-testid-parity.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(SCRIPT_DIR, '..', 'check-testid-parity.mjs')

describe('extractImpls：实现三形态提取', () => {
  it('静态属性 → exact', () => {
    const { exact, prefix } = extractImpls('a.vue', '<div data-testid="composer-box"></div>')
    expect(exact.get('composer-box')).toEqual(['a.vue'])
    expect(prefix.size).toBe(0)
  })

  it('动态模板前缀 → prefix（`${` 前静态段，含 : 绑定与不带 : 形态）', () => {
    const src = [
      '<Turn :data-testid="`turn-${turn.index}`" />',
      '<Row data-testid="`wf-viz-trace-row-${row.id}`" />',
    ].join('\n')
    const { prefix, exact } = extractImpls('b.vue', src)
    expect(prefix.has('turn-')).toBe(true)
    expect(prefix.has('wf-viz-trace-row-')).toBe(true)
    // 静态匹配的负向 lookbehind：`X${...}` 模板不被误收进 exact
    expect(exact.size).toBe(0)
  })

  it('动态绑定字面量（三元 / ||）→ exact', () => {
    const src = [
      `<div :data-testid="degradedZone ? 'session-body-flat' : 'default-project-flat-zone'" />`,
      `<div :data-testid="flag || 'fallback-lit'" />`,
    ].join('\n')
    const { exact } = extractImpls('c.vue', src)
    expect(exact.has('session-body-flat')).toBe(true)
    expect(exact.has('default-project-flat-zone')).toBe(true)
    expect(exact.has('fallback-lit')).toBe(true)
  })

  it('动态绑定三元内的反引号模板串 → prefix（ListTree.vue 行按钮形态）', () => {
    const src = `<div :data-testid="isClickable(item) ? \`gui-list-tree-action-\${i}\` : undefined" />`
    const { prefix, exact } = extractImpls('d.vue', src)
    expect(prefix.has('gui-list-tree-action-')).toBe(true)
    expect(exact.has('gui-list-tree-action-')).toBe(false)
  })

  it('注释文本不算实现（JSDoc / 行注释 / 模板注释；PresetChip.vue:31 形态）', () => {
    const src = [
      '/**',
      ' * 信任标记跨档不丢：纯图标档 = 右上角警示色角标（`data-testid="preset-chip-replace-badge"`）+ tooltip。',
      ' */',
      '// 行注释形态：data-testid="line-comment-id"',
      '<!-- <span data-testid="template-comment-id" /> -->',
      '<span data-testid="real-id" />',
    ].join('\n')
    const { exact, prefix } = extractImpls('PresetChip.vue', src)
    expect([...exact.keys()]).toEqual(['real-id'])
    expect(prefix.size).toBe(0)
  })
})

describe('extractSpecRefs：spec 引用形态', () => {
  it('[data-testid="X"] 与 getByTestId 单双引号 → exact；[^=] → prefix', () => {
    const src = [
      `const a = page.locator('[data-testid="tray-panel"]')`,
      `const b = page.getByTestId('composer-box')`,
      `const c = page.getByTestId("terminal-xterm")`,
      `const d = page.locator('[data-testid^="wf-viz-event-"]')`,
    ].join('\n')
    const { exact, prefix } = extractSpecRefs('s.spec.ts', src)
    expect([...exact.keys()].sort()).toEqual(['composer-box', 'terminal-xterm', 'tray-panel'])
    expect([...prefix.keys()]).toEqual(['wf-viz-event-'])
  })

  it('模板字面量 → 静态前缀、正则字面量 → 字面前缀、无插值模板 → exact、变量形态不计引用', () => {
    const src = [
      'const a = overlay.getByTestId(`wfvz-dag-node-${nodeId}`)',
      'const b = page.getByTestId(/^turn-\\d+$/)',
      'const c = page.getByTestId(opts.settleScopeTestId)',
      'const d = page.getByTestId(`composer-box`)',
    ].join('\n')
    const { exact, prefix } = extractSpecRefs('s.spec.ts', src)
    expect([...exact.keys()]).toEqual(['composer-box'])
    expect([...prefix.keys()].sort()).toEqual(['turn-', 'wfvz-dag-node-'])
  })
})

describe('parityCheck：对账判定', () => {
  const impls = (() => {
    const merged = { exact: new Map(), prefix: new Map() }
    mergeExtracts(merged, extractImpls('I1.vue', '<div data-testid="session-list"></div>'))
    mergeExtracts(merged, extractImpls('I2.vue', '<div :data-testid="`turn-${i}`" />'))
    mergeExtracts(merged, extractImpls('I3.vue', `<div :data-testid="x ? 'tree-node' : 'other'" />`))
    return merged
  })()

  it('精确引用被 exact 与动态前缀覆盖', () => {
    expect(exactCovered('session-list', impls)).toBe(true)
    expect(exactCovered('turn-7', impls)).toBe(true)
    expect(exactCovered('tree-node', impls)).toBe(true)
    expect(exactCovered('tray-workflow-row', impls)).toBe(false)
  })

  it('前缀引用被实现前缀 / exact 前缀段命中覆盖', () => {
    expect(prefixCovered('turn-', impls)).toBe(true)
    expect(prefixCovered('tree-', impls)).toBe(true)
    expect(prefixCovered('no-such-prefix-', impls)).toBe(false)
  })

  it('悬空分桶：豁免项进 exempted、未登记悬空进 dangling、stale 登记检出', () => {
    const specRefs = {
      exact: new Map([
        ['tray-workflow-row', ['s.spec.ts']],
        ['session-list', ['s.spec.ts']],
        ['tree-node', ['s.spec.ts']],
      ]),
      prefix: new Map(),
    }
    // session-list 有引用且有实现 → stale 登记检出；tree-node 有引用有实现未登记 → 正常绿
    const known = { 'tray-workflow-row': '退役条件', 'session-list': '已恢复实现的旧登记' }
    const r = parityCheck(specRefs, impls, known)
    expect(r.danglingExact).toEqual([])
    expect(r.exempted.map((e) => e.testid)).toEqual(['tray-workflow-row'])
    expect(r.staleExemptions).toEqual(['session-list'])
  })

  it('悬空前缀引用判红', () => {
    const specRefs = { exact: new Map(), prefix: new Map([['dead-prefix-', ['s.spec.ts']]]) }
    const r = parityCheck(specRefs, impls, {})
    expect(r.danglingPrefix.map((d) => d.testid)).toEqual(['dead-prefix-'])
  })
})

describe('文件收集', () => {
  let root
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'testid-parity-collect-'))
    mkdirSync(join(root, 'pkg', '__tests__'), { recursive: true })
    mkdirSync(join(root, 'pkg', 'sub'), { recursive: true })
    writeFileSync(join(root, 'pkg', 'A.vue'), '<div/>')
    writeFileSync(join(root, 'pkg', 'B.test.ts'), '')
    writeFileSync(join(root, 'pkg', '__tests__', 'C.ts'), '')
    writeFileSync(join(root, 'pkg', 'sub', 'D.ts'), '')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true , maxRetries: 5, retryDelay: 20 }))

  it('collectSourceFiles 排除 __tests__ 与 *.test.ts；collectSpecFiles 只收 *.spec.ts', () => {
    expect(collectSourceFiles(root)).toEqual([join(root, 'pkg', 'A.vue'), join(root, 'pkg', 'sub', 'D.ts')])
    writeFileSync(join(root, 'pkg', 'sub', 'E.spec.ts'), '')
    expect(collectSpecFiles(root)).toEqual([join(root, 'pkg', 'sub', 'E.spec.ts')])
  })
})

describe('main 退出码（--root 注入 tmpdir fixture 树）', () => {
  let root
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'testid-parity-main-'))
    // IMPL_ROOTS 四个目录齐备（main 对任一实现目录缺失 fail-fast exit 2）
    mkdirSync(join(root, 'packages', 'renderer', 'src'), { recursive: true })
    mkdirSync(join(root, 'packages', 'core', 'src'), { recursive: true })
    mkdirSync(join(root, 'packages', 'ui', 'src'), { recursive: true })
    mkdirSync(join(root, 'packages', 'dom-core', 'src'), { recursive: true })
    mkdirSync(join(root, 'e2e'), { recursive: true })
    writeFileSync(
      join(root, 'packages', 'renderer', 'src', 'Comp.vue'),
      '<div data-testid="composer-box"></div>',
    )
    writeFileSync(
      join(root, 'e2e', 'smoke.spec.ts'),
      `await page.getByTestId('composer-box')\n`,
    )
  })
  afterAll(() => rmSync(root, { recursive: true, force: true , maxRetries: 5, retryDelay: 20 }))

  const run = (args) =>
    spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' })

  it('绿：引用有实现 → exit 0', () => {
    const r = run(['--root', root])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('红：悬空引用 → exit 1 且输出明细', () => {
    writeFileSync(
      join(root, 'e2e', 'smoke.spec.ts'),
      `await page.getByTestId('tray-panel-deleted')\n`,
    )
    const r = run(['--root', root])
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('tray-panel-deleted')
  })

  it('输入错误：实现目录缺失 → exit 2', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'testid-parity-empty-'))
    try {
      const r = run(['--root', emptyRoot])
      expect(r.status).toBe(2)
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true , maxRetries: 5, retryDelay: 20 })
    }
  })

  it('输入错误：e2e spec 目录缺失 → exit 2（实现目录齐备时仍拦截，防空转恒 PASS）', () => {
    const noE2eRoot = mkdtempSync(join(tmpdir(), 'testid-parity-no-e2e-'))
    try {
      mkdirSync(join(noE2eRoot, 'packages', 'renderer', 'src'), { recursive: true })
      mkdirSync(join(noE2eRoot, 'packages', 'core', 'src'), { recursive: true })
      mkdirSync(join(noE2eRoot, 'packages', 'ui', 'src'), { recursive: true })
      mkdirSync(join(noE2eRoot, 'packages', 'dom-core', 'src'), { recursive: true })
      const r = run(['--root', noE2eRoot])
      expect(r.status).toBe(2)
      expect(r.stdout + r.stderr).toContain('e2e spec 目录缺失')
    } finally {
      rmSync(noE2eRoot, { recursive: true, force: true , maxRetries: 5, retryDelay: 20 })
    }
  })

  it('输入错误：e2e 目录存在但零 spec 文件 → exit 2（零引用对账恒 PASS 属 fail-open）', () => {
    const emptySpecRoot = mkdtempSync(join(tmpdir(), 'testid-parity-empty-spec-'))
    try {
      mkdirSync(join(emptySpecRoot, 'packages', 'renderer', 'src'), { recursive: true })
      mkdirSync(join(emptySpecRoot, 'packages', 'core', 'src'), { recursive: true })
      mkdirSync(join(emptySpecRoot, 'packages', 'ui', 'src'), { recursive: true })
      mkdirSync(join(emptySpecRoot, 'packages', 'dom-core', 'src'), { recursive: true })
      mkdirSync(join(emptySpecRoot, 'e2e'), { recursive: true })
      const r = run(['--root', emptySpecRoot])
      expect(r.status).toBe(2)
      expect(r.stdout + r.stderr).toContain('无 *.spec.ts')
    } finally {
      rmSync(emptySpecRoot, { recursive: true, force: true , maxRetries: 5, retryDelay: 20 })
    }
  })
})
