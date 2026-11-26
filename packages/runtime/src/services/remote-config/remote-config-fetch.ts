/**
 * taiji 远程配置 — 通用拉取器（GitHub main 固定 raw 地址热更新基建）。
 *
 * 配置源：仓库 `configs/remote/<domain>.json`（PUBLIC 仓，raw 匿名可拉，跟随 main 最新，
 * raw CDN 缓存约 5 分钟）。fail-safe 链：远程失败/guard 拒绝 → 上次落盘缓存 → 无缓存
 * 返回 undefined（域消费方按「无远程覆盖」运行——quota 域另有编译期基线兜底）。
 *
 * 架构对齐 provider-catalog-refresh.ts（同一「远程目录 overlay」家族）：mtime 内存缓存
 * 失效检测、ETag 协商（304 仅顺延 checkedAt）、checkedAt 节流窗、tmp+rename 原子落盘、
 * 全程 log 不抛错。差异：本模块的数据经域 guard 整体校验后才可落盘（guard 拒绝 = 整体
 * 拒用，不部分采纳——坏配置的最坏后果是停留在上次可用数据）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import { logger } from '../../infra/logger.js'

export const REMOTE_CONFIG_BASE_URL =
  'https://raw.githubusercontent.com/zhushanwen321/tai-ji/main/configs/remote'

/**
 * 远程配置候选源（按优先级排序；「配置源 commit main 即发布」不变，多源只解决可达性）。
 *
 * 拉取策略 = **并发探测 + 按优先级取首个有效源**（不串行 fail-forward：串行在首源超时时要
 * 白等满 REQUEST_TIMEOUT_MS 才试下一源，而本链在启动与进设置页两个用户可感知路径上）。
 * 有效性判据包含「HTTP 2xx **且** body 可 JSON.parse **且** 通过域 guard」——把「200 + 非
 * JSON」当成成功会让 GitCode 的边缘缓存页（HTML/占位文案）变成永久的 invalid 域。
 *
 * GitCode 侧属主与 GitHub 不同（qq_18433817 vs zhushanwen321），仓库内容由
 * scripts/gitcode-release-sync.mjs 的 pushRepoMirror 单向镜像；raw 端点为
 * `raw.gitcode.com/<repo>/raw/<ref>/<path>`（实测支持 if-none-match 304），
 * 而 `gitcode.com/<repo>/raw/...` 返回 SSR HTML 不可解析——故 baseUrl 只能用前者。
 */
export const REMOTE_CONFIG_SOURCES = [
  { id: 'github', baseUrl: REMOTE_CONFIG_BASE_URL },
  { id: 'gitcode', baseUrl: 'https://raw.gitcode.com/qq_18433817/tai-ji/raw/main/configs/remote' },
] as const


/** 新鲜度窗口 4h = 14_400_000ms（窗口内直接用缓存，不发网络请求；对齐 pi remote-catalog 的 4h 节奏）。 */
const REFRESH_INTERVAL_MS = 14_400_000
const REQUEST_TIMEOUT_MS = 8000
const CACHE_VERSION = 1
/** JSON 落盘缩进（全仓 JSON_INDENT = 2 约定）。 */
const JSON_INDENT = 2
const HTTP_NOT_MODIFIED = 304

/** 当前已接入的配置域（quota-fetchers = quota presets + fetcher 声明式配置，域 2；
 * v2-plugins = 可安装插件清单，provider-plugin-access U5 域 3，guard 归 plugin-catalog.ts；
 * retry-rules = 重试规则远程覆盖层，域 4，subagent-observability §3.3.12）。 */
/** 当前已接入的配置域（quota-fetchers = quota presets + fetcher 声明式配置，域 2；
v2-plugins = 可安装插件清单，域 3；retry-rules = 重试规则远程覆盖层，域 4；
provider-model-metadata = 附加段 provider（taijiExtra）模型元数据补丁，域 5，
见 remote-provider-metadata.ts）。 */
export type RemoteConfigDomain =
  | 'builtin-providers'
  | 'quota-fetchers'
  | 'v2-plugins'
  | 'retry-rules'
  | 'provider-model-metadata'


