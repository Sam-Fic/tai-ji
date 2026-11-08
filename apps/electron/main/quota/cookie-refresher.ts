/**
 * 隐藏窗口 cookie 刷新器（quota:refresh-cookie 的执行主体）。
 *
 * cookie 类 provider（mimo / opencode-go）的服务端登录态换发必须走真实浏览器环境
 * （页面 JS + SSO 跳转），本模块按需创建隐藏 BrowserWindow 让续期循环跑起来：
 *
 *   种 cookie（secrets 文件 → partition）→ 加载 pageUrl → 页面导航/load/cookie 变更
 *   事件触发页面内 API 探测（200 即就绪）→ 导出 partition 的目标域 cookie 串 → 销毁窗口
 *   （串经 IPC 回 renderer）。无周期轮询 / 登录页停留判定等时间阈值机制：探测时当前 URL
 *   命中登录页特征 = 登录态失效的确定性事实（URL 判定，非时间阈值），show() 转可见并即刻
 *   以 login required 失败收尾（成败都 destroy，渲染端 dedup 槽随 Promise 落定即时释放）；
 *   整体网络级兜底超时（REFRESH_DEADLINE_MS）封住「无事件可等」的挂起形态（归类依据见
 *   该常量注释）。
 *
 * 日常零内存占用：窗口按需创建、成败都 destroy；partition 用 persist 前缀（历史登录态
 * 跨刷新保留，SSO 跳转链的中间 cookie 不丢）。
 *
 * 与 runtime 的写方关系（跨进程单写方裁决，data-source-registry #66）：main **只读**
 * secrets 文件（种 cookie 直读）；导出串不落盘，由 renderer 续期链走 quota.configure
 * 保存链经 runtime QuotaService 单点写入——secrets 文件的唯一写方进程恒为 runtime，
 * 消除 main 覆盖写与 runtime 读-合并-写跨进程交错丢更新的竞态。
 *
 * 安全策略（与主窗口 window-factory 的白名单语义不同，独立成套）：
 * - will-navigate 只放行目标站点域（pageUrl / apiUrl 的 host）+ loginUrlPatterns 中
 *   host 形态 pattern 命中的账号域，其余 deny——第三方域导航会把 session cookie 带
 *   到不可信站点（Cookie SameSite 之外的最后防线）
 * - setWindowOpenHandler 一律 deny（弹窗不开）
 * - nodeIntegration: false + contextIsolation: true（加载的是平台页面，非受控内容）
 *
 * 依赖方向：quota/cookie-refresher → electron + node:fs/node:path + @taiji/shared
 * （刷新目标 SSOT）+ logs/main-logger。无下游（IPC 层 quota-cookie-ipc 消费）。
 */
import { BrowserWindow, session } from 'electron'
import type { Session } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import { getQuotaRefreshTarget, normalizeCookieHeader } from '@taiji/shared'
import type { QuotaRefreshCookieResult, QuotaRefreshTarget } from '@taiji/shared'
import { mainLogger } from '../logs/main-logger.js'

/** 完成信号：API 探测的 HTTP 状态码（只看 200，不校验业务字段）。 */
const HTTP_OK = 200

/**
 * 刷新整体兜底超时（毫秒）：页面加载成功后「无任何导航/cookie 事件且探测不 200」的
 * 网络级异常形态（站点半死 / 网络中断 / 页面 JS 崩溃）没有事件可等，按失败收尾交用户
 * 重试。归类 ADR-0190 丙类③（远程网络相关调用的超时设置，事件驱动非轮询）；区别于
 * 同裁决丁类已删的「cookie 刷新轮询周期 + deadline」机制（本 deadline 只封网络级挂起，
 * 不做周期轮询/时间阈值判死）。120s 覆盖最慢合法形态（SSO 跳转链 + 慢网络，
 * 真机在册目标收尾实测 3.2s / 2.8s，两个数量级余量）。
 */
const REFRESH_DEADLINE_MS = 120_000

/** REFRESH_DEADLINE_MS 的秒制值（超时文案显示用，改窗长时随常量联动）。 */
// eslint-disable-next-line no-magic-numbers -- ms→s 单位换算因子，非业务常量
const REFRESH_DEADLINE_S = REFRESH_DEADLINE_MS / 1000

/** 刷新请求（与 IPC payload 同构；providerId 决定 partition 与 secrets 文件名）。 */
export type QuotaRefreshInput = {
  fetcherId: string
  providerId: string
}

/** 依赖注入范围：测试注入 dataDir 桩；生产缺省 @taiji/shared/paths getDataDir()。 */
export type QuotaRefreshDeps = {
  dataDir?: () => string
}

