/**
 * cookie-refresher 单测（隐藏窗口 cookie 刷新器）。
 *
 * 覆盖（任务验收条款；周期轮询/超时等待已随时间机制清查删除，登录页判定改为 URL 事实
 * 确证的确定性收尾）：
 * - 导航白名单 / 登录页判定 / cookie 域过滤三个纯函数的边界
 * - 种 cookie：secrets 文件存在 → cookies.set 逐对种入；文件缺失 → 零种入
 * - API 探测成功路径（事件驱动）：页面就绪事件 + 探测 200 → 导出目标域 cookie 串随
 *   返回值回传 + secrets 文件零写入断言（main 不落盘——单写方 = runtime QuotaService，
 *   renderer 走 quota.configure 保存链落盘）
 * - SPA 换发触发源：会话换发不产生导航事件（页内 XHR Set-Cookie）的形态下，cookie
 *   'changed' 事件触发重探 → 200 收尾；无效变更（域外/removed/expired）不触发；
 *   收尾后监听器移除（partition session 常驻防泄漏）
 * - 登录页确定性收尾：URL 命中登录页特征 → show() + ok:false("login required") +
 *   destroy（Promise 落定不悬挂，收尾后同 provider 可重新发起）
 * - 同 provider 重入去重：返回同一 Promise、只开一个窗口
 * - IPC 注册（quota:refresh-cookie）：payload 校验 / 转发 / 注册幂等
 *
 * electron mock：BrowserWindow / session.fromPartition 为 EventEmitter 假件
 * （window-factory.test.ts 的 MockBrowserWindow + log-retention-ipc.test.ts 的
 * ipcMain.handle 捕获两形态合用）；真实文件 IO（secrets 种入读取）落 mkdtemp tmpdir
 * （fs-guard 生效中），dataDir 经 deps 注入。
 *
 * 异步时序约定：BrowserWindow 在 seedCookies 完成后的微任务里创建，用例统一经
 * windowOf() 等窗口出现、再改写假件状态（URL / API status），最后 await 结果。
 *
 * 运行：cd apps/electron/main && npx vitest run quota/__tests__/cookie-refresher.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── electron 假件（hoisted：mock 工厂与用例共享同一可变状态容器）──────────────

type FakeCookie = {
  name: string
  value: string
  domain: string
}

type CookieSetCall = {
  url: string
  name: string
  value: string
  path: string
  secure: boolean
}

const fake = vi.hoisted(() => {
  /** 最小事件发射器（hoisted 作用域内不可 import node:events，手写 on/emit 够用）。 */
  class MiniEmitter {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    on(event: string, fn: (...args: unknown[]) => void): void {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
    }
    removeListener(event: string, fn: (...args: unknown[]) => void): void {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((f) => f !== fn))
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.listeners.get(event) ?? []) fn(...args)
    }
  }

  class FakeWebContents extends MiniEmitter {
    /** 当前页面 URL（用例改写驱动登录页检测）。 */
    url = ''
    /** window.open 拦截器（setWindowOpenHandler 捕获）。 */
    windowOpenHandler: ((detail: { url: string }) => { action: string }) | null = null
    setWindowOpenHandler(fn: (detail: { url: string }) => { action: string }): void {
      this.windowOpenHandler = fn
    }
    getURL(): string {
      return this.url
    }
    async executeJavaScript(expr: string): Promise<unknown> {
      state.execCalls++
      return state.execImpl(expr)
    }
  }

  class FakeBrowserWindow extends MiniEmitter {
    static instances: FakeBrowserWindow[] = []
    readonly webContents = new FakeWebContents()
    shown = false
    destroyed = false
    constructor(public options: unknown) {
      super()
      FakeBrowserWindow.instances.push(this)
    }
    async loadURL(url: string): Promise<void> {
      state.loadUrls.push(url)
      // 用例可覆写为 reject（驱动 ERR_ABORTED / 加载故障分支）；缺省成功加载
      if (state.loadUrlImpl) return state.loadUrlImpl(url, this)
      this.webContents.url = url
    }
    show(): void {
      this.shown = true
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
  }

  class FakeCookies extends MiniEmitter {
    jar: FakeCookie[] = []
    setCalls: CookieSetCall[] = []
    async set(details: { url: string; name: string; value: string; path?: string; secure?: boolean }): Promise<void> {
      this.setCalls.push({
        url: details.url,
        name: details.name,
        value: details.value,
        path: details.path ?? '/',
        secure: details.secure ?? false,
      })
      // 真实 Electron 按 set url 的 host 落 domain；假件同构推导供导出过滤消费
      this.jar.push({ name: details.name, value: details.value, domain: new URL(details.url).hostname })
    }
    async get(filter: Record<string, unknown>): Promise<FakeCookie[]> {
      const name = filter?.['name'] as string | undefined
      return [...this.jar].filter((c) => name === undefined || c.name === name)
    }
  }

  const partitions = new Map<string, { cookies: FakeCookies }>()
  /** ipcMain.handle 捕获（key=channel）。 */
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  const state = {
    /** executeJavaScript 实现（beforeEach 重置 401，用例覆写驱动成功/悬置）。 */
    execImpl: (async () => 401) as (expr: string) => Promise<unknown>,
    /** executeJavaScript 调用计数（探测次数断言用：SPA 换发触发源/过滤/清理防泄漏）。 */
    execCalls: 0,
    /** loadURL 覆写（缺省 null = 成功加载并落 url；用例 reject 驱动 ABORTED 分支）。 */
    loadUrlImpl: null as null | ((url: string, win: FakeBrowserWindow) => Promise<void>),
    loadUrls: [] as string[],
    partitions,
    handlers,
    partitionNames: [] as string[],
  }

  return { MiniEmitter, FakeWebContents, FakeBrowserWindow, FakeCookies, state }
})

