/**
 * check-test-typecheck-coverage.mjs 单测：renderer 测试 typecheck 覆盖对账逻辑。
 *
 * fixture 场景（纯函数直测 + --no-run 静态对账链 spawnSync 注入，不真跑 vue-tsc——
 * 双跑集成验证由 CI 步骤承担）：
 *   - include 全量四形态断言（缺形态检出）
 *   - isTestFile 判定（.test.ts / .spec.ts / __tests__ 内 .ts；.d.ts 除外）
 *   - parseErrorFiles 只收 src/ 前缀 renderer 文件（他包传递错误不计账）
 *   - reconcileDebt：未登记新债务 / stale 可收编分桶
 *   - buildFullTsconfig：extends 绝对化 + exclude 清空 + include/paths 绝对化
 *   - classifyRun / runDebtReconciliation：正式跑与全量跑同一错误分级（spawn 失败 =
 *     基础设施故障，不归因 exclude 债务；runner 注入，不真跑 vue-tsc）
 *   - main --no-run：临时 tsconfig 树（mkdtempSync 自建自删）形态断言红/绿
 *   - isMain：脚本路径含 # 时仍执行 main（pathToFileURL 判定，不退化为空转 exit 0）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  missingIncludeForms,
  isTestFile,
  collectTestFiles,
  parseErrorFiles,
  reconcileDebt,
  buildFullTsconfig,
  classifyRun,
  runDebtReconciliation,
} from '../check-test-typecheck-coverage.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(SCRIPT_DIR, '..', 'check-test-typecheck-coverage.mjs')

describe('include 形态断言', () => {
  it('全量四形态齐备 → 零缺失', () => {
    expect(
      missingIncludeForms([
        'src/**/__tests__/**/*',
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
      ]),
    ).toEqual([])
  })

  it('回退为白名单枚举 → 检出缺失形态', () => {
    expect(missingIncludeForms(['src/__tests__/a.test.ts', 'src/**/*.d.ts'])).toEqual([
      'src/**/__tests__/**/*',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/*.spec.ts',
    ])
  })
})

describe('isTestFile / collectTestFiles', () => {
  it('测试文件判定矩阵', () => {
    expect(isTestFile('src/__tests__/a.test.ts')).toBe(true)
    expect(isTestFile('src/x.spec.ts')).toBe(true)
    expect(isTestFile('src/stores/canvas.test.ts')).toBe(true)
    expect(isTestFile('src/__tests__/helpers/mock.ts')).toBe(true)
    expect(isTestFile('src/components/a.vue')).toBe(false)
    expect(isTestFile('src/env.d.ts')).toBe(false)
    expect(isTestFile('src/__tests__/fixtures.d.ts')).toBe(false)
  })

  it('collectTestFiles 保留 baseDir 相对前缀（src/ 前缀与 exclude 对齐）', () => {
    const root = mkdtempSync(join(tmpdir(), 'collect-testfiles-'))
    try {
      mkdirSync(join(root, 'src', '__tests__'), { recursive: true })
      writeFileSync(join(root, 'src', '__tests__', 'a.test.ts'), '')
      writeFileSync(join(root, 'src', 'main.ts'), '')
      const rel = collectTestFiles(join(root, 'src'), root)
      expect(rel).toEqual(['src/__tests__/a.test.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true , maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('parseErrorFiles', () => {
  it('只收 src/ 前缀文件，他包传递错误不计', () => {
    const out = [
      'src/__tests__/a.test.ts(12,3): error TS2322: Type A',
      '../subagent-core/src/execution/x.ts(1,1): error TS6133: unused',
      'src/components/B.vue(4,5): error TS2339: Property',
      '不相关行',
    ].join('\n')
    expect(parseErrorFiles(out)).toEqual(['src/__tests__/a.test.ts', 'src/components/B.vue'])
  })
})

describe('reconcileDebt', () => {
  it('未登记债务与 stale 分桶', () => {
    const r = reconcileDebt(['src/a.test.ts', 'src/b.test.ts'], ['src/b.test.ts', 'src/fixed.test.ts'])
    expect(r.unregistered).toEqual(['src/a.test.ts'])
    expect(r.stale).toEqual(['src/fixed.test.ts'])
  })

  it('完全一致 → 双空', () => {
    const r = reconcileDebt(['src/a.test.ts'], ['src/a.test.ts'])
    expect(r).toEqual({ unregistered: [], stale: [] })
  })
})

describe('buildFullTsconfig', () => {
  it('extends/include/paths 绝对化 + exclude 清空', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'build-full-tsconfig-'))
    try {
      const rendererDir = join(tmp, 'renderer')
      mkdirSync(rendererDir)
      const formalPath = join(rendererDir, 'tsconfig.typecheck-test.json')
      writeFileSync(
        formalPath,
        JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            paths: { '@/*': ['./src/*'] },
          },
          include: ['src/**/__tests__/**/*', '../../apps/electron/preload/index.d.ts'],
          exclude: ['src/__tests__/debt.test.ts'],
        }),
      )
      const fullTsconfigPath = buildFullTsconfig(formalPath, tmp)
      const full = JSON.parse(readFileSync(fullTsconfigPath, 'utf8'))
      expect(full.extends).toBe(formalPath)
      expect(full.exclude).toEqual([])
      expect(full.include[0]).toBe(join(rendererDir, 'src/**/__tests__/**/*'))
      expect(full.compilerOptions.paths['@/*'][0]).toBe(join(rendererDir, './src/*').replace('/./', '/'))
    } finally {
      rmSync(tmp, { recursive: true, force: true , maxRetries: 5, retryDelay: 20 })
    }
  })
})