/** providerId → 在途刷新 Promise（同 provider 重入返回同一 Promise，不并发开第二个窗口）。 */
const inflight = new Map<string, Promise<QuotaRefreshCookieResult>>()

/**
 * 刷新指定 provider 的 cookie 登录态。永不 reject（异常归一进 ok:false + error 文案，
 * IPC 调用方按结果分支展示，无需 catch 面区分调用错误与执行失败）。
 */
export function refreshQuotaCookie(
  input: QuotaRefreshInput,
  deps: QuotaRefreshDeps = {},
): Promise<QuotaRefreshCookieResult> {
  const existing = inflight.get(input.providerId)
  if (existing) return existing
  const run = runRefresh(input, deps).finally(() => {
    inflight.delete(input.providerId)
  })
  inflight.set(input.providerId, run)
  return run
}

async function runRefresh(input: QuotaRefreshInput, deps: QuotaRefreshDeps): Promise<QuotaRefreshCookieResult> {
  const target = getQuotaRefreshTarget(input.fetcherId)
  if (!target) {
    // IPC 层已校验 fetcherId 在册；此处兜底（直接调用方传错 id 时给出可定位文案）
    return { ok: false, error: `no quota refresh target for fetcher: ${input.fetcherId}` }
  }
  const dataDir = deps.dataDir?.() ?? getDataDir()
  let win: BrowserWindow | null = null
  // 整体兜底超时（REFRESH_DEADLINE_MS，归类依据见常量注释）：武装点在 runRefresh 进入
  // 即启动——loadURL 悬挂（主文档 load 被挂起型子资源长期阻塞、不报错也不完成的罕见
  // 形态）与探测全程同受约束；超时 reject 经下方 catch 归一 ok:false，窗口随 finally
  // destroy、inflight 槽随 Promise 落定释放
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new Error(`refresh timed out after ${REFRESH_DEADLINE_S}s — 网络异常或站点无响应，请稍后重试`)),
      REFRESH_DEADLINE_MS,
    )
  })
  try {
    const main = (async (): Promise<QuotaRefreshCookieResult> => {
      // persist 前缀 = 落盘 partition（历史登录态跨刷新保留）；providerId 维度隔离。
      // fromPartition 一并进 main 链：任何环节异常都归一进 ok:false，守住「永不 reject」契约
      const ses = session.fromPartition(`persist:quota-${input.providerId}`)
      await seedCookies(ses, target, dataDir, input.providerId)
      win = new BrowserWindow({
        show: false,
        webPreferences: {
          session: ses,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      attachNavigationGuards(win, target)
      try {
        // loadURL resolve 即主文档加载完成（含 SSO 服务端跳转链），此后页面可执行 JS
        await win.loadURL(target.pageUrl)
      } catch (err) {
        // ERR_ABORTED(-3) 不是失败：平台页 JS 发现未登录会主动导航到登录链
        // （如 xiaomimimo 的 genLoginUrl → account.xiaomi.com），打断初始加载。
        // 跳转后的 API 探测由页面导航/load 事件驱动（见 probeUntilApiOk），这里只拦真正的加载故障
        if (!isAbortedNavigation(err)) {
          return { ok: false, error: `page load failed: ${errorMessage(err)}` }
        }
      }
      await probeUntilApiOk(win, ses, target)
      const cookie = await exportCookies(ses, target)
      return { ok: true, cookie }
    })()
    // race 输家吸收：超时先落定时，主链稍后的 settle（含 reject）不得成为 unhandled
    // rejection；主链自身 reject 经 race 传递由外层 catch 归一
    void main.catch(() => {})
    return await Promise.race([main, deadline])
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  } finally {
    clearTimeout(deadlineTimer)
    if (win && !win.isDestroyed()) win.destroy()
  }
}

// ── 种 cookie（secrets 文件 → partition）─────────────────────────────────────

/** cookie 文件路径：`<dataDir>/secrets/<providerId>-cookie.txt`（与 runtime quota-service 同一规则）。 */
function cookieFilePath(dataDir: string, providerId: string): string {
  return join(dataDir, 'secrets', `${providerId}-cookie.txt`)
}

async function seedCookies(ses: Session, target: QuotaRefreshTarget, dataDir: string, providerId: string): Promise<void> {
  let raw: string
  try {
    raw = readFileSync(cookieFilePath(dataDir, providerId), 'utf-8')
  } catch {
    // 文件缺失 = 首次刷新（用户从未贴过 cookie）：跳过种入，partition 里可能已有
    // 历史登录态（persist partition），让页面自己判定
    return
  }
  const normalized = normalizeCookieHeader(raw)
  if (!normalized) return
  const origin = new URL(target.pageUrl).origin
  for (const pair of normalized.split('; ')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    try {
      // path:'/' + secure:true 显式给足：__Host- 前缀 cookie（如 opencode 的
      // __Host-console_session）的 Chromium 强校验（host-only + Secure + Path=/），
      // url-only 形态被 EXCLUDE_INVALID_PREFIX 拒绝、会话种不进 partition；对普通
      // cookie 这也正是服务端种入的真实属性（在册 target 的 pageUrl 恒 https）
      await ses.cookies.set({
        url: origin,
        name: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        path: '/',
        secure: true,
      })
    } catch (err) {
      // 单条种入失败（cookie 域/属性与服务端写入形态不符）只降级不中断：其余 cookie
      // 足以让续期循环跑起来的场景不能被个别畸形条目阻塞
      mainLogger.warn('[quota-cookie-refresher] seed cookie skipped', {
        providerId,
        name: pair.slice(0, eq),
        error: errorMessage(err),
      })
    }
  }
}

// ── 事件驱动 API 探测（页面导航/load/cookie 变更事件触发）────────────────────

/**
 * 挂页面导航/load/cookie 变更事件监听，每次事件触发一次页面内 API 探测；命中 HTTP_OK
 * 即完成。
 *
 * 触发面三源：
 * - 'did-finish-load'（主文档加载完成）与 'did-navigate'（每次导航提交，覆盖 SSO
 *   跳转链的每一跳与登录后跳回）。附上监听后**立即先探一次**——生产路径 loadURL await
 *   期间 did-finish-load 已发射，迟挂的监听收不到那一次。
 * - session.cookies 'changed'（服务端 Set-Cookie 落地）。SPA 平台（如 stepfun）的
 *   会话换发是页内 XHR 响应的 Set-Cookie，**不产生任何导航事件**——只挂导航事件时
 *   首探（换发完成前）401 后探测永不重试，登录态已换发成功却等不到 200 确证，
 *   Promise 挂起。cookie 落地是「换发完成」的确定性事实，事件驱动补源，非时间阈值。
 *
 * 确定性收尾（URL 事实，非时间阈值停留判定）：探测时当前 URL 命中登录页特征
 * （isQuotaRefreshLoginUrl）= 登录态失效确证 → win.show() 转可见提示 + reject
 * （"login required"）——经 runRefresh 既有 catch 归一 ok:false，窗口随 finally
 * destroy、渲染端 cookieRefreshDedup 槽随 Promise 落定即时释放，恢复由用户侧重试
 * 承载（重新登录后下次 hover 重查，探测即 200）。窗口销毁 → reject（同经 catch 归一）。
 * 「无事件可等」的挂起形态（页面加载成功后零事件且探测不 200）由 runRefresh 层的
 * 整体网络级超时兜底（见 REFRESH_DEADLINE_MS），本函数不持计时器。
 */
function probeUntilApiOk(win: BrowserWindow, ses: Session, target: QuotaRefreshTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const wc = win.webContents
    const siteHosts = siteHostsOf(target)
    const cleanup = (): void => {
      wc.removeListener('did-finish-load', onReady)
      wc.removeListener('did-navigate', onReady)
      wc.removeListener('destroyed', onDestroyed)
      // partition session 跨刷新常驻（persist 落盘）：不移除会随进程累积监听器泄漏
      ses.cookies.removeListener('changed', onCookieChanged)
    }
    const succeed = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(message))
    }
    const onReady = (): void => {
      if (win.isDestroyed()) {
        fail('refresh window destroyed before api ready')
        return
      }
      // 登录页命中 = 登录态失效的确定性确证（URL 事实，非时间阈值停留判定）：转可见
      // 提示 + 即刻以 login required 失败收尾。无时间窗裁决下没有「等用户登录」的
      // 等待窗；且页面停在登录域（API 永不 200、无后续导航事件）时 Promise 必须落定，
      // 否则隐藏窗口泄漏（成败都 destroy 契约失守）+ 渲染端 dedup 槽永不释放（该
      // provider 续期被静默拦截）。检测先于探测：登录态已失效的页面无需再发 API 探测
      const url = win.webContents.getURL()
      if (isQuotaRefreshLoginUrl(url, target)) {
        win.show()
        mainLogger.info('[quota-cookie-refresher] login required', { url })
        fail('login required')
        return
      }
      void probeApi(win, ses, target).then((status) => {
        if (status === HTTP_OK) succeed()
      })
    }
    // cookie 变更重探源：只认目标域的**写入**事件（真机词表，Electron 42 实测 2026-11-06：
    // 写入 = cause 'inserted' / 'inserted-no-value-change-overwrite'，覆盖换发 = 'overwrite'
    // removed=true 删旧 + 'inserted' 插新两连发；清理/过期/驱逐均 removed=true）。
    // 域外变更（第三方分析 cookie 等）与会话无关，触发只会徒增页面上下文 fetch
    const onCookieChanged = (
      _event: unknown,
      cookie: { domain?: string },
      cause: string,
      removed: boolean,
    ): void => {
      if (removed) return
      if (!cause.startsWith('inserted')) return
      if (!isTargetCookieDomain(cookie.domain, siteHosts)) return
      onReady()
    }
    const onDestroyed = (): void => fail('refresh window destroyed before api ready')

    wc.on('did-finish-load', onReady)
    wc.on('did-navigate', onReady)
    wc.on('destroyed', onDestroyed)
    ses.cookies.on('changed', onCookieChanged)
    onReady() // 首探：覆盖「loadURL 已就绪、初始 did-finish-load 已错过」的窗口
  })
}