vi.mock('electron', () => ({
  BrowserWindow: fake.FakeBrowserWindow,
  session: {
    fromPartition: (name: string) => {
      fake.state.partitionNames.push(name)
      let ses = fake.state.partitions.get(name)
      if (!ses) {
        ses = { cookies: new fake.FakeCookies() }
        fake.state.partitions.set(name, ses)
      }
      return ses
    },
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      fake.state.handlers.set(channel, fn)
    },
  },
}))

// mainLogger mock：刷新器日志落盘会往 dataDir 写 main log（防污染 + 用例可断言 warn 通道）
vi.mock('../../logs/main-logger.js', () => ({
  mainLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { refreshQuotaCookie } from '../cookie-refresher.js'
import {
  isAllowedQuotaRefreshNavigation,
  isQuotaRefreshLoginUrl,
  isTargetCookieDomain,
} from '../cookie-refresher.js'
import { registerQuotaCookieRefreshHandler, isValidQuotaRefreshCookiePayload } from '../quota-cookie-ipc.js'
import { QUOTA_REFRESH_COOKIE, getQuotaRefreshTarget } from '@taiji/shared'
import { mainLogger } from '../../logs/main-logger.js'

type FakeWindow = typeof fake.FakeBrowserWindow.prototype

const MIMO = getQuotaRefreshTarget('mimo')!
const OPENCODE = getQuotaRefreshTarget('opencode-go')!

const CONSOLE_URL = 'https://platform.xiaomimimo.com/console/plan-manage'
const LOGIN_URL = 'https://account.xiaomi.com/signin?callback=xxx'

/** 每用例共享的前置：tmp dataDir + 默认 exec 401。 */
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'quota-cookie-refresher-test-'))
  fake.FakeBrowserWindow.instances = []
  fake.state.loadUrls = []
  fake.state.loadUrlImpl = null
  fake.state.partitionNames = []
  fake.state.partitions.clear()
  fake.state.execImpl = async () => 401
  fake.state.execCalls = 0
  vi.mocked(mainLogger.warn).mockClear()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/**
 * 等刷新器把窗口建出来（BrowserWindow 在 seedCookies 的 await 之后的微任务里创建，
 * 微任务不受 fake timers 控管，逐跳 Promise.resolve 轮询即可，两种 timer 模式通用）。
 */
async function windowOf(_refresh: Promise<unknown>): Promise<FakeWindow> {
  for (let i = 0; i < 10 && fake.FakeBrowserWindow.instances.length === 0; i++) {
    await Promise.resolve()
  }
  const win = fake.FakeBrowserWindow.instances.at(-1)
  expect(win, '刷新器应已创建 BrowserWindow').toBeDefined()
  return win!
}

/** 微任务逐跳推进（探测 promise 链走完：executeJavaScript 假件 + then 回调各占数跳）。 */
async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/** 微任务逐跳等待探测累计发生 n 次（覆盖 loadURL await → probeUntilApiOk 挂监听 → 首探链）。 */
async function untilProbeCount(n: number): Promise<void> {
  for (let i = 0; i < 50 && fake.state.execCalls < n; i++) await Promise.resolve()
  expect(fake.state.execCalls, `探测应已发生 ${n} 次`).toBeGreaterThanOrEqual(n)
}

/** 往最近创建的 partition 种一枚目标域会话 cookie（模拟服务端续期后的 Set-Cookie）。 */
function seedSessionCookie(): void {
  const lastName = fake.state.partitionNames.at(-1)
  expect(lastName, '刷新器应已创建 partition').toBeDefined()
  const ses = fake.state.partitions.get(lastName!)
  if (ses && !ses.cookies.jar.some((c) => c.name === 'sid')) {
    ses.cookies.jar.push({ name: 'sid', value: 'refreshed', domain: '.xiaomimimo.com' })
  }
}

/** API 就绪态：URL 在 console 页 + 探测 200（不种 cookie，供自备 jar 的用例）。 */
function makeApiOk(win: FakeWindow): void {
  win.webContents.url = CONSOLE_URL
  fake.state.execImpl = async () => 200
  // 事件驱动探测：状态就绪后发一次 load 事件触发重探（若首探已在就绪态发出则此发为冗余，
  // settled 去重无害）
  win.webContents.emit('did-finish-load')
}

/** 造就绪态 = makeApiOk + 服务端种会话 cookie。 */
function makeReady(win: FakeWindow): void {
  makeApiOk(win)
  seedSessionCookie()
}

function cookiePath(providerId: string): string {
  return join(tmpDir, 'secrets', `${providerId}-cookie.txt`)
}

/** 标准成功路径：发起刷新 → 等窗口 → 就绪态 → await 结果。 */
async function refreshAndReady(providerId: string): Promise<{ result: ReturnType<typeof refreshQuotaCookie>; win: FakeWindow }> {
  const result = refreshQuotaCookie({ fetcherId: 'mimo', providerId }, { dataDir: () => tmpDir })
  const win = await windowOf(result)
  makeReady(win)
  return { result, win }
}

// ── 纯函数：导航白名单 / 登录页判定 / cookie 域过滤 ───────────────────────────

describe('isAllowedQuotaRefreshNavigation（导航白名单）', () => {
  it('目标站点域放行（pageUrl / apiUrl 同域的任意路径）', () => {
    expect(isAllowedQuotaRefreshNavigation(CONSOLE_URL, MIMO)).toBe(true)
    expect(isAllowedQuotaRefreshNavigation('https://platform.xiaomimimo.com/api/v1/tokenPlan/usage', MIMO)).toBe(true)
    expect(isAllowedQuotaRefreshNavigation('https://platform.xiaomimimo.com/anything/else', MIMO)).toBe(true)
  })

  it('账号域放行（loginUrlPatterns 的 host 形态 pattern 命中）', () => {
    expect(isAllowedQuotaRefreshNavigation(LOGIN_URL, MIMO)).toBe(true)
    // opencode 的 'auth\\.' host 形态：auth 子域放行
    expect(isAllowedQuotaRefreshNavigation('https://auth.opencode.ai/authorize', OPENCODE)).toBe(true)
  })

  it('第三方域 deny（cookie 不得被导航带到不可信站点）', () => {
    expect(isAllowedQuotaRefreshNavigation('https://evil.com/login', MIMO)).toBe(false)
    expect(isAllowedQuotaRefreshNavigation('https://evil.com/console/plan-manage', MIMO)).toBe(false)
    expect(isAllowedQuotaRefreshNavigation('https://account.xiaomi.com.evil.com/', MIMO)).toBe(false)
  })

  it('非 http(s) 协议 deny + 非法 URL deny', () => {
    expect(isAllowedQuotaRefreshNavigation('file:///etc/passwd', MIMO)).toBe(false)
    expect(isAllowedQuotaRefreshNavigation('javascript:alert(1)', MIMO)).toBe(false)
    expect(isAllowedQuotaRefreshNavigation('not a url', MIMO)).toBe(false)
  })

  it('路径形态 pattern（/login）不参与放行：opencode 目标域外同名路径 deny', () => {
    expect(isAllowedQuotaRefreshNavigation('https://opencode.ai/login', OPENCODE)).toBe(true)
    expect(isAllowedQuotaRefreshNavigation('https://evil.com/login', OPENCODE)).toBe(false)
  })
})

describe('isQuotaRefreshLoginUrl（登录页判定）', () => {
  it('SSO 账号域与平台自身登录路径命中', () => {
    expect(isQuotaRefreshLoginUrl(LOGIN_URL, MIMO)).toBe(true)
    expect(isQuotaRefreshLoginUrl('https://platform.xiaomimimo.com/login', MIMO)).toBe(true)
    expect(isQuotaRefreshLoginUrl('https://opencode.ai/login', OPENCODE)).toBe(true)
  })

  it('console 页 / 无关域不命中', () => {
    expect(isQuotaRefreshLoginUrl(CONSOLE_URL, MIMO)).toBe(false)
    expect(isQuotaRefreshLoginUrl('https://example.com/', MIMO)).toBe(false)
  })
})

describe('isTargetCookieDomain（导出域过滤）', () => {
  const hosts = new Set(['platform.xiaomimimo.com'])

  it('域 cookie（前导点）与 host-only cookie 均命中', () => {
    expect(isTargetCookieDomain('.xiaomimimo.com', hosts)).toBe(true)
    expect(isTargetCookieDomain('platform.xiaomimimo.com', hosts)).toBe(true)
  })

  it('无关域 / 空域 / 后缀伪装域不命中', () => {
    expect(isTargetCookieDomain('.evil.com', hosts)).toBe(false)
    expect(isTargetCookieDomain('', hosts)).toBe(false)
    expect(isTargetCookieDomain('.xiaomimimo.com.evil.com', hosts)).toBe(false)
  })
})

// ── 集成路径（mock electron + 真实 secrets 文件 IO）──────────────────────────

describe('refreshQuotaCookie：种 cookie', () => {
  it('secrets 文件存在：逐对种入 partition（url = pageUrl origin，path:/ + secure 满足 __Host- 前缀校验），且种入文件保持原样（main 只读）', async () => {
    mkdirSync(join(tmpDir, 'secrets'), { recursive: true })
    writeFileSync(cookiePath('p-seed'), 'a=1; __Host-console_session=s3')

    const { result } = await refreshAndReady('p-seed')
    // 导出串 = 种入对 + 服务端续期后的新会话 cookie（jar 按种入序 + seedSessionCookie 追加序）
    expect(await result).toEqual({ ok: true, cookie: 'a=1; __Host-console_session=s3; sid=refreshed' })
    // main 不落盘：种入源文件内容不被导出串覆盖（单写方 = runtime）
    expect(readFileSync(cookiePath('p-seed'), 'utf-8')).toBe('a=1; __Host-console_session=s3')

    const ses = fake.state.partitions.get('persist:quota-p-seed')
    expect(ses, 'partition 应为 persist:quota-<providerId>').toBeDefined()
    expect(ses!.cookies.setCalls).toEqual([
      { url: 'https://platform.xiaomimimo.com', name: 'a', value: '1', path: '/', secure: true },
      { url: 'https://platform.xiaomimimo.com', name: '__Host-console_session', value: 's3', path: '/', secure: true },
    ])
  })

  it('secrets 文件缺失：零种入（partition 历史登录态自效），导出串照常回传且不建 secrets 目录', async () => {
    const { result } = await refreshAndReady('p-noseed')
    expect(await result).toEqual({ ok: true, cookie: 'sid=refreshed' })
    // main 不落盘：不创建 secrets 目录 / cookie 文件
    expect(existsSync(join(tmpDir, 'secrets'))).toBe(false)
    expect(existsSync(cookiePath('p-noseed'))).toBe(false)
    // setCalls 只可能来自种入路径（成功路径导出走 get），缺失时必须为空
    const ses = fake.state.partitions.get('persist:quota-p-noseed')
    expect(ses!.cookies.setCalls).toEqual([])
  })
})

describe('refreshQuotaCookie：API 探测成功路径', () => {
  it('200 → 导出串回传 + 窗口形态（隐藏 / 双隔离 / persist session）+ 弹窗 deny + destroy 收尾', async () => {
    const { result, win } = await refreshAndReady('p-ok')
    expect(await result).toEqual({ ok: true, cookie: 'sid=refreshed' })

    const options = win.options as {
      show?: boolean
      webPreferences: { nodeIntegration: boolean; contextIsolation: boolean; session: { cookies: unknown } }
    }
    expect(options.show).toBe(false)
    expect(options.webPreferences.nodeIntegration).toBe(false)
    expect(options.webPreferences.contextIsolation).toBe(true)
    // session 即该 partition 的 session（fromPartition 返回的同一对象）
    expect(options.webPreferences.session).toBe(
      fake.state.partitions.get('persist:quota-p-ok'),
    )
    // 加载入口 = pageUrl
    expect(fake.state.loadUrls).toEqual([CONSOLE_URL])
    // 弹窗一律 deny
    expect(win.webContents.windowOpenHandler!({ url: 'https://evil.com' })).toEqual({ action: 'deny' })
    // 收尾：destroy 释放（不用 close）
    expect(win.destroyed).toBe(true)
    expect(win.shown).toBe(false)
  })

  it('导出串只含目标域 cookie，格式与手贴一致；secrets 文件零写入（main 不落盘）', async () => {
    // partition 预置历史登录态：目标域域 cookie + host-only + 无关域各一枚
    const cookies = new fake.FakeCookies()
    fake.state.partitions.set('persist:quota-p-export', { cookies })
    cookies.jar.push(
      { name: 'sid', value: 'token-1', domain: '.xiaomimimo.com' },
      { name: 'uid', value: '42', domain: 'platform.xiaomimimo.com' },
      { name: 'tracker', value: 'x', domain: '.evil.com' },
    )

    const result = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-export' },
      { dataDir: () => tmpDir },
    )
    makeApiOk(await windowOf(result))

    // 无关域被过滤；'name=value; name2=value2' 手贴格式（顺序按 cookies.get 返回序）
    expect(await result).toEqual({ ok: true, cookie: 'sid=token-1; uid=42' })
    expect(existsSync(cookiePath('p-export'))).toBe(false)
  })

  it('stepfun：POST 端点探测带 method/body/业务头族（静态头 + Oasis-Webid cookie 镜像），200 → 导出串只含目标域 cookie', async () => {
    const STEPFUN = getQuotaRefreshTarget('stepfun')!
    expect(STEPFUN.apiMethod).toBe('POST')

    // partition 预置目标域 cookie（首轮探测即 200 的时序下导出不能依赖事后再种）
    const cookies = new fake.FakeCookies()
    fake.state.partitions.set('persist:quota-p-stepfun', { cookies })
    cookies.jar.push(
      { name: 'Oasis-Token', value: 'sf-refreshed', domain: 'platform.stepfun.com' },
      { name: 'Oasis-Webid', value: 'web-42', domain: 'platform.stepfun.com' },
    )
    const exprs: string[] = []
    fake.state.execImpl = async (expr: string) => {
      exprs.push(expr)
      return 200
    }
    const result = refreshQuotaCookie({ fetcherId: 'stepfun', providerId: 'p-stepfun' }, { dataDir: () => tmpDir })
    const win = await windowOf(result)
    win.webContents.url = 'https://platform.stepfun.com/account-overview'

    expect(await result).toEqual({ ok: true, cookie: 'Oasis-Token=sf-refreshed; Oasis-Webid=web-42' })
    // 探测表达式 = POST + 静态 body + 业务头族（connect RPC 端点对无头探测回 401，
    // 有效会话下也校验 oasis 头——2026-11-06 真机网络层对照实证）
    expect(exprs[0]).toContain(`fetch(${JSON.stringify(STEPFUN.apiUrl)},{method:'POST'`)
    expect(exprs[0]).toContain(`"oasis-appid":"10300"`)
    expect(exprs[0]).toContain(`"oasis-webid":"web-42"`)
    expect(existsSync(cookiePath('p-stepfun'))).toBe(false)
  })

  it('镜像 cookie 缺失时跳过对应头（探测仍发，静态头保留），不阻塞重探链', async () => {
    const STEPFUN = getQuotaRefreshTarget('stepfun')!
    const cookies = new fake.FakeCookies()
    fake.state.partitions.set('persist:quota-p-nowebid', { cookies })
    // 只有 Oasis-Token，无 Oasis-Webid → oasis-webid 头跳过
    cookies.jar.push({ name: 'Oasis-Token', value: 'sf-x', domain: 'platform.stepfun.com' })
    const exprs: string[] = []
    fake.state.execImpl = async (expr: string) => {
      exprs.push(expr)
      return 200
    }
    const result = refreshQuotaCookie({ fetcherId: 'stepfun', providerId: 'p-nowebid' }, { dataDir: () => tmpDir })
    const win = await windowOf(result)
    win.webContents.url = 'https://platform.stepfun.com/account-overview'

    expect(await result).toEqual({ ok: true, cookie: 'Oasis-Token=sf-x' })
    expect(exprs[0]).toContain('"oasis-appid":"10300"')
    expect(exprs[0]).not.toContain('oasis-webid')
  })
})