/** 落盘缓存 envelope（元数据与域数据分离；内容比较只比 data）。 */
interface RemoteCacheEnvelope { // oe-exempt:20261019:framework:taiji 远程配置域内形状/依赖注入面——接口先立单实现常态（本仓架构偏好），W3 quota-fetchers 域将复用同族形状
  version: number
  /** 最近一次完成检查（含 304）的时刻（ms）。节流窗的承载字段。 */
  checkedAt: number
  /**
   * 本次 data 的来源源 id（排障可见；双源后「哪一源落后」是新不可观测面，留痕消费）。
   * version 1 的 envelope 无此字段（读侧按无来源处理，不迁移写盘）。
   */
  source?: string
  /**
   * per-source ETag（源 id → etag）。双源下必须按源分存：单字段会把 A 源的 etag 送给 B 源，
   * 且 304 分支无法判断「这个 304 是对哪个源的」。version 1 的 envelope 用单 `etag`。
   */
  etags?: Record<string, string>
  /** @deprecated version 1 单源形态；读侧兼容（视为无 etag，首轮无条件 GET），写侧不再产出。 */
  etag?: string
  /** guard 校验通过后的域数据（未校验的原始响应永不落盘）。 */
  data: unknown
}

/** 域拉取结果：data = 本次可用数据（缓存优先语义）；refreshed = 本次发生了网络刷新且
 * 内容有变化（消费方据此触发合并写盘等下游动作）；reason = 未刷新原因（排障可见）。
 * 「无缓存且拉不到」不设独立 reason——「无数据」由 data===undefined 表达，reason
 * 恒取真实未刷新原因（network / invalid / throttled）。 */
export interface RemoteRefreshOutcome<T> { // oe-exempt:20261019:framework:taiji 远程配置域内形状/依赖注入面——接口先立单实现常态（本仓架构偏好），W3 quota-fetchers 域将复用同族形状
  data: T | undefined
  refreshed: boolean
  reason?: 'throttled' | 'network' | 'invalid'
  /** 本次数据的来源源 id（仅排障/日志消费，不参与任何业务判定）。 */
  source?: string
  /** 本次各失败源的归因（源 id → 原因），双源可达性排障用（ADR-0122 ⑧ 失败显式上报）。 */
  sourceFailures?: Array<{ source: string; reason: 'network' | 'invalid' }>
}

function remoteCachePath(domain: RemoteConfigDomain): string {
  return join(getDataDir(), 'remote-config', `${domain}.json`)
}

/** 落盘缓存解析：文件缺失 → null；JSON/结构损坏 → null + warn（fail-safe 回退）。 */
function parseCacheFile(domain: RemoteConfigDomain): RemoteCacheEnvelope | null {
  const path = remoteCachePath(domain)
  try {
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    const env = parsed as RemoteCacheEnvelope
    if (typeof env.checkedAt !== 'number' || !('data' in env)) throw new Error('missing fields')
    return env
  } catch (e) {
    logger.warn('[remote-config] cache file unreadable, treating as absent', {
      path,
      error: e instanceof Error ? e.message : String(e),
    })
    return null
  }
}

/** mtime（ms），不存在返回 -1。内存缓存失效检测用（外部无写方，理论恒命中——保留对齐
 * 家族模式，成本一次 statSync）。 */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}

// @data-owner #68（data-source-registry.md）：remote-config 落盘缓存的读侧内存快照（mtime
// 失效检测），持久权威是磁盘 envelope 文件——persistCache 落盘后同步刷新本快照，非第二写方。
const cacheSnapshots = new Map<string, { mtime: number; envelope: RemoteCacheEnvelope | null }>()

/** 读域缓存（内存快照 + mtime 失效检测）。 */
function loadCache(domain: RemoteConfigDomain): RemoteCacheEnvelope | null {
  const path = remoteCachePath(domain)
  const mtime = mtimeOf(path)
  const snap = cacheSnapshots.get(domain)
  if (snap && snap.mtime === mtime) return snap.envelope
  const envelope = parseCacheFile(domain)
  cacheSnapshots.set(domain, { mtime, envelope })
  return envelope
}

/** 写域缓存（tmp + rename 原子替换；目录不存在则创建）+ 失效内存快照。 */
async function persistCache(domain: RemoteConfigDomain, envelope: RemoteCacheEnvelope): Promise<void> {
  const path = remoteCachePath(domain)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(envelope, null, JSON_INDENT), 'utf-8')
  await rename(tmp, path)
  cacheSnapshots.set(domain, { mtime: mtimeOf(path), envelope })
}