/**
 * 组装探测请求头：静态 apiHeaders + apiHeaderFroms 的 cookie 镜像（partition 读值注入，
 * main 侧 API 可读 HttpOnly——页面上下文 document.cookie 读不到，这是必须 main 注入的原因）。
 * partition 缺该 cookie 时跳过对应头（探测维持现状失败，不劣化）。
 */
async function resolveProbeHeaders(ses: Session, target: QuotaRefreshTarget): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(target.apiHeaders ?? {}) }
  for (const { cookieKey, header } of target.apiHeaderFroms ?? []) {
    try {
      const found = await ses.cookies.get({ name: cookieKey })
      const value = found.at(-1)?.value
      if (value !== undefined && value !== '') headers[header] = value
    } catch (err) {
      // cookies.get 异常（分区读写竞争等）：跳过该头，探测按现状失败，不阻塞重探链
      mainLogger.warn('[quota-cookie-refresher] probe header cookie read failed', {
        cookieKey,
        error: errorMessage(err),
      })
    }
  }
  return headers
}

/** 页面上下文内 fetch 目标 API，返回 HTTP status（异常/非数值归一为 0）。
 *  POST 端点（connect RPC 形态）按 target.apiMethod/apiBody 发探测——与真实额度
 *  请求同方法同头（缺业务头时有效会话也 401，见 QuotaRefreshTarget.apiHeaders 注释）。 */