describe('refreshQuotaCookie：loadURL 中断处理', () => {
  it('ERR_ABORTED(-3)（SSO 链页面自导航打断初始加载）→ 放行进事件驱动探测，API 200 仍成功', async () => {
    fake.state.loadUrlImpl = async (url, win) => {
      // 复现真机形态：平台页 JS 跳 genLoginUrl 打断 loadURL（Electron 以 ABORTED reject）
      win.webContents.url = `${url}/api/v1/genLoginUrl`
      throw Object.assign(new Error(`ERR_ABORTED (-3) loading '${url}'`), { code: -3 })
    }
    const result = refreshQuotaCookie({ fetcherId: 'mimo', providerId: 'p-aborted' }, { dataDir: () => tmpDir })
    const win = await windowOf(result)
    makeReady(win)

    expect(await result).toEqual({ ok: true, cookie: 'sid=refreshed' })
    expect(win.destroyed).toBe(true)
  })

  it('非 ABORTED 加载故障（DNS 解析失败）→ 仍立即失败并携带 page load failed 文案', async () => {
    fake.state.loadUrlImpl = async () => {
      throw Object.assign(new Error('ERR_NAME_NOT_RESOLVED (-105)'), { code: -105 })
    }
    const result = await refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-dns' },
      { dataDir: () => tmpDir },
    )
    expect(result.ok).toBe(false)
    expect(result.cookie).toBeUndefined()
    expect(result.error).toContain('page load failed')
    expect(result.error).toContain('ERR_NAME_NOT_RESOLVED')
  })
})

