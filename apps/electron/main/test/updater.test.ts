// updater.test.ts —— electron-main-test C08 簇合并产物（round5-G）。
// 共同被测业务模块：`update/updater-script.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - test/updater-script-integration.test.ts（23 用例，skip 18）
//   - test/updater-script.test.ts（12 用例，skip 0）
//
// 池分离（live 池拆分）：TAIJI_E2E_UPDATER 门控的 mac 真链三段（端到端 / 中断注入 /
// 磁盘满 P10，14 用例）已整段保形迁移到 test/updater.e2e.test.ts（独立 live 池，全量
// 门禁以 --project '!live' 排除；e2e-map 登记 = E2E-UPDATER-01）。本文件保留
// INTEGRATION 档快用例 21 个（bash 语法检查 3 + linux mv 4 + CLI 工具 2 + mock 模板
// 断言 12；e2e-map 登记 = E2E-INTEG-53）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from '../../../../test-guard/integration-gate.ts'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { buildUpdaterScript, buildLinuxUpdaterScript, type UpdaterScriptVars, type LinuxUpdaterScriptVars } from '../update/updater-script'

// ======== 来源：updater-script-integration.test.ts ========
describe("updater-script-integration", () => {
  // 文件级超时预算：管辖本文件剩余的门控 describe（linux mv 段走集成门控）的真执行
  // 用例（本地默认跳过时不生效）。用例经真 bash 子进程全链执行，CI 的 runner 高负载
  // 下 vitest 默认 20s 有撞线风险（历史基线见 2026-09-07 v0.9.15 post-merge CI 两连挂，
  // 时 60s 预算覆盖 mac 真链三段 + linux 段；mac 三段拆出后预算沿用，吸收 CI 抖动）。
  // 注意：用例级第三参显式超时会覆盖本预算——除既有存量外不要补第三参，
  // 统一由这行管辖，新增用例也不要写显式超时。
  vi.setConfig({ testTimeout: 60_000 })

  // ──────────────────────────────────────────────────────────────────
  // 环境探测：哪些系统命令可用（决定哪些用例能真实跑）
  // ──────────────────────────────────────────────────────────────────

  /** 安全的 which：命令存在返回 true，否则 false（不抛异常）。 */
  function hasCommand(cmd: string): boolean {
    // bash -c 单字符串形式避免「spawn shell:true + args」的 DEP0190 弃用警告；
    // 命令名是测试内常量、无注入风险。
    const r = spawnSync('bash', ['-c', `command -v ${cmd}`])
    return r.status === 0
  }

  const HAS_HDIUTIL = hasCommand('hdiutil') // 生成 dmg + 脚本挂载/卸载（CLI 工具守护断言对象；mac 真链三段已拆至 updater.e2e.test.ts）
  const HAS_DITTO = hasCommand('ditto')     // 脚本 dmg→staging 拷贝用（批次 3 解包原语；CLI 工具守护断言对象）
  const HAS_SHASUM = hasCommand('shasum')  // mac 脚本 sha256 用（CLI 工具守护断言对象）
  const IS_MAC = process.platform === 'darwin'

  // mac 真链三段的 TAIJI_E2E_UPDATER 门控常量与 MAC_SUITE_READY 就绪条件已随三段
  // 迁至 test/updater.e2e.test.ts（live 池；e2e-map E2E-UPDATER-01）。

  /** 门控 describe 名：跳过时显式携带理由（env 未设置 = 本地默认跳过），不静默消失。
   *  skipReason 默认走集成门控理由（linux 段）；mac 真链三段的 E2E 档理由在 updater.e2e.test.ts。 */
  function gatedTitle(name: string, skipReason: string = INTEGRATION_TESTS_ENABLED ? '' : INTEGRATION_TESTS_SKIP_REASON): string {
    return name + (skipReason ? `｜skip：${skipReason}` : '')
  }

  // ──────────────────────────────────────────────────────────────────
  // 临时目录生命周期（per-test：vitest 可扩展 test context 传递，用例间零共享变量）
  // ──────────────────────────────────────────────────────────────────

  /** 用例级作用域：beforeEach 写入 tmpDir，用例体与 afterEach 经同一 context 对象读回。 */
  interface TestScope { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    tmpDir: string
  }

  beforeEach<TestScope>((ctx) => {
    ctx.tmpDir = mkdtempSync(path.join(tmpdir(), 'updater-int-'))
  })

  afterEach<TestScope>(async (ctx) => {
    const t = ctx.tmpDir
    if (!t || !existsSync(t)) return
    // 磁盘镜像用例可能留下挂载点：先尝试卸载再删目录（失败仅告警，不让 teardown 掩盖用例结果）
    const mnt = path.join(t, 'mnt')
    if (existsSync(mnt) && IS_MAC && HAS_HDIUTIL) {
      await detachQuiet(mnt)
    }
    try {
      rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch (e) {
      console.warn('[warn] tmpDir 清理失败（可能挂载点残留）:', e)
    }
  })

  // ──────────────────────────────────────────────────────────────────
  // 共享 dmg 资产（五元组惰性缓存 + 首造互斥）已随 mac 真链三段迁至
  // test/updater.e2e.test.ts——本文件剩余段（bash 语法检查 / linux mv / CLI 工具）
  // 零 dmg 构造。
  // ──────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────
  // 辅助函数
  // ──────────────────────────────────────────────────────────────────

  /**
 * 异步执行外部命令并采集 stdio（promisify spawn；用 close 事件保证管道排空后才返回，
 * 与 spawnSync 的 { encoding: 'utf8' } 采集语义等价）。
 * timeoutMs 到点向子进程发 SIGTERM（spawnSync 默认 killSignal 同款），超时判定
 * 由调用方按 signal === 'SIGTERM' 完成。
 */
  function execCapture(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      const timer = opts.timeoutMs !== undefined
        ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs)
        : undefined
      child.on('error', (e) => {
        if (timer !== undefined) clearTimeout(timer)
        reject(e)
      })
      child.on('close', (code, signal) => {
        if (timer !== undefined) clearTimeout(timer)
        resolve({ status: code, signal, stdout, stderr })
      })
    })
  }

  /** 安静卸载挂载点（teardown 兜底路径：结果不关心、不抛错、异步不阻塞事件循环）。 */
  function detachQuiet(mountPoint: string): Promise<void> {
    return new Promise((resolve) => {
      const c = spawn('hdiutil', ['detach', mountPoint, '-force'], { stdio: 'ignore' })
      c.on('close', () => resolve())
      c.on('error', () => resolve())
    })
  }

  function writeScriptToTmp(tmpDir: string, script: string, name = 'updater.sh'): string {
    const p = path.join(tmpDir, name)
    writeFileSync(p, script, { mode: 0o755 })
    return p
  }

  /**
 * 异步执行 bash 脚本（spawn + close 采集，timeout 硬上限）。
 * 超时（SIGTERM）明确抛错——避免被当成正常 exit 误判为通过（假绿）。
 */
  const BASH_TIMEOUT_MS = 15_000

  async function runBash(tmpDir: string, scriptPath: string, timeoutMs = BASH_TIMEOUT_MS): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const r = await execCapture('bash', [scriptPath], { cwd: tmpDir, timeoutMs })
    if (r.signal === 'SIGTERM') {
      throw new Error(
        `bash 脚本超时（${timeoutMs}ms）：${scriptPath}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      )
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  // runBashDetached / killGroup / waitFor / pauseAfterStage / stripOpenLine（中断注入
  // 与 mac 真链专用夹具）已随 mac 三段迁至 test/updater.e2e.test.ts。

  /** 剥掉 linux 脚本 sha256 校验段（聚焦 mv 决策树的用例用；sha 语义由 mac 侧覆盖）。 */
  function stripLinuxSha(script: string): string {
    return script.replace(/\nACTUAL="\$\(sha256sum[\s\S]*?\nfi\n/, '\necho "[test] skip sha check (covered by mac integration suite)"\n')
  }

  /** 剥掉 linux 脚本末尾后台重启行（不真启动 AppImage）。 */
  function stripLinuxRestart(script: string): string {
    return script.replace(/^"[^"]+" &\s*$/m, 'echo "[test] skip AppImage spawn"')
  }

  /**
 * 把 60s 超时（120 轮）压成 6 轮（3s），让超时 abort 用例快速出结果。
 * [HISTORICAL] 曾压成 2 轮（1s）：CI runner 高负载下 bash spawn + 脚本前置步骤的
 * 调度抖动可吃掉大半窗口，v0.10.8 post-merge macOS job 实测 flaky（2/23，rerun 绿）。
 * 3s 对抖动容忍 ×3，代价仅超时用例时长 +2s。
 */
  function shortenWaitLimit(script: string): string {
    if (!script.includes('-gt 120')) throw new Error('未找到等待上限 -gt 120（模板变了？）')
    return script.replace('-gt 120', '-gt 6')
  }

  /** mac 用标准 vars（parentPid 默认死 PID：kill -0 立即失败 = 模拟 app 已退出）。 */
  function makeMacVars(tmpDir: string, opts: {
    dmgPath: string
    sha256: string
    appBundleName?: string
    binaryName?: string
    appBundle?: string
    parentPid?: string
    targetVersion?: string
  }): UpdaterScriptVars {
    const appBundleName = opts.appBundleName ?? 'TaiJi.app'
    const binaryName = opts.binaryName ?? 'TaiJi'
    return {
      appBundle: opts.appBundle ?? path.join(tmpDir, 'installed', appBundleName),
      dmgPath: opts.dmgPath,
      sha256: opts.sha256,
      logPath: path.join(tmpDir, 'updater.log'),
      resultPath: path.join(tmpDir, 'update-result.json'),
      appName: binaryName,
      targetVersion: opts.targetVersion ?? '0.9.0-integration',
      parentPid: opts.parentPid ?? '9999999',
    }
  }

  // ════════════════════════════════════════════════════════════════
  // bash 语法检查（不依赖 hdiutil/ditto，最稳）
  // ════════════════════════════════════════════════════════════════
  describe('updater-script integration: bash 语法检查', () => {
    it<TestScope>('mac 脚本：buildUpdaterScript 产物 bash -n 通过（语法正确、无残留占位符炸）', ({ tmpDir }) => {
      const script = buildUpdaterScript(makeMacVars(tmpDir, { dmgPath: '/tmp/x.dmg', sha256: 'a'.repeat(64) }))
      const scriptPath = writeScriptToTmp(tmpDir, script)

      expect(script, '执行产物不应残留 {{...}} 占位符').not.toMatch(/\{\{[^}]+\}\}/)
      const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' })
      expect(r.status, `bash -n 应通过；stderr=${r.stderr}`).toBe(0)
    })

    it<TestScope>('linux 脚本：buildLinuxUpdaterScript 产物 bash -n 通过', ({ tmpDir }) => {
      const script = buildLinuxUpdaterScript({
        appImagePath: path.join(tmpDir, 'x.appimage'),
        newFilePath: path.join(tmpDir, 'y.appimage'),
        sha256: 'a'.repeat(64),
        logPath: path.join(tmpDir, 'l.log'),
        resultPath: path.join(tmpDir, 'r.json'),
        targetVersion: '0.9.0-int',
        parentPid: '9999999',
      })
      const scriptPath = writeScriptToTmp(tmpDir, script, 'linux-updater.sh')
      expect(script).not.toMatch(/\{\{[^}]+\}\}/)

      const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' })
      expect(r.status, `bash -n 应通过；stderr=${r.stderr}`).toBe(0)
    })

    it<TestScope>('mac 脚本：sha256 含特殊字符也不破坏 bash 语法（防御注入）', ({ tmpDir }) => {
      const weirdButHex = '0'.repeat(64)
      const script = buildUpdaterScript(makeMacVars(tmpDir, { dmgPath: '/tmp/x.dmg', sha256: weirdButHex }))
      const r = spawnSync('bash', ['-n', writeScriptToTmp(tmpDir, script)], { encoding: 'utf8' })
      expect(r.status).toBe(0)
    })
  })

  // ════════════════════════════════════════════════════════════════
  // LINUX 脚本：mv 备份/回滚决策树 + 检查（不真 spawn AppImage）【集成门控】
  // 真真 bash 子进程执行整脚本（含压缩后的真实等待窗），与 mac 三段同属「代码 + OS
  // 组合行为」——retry:2 与 bash 预算 15s 正是本段负载敏感症状，一并挂门控。
  // 本段无 hdiutil 依赖（纯 bash 子进程），CI ubuntu 可跑，保留集成门控
  // TAIJI_TEST_INTEGRATION（mac 真链三段走 E2E 档，在 test/updater.e2e.test.ts）。
  // ════════════════════════════════════════════════════════════════
  describe.skipIf(!INTEGRATION_TESTS_ENABLED)(gatedTitle('updater-script integration: linux mv 备份/回滚'), () => {
    function makeLinuxVars(tmpDir: string, opts: { appImagePath?: string; newFilePath?: string } = {}): LinuxUpdaterScriptVars {
      return {
        appImagePath: opts.appImagePath ?? path.join(tmpDir, 'TaiJi-x86_64.AppImage'),
        newFilePath: opts.newFilePath ?? path.join(tmpDir, 'update', 'TaiJi-x86_64.AppImage'),
        sha256: 'a'.repeat(64), // mv 决策树用例剥离 sha 段，占位满足类型
        logPath: path.join(tmpDir, 'updater-linux.log'),
        resultPath: path.join(tmpDir, 'update-result.json'),
        targetVersion: '0.9.0-int',
        parentPid: '9999999',
      }
    }

    /** linux 主体脚本：剥 sha 段（sha 语义由 mac 侧覆盖）+ 剥后台重启行。 */
    function buildLinuxBodyScript(vars: LinuxUpdaterScriptVars): string {
      return stripLinuxRestart(stripLinuxSha(buildLinuxUpdaterScript(vars)))
    }

    it<TestScope>('happy path：备份 + 换装 + chmod 755 + status=done + .old 清理', async ({ tmpDir }) => {
      const vars = makeLinuxVars(tmpDir)
      writeFileSync(vars.appImagePath, 'OLD AppImage content')
      mkdirSync(path.dirname(vars.newFilePath), { recursive: true })
      writeFileSync(vars.newFilePath, 'NEW AppImage content')

      const scriptPath = writeScriptToTmp(tmpDir, buildLinuxBodyScript(vars), 'linux-updater.sh')
      const r = await runBash(tmpDir, scriptPath)

      expect(r.status, `期望 exit 0，stderr=${r.stderr}`).toBe(0)
      expect(existsSync(vars.appImagePath)).toBe(true)
      expect(readFileSync(vars.appImagePath, 'utf8')).toBe('NEW AppImage content')
      expect(existsSync(`${vars.appImagePath}.old`)).toBe(false)
      const mode = statSync(vars.appImagePath).mode & 0o777
      expect(mode, `chmod 应为 755，实际=${mode.toString(8)}`).toBe(0o755)
      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string }
      expect(result.status).toBe('done')
    })

    it<TestScope>('mv 失败回滚：新文件不存在 → exit 1、旧 AppImage 恢复、error=mv failed', async ({ tmpDir }) => {
      const vars = makeLinuxVars(tmpDir)
      writeFileSync(vars.appImagePath, 'OLD AppImage content')
      // 不创建 newFilePath → S4 mv 必失败 → 回滚

      const scriptPath = writeScriptToTmp(tmpDir, buildLinuxBodyScript(vars), 'linux-updater.sh')
      const r = await runBash(tmpDir, scriptPath)

      expect(r.status, 'mv 失败应 exit 1').toBe(1)
      expect(existsSync(vars.appImagePath), '旧 AppImage 应被回滚恢复').toBe(true)
      expect(readFileSync(vars.appImagePath, 'utf8')).toBe('OLD AppImage content')
      expect(existsSync(`${vars.appImagePath}.old`), '回滚后 .old 应被 mv 走').toBe(false)
      const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
      expect(result.error).toBe('mv failed')
    })

    // retry: 2 —— CI macOS runner 高负载下实测 flaky（v0.10.8 post-merge 2/23，rerun 绿），
    // chmod 语义与负载的耦合无法在 JS 侧消除，retry 兜底环境敏感性
    it<TestScope>('只读检测：APP_DIR 不可写 → exit 1、error=read-only volume、不动任何文件', { retry: 2 }, async ({ tmpDir }) => {
      const appDir = path.join(tmpDir, 'readonly-mount')
      mkdirSync(appDir, { recursive: true })
      const vars = makeLinuxVars(tmpDir, { appImagePath: path.join(appDir, 'TaiJi-x86_64.AppImage') })
      writeFileSync(vars.appImagePath, 'OLD content')

      chmodSync(appDir, 0o555)
      try {
        const scriptPath = writeScriptToTmp(tmpDir, buildLinuxBodyScript(vars), 'linux-updater.sh')
        const r = await runBash(tmpDir, scriptPath)
        expect(r.status, '只读目录应 exit 1').toBe(1)
        const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
        expect(result.error).toBe('read-only volume')
        // 只读检测在等待/sha/备份之前 → .old 不应产生
        expect(existsSync(`${vars.appImagePath}.old`)).toBe(false)
      } finally {
        chmodSync(appDir, 0o755)
      }
    })

    // retry: 2 —— 等待窗已放宽到 3s（见 shortenWaitLimit），retry 再兜一层极端调度抖动
    it<TestScope>('等待超时 abort：父进程不退 → failed(app still running)', { retry: 2 }, async ({ tmpDir }) => {
      const vars = makeLinuxVars(tmpDir)
      writeFileSync(vars.appImagePath, 'OLD AppImage content')
      mkdirSync(path.dirname(vars.newFilePath), { recursive: true })
      writeFileSync(vars.newFilePath, 'NEW AppImage content')

      const parent = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
      parent.once('exit', () => {})
      const timedVars: LinuxUpdaterScriptVars = { ...vars, parentPid: String(parent.pid) }
      try {
        const script = shortenWaitLimit(buildLinuxBodyScript(timedVars))
        const scriptPath = writeScriptToTmp(tmpDir, script, 'linux-updater.sh')
        const r = await runBash(tmpDir, scriptPath)
        expect(r.status, '超时应 exit 1').toBe(1)
        const result = JSON.parse(readFileSync(vars.resultPath, 'utf8')) as { status: string; error: string }
        expect(result.error).toBe('app still running')
        expect(readFileSync(vars.appImagePath, 'utf8')).toBe('OLD AppImage content')
      } finally {
        try { if (parent.pid) process.kill(parent.pid, 'SIGKILL') } catch { /* 已退 */ }
      }
    })
  })

  // ════════════════════════════════════════════════════════════════
  // 脚本依赖的 CLI 工具可用性（失败原因可读性）
  // ════════════════════════════════════════════════════════════════
  describe('updater-script integration: 脚本依赖的 CLI 工具', () => {
    it('shasum 可用（mac 脚本 sha256 校验依赖）', () => {
      expect(HAS_SHASUM, 'shasum 应在 PATH 中（macOS 标配）').toBe(true)
    })

    // hdiutil/ditto 是 macOS-only 工具：test-main job 在 ubuntu（ci.yml「只跑 ubuntu
    // 上能跑的子集」）上必然缺失，非 mac 跳过；mac 上仍实跑守护解包原语依赖。
    it.skipIf(!IS_MAC)('hdiutil + ditto 可用（mac 脚本 dmg 挂载/拷贝/卸载依赖，批次 3 解包原语）', () => {
      if (!HAS_HDIUTIL || !HAS_DITTO) {
        console.warn('[warn] hdiutil/ditto 不在 PATH，mac 端到端用例已跳过')
      }
      expect(HAS_HDIUTIL, 'hdiutil 应在 PATH 中（macOS 标配）').toBe(true)
      expect(HAS_DITTO, 'ditto 应在 PATH 中（macOS 标配）').toBe(true)
    })
  })
});

// ======== 来源：updater-script.test.ts ========
describe("updater-script", () => {
  /** 标准变量 fixture（parentPid 用不存在的 PID——9999999 超过 macOS/linux pid_max） */
  const MAC_VARS = {
    appBundle: '/Applications/TaiJi.app',
    dmgPath: '/Users/test/.taiji/update/TaiJi-mac-arm64.dmg',
    sha256: 'a'.repeat(64),
    logPath: '/Users/test/.taiji/update/updater.log',
    resultPath: '/Users/test/.taiji/update/update-result.json',
    appName: 'TaiJi',
    targetVersion: '0.9.0',
    parentPid: '9999999',
  }

  const LINUX_VARS = {
    appImagePath: '/home/test/TaiJi-x86_64.AppImage',
    newFilePath: '/home/test/.taiji/update/TaiJi-x86_64.AppImage',
    sha256: 'a'.repeat(64),
    logPath: '/Users/test/.taiji/update/updater-linux.log',
    resultPath: '/Users/test/.taiji/update/update-result.json',
    targetVersion: '0.9.0',
    parentPid: '9999999',
  }

  describe('u1a: mac 脚本模板（staging 状态机 + §3.3.2 全检查）', () => {
    it('生成脚本含 §3.3.2 全部命令级检查且占位符全替换', () => {
      const script = buildUpdaterScript(MAC_VARS)

      // ── 验收条款①逐项检查（grep 级断言，验收对照）─────────────────
      const guards: Array<[string, string]> = [
        // dmg 解包链退出码显式检查（批次 3 §3.3.3-B：hdiutil attach + ditto）
        ['attach 退出码检查', 'if ! hdiutil attach -nobrowse -readonly "{{DMG_PATH}}"'],
        ['挂载失败错误码', 'fail "dmg mount failed'],
        ['ditto 退出码检查', 'if ! ditto "$SRC_APP" "$STAGED_APP"'],
        ['ditto 失败错误码', 'fail "ditto copy failed"'],
        // 主二进制缺失错误码（RI1 检查，S8：解包后主二进制存在检查保留）
        ['主二进制缺失错误码', 'fail "extract failed"'],
        // 备份 mv 失败 abort（RM7：不吞错）
        ['备份 mv 失败检查', 'if ! mv "$APP" "$APP_OLD"'],
        ['备份失败错误码', 'fail "backup failed"'],
        // 60s 超时 abort（PID 制 kill -0，120 轮 × 0.5s）
        ['PID 制等待', 'while kill -0 "$PARENT_PID" 2>/dev/null'],
        ['60s 上限（120 轮）', '-gt 120'],
        ['轮询步长 0.5s', 'sleep 0.5'],
        ['等待超时错误码', 'fail "app still running"'],
        // /Volumes 只读拒装（RM7 循环场景）
        ['只读卷检测', '/Volumes/*)'],
        ['只读卷错误码', 'fail "read-only volume"'],
        // 换装失败回滚（S4：回滚 .old 后写 failed）
        ['换装 mv 失败检查', 'if ! mv "$APP_NEW" "$APP"'],
        ['回滚备份', 'mv "$APP_OLD" "$APP"'],
        ['换装失败错误码', 'fail "swap failed"'],
        // sha256 校验（verify-before-replace 保持现状）
        ['sha256 校验', 'shasum -a 256'],
        ['sha 错误码', 'fail "sha mismatch"'],
      ]
      for (const [name, frag] of guards) {
        // guards 里的 {{DMG_PATH}} 片段是模板源形态，比对前替换为实际注入值
        const expected = frag.replaceAll('{{DMG_PATH}}', MAC_VARS.dmgPath)
        expect(script, `应包含检查: ${name} (${expected})`).toContain(expected)
      }

      // ── tmp + rename 原子写 result（m12）───────────────────────────
      expect(script).toContain(`RESULT_TMP="${MAC_VARS.resultPath}.tmp"`)
      expect(script).toContain('> "$RESULT_TMP"')
      expect(script).toContain(`mv -f "$RESULT_TMP" "${MAC_VARS.resultPath}"`)

      // ── 状态机结构（S1-S5 stage 标记 + 两步中转）───────────────────
      for (const stage of ['S1 extract begin', 'S2 promote begin', 'S3 backup begin', 'S4 swap begin', 'S5 finalize begin']) {
        expect(script, `应包含 stage 标记: ${stage}`).toContain(`[stage] ${stage}`)
      }
      // 两步中转：先 ditto 拷贝到 STAGING_DIR、成功后 mv 为 .app.new
      // （dmg 内 .app 经 ditto 拷到 staging，再同卷 mv 为 .app.new）
      expect(script).toContain('STAGING_DIR=')
      expect(script).toContain('mv "$STAGED_APP" "$APP_NEW"')
      // S1/S2 残留清理（状态机恢复方：上次中断残留本次解包前清除）
      expect(script).toContain('rm -rf "$STAGING_DIR" "$APP_NEW"')
      // 主二进制存在检查（可运行 app，Contents/MacOS/<appName>）
      expect(script).toContain('[ ! -x "$MAIN_BINARY" ]')
      expect(script).toContain(`Contents/MacOS/${MAC_VARS.appName}`)

      // ── 契约与重启语义 ─────────────────────────────────────────────
      // PARENT_PID 注入（u1a 模板侧契约；u1b 注入 process.pid）
      expect(script).toContain(`PARENT_PID="${MAC_VARS.parentPid}"`)
      // open 无 -n（open -n 强制新实例会被单实例锁弹掉 = 重启静默失败，RM6）。
      // 断言命令形态 `open -n "`，避免命中模板注释里的说明文字。
      expect(script).toContain('open "$APP"')
      expect(script, '不得再使用 open -n 命令').not.toContain('open -n "')
      // pgrep pattern 匹配已废弃（PID 制 by construction，RM9）
      expect(script, '不得再使用 pgrep').not.toContain('pgrep')
      // 旧 rm-then-mv「.old 预恢复」已删除：S3 残余窗口态禁止脚本动 .old（手动恢复出口）
      expect(script, 'S0 检查段不得预恢复 .old').not.toContain('restored from .old')

      // ── 占位符全替换 + 实际值注入 ──────────────────────────────────
      expect(script, '不应残留 {{ 占位符').not.toMatch(/\{\{[^}]+\}\}/)
      expect(script).toContain('/Applications/TaiJi.app')
      expect(script).toContain('a'.repeat(64))
      expect(script).toContain('0.9.0')
      expect(script, '成功标记').toContain('write_result "done"')
    })

    it('parentPid 缺失 → throw（契约：无父 PID 就没有可靠等待检查，禁止静默跳过）', () => {
      expect(() =>
        buildUpdaterScript({ ...MAC_VARS, parentPid: '' } as unknown as typeof MAC_VARS),
      ).toThrow(/parentPid is required/)
      expect(() =>
        buildUpdaterScript({ ...MAC_VARS, parentPid: undefined } as unknown as typeof MAC_VARS),
      ).toThrow(/parentPid is required/)
    })

    it('sha256 为 64 位 hex 全替换后比较行语法正确（防御注入回归）', () => {
      const script = buildUpdaterScript({ ...MAC_VARS, sha256: 'f'.repeat(64) })
      expect(script).toContain('f'.repeat(64))
      expect(script).toMatch(/"\$ACTUAL" != "f{64}"/)
    })

    it('appBundle 含 shell 危险字符（" $ ` \\）时逐字符转义，不破坏引号配对', () => {
      const evil = '/Applications/evil"$(rm -rf ~).app'
      const script = buildUpdaterScript({ ...MAC_VARS, appBundle: evil })
      // 双引号上下文危险字符被反斜杠转义（shellEscapeDoubleQuote）
      expect(script).toContain('evil\\"\\$(rm -rf ~).app')
      // 注入点均落在双引号内，原始未转义序列不得出现
      expect(script).not.toContain('evil"$(rm')
    })
  })

  describe('批次 3 S8: mac S1 段 dmg 解包原语（设计 §3.3.3-B）', () => {
    it('mountpoint 在 $TMPDIR 下 mktemp，且独立于 STAGING_DIR / 不放 /Volumes', () => {
      const script = buildUpdaterScript(MAC_VARS)
      const lines = script.split('\n')
      const mktempLine = lines.find((l) => l.includes('MOUNT_DIR=$(mktemp -d'))
      expect(mktempLine, '应有 MOUNT_DIR mktemp 赋值行').toBeDefined()
      // 用户可写目录：$TMPDIR 下 mktemp（/Volumes 是 root:wheel 755，普通用户必败——r1 探针实证）
      expect(mktempLine!).toContain('"${TMPDIR:-/tmp}/taiji-dmg.')
      expect(mktempLine!).toContain('XXXXXX')
      expect(mktempLine!, 'mountpoint 不得放 /Volumes').not.toContain('/Volumes')
      // 独立于 STAGING_DIR：detach 失败滞留挂载时 staging 清理不得波及活跃挂载卷
      expect(mktempLine!, 'mountpoint 推导不得引用 STAGING_DIR').not.toContain('STAGING_DIR')
    })

    it('解包命令序列 = hdiutil attach(-mountpoint) → ditto → detach(eject 降级)', () => {
      const script = buildUpdaterScript(MAC_VARS)
      // attach 显式挂载点（dmg 路径注入值）
      expect(script).toContain(
        `hdiutil attach -nobrowse -readonly "${MAC_VARS.dmgPath}" -mountpoint "$MOUNT_DIR"`,
      )
      // dmg 内 .app 定位（ls -d 通配 + head 取首个）
      expect(script).toContain('SRC_APP=$(ls -d "$MOUNT_DIR"/*.app')
      // ditto 拷贝到 staging（保签名/xattr，不用 cp -R）
      expect(script).toContain('ditto "$SRC_APP" "$STAGED_APP"')
      // 最终 detach 带 eject 降级，且该行无 fail 调用（detach 失败不阻断，S2-S4 换装继续）
      const finalDetachLine = script
        .split('\n')
        .find((l) => l.replace(/^hdiutil detach /, '').startsWith('"$MOUNT_DIR"') && l.includes('hdiutil eject'))
      expect(finalDetachLine, '最终 detach 行应为 detach || eject 降级').toBeDefined()
      expect(finalDetachLine!, 'detach 失败不得阻断（无 fail 调用）').not.toContain('fail')
    })

    it('attach 失败 → fail 分支且错误信息带恢复动作（重启/手动 detach 后重试）', () => {
      const script = buildUpdaterScript(MAC_VARS)
      expect(script, 'attach 应显式判退出码').toContain('if ! hdiutil attach')
      expect(script, '挂载失败错误码 + 恢复指引').toContain(
        'fail "dmg mount failed (reboot the system or run hdiutil detach manually, then retry)"',
      )
    })

    it('unzip 解包原语已被整体替换（不再出现）', () => {
      const script = buildUpdaterScript(MAC_VARS)
      expect(script, '批次 3 后 mac 脚本不得再使用 unzip').not.toContain('unzip')
    })

    it('S2-S5 换装/回滚/finalize 段未被解包改造波及', () => {
      const script = buildUpdaterScript(MAC_VARS)
      // stage 标记齐全（S1 改造只动解包原语，状态机骨架不变）
      for (const stage of ['S1 extract begin', 'S2 promote begin', 'S3 backup begin', 'S4 swap begin', 'S5 finalize begin']) {
        expect(script, `应包含 stage 标记: ${stage}`).toContain(`[stage] ${stage}`)
      }
      // S2 两步中转 / S3 备份不吞错 / S4 原子换装 + 回滚 / S5 xattr + done
      expect(script).toContain('mv "$STAGED_APP" "$APP_NEW"')
      expect(script).toContain('if ! mv "$APP" "$APP_OLD"')
      expect(script).toContain('if ! mv "$APP_NEW" "$APP"')
      expect(script).toContain('mv "$APP_OLD" "$APP"')
      expect(script).toContain('xattr -cr "$APP"')
      expect(script).toContain('write_result "done"')
    })
  })

  describe('u1a: linux 脚本模板（PID 等待 + 只读检测 + 原子 result，无 staging）', () => {
    it('生成脚本含 §3.3.3 检查（PID 等待/超时/只读/原子 result）且占位符全替换', () => {
      const script = buildLinuxUpdaterScript(LINUX_VARS)

      const guards: Array<[string, string]> = [
        ['PID 制等待', 'while kill -0 "$PARENT_PID" 2>/dev/null'],
        ['60s 上限（120 轮）', '-gt 120'],
        ['等待超时错误码', 'fail "app still running"'],
        // 只读检测：APP_DIR 不可写（rename 权限看父目录写权限）
        ['只读检测', '[ ! -w "$APP_DIR" ]'],
        ['只读错误码', 'fail "read-only volume"'],
        // 备份/换装失败不吞错 + 回滚
        ['备份 mv 失败检查', 'if ! mv "$APP" "$APP_OLD"'],
        ['备份失败错误码', 'fail "backup failed"'],
        ['换装 mv 失败检查', 'if ! mv "$APP_NEW_FILE" "$APP"'],
        ['回滚备份', 'mv "$APP_OLD" "$APP"'],
        ['换装失败错误码', 'fail "mv failed"'],
        // sha256 校验（sha256sum）
        ['sha256 校验', 'sha256sum'],
        ['sha 错误码', 'fail "sha mismatch"'],
        // tmp + rename 原子写
        ['result tmp 变量', `RESULT_TMP="${LINUX_VARS.resultPath}.tmp"`],
        ['tmp 写入', '> "$RESULT_TMP"'],
        ['tmp rename', `mv -f "$RESULT_TMP" "${LINUX_VARS.resultPath}"`],
        // 权限 + 备份清理
        ['chmod 755', 'chmod 755'],
        ['残留 .old 清理', 'rm -f "$APP_OLD"'],
      ]
      for (const [name, frag] of guards) {
        expect(script, `应包含检查: ${name} (${frag})`).toContain(frag)
      }

      // 后台重启（& 放后台；P9 探针覆盖稳定性）
      expect(script).toContain(`"${LINUX_VARS.appImagePath}" &`)
      // PARENT_PID 注入
      expect(script).toContain(`PARENT_PID="${LINUX_VARS.parentPid}"`)
      // pgrep 已废弃；无 staging（AppImage 单文件 mv 原子）
      expect(script, '不得再使用 pgrep').not.toContain('pgrep')
      expect(script, 'linux 无 staging 目录').not.toContain('STAGING_DIR')
      // 占位符全替换
      expect(script).not.toMatch(/\{\{[^}]+\}\}/)
      expect(script).toContain('/home/test/TaiJi-x86_64.AppImage')
      expect(script).toContain('0.9.0')
      expect(script, '成功标记').toContain('write_result "done"')
    })

    it('parentPid 缺失 → throw（与 mac 同契约）', () => {
      expect(() =>
        buildLinuxUpdaterScript({ ...LINUX_VARS, parentPid: '' } as unknown as typeof LINUX_VARS),
      ).toThrow(/parentPid is required/)
    })
  })

  describe('u5a: 跨进程互斥 pid 文件（批次 5 §3.7.1）', () => {
    it('mac/linux 脚本启动即写 updater.pid（结果路径同目录）+ trap 退出清理', () => {
      const mac = buildUpdaterScript({ ...MAC_VARS })
      const linux = buildLinuxUpdaterScript({ ...LINUX_VARS })

      // pid 文件路径：由 resultPath 同目录推导（零新增注入点）
      expect(mac, 'mac 应写 pid 文件').toContain(
        `PID_FILE="$(dirname "${MAC_VARS.resultPath}")/updater.pid"`,
      )
      expect(linux, 'linux 应写 pid 文件').toContain(
        `PID_FILE="$(dirname "${LINUX_VARS.resultPath}")/updater.pid"`,
      )
      // 写自身 pid + trap EXIT 清理（覆盖成功/失败/意外错误退出路径）
      expect(mac, 'mac 应写自身 pid').toMatch(/echo \$\$ > "\$PID_FILE"/)
      expect(linux, 'linux 应写自身 pid').toMatch(/echo \$\$ > "\$PID_FILE"/)
      expect(mac, 'mac 应 trap EXIT 清理 pid').toContain(
        "trap 'rm -f \"$PID_FILE\"' EXIT",
      )
      expect(linux, 'linux 应 trap EXIT 清理 pid').toContain(
        "trap 'rm -f \"$PID_FILE\"' EXIT",
      )
    })
  })
});