/** 缓存数据过 guard 后返回（guard 拒绝 = 无数据，不部分采纳）。 */
function guardedCacheData<T>(cached: RemoteCacheEnvelope | null, guard: (v: unknown) => v is T): T | undefined {
  return cached && guard(cached.data) ? cached.data : undefined
}

/** 单源探测结果：有效（拿得到 guard 通过的数据）/ 304（缓存仍有效）/ 失败（归因）。 */
type SourceProbe<T> =
  | { source: string; kind: 'valid'; body: T; etag?: string; changed: boolean }
  | { source: string; kind: 'cached'; etag?: string }
  | { source: string; kind: 'failed'; reason: 'network' | 'invalid' }

/** 从缓存里取某源的 etag（version 1 单 etag 字段不参与——未知源，首轮无条件 GET）。 */
function etagForSource(cached: RemoteCacheEnvelope | null, sourceId: string): string | undefined {
  return cached?.etags?.[sourceId]
}

/**
 * 单源探测：网络 → 304 / 2xx + JSON + guard / 失败归因。
 *
 * 有效判据必须同时满足「2xx」「body 可 JSON.parse」「通过域 guard」——GitCode 的
 * raw 端点在边缘缓存异常时会返回 200 + 占位文案/HTML，只看状态码会让该域永久 invalid。
 */