describe('refreshQuotaCookie：登录页确定性收尾', () => {
  it('页面停在登录域（无后续导航事件）→ show() + ok:false("login required") + destroy，Promise 落定不悬挂', async () => {
    const result = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-login' },
      { dataDir: () => tmpDir },
    )
    const win = await windowOf(result)
    // SSO 把页面重定向到小米登录页并停住：API 恒 401（exec 缺省）、无后续导航事件——
    // 删时间窗后唯一无收尾的形态，靠登录页 URL 事实确定性收尾
    win.webContents.url = LOGIN_URL
    win.webContents.emit('did-finish-load')

    const settled = await result
    expect(settled).toEqual({ ok: false, error: 'login required' })
    // 转可见提示（登录态失效对用户可见）+ 成败都 destroy 收尾（无隐藏窗口泄漏）
    expect(win.shown).toBe(true)
    expect(win.destroyed).toBe(true)
  })

  it('登录页失败收尾后同 provider 再刷新重新执行（inflight 槽释放，续期不再被静默拦截）', async () => {
    const first = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-retry' },
      { dataDir: () => tmpDir },
    )
    const win1 = await windowOf(first)
    win1.webContents.url = LOGIN_URL
    win1.webContents.emit('did-finish-load')
    expect(await first).toEqual({ ok: false, error: 'login required' })

    // 第二轮不再是登录页（登录态修复形态）→ 正常成功；两轮各开一窗证明首轮已收尾、
    // inflight 表已清（渲染端 cookieRefreshDedup 同语义：settle 即清可重试）
    const second = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-retry' },
      { dataDir: () => tmpDir },
    )
    expect(second).not.toBe(first)
    makeReady(await windowOf(second))
    expect(await second).toEqual({ ok: true, cookie: 'sid=refreshed' })
    expect(fake.FakeBrowserWindow.instances).toHaveLength(2)
    expect(win1.destroyed).toBe(true)
  })
})