async function probeApi(win: BrowserWindow, ses: Session, target: QuotaRefreshTarget): Promise<number> {
  try {
    const headers = await resolveProbeHeaders(ses, target)
    const initParts: string[] = []
    if (target.apiMethod === 'POST') initParts.push(`method:'POST'`, `body:${JSON.stringify(target.apiBody ?? '{}')}`)
    if (Object.keys(headers).length > 0) initParts.push(`headers:${JSON.stringify(headers)}`)
    const init = initParts.length > 0 ? `{${initParts.join(',')}}` : ''
    const expr = `fetch(${JSON.stringify(target.apiUrl)},${init}).then(r => r.status).catch(() => 0)`
    const status = await win.webContents.executeJavaScript(expr)
    return typeof status === 'number' ? status : 0
  } catch {
    // 页面跳转中 / 导航被拦截时 executeJavaScript 会拒绝：本次按无响应处理，
    // 下一个页面事件（导航完成/加载完成）触发重探
    return 0
  }
}

/** Electron net 错误码 ERR_ABORTED：页面 JS 发起新导航打断初始加载（SSO 链标准形态）。 */
const NET_ERR_ABORTED = -3

function isAbortedNavigation(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  return code === NET_ERR_ABORTED || /ERR_ABORTED/.test(err.message)
}

// ── 导出（partition → IPC 返回值）────────────────────────────────────────────

/**
 * 导出 partition 中目标域的 cookie 串。
 *
 * ses.cookies.get({}) 能拿到 HttpOnly cookie（document.cookie 拿不到，这正是要走
 * 隐藏窗口而非 renderer fetch 的原因）；导出串保持手贴格式（`name=value; name2=value2`），
 * 除域过滤外不做任何加工——runtime fetcher 直接把它作 Cookie 请求头发送。
 * main 不落盘（跨进程单写方裁决，见模块头注释）：串经 QuotaRefreshCookieResult.cookie
 * 回 renderer，由续期链走 quota.configure 保存链经 runtime 单点写 secrets 文件。
 *
 * @returns 目标域一条 cookie 都没有时 throw（API 200 却无 cookie 属于不可能态，按异常
 *   上抛由调用方统一归一，不静默返回「成功但没导出」）
 */
