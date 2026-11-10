/**
 * plugin-host fork env 注入 → TAIJI_PLUGIN_SANDBOX_DIR 包根形态回归测试
 * （ISSUES-2 ⑤ 的宿主侧锁；2026-11-10 wool-qoder 安装激活失败事故后补）。
 *
 * 事故形态：040f3f569 已把宿主注入从 dirname(pluginPath) 改为 findPackageRootDir
 * （子目录入口 src/index.ts 下 dirname 会把沙箱边界错划成 <插件根>/src，插件对
 * <插件根>/node_modules 的裸导入全部被判越界，激活即炸、安装回滚），该修复在某次
 * 合并中被静默回退为 dirname 形态。既有 SEC-A3（domains-bundle）用例自算包根构造
 * env——模拟「正确的宿主」而非验证宿主本身，回退后照绿，防线空转。
 *
 * 本文件锁宿主真实注入代码路径：fork 桩捕获 options.env，断言 sandbox 分支注入的
 * TAIJI_PLUGIN_SANDBOX_DIR = 插件包根（含 package.json 的祖先），并显式排除
 * dirname 回退形态。改回 dirname(pluginPath) → 本用例红且错误信息指向 ⑤ 包根修正。
 *
 * 形态：与 plugin-host-process-journal.test.ts 同款 fork 桩（零真进程，桩只替换
 * 进程边界，被测物是宿主 env 装配——纯代码路径，默认单测层）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/plugin-host-process-sandbox-env.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname as pathDirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginHostProcess } from '../plugin-host-process.js'
import { PluginRpcServer } from '../plugin-rpc-server.js'

const __dirname = pathDirname(fileURLToPath(import.meta.url))
const LOADER_PATH = join(__dirname, '../plugin-esm-loader.cjs')

// ── fork 桩：假子进程 + fork options 捕获 seam（零真进程）────────────
const forkSlot = vi.hoisted(() => ({
  child: null as unknown,
  options: null as { env?: NodeJS.ProcessEnv } | null,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    fork: (_file: string, _args: readonly string[], options?: { env?: NodeJS.ProcessEnv }): ChildProcess => {
      forkSlot.options = options ?? null
      if (forkSlot.child) return forkSlot.child as ChildProcess
      throw new Error('fork stub: 未装入假子进程（用例须先 installFakeChild）')
    },
  }
})

/** 假 fork 子进程：只实现 PluginHostProcess 消费的成员面（常驻形态，afterEach 回收）。 */
class FakeForkChild extends EventEmitter {
  readonly pid = 4321
  exitCode: number | null = null
  signalCode: string | null = null
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  kill(): void {
    this.emit('exit', null, 'SIGKILL')
  }
  send(_message: unknown): boolean {
    return true
  }
}

let activeHost: PluginHostProcess | null = null
const createdDirs: string[] = []

afterEach(async () => {
  forkSlot.child = null
  forkSlot.options = null
  if (activeHost) {
    await activeHost.shutdown()
    activeHost = null
  }
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  createdDirs.length = 0
})

describe('plugin-host fork env → TAIJI_PLUGIN_SANDBOX_DIR = 插件包根（ISSUES-2 ⑤ 宿主侧锁）', () => {
  it('子目录入口（src/index.mjs，真实发布形态）：sandbox 根注入包根而非入口 dirname', async () => {
    // 真实插件布局：包根 package.json + 子目录入口；node_modules 依赖在包根下
    const pkgRoot = mkdtempSync(join(tmpdir(), 'plugin-sbx-env-'))
    createdDirs.push(pkgRoot)
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'p-sub-entry', version: '1.0.0' }))
    mkdirSync(join(pkgRoot, 'src'), { recursive: true })
    writeFileSync(join(pkgRoot, 'src', 'index.mjs'), 'export const loaded = true\n')
    // bootstrap 占位：fork 已桩化不执行，resolveAndValidateFile 链短路
    const bootstrapStub = join(pkgRoot, 'bootstrap-not-executed.cjs')
    writeFileSync(bootstrapStub, '')

    const child = new FakeForkChild()
    forkSlot.child = child as unknown
    activeHost = new PluginHostProcess(new PluginRpcServer(), {
      bootstrapPathOverride: bootstrapStub,
      execArgv: ['--import', LOADER_PATH],
    })

    await activeHost.assignProcess('p-sub-entry', 'sandbox', join(pkgRoot, 'src', 'index.mjs'))

    const env = forkSlot.options?.env
    expect(env, 'fork 桩应捕获 options.env').toBeDefined()
    // 注入值 = 包根（含 package.json 的祖先）——插件 node_modules 依赖的裸导出判界依据
    expect(env!.TAIJI_PLUGIN_SANDBOX_DIR).toBe(pkgRoot)
    // 显式排除回退形态：dirname(入口) = <包根>/src（⑤ 修复曾被合并静默回退为此形态，
    // wool 家族 src/ 入口安装即激活失败——2026-11-10 qoder 安装事故）
    expect(env!.TAIJI_PLUGIN_SANDBOX_DIR, 'sandbox 根退化为入口 dirname（ISSUES-2 ⑤ 修复丢失？）').not.toBe(pathDirname(join(pkgRoot, 'src', 'index.mjs')))
  })
})