describe('refreshQuotaCookie：网络级兜底超时（REFRESH_DEADLINE_MS）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('页面加载成功但零事件且探测不 200（站点半死/网络中断形态）→ 120s 超时失败收尾 + destroy + inflight 释放', async () => {
    vi.useFakeTimers()
    const result = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-dead' },
      { dataDir: () => tmpDir },
    )
    const win = await windowOf(result)
    // 页面停在 console 页（非登录域，登录页收尾不可达）、API 恒 401（execImpl 缺省）、
    // 零后续导航/cookie 事件——事件源齐全但无事件可等 = 修复前唯一永久挂起形态
    win.webContents.url = CONSOLE_URL
    win.webContents.emit('did-finish-load')
    await untilProbeCount(1)

    vi.advanceTimersByTime(120_000)
    const settled = await result
    expect(settled.ok).toBe(false)
    expect(settled.error).toContain('timed out')
    expect(win.destroyed).toBe(true)

    // inflight 槽随落定释放：同 provider 可重新发起（新一轮可正常成功）
    const second = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-dead' },
      { dataDir: () => tmpDir },
    )
    expect(second).not.toBe(result)
    makeReady(await windowOf(second))
    expect(await second).toEqual({ ok: true, cookie: 'sid=refreshed' })
  })

  it('loadURL 悬挂（主文档 load 被挂起型子资源阻塞、不报错也不完成）→ 同受 120s 兜底覆盖，窗口 destroy', async () => {
    vi.useFakeTimers()
    // loadUrlImpl 返回永不落定的 promise：加载阶段无事件可等，deadline 武装点必须
    // 覆盖 loadURL（只武装在探测阶段时该形态漏网 → 窗口泄漏 + inflight 挂死）
    fake.state.loadUrlImpl = () => new Promise<void>(() => {})
    const result = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-hang' },
      { dataDir: () => tmpDir },
    )
    const win = await windowOf(result)

    vi.advanceTimersByTime(120_000)
    const settled = await result
    expect(settled.ok).toBe(false)
    expect(settled.error).toContain('timed out')
    expect(win.destroyed).toBe(true)
  })

  it('超时前收尾（探测 200）→ deadline 计时器清除，不产生迟到失败', async () => {
    vi.useFakeTimers()
    const result = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-fast' },
      { dataDir: () => tmpDir },
    )
    const win = await windowOf(result)
    makeReady(win)
    expect(await result).toEqual({ ok: true, cookie: 'sid=refreshed' })

    // 窗口已收尾销毁后越过 deadline：不应有任何迟到回调再触发（fail 文案不出现、无异常）
    vi.advanceTimersByTime(120_000)
    expect(win.destroyed).toBe(true)
    expect(fake.FakeBrowserWindow.instances).toHaveLength(1)
  })
})