describe('classifyRun（正式跑 / 全量跑同一错误分级判据）', () => {
  it('零退出 → ok；非零且零可解析错误 → infra（原始输出留证）；非零且有错误 → type-error', () => {
    expect(classifyRun({ status: 0, stdout: '' })).toEqual({ kind: 'ok', errorFiles: [], detailLines: [] })

    const infra = classifyRun({ status: 1, stdout: 'Error: spawn pnpm ENOENT\n\n    at ChildProcess\n' })
    expect(infra.kind).toBe('infra')
    expect(infra.errorFiles).toEqual([])
    expect(infra.detailLines).toEqual(['Error: spawn pnpm ENOENT', '    at ChildProcess'])

    const typed = classifyRun({
      status: 2,
      stdout: 'src/__tests__/a.test.ts(1,1): error TS2322: Type string\n噪声行\n',
    })
    expect(typed.kind).toBe('type-error')
    expect(typed.errorFiles).toEqual(['src/__tests__/a.test.ts'])
    expect(typed.detailLines).toEqual(['src/__tests__/a.test.ts(1,1): error TS2322: Type string'])
  })
})

describe('runDebtReconciliation（runner 注入，不真跑 vue-tsc）', () => {
  const withTsconfig = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'debt-reconcile-'))
    try {
      writeFileSync(join(dir, 'tsconfig.typecheck-test.json'), JSON.stringify({ include: [], exclude: [] }))
      return fn(dir, join(dir, 'tsconfig.typecheck-test.json'))
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }

  it('正式跑 spawn 失败（零可解析错误）→ 报基础设施故障并带原始输出，不归因 exclude 债务', () => {
    withTsconfig((dir, tsconfigPath) => {
      const failures = []
      const r = runDebtReconciliation(dir, tsconfigPath, { exclude: [] }, failures, () => ({
        status: 1,
        stdout: 'Error: spawn pnpm ENOENT\n',
      }))
      const text = failures.join('\n')
      expect(r.formalInfra).toBe(true)
      expect(text).toContain('typecheck 基础设施故障')
      expect(text).toContain('spawn pnpm ENOENT')
      expect(text).not.toContain('新登记外文件存在类型错误')
      expect(text).not.toContain('exclude 显式登记')
    })
  })

  it('正式跑有类型错误 → 报「新登记外文件存在类型错误」，明细取 error TS 行', () => {
    withTsconfig((dir, tsconfigPath) => {
      const failures = []
      let calls = 0
      const formalOut = 'src/__tests__/a.test.ts(1,1): error TS2322: Type string is not assignable\n'
      const r = runDebtReconciliation(dir, tsconfigPath, { exclude: [] }, failures, () => {
        calls += 1
        return calls === 1 ? { status: 1, stdout: formalOut } : { status: 0, stdout: '' }
      })
      const text = failures.join('\n')
      expect(r.formalInfra).toBe(false)
      expect(r.debtFindings).toBe(1)
      expect(text).toContain('新登记外文件存在类型错误')
      expect(text).toContain('error TS2322')
      expect(text).not.toContain('基础设施故障')
    })
  })
})

