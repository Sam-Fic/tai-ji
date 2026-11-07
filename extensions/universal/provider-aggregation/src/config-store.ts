/**
 * providers.json routes 段读取（扩展侧只读，设计 D2/SC3/SC5）。
 *
 * 路径公式 SSOT = @zhushanwen/extension-protocol/provider-store-paths 纯模块（getProviderExtrasPath
 * 纯函数，agentDir 入参；写侧 runtime pi-paths 与另一读侧 subagent-core scoped-models
 * 同源消费，公式漂移结构上不可能）。本模块只补扩展侧基址：pi 官方 getAgentDir
 * （尊重 PI_CODING_AGENT_DIR，taiji 托管形态下即 <dataDir>/agent）。providers.json
 * 是 taiji 的配置（pi 引擎零消费，前提 AS20），本模块只读顶层 routes 键，其余键
 * （providers/scopedModels 等）不触碰。
 *
 * mtime 门（D1 修订形态 / SI2）：route 求值前与 session_start 对账前按文件 mtime 检查，
 * 变化才重读——无定时器、无 fs.watch（ADR-0190/ADR-0122 红线：监视存储模拟实时禁断）。
 * 写侧唯一 = runtime provider-extras-store 的 tmp+rename 原子写，rename 必然更新 mtime，
 * 信号与目标同源同发；「内容未变的重复保存」也会更新 mtime，但重读解析幂等（重注册
 * 同 id = 替换），无错误行为。
 *
 * 读取全部用同步 API：route 闭包内的重读必须同步完成（求值前状态替换与求值之间无
 * await 窗口，天然免并发竞态）；文件为 KB 级小文本，与 runtime 写侧的同步读一致。
 *
 * 消费语义（RL4）：读取成功/失败都记录消费签名（该版本内容已消费，下次内容再变才重读
 * ——失败版本不反复 warn 刷日志）；损坏/不可读（含 stat 故障——文件存在但状态未知，
 * 见 probeFileMtime）由调用方保持上一有效注册继续路由（扩展侧读失败不发明「隔离坏
 * 文件」动作——磁盘隔离与呈报是 runtime extras store 的既有语义，扩展侧只保证自身
 * 不因坏配置丢注册）。
 */

import { readFileSync, statSync } from "node:fs";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getProviderExtrasPath as sharedGetProviderExtrasPath } from "@zhushanwen/extension-protocol/provider-store-paths";
import { parseAggregationRoutesSection, type AggregationRoutesFile } from "@zhushanwen/extension-protocol/aggregation";

/** providers.json 绝对路径（延迟调用 getAgentDir——模块加载期 pi 环境未必就绪）。
 * 公式本体 = shared provider-store-paths 纯模块（与 runtime 写侧同源）。 */
export function getProviderExtrasPath(): string {
	return sharedGetProviderExtrasPath(getAgentDir())
}

/** routes 段单次读取结果。absent 是合法态（无 routes 域的既有环境/原生 pi 用户），不是失败；
 * skipped = mtime 门未触发（调用方不消费该结果）。 */
export type RoutesSectionRead =
	| { status: "ok", file: AggregationRoutesFile }
	| { status: "absent" }
	| { status: "skipped" }
	| { status: "corrupt", reason: string }
	| { status: "unreadable", reason: string }

/** 门已触发的一次真实读取（readIfChanged changed=true / readLatest 的返回——skipped 不出现）。 */
export type ConsumedRoutesSectionRead = Exclude<RoutesSectionRead, { status: "skipped" }>

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** stat 门单次探测结果：absent 仅限 ENOENT（确定不存在）；failed = 其余 stat 故障（存在但状态未知）。 */
type StatProbe =
	| { kind: "ok", mtimeMs: number }
	| { kind: "absent" }
	| { kind: "failed", reason: string }