describe('refreshQuotaCookie：SPA 换发（cookie 变更触发源）', () => {
  /**
   * stepfun 真机形态（2026-11-06 排障实证）：会话换发是页内 XHR 响应的 Set-Cookie，
   * 全程零导航事件——只挂 did-finish-load/did-navigate 时首探（换发完成前）401 后
   * 探测永不重试，登录态已换发成功却等不到 200 确证，Promise 挂起（UI 永久 loading）。
   * 修复 = 补 session.cookies 'changed' 事件触发源。
   *
   * cause 词表按真机观测（Electron 42，2026-11-06 隐藏窗口实测）：写入 = 'inserted' /
   * 'inserted-no-value-change-overwrite'；覆盖换发 = 'overwrite' removed=true 删旧 +
   * 'inserted' removed=false 插新两连发；清理/过期均 removed=true。
   */
  it('首探 401 且零导航事件 → 目标域 Set-Cookie 落地（changed/inserted）触发重探 → 200 成功导出', async () => {
    const result = refreshQuotaCookie({ fetcherId: 'mimo', providerId: 'p-spa' }, { dataDir: () => tmpDir })
    const win = await windowOf(result)
    win.webContents.url = CONSOLE_URL
    await untilProbeCount(1) // 首探已发出且 401 落定（execImpl 缺省）

    // SPA 换发：页内 XHR 响应 Set-Cookie 落地 + API 就绪，全程不发任何导航事件
    const ses = fake.state.partitions.get('persist:quota-p-spa')!
    ses.cookies.jar.push({ name: 'sid', value: 'refreshed', domain: '.xiaomimimo.com' })
    fake.state.execImpl = async () => 200
    ses.cookies.emit('changed', {}, { domain: '.xiaomimimo.com' }, 'inserted', false)

    expect(await result).toEqual({ ok: true, cookie: 'sid=refreshed' })
    expect(win.destroyed).toBe(true)
  })

  it('覆盖换发两连发（overwrite 删旧 + inserted 插新，真机形态）：仅插新那条触发重探一次', async () => {
    const result = refreshQuotaCookie({ fetcherId: 'mimo', providerId: 'p-roll' }, { dataDir: () => tmpDir })
    const win = await windowOf(result)
    win.webContents.url = CONSOLE_URL
    await untilProbeCount(1)

    const ses = fake.state.partitions.get('persist:quota-p-roll')!
    fake.state.execImpl = async () => 200
    // 真机时序：同一 Set-Cookie 覆盖旧值时连发两条——先删旧（overwrite removed）再插新
    ses.cookies.emit('changed', {}, { domain: '.xiaomimimo.com' }, 'overwrite', true)
    ses.cookies.emit('changed', {}, { domain: '.xiaomimimo.com' }, 'inserted', false)
    ses.cookies.jar.push({ name: 'sid', value: 'refreshed', domain: '.xiaomimimo.com' })

    expect(await result).toEqual({ ok: true, cookie: 'sid=refreshed' })
    expect(fake.state.execCalls, '删旧事件不触发重探（removed 过滤），插新触发恰好一次').toBe(2)
  })

  it('域外 / removed / expired 类变更不触发重探（exec 计数锁定）；值未变的覆盖（inserted-no-value-change-overwrite）后才收尾', async () => {
    const result = refreshQuotaCookie({ fetcherId: 'mimo', providerId: 'p-noise' }, { dataDir: () => tmpDir })
    const win = await windowOf(result)
    win.webContents.url = CONSOLE_URL
    await untilProbeCount(1)

    const ses = fake.state.partitions.get('persist:quota-p-noise')!
    // 无效变更：域外（第三方 cookie）/ removed（删除与清理）/ 值未变覆盖之外的非写入 cause
    ses.cookies.emit('changed', {}, { domain: '.evil.com' }, 'inserted', false)
    ses.cookies.emit('changed', {}, { domain: '.xiaomimimo.com' }, 'expired', false)
    ses.cookies.emit('changed', {}, { domain: '.xiaomimimo.com' }, 'inserted', true)
    await flushMicrotasks()
    expect(fake.state.execCalls, '无效变更不触发重探').toBe(1)

    // 真机词表变体：值未变的覆盖写入（inserted-no-value-change-overwrite）→ 重探收尾
    ses.cookies.jar.push({ name: 'sid', value: 'refreshed', domain: '.xiaomimimo.com' })
    fake.state.execImpl = async () => 200
    ses.cookies.emit('changed', {}, { domain: '.xiaomimimo.com' }, 'inserted-no-value-change-overwrite', false)
    expect(await result).toEqual({ ok: true, cookie: 'sid=refreshed' })
  })

  it('成功收尾后 changed 监听已移除（partition session 常驻，无监听器泄漏）', async () => {
    const { result } = await refreshAndReady('p-clean')
    await result

    const ses = fake.state.partitions.get('persist:quota-p-clean')!
    const before = fake.state.execCalls
    fake.state.execImpl = async () => 200
    // 真机词表的合法写入事件（若监听仍在，必触发探测使 execCalls 增加）
    ses.cookies.emit('changed', {}, { domain: '.xiaomimimo.com' }, 'inserted', false)
    await flushMicrotasks()
    expect(fake.state.execCalls, '收尾后变更事件不应再触发探测').toBe(before)
  })
})

