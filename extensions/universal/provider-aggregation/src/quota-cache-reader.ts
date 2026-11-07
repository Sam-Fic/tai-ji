/**
 * quota-cache.json 只读通道（provider-aggregation D3/SC5，M2 接线增量）。
 *
 * 写侧唯一 = runtime QuotaCache（packages/runtime/src/services/quota-cache.ts），路径
 * 公式 = join(<dataDir>, "quota-cache.json")。扩展侧经 pi 官方 getAgentDir() 推导
 * <dataDir>（设计 AS6：taiji 托管形态 agentDir = <dataDir>/agent，runtime spawn 注入的
 * PI_CODING_AGENT_DIR 值同源）——独立 pi 用户（agentDir = ~/.pi/agent）下推导指向
 * ~/.pi/quota-cache.json，该 taiji 概念文件不存在 → absent → 快照空（fail-open 语义保持）。
 *
 * mtime 门（SI3，与 config-store.ts 同形态）：route 求值前按文件 mtime 检查，变化才
 * 重读——无定时器、无 fs.watch（ADR-0190/ADR-0122 红线）。写侧原子写（tmp+rename），
 * rename 必然更新 mtime；同秒多次写可能同 mtime 最坏漏读一次更新（SI3 登记的接受项，
 * 下一请求补读）。
 *
 * 快照构造（D3/RL3）：新鲜条目（isAggregationQuotaDataFresh 单源判定，shared 契约根）
 * → percent 投影进 map；不新鲜 / pct 非有限数值 → 不入 map（求值侧按未知 fail-open，
 * 矩阵行 6/12）。读失败 / 缺失 / 损坏 = 条目集清空（快照空——本模块不区分「读不到」
 * 与「读到了但过期」，两者对求值的含义一致：额度未知不判死）。新鲜度过滤每次求值
 * 按当次墙钟现算（条目会随时间老化越过 600s 窗口，缓存解析结果不代表缓存判定结果）。
 *
 * 读取全部同步 API（route 闭包内完成，与 config-store 同款：求值前状态替换与求值
 * 之间无 await 窗口）；文件 KB 级小文本，与 runtime 写侧的同步读一致。
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isAggregationQuotaDataFresh, type AggregationQuotaFreshnessProbe } from "@taiji/shared/aggregation";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import type { RouteQuotaSnapshot } from "./router.ts";

const logger = getLogger("provider-aggregation");

/** quota-cache.json 文件名（与 runtime QuotaCache CACHE_FILENAME 同名锚点）。 */
export const QUOTA_CACHE_FILENAME = "quota-cache.json"

/** quota-cache.json 绝对路径（延迟调用 getAgentDir——模块加载期 pi 环境未必就绪）。 */
export function getQuotaCachePath(): string {
	return join(dirname(getAgentDir()), QUOTA_CACHE_FILENAME)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** stat 门单次探测结果（形态与 config-store probeFileMtime 同款）。 */
type StatProbe =
	| { kind: "ok", mtimeMs: number }
	| { kind: "absent" }
	| { kind: "failed", reason: string }

function probeFileMtime(path: string): StatProbe {
	try {
		return { kind: "ok", mtimeMs: statSync(path).mtimeMs }
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | null)?.code
		// ENOENT = 文件确定不存在（合法态：无缓存/独立 pi 用户）；其余 errno = 状态未知。
		if (code === "ENOENT") return { kind: "absent" }
		return { kind: "failed", reason: `quota-cache.json stat failed (${code ?? "unknown"})` }
	}
}

/** 单条额度窗口的判定投影字段（磁盘形态逐字段运行时提取，畸形 = 未知不猜值）。 */
interface QuotaWindowProjection { // oe-exempt:20261106:framework:schema 数据契约，单实现为设计终态
	pct?: number | null
	resetSec?: number | null
}

/** 首窗口已用百分比（缓存 pct 口径权威 = shared quota-types.ts QuotaWindow.pct
 * 「已用百分比 0-100」）：wins[0]（5h 滚动窗，AS4 的 TOKENS_LIMIT percentage 落点）
 * 直投——磁盘形态即已用口径（declarative-engine 各 via 全部转成已用落缓存；2026-11-07
 * 真机核实 bigmodel percentage = 已用：TIME_LIMIT usage=1000 / currentValue=867 /
 * remaining=133 / percentage=86 ≈ currentValue/usage）。判定侧（router.ts
 * isQuotaConditionSatisfied）做剩余换算（100 − pct）≥ 阈值，本投影不做二次换算——
 * 直投保持「UI 与扩展同源同语义」。非有限数值（null = 无限/未订阅、缺字段、NaN）返回
 * undefined = 未知（不猜数值，fail-open）。 */