function probeFileMtime(path: string): StatProbe {
	try {
		return { kind: "ok", mtimeMs: statSync(path).mtimeMs }
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | null)?.code
		// ENOENT = 文件确定不存在（合法态 → absent）；其余 errno（EACCES/EIO/ELOOP 等）=
		// 存在但状态未知 → 按 unreadable 呈报并保持旧注册（RL4 读失败族与 corrupt/unreadable
		// 同契约），绝不并入 absent——一次瞬时 stat 故障把全部已注册路由标删除态、用户面对
		// 误导性「已删除」错误，是该处并入 absent 的根因。
		if (code === "ENOENT") return { kind: "absent" }
		return { kind: "failed", reason: `providers.json stat failed (${code ?? "unknown"})` }
	}
}

function readRoutesSection(path: string): ConsumedRoutesSectionRead {
	let raw: string
	try {
		raw = readFileSync(path, "utf8")
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | null)?.code
		if (code === "ENOENT") return { status: "absent" }
		return { status: "unreadable", reason: `providers.json read failed (${code ?? "unknown"})` }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return { status: "corrupt", reason: "providers.json is not valid JSON" }
	}
	if (!isPlainObject(parsed)) return { status: "corrupt", reason: "providers.json is not an object" }
	const result = parseAggregationRoutesSection(parsed.routes)
	return result.ok ? { status: "ok", file: result.file } : { status: "corrupt", reason: result.reason }
}

/**
 * mtime 门 + routes 段读取器（每扩展工厂实例一个，闭包持有；不可进程级共享——
 * 多 pi 实例各自有自己的 agentDir 视角）。
 */
export class RoutesConfigReader {
	private readonly path: string
	/** 最后一次消费的内容签名（mtimeMs 字符串；"absent" = 消费时文件不存在；"stat-failed" =
	 * 上次 stat 故障未读到状态；null = 从未消费）。 */
	private lastSignature: string | null = null

	constructor(path: string = getProviderExtrasPath()) {
		this.path = path
	}

	/**
	 * mtime 门触发的一次读取。changed=false 表示文件自上次消费后未变（read 为 skipped，
	 * 调用方不消费）；changed=true 时 read 为本次真实读取结果（成功失败都算消费——
	 * 失败版本已呈报过，不再重读重报）。
	 */
	readIfChanged(): { changed: false, read: RoutesSectionRead } | { changed: true, read: ConsumedRoutesSectionRead } {
		const probe = probeFileMtime(this.path)
		if (probe.kind === "absent") {
			if (this.lastSignature === "absent") return { changed: false, read: { status: "absent" } }
			this.lastSignature = "absent"
			return { changed: true, read: { status: "absent" } }
		}
		if (probe.kind === "failed") {
			// stat 故障按 unreadable 消费（保持旧注册 + warn，与 corrupt/unreadable 同契约）；
			// 签名记 sentinel——stat 恢复后 mtime 签名必然异于 sentinel 自然触发重读收敛，
			// 故障持续期间不重复 warn。
			if (this.lastSignature === "stat-failed") return { changed: false, read: { status: "skipped" } }
			this.lastSignature = "stat-failed"
			return { changed: true, read: { status: "unreadable", reason: probe.reason } }
		}
		const signature = String(probe.mtimeMs)
		if (signature === this.lastSignature) return { changed: false, read: { status: "skipped" } }
		const read = readRoutesSection(this.path)
		this.lastSignature = signature
		return { changed: true, read }
	}

	/**
	 * 无视 mtime 门的强制读取（消费签名照常更新）。专用于 session_start 全量对账：
	 * 求值前重读会「消费」文件内容但只处理已注册 id（新增 id 被 D1 ③ 有意忽略）——
	 * 若对账也走门，被消费的新增 id 将在门未再变化时永远注册不上。会话加载一次的
	 * 全量重读（statSync + readFileSync，KB 级）是对账正确性的必要成本，事件驱动非轮询。
	 */
	readLatest(): ConsumedRoutesSectionRead {
		const probe = probeFileMtime(this.path)
		if (probe.kind === "absent") {
			this.lastSignature = "absent"
			return { status: "absent" }
		}
		if (probe.kind === "failed") {
			this.lastSignature = "stat-failed"
			return { status: "unreadable", reason: probe.reason }
		}
		this.lastSignature = String(probe.mtimeMs)
		return readRoutesSection(this.path)
	}
}