describe('refreshQuotaCookie：同 provider 重入去重', () => {
  it('在途刷新重入返回同一 Promise，只创建一个窗口', async () => {
    // 手动闸门：首轮 fetch 悬置，制造在途刷新
    let releaseStatus: (status: number) => void = () => {}
    const gate = new Promise<number>((resolve) => {
      releaseStatus = resolve
    })
    fake.state.execImpl = () => gate

    const p1 = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-dedup' },
      { dataDir: () => tmpDir },
    )
    const win = await windowOf(p1)

    const p2 = refreshQuotaCookie(
      { fetcherId: 'mimo', providerId: 'p-dedup' },
      { dataDir: () => tmpDir },
    )
    expect(p2).toBe(p1)
    expect(fake.FakeBrowserWindow.instances).toHaveLength(1)

    // 闸门放行前先种会话 cookie（模拟服务端在登录态续期后的 Set-Cookie；
    // 不走 makeReady——它会覆盖 execImpl 破坏闸门）
    seedSessionCookie()
    releaseStatus(200)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual({ ok: true, cookie: 'sid=refreshed' })
    expect(r2).toEqual(r1)
    expect(win.destroyed).toBe(true)
  })

  it('在途结束后同 provider 再刷新 → 重新执行（inflight Map 收尾清除）', async () => {
    const first = await refreshAndReady('p-again')
    expect(await first.result).toEqual({ ok: true, cookie: 'sid=refreshed' })
    expect(fake.FakeBrowserWindow.instances).toHaveLength(1)

    const second = await refreshAndReady('p-again')
    expect(await second.result).toEqual({ ok: true, cookie: 'sid=refreshed' })
    expect(fake.FakeBrowserWindow.instances).toHaveLength(2)
  })
})