function quotaPercentOf(entry: unknown): number | undefined {
	if (!isPlainObject(entry)) return undefined
	const wins = (entry.data as { wins?: unknown } | undefined)?.wins
	if (!Array.isArray(wins) || wins.length === 0) return undefined
	const pct = (wins[0] as QuotaWindowProjection).pct
	return typeof pct === "number" && Number.isFinite(pct) ? pct : undefined
}

/** 各窗口重置剩余秒数投影（isAggregationQuotaDataFresh 的 resetSecs 输入）。 */
function quotaResetSecsOf(entry: unknown): AggregationQuotaFreshnessProbe["resetSecs"] {
	const wins = (entry as { data?: { wins?: unknown } } | undefined)?.data?.wins
	if (!Array.isArray(wins)) return []
	return wins.map(w => (isPlainObject(w) ? (w as QuotaWindowProjection).resetSec : undefined))
}

/**
 * mtime 门 + 新鲜度过滤的额度快照读取器（每扩展工厂实例一个，闭包持有；不可进程级
 * 共享——多 pi 实例各自有自己的 agentDir 视角）。
 */
export class QuotaCacheReader {
	private readonly path: string
	/** 最后一次消费的内容签名（mtimeMs 字符串；"absent" = 消费时文件不存在；"stat-failed" =
	 * 上次 stat 故障未读到状态；null = 从未消费）。失败版本同样算消费（warn 一次不刷屏，
	 * config-store 同契约）。 */
	private lastSignature: string | null = null
	/** 最后一次成功解析的 providers 条目集（读失败/缺失 = 空——快照空语义，不保留旧值）。 */
	private entries: Record<string, unknown> = {}

	constructor(path: string = getQuotaCachePath()) {
		this.path = path
	}

	/**
	 * 一次路由求值的额度快照（D3）：mtime 门决定是否重读磁盘，新鲜度按当次 nowMs 现算。
	 * 返回 providerId → { percent }；空 map = 全部 provider 额度未知（求值侧 fail-open）。
	 */
	readFreshSnapshots(nowMs: number): ReadonlyMap<string, RouteQuotaSnapshot> {
		this.refreshIfChanged()
		const snapshots = new Map<string, RouteQuotaSnapshot>()
		for (const [providerId, entry] of Object.entries(this.entries)) {
			const percent = quotaPercentOf(entry)
			if (percent === undefined) continue
			const probe: AggregationQuotaFreshnessProbe = {
				lastFetchAt: quotaLastFetchAtOf(entry),
				resetSecs: quotaResetSecsOf(entry),
			}
			if (!isAggregationQuotaDataFresh(probe, nowMs)) continue
			snapshots.set(providerId, { percent })
		}
		return snapshots
	}

	/** mtime 门触发的重读（签名未变化时零磁盘读）。 */
	private refreshIfChanged(): void {
		const probe = probeFileMtime(this.path)
		if (probe.kind === "absent") {
			if (this.lastSignature === "absent") return
			this.lastSignature = "absent"
			this.entries = {}
			return
		}
		if (probe.kind === "failed") {
			if (this.lastSignature === "stat-failed") return
			this.lastSignature = "stat-failed"
			this.entries = {}
			logger.warn(`quota cache stat failed — quota snapshots treated as unknown (${probe.reason})`)
			return
		}
		const signature = String(probe.mtimeMs)
		if (signature === this.lastSignature) return
		this.lastSignature = signature
		this.entries = this.readEntries()
	}

	/** 整文件读取与防御解析；任一失败返回空条目集（warn 一次，签名已消费不重复报）。 */
	private readEntries(): Record<string, unknown> {
		let raw: string
		try {
			raw = readFileSync(this.path, "utf8")
		} catch (err) {
			const code = (err as NodeJS.ErrnoException | null)?.code
			logger.warn(`quota cache read failed — quota snapshots treated as unknown (${code ?? "unknown"})`)
			return {}
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch {
			logger.warn("quota cache is not valid JSON — quota snapshots treated as unknown")
			return {}
		}
		const providers = isPlainObject(parsed) ? parsed.providers : undefined
		if (!isPlainObject(providers)) {
			logger.warn("quota cache is missing the providers object — quota snapshots treated as unknown")
			return {}
		}
		return providers
	}
}

/** 条目 lastFetchAt 投影（畸形 = null，判定函数自身按未知处理）。 */
function quotaLastFetchAtOf(entry: unknown): number | null {
	const lastFetchAt = (entry as { lastFetchAt?: unknown } | null | undefined)?.lastFetchAt
	return typeof lastFetchAt === "number" ? lastFetchAt : null
}