describe('main --no-run（静态对账链，不真跑 vue-tsc）', () => {
  let root
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'coverage-main-'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true , maxRetries: 5, retryDelay: 20 }))

  const run = (dir) =>
    spawnSync(process.execPath, [SCRIPT_PATH, '--no-run', '--renderer-dir', dir], { encoding: 'utf8' })

  it('include 白名单回退 → exit 1 且指出缺失形态', () => {
    const dir = join(root, 'regress')
    mkdirSync(join(dir, 'src', '__tests__'), { recursive: true })
    writeFileSync(join(dir, 'src', '__tests__', 'a.test.ts'), '')
    writeFileSync(
      join(dir, 'tsconfig.typecheck-test.json'),
      JSON.stringify({ include: ['src/**/*.d.ts'], exclude: [] }),
    )
    const r = run(dir)
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('include 缺全量形态')
  })

  it('全量形态 + 空债务 → exit 0', () => {
    const dir = join(root, 'clean')
    mkdirSync(join(dir, 'src', '__tests__'), { recursive: true })
    writeFileSync(
      join(dir, 'tsconfig.typecheck-test.json'),
      JSON.stringify({
        include: [
          'src/**/__tests__/**/*',
          'src/**/*.test.ts',
          'src/**/*.test.tsx',
          'src/**/*.spec.ts',
          'src/**/*.d.ts',
        ],
        exclude: [],
      }),
    )
    const r = run(dir)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('tsconfig 缺失 → exit 2', () => {
    const empty = join(root, 'missing')
    mkdirSync(empty)
    const r = run(empty)
    expect(r.status).toBe(2)
  })
})

describe('isMain 判定（路径含 # 不得退化为静默 exit 0）', () => {
  it('脚本副本位于含 # 的目录 → 仍执行 main 并输出 PASS', () => {
    // import.meta.url 取的是 realpath（/var → /private/var），副本路径也用 realpath
    // 基址，确保 # 是 href 比对的唯一变量
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ismain-hash-')))
    try {
      const hashDir = join(base, 'dir#hash')
      mkdirSync(hashDir)
      const copy = join(hashDir, 'check-test-typecheck-coverage.mjs')
      writeFileSync(copy, readFileSync(SCRIPT_PATH, 'utf8'))

      const rendererDir = join(base, 'renderer')
      mkdirSync(join(rendererDir, 'src', '__tests__'), { recursive: true })
      writeFileSync(
        join(rendererDir, 'tsconfig.typecheck-test.json'),
        JSON.stringify({
          include: [
            'src/**/__tests__/**/*',
            'src/**/*.test.ts',
            'src/**/*.test.tsx',
            'src/**/*.spec.ts',
          ],
          exclude: [],
        }),
      )
      const r = spawnSync(process.execPath, [copy, '--no-run', '--renderer-dir', rendererDir], {
        encoding: 'utf8',
      })
      expect(r.stdout).toContain('PASS')
      expect(r.status).toBe(0)
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