describe('refreshQuotaCookie：导航拦截接线', () => {
  it('will-navigate 到第三方域被 preventDefault，账号域放行', async () => {
    const { result, win } = await refreshAndReady('p-nav')
    await result

    const blocked = { prevented: false, preventDefault() { this.prevented = true } }
    win.webContents.emit('will-navigate', blocked, 'https://evil.com/phish')
    expect(blocked.prevented).toBe(true)
    expect(mainLogger.warn).toHaveBeenCalled()

    const allowed = { prevented: false, preventDefault() { this.prevented = true } }
    win.webContents.emit('will-navigate', allowed, LOGIN_URL)
    expect(allowed.prevented).toBe(false)
  })
})

// ── IPC 注册（quota:refresh-cookie）───────────────────────────────────────────

describe('quota:refresh-cookie IPC', () => {
  let savedDataDir: string | undefined

  beforeEach(() => {
    // IPC handler 无 deps 注入面，dataDir 走 getDataDir()：env 重定向到本用例 tmp
    // （log-retention-ipc.test.ts 同款先例）
    savedDataDir = process.env.TAIJI_AGENT_DATA_DIR
    process.env.TAIJI_AGENT_DATA_DIR = tmpDir
  })

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = savedDataDir
  })

  it('注册幂等：重复调用不重复 handle', () => {
    registerQuotaCookieRefreshHandler()
    registerQuotaCookieRefreshHandler()
    expect(fake.state.handlers.get(QUOTA_REFRESH_COOKIE)).toBeDefined()
    expect([...fake.state.handlers.keys()].filter((c) => c === QUOTA_REFRESH_COOKIE)).toHaveLength(1)
  })

  it('合法 payload 转发刷新器（成功路径，导出串随返回值回传）', async () => {
    registerQuotaCookieRefreshHandler()
    const handler = fake.state.handlers.get(QUOTA_REFRESH_COOKIE)!

    const invoke = handler(undefined, { fetcherId: 'mimo', providerId: 'p-ipc' }) as Promise<{
      ok: boolean
      cookie?: string
    }>
    makeReady(await windowOf(invoke))
    expect(await invoke).toEqual({ ok: true, cookie: 'sid=refreshed' })
  })

  it('非法 payload reject：空字段 / 非对象 / 不在册 fetcherId，且不触达刷新器', async () => {
    registerQuotaCookieRefreshHandler()
    const handler = fake.state.handlers.get(QUOTA_REFRESH_COOKIE)!
    await expect(handler(undefined, { fetcherId: '', providerId: 'p' })).rejects.toThrow(/invalid payload/)
    await expect(handler(undefined, { fetcherId: 'mimo', providerId: '' })).rejects.toThrow(/invalid payload/)
    await expect(handler(undefined, 'mimo')).rejects.toThrow(/invalid payload/)
    await expect(handler(undefined, { fetcherId: 'zhipu', providerId: 'p' })).rejects.toThrow(/invalid payload/)
    // providerId 含路径分隔符（形态白名单拒绝，不进刷新流程）
    await expect(handler(undefined, { fetcherId: 'mimo', providerId: '../evil' })).rejects.toThrow(/invalid payload/)
    // 均未开窗口（校验前置）
    expect(fake.FakeBrowserWindow.instances).toHaveLength(0)
  })

  it('isValidQuotaRefreshCookiePayload 纯函数边界', () => {
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 'mimo', providerId: 'p' })).toBe(true)
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 'opencode-go', providerId: 'p' })).toBe(true)
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 'mimo', providerId: 'my-zhipu' })).toBe(true)
    expect(isValidQuotaRefreshCookiePayload(null)).toBe(false)
    expect(isValidQuotaRefreshCookiePayload(undefined)).toBe(false)
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 1, providerId: 'p' })).toBe(false)
    // 在册 QUOTA_PRESETS 但无刷新目标（api-key 类）：拒绝
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 'minimax', providerId: 'p' })).toBe(false)
    // providerId 形态白名单：含路径分隔符（join 会把写盘路径移出 secrets 目录）→ 拒绝
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 'mimo', providerId: '../evil' })).toBe(false)
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 'mimo', providerId: 'a/b' })).toBe(false)
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 'mimo', providerId: 'a\\b' })).toBe(false)
    // 首字符非字母数字（点开头的隐藏文件形态）→ 拒绝
    expect(isValidQuotaRefreshCookiePayload({ fetcherId: 'mimo', providerId: '.hidden' })).toBe(false)
  })
})