async function probeSource<T>(
  domain: RemoteConfigDomain,
  guard: (v: unknown) => v is T,
  cached: RemoteCacheEnvelope | null,
  sourceId: string,
  baseUrl: string,
): Promise<SourceProbe<T>> {
  let res: globalThis.Response
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    const etag = etagForSource(cached, sourceId)
    if (etag) headers['if-none-match'] = etag
    res = await fetch(`${baseUrl}/${domain}.json`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    logger.warn('[remote-config] source fetch failed', {
      domain,
      source: sourceId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { source: sourceId, kind: 'failed', reason: 'network' }
  }

  if (res.status === HTTP_NOT_MODIFIED) {
    // 304 只对「本次发的 etag 所属源」有意义——etag 是按源取的，故命中的就是本源的缓存
    return { source: sourceId, kind: 'cached', etag: etagForSource(cached, sourceId) }
  }
  if (!res.ok) {
    void res.body?.cancel()
    logger.warn('[remote-config] source returned non-ok', { domain, source: sourceId, status: res.status })
    return { source: sourceId, kind: 'failed', reason: 'network' }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    logger.warn('[remote-config] source body is not JSON', { domain, source: sourceId })
    return { source: sourceId, kind: 'failed', reason: 'invalid' }
  }
  if (!guard(body)) {
    logger.warn('[remote-config] source payload rejected by domain guard', { domain, source: sourceId })
    return { source: sourceId, kind: 'failed', reason: 'invalid' }
  }

  return {
    source: sourceId,
    kind: 'valid',
    body,
    etag: res.headers.get('etag') ?? undefined,
    changed: !cached || JSON.stringify(cached.data) !== JSON.stringify(body),
  }
}

/**
 * 拉取域配置并返回可用数据（含节流/ETag/双源/fail-safe 全语义）。
 *
 * - 节流：缓存 checkedAt 在窗口内 → 直接返回缓存数据（reason: throttled）。
 * - 并发探测全部候选源，**按优先级取首个有效源**（有效 = 2xx + JSON + guard，或 304）。
 *   串行 fail-forward 会在首源超时语境下白等满超时再试下一源，而本链在启动与进设置页
 *   两个用户可感知路径上（并发成本 = 每域 2 个 KB 级请求，可接受）。
 * - 304：仅顺延 checkedAt（节流窗承载点），返回缓存数据。
 * - 200 + guard 通过：内容与缓存一致 → 只顺延元数据；有变化 → 落盘并返回新数据
 *   （refreshed: true，下游触发合并写盘）。
 * - 所有源都失败/都 guard 拒：整体拒用（不部分采纳），warn + 返回旧缓存数据。
 * - 全链无数据（无缓存且拉不到）：data undefined，reason 取真实未刷新原因。
 *
 * 高优先级源先成功时，低优先级源的结果只用于排障日志（sourceFailures / 内容不一致提示）——
 * 不参与选优，避免引入「哪份更新」的不可判定问题（镜像滞后就滞后，主源权威）。
 */
export async function refreshRemoteConfig<T>(
  domain: RemoteConfigDomain,
  guard: (v: unknown) => v is T,
  options?: { force?: boolean },
): Promise<RemoteRefreshOutcome<T>> {
  const cached = loadCache(domain)
  if (!options?.force && cached && Date.now() - cached.checkedAt < REFRESH_INTERVAL_MS) {
    return { data: guardedCacheData(cached, guard), refreshed: false, reason: 'throttled' }
  }

  // 两源是独立数据源（任一失败不影响另一源可用）：allSettled 而非 all——probeSource 内部
  // 已把网络/非 2xx/非 JSON/guard 拒全部归一为 failed 分支，allSettled 是对「它自己意外抛出」
  // 的额外隔离层（单源探测异常不得拖垮整次刷新）。
  const settled = await Promise.allSettled(
    REMOTE_CONFIG_SOURCES.map((s) => probeSource(domain, guard, cached, s.id, s.baseUrl)),
  )
  const probes: Array<SourceProbe<T>> = settled.map((r, idx) => {
    if (r.status === 'fulfilled') return r.value
    logger.warn('[remote-config] source probe threw', {
      domain,
      source: REMOTE_CONFIG_SOURCES[idx]?.id,
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    })
    return { source: REMOTE_CONFIG_SOURCES[idx]?.id ?? String(idx), kind: 'failed', reason: 'network' }
  })
  const winner = probes.find((p) => p.kind !== 'failed')
  const sourceFailures = probes
    .filter((p): p is Extract<SourceProbe<T>, { kind: 'failed' }> => p.kind === 'failed')
    .map((p) => ({ source: p.source, reason: p.reason }))
  const withFailures = <O extends RemoteRefreshOutcome<T>>(o: O): O =>
    sourceFailures.length > 0 ? { ...o, sourceFailures } : o

  if (!winner) {
    // 全部源失败：归因取「是否有源返回了坏内容」——有 invalid 优先报 invalid（配置源本身有问题）
    const reason: 'network' | 'invalid' = sourceFailures.some((f) => f.reason === 'invalid')
      ? 'invalid'
      : 'network'
    return withFailures({ data: guardedCacheData(cached, guard), refreshed: false, reason })
  }

  if (winner.kind === 'cached') {
    if (!cached) {
      // 理论上不可达（304 需要先发 etag，而 etag 来自缓存）；防御性归为 network
      return withFailures({ data: undefined, refreshed: false, reason: 'network', source: winner.source })
    }
    await persistCache(domain, {
      ...cached,
      version: CACHE_VERSION,
      checkedAt: Date.now(),
      source: winner.source,
      etags: { ...cached.etags, ...(winner.etag ? { [winner.source]: winner.etag } : {}) },
    }).catch((e) => {
      logger.warn('[remote-config] persist cache failed', {
        domain,
        error: e instanceof Error ? e.message : String(e),
      })
    })
    return withFailures({
      data: guardedCacheData(cached, guard),
      refreshed: false,
      reason: 'throttled',
      source: winner.source,
    })
  }

  try {
    await persistCache(domain, {
      version: CACHE_VERSION,
      checkedAt: Date.now(),
      source: winner.source,
      // 收录**全部有效源**的 etag（不止胜出源）：下一轮两源都能各自送 if-none-match，
      // 命中 304 即省下整份 body。收录失败源/坏内容的 etag 无意义（该源本轮没给出可信
      // 版本标识），故只取 kind==='valid' 的那些。
      etags: {
        ...(cached?.etags ?? {}),
        ...Object.fromEntries(
          probes
            .filter((p): p is Extract<SourceProbe<T>, { kind: 'valid' }> => p.kind === 'valid')
            .filter((p) => p.etag !== undefined)
            .map((p) => [p.source, p.etag as string]),
        ),
      },
      data: winner.body,
    })
  } catch (e) {
    // 落盘失败不阻断本次返回（内存数据已可用），下次触发点重刷
    logger.warn('[remote-config] persist cache failed', {
      domain,
      error: e instanceof Error ? e.message : String(e),
    })
  }
  return withFailures({
    data: winner.body,
    refreshed: winner.changed,
    reason: winner.changed ? undefined : 'throttled',
    source: winner.source,
  })
}

/** 读域数据（纯缓存，不发网络；域消费方的同步读侧入口）。 */
export function loadRemoteConfig<T>(domain: RemoteConfigDomain, guard: (v: unknown) => v is T): T | undefined {
  const cached = loadCache(domain)
  return cached && guard(cached.data) ? cached.data : undefined
}