async function exportCookies(ses: Session, target: QuotaRefreshTarget): Promise<string> {
  const all = await ses.cookies.get({})
  const siteHosts = siteHostsOf(target)
  const header = all
    .filter((c) => isTargetCookieDomain(c.domain, siteHosts))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
  if (!header) {
    throw new Error(`no cookies captured for target domain (${[...siteHosts].join(', ')})`)
  }
  return header
}

// ── 导航守卫（安全策略）───────────────────────────────────────────────────────

function attachNavigationGuards(win: BrowserWindow, target: QuotaRefreshTarget): void {
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedQuotaRefreshNavigation(url, target)) {
      event.preventDefault()
      mainLogger.warn('[quota-cookie-refresher] blocked navigation outside target domains', { url })
    }
  })
  // 弹窗一律不开：刷新流程没有需要新窗口的分支，window.open / target=_blank 全 deny
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

/** 目标站点域集合（pageUrl / apiUrl 的 hostname；大小写归一）。 */
function siteHostsOf(target: QuotaRefreshTarget): Set<string> {
  const hosts = new Set<string>()
  for (const u of [target.pageUrl, target.apiUrl]) {
    try {
      hosts.add(new URL(u).hostname.toLowerCase())
    } catch {
      // 在册配置 URL 非法的防御分支：跳过该条，白名单按已解析的其余域收窄
      mainLogger.warn('[quota-cookie-refresher] invalid target url in config', { url: u })
    }
  }
  return hosts
}

/**
 * 登录页判定：loginUrlPatterns 任一命中当前 URL（大小写不敏感）。
 * 与导航白名单（isAllowedQuotaRefreshNavigation）语义不同：这里对完整 URL 跑
 * pattern（路径形态 '/login' 在此生效），只用于登录态失效确证（确定性失败收尾判定），
 * 不放行任何导航。
 */
export function isQuotaRefreshLoginUrl(url: string, target: QuotaRefreshTarget): boolean {
  return target.loginUrlPatterns.some((p) => new RegExp(p, 'i').test(url))
}

/**
 * 导航白名单：只放行目标站点域 + loginUrlPatterns 中 host 形态 pattern 命中的账号域。
 *
 * host 形态判定 = pattern 不含 '/'（'account\\.xiaomi\\.com' / 'auth\\.'）；
 * 路径形态（'/login'）**不参与放行**——它匹配任意域的同路径（evil.com/login 也命中），
 * 平台自身的 /login 登录页已在目标站点域内放行，不需要路径形态开洞。
 *
 * host 匹配用锚定式而非对 pattern 跑正则：无锚正则的子串语义会把伪装域
 * （account.xiaomi.com.evil.com）当账号域放行。两种 pattern 形态各自锚定：
 * 尾点形态（'auth\\.'）= 子域前缀（auth.opencode.ai）；裸域形态（'account.xiaomi.com'）
 * = 等值或子域后缀（sub.account.xiaomi.com）。
 */
export function isAllowedQuotaRefreshNavigation(url: string, target: QuotaRefreshTarget): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  const host = parsed.hostname.toLowerCase()
  if (siteHostsOf(target).has(host)) return true
  return target.loginUrlPatterns
    .filter((p) => !p.includes('/'))
    .some((p) => hostMatchesLoginHostPattern(host, p))
}

/** host 形态 pattern 的锚定匹配（形态语义见 isAllowedQuotaRefreshNavigation）。 */
function hostMatchesLoginHostPattern(host: string, pattern: string): boolean {
  if (pattern.endsWith('.')) return host.startsWith(pattern)
  return host === pattern || host.endsWith(`.${pattern}`)
}

/**
 * cookie 的 domain 属性是否落在目标站点域内（导出过滤）。
 * Electron cookie.domain 形态：'.example.com'（域 cookie，覆盖子域）或
 * 'app.example.com'（host-only）；前导 '.' 剥掉后按域后缀匹配。缺省 domain
 * （Electron 类型可缺）按不匹配处理。
 */
export function isTargetCookieDomain(cookieDomain: string | undefined, siteHosts: Set<string>): boolean {
  if (!cookieDomain) return false
  const domain = cookieDomain.replace(/^\./, '').toLowerCase()
  for (const host of siteHosts) {
    if (host === domain || host.endsWith(`.${domain}`)) return true
  }
  return false
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
