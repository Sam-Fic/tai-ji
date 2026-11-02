/**
 * InstalledStore —— <pluginsDir>/installed.json 读写（provider-plugin-access U4 / D11）。
 *
 * 只记安装事实时间：{ [pluginId]: { installedAt } }。版本与命名空间**均不落盘**——
 * 版本唯一事实 = 插件目录内 package.json 的 version（registry scan 直读），命名空间 =
 * 包名纯函数推导（plugin-namespace.ts）。两个候选持久化字段都没有已发生问题支撑，
 * 第二份事实只引入失真面（可派生状态不落第二份，ADR-0122）。
 *
 * 登记缺失无碍安装判定：安装与否的唯一事实 = 插件目录存在且 package.json 合法
 * （registry scan 口径），installed.json 只承载 installedAt 展示。文件损坏按空表容错
 * （warn fail-visible），不阻断安装/卸载编排。
 *
 * ── 禁用标记清单（startup-readiness §7.5 / D2 / U7 机制半边）────────────────
 *
 * `<pluginsDir>/disabled.json`：{ [pluginId]: { reason, disabledAt } }。与 installed.json
 * 同目录、同容错语义、**schema 各自独立**（installed.json schema 冻结只含 installedAt——
 * 禁用状态独立成文件不污染既有 schema，D2 证据行）。三个事实归它承载：
 * - 写入口 = recordDisabled（呈现半边的「[禁用并重试]」动作经主进程 IPC 到达，归
 *   u-m2 波次接线；本模块只交机制）；
 * - 消费口 = PluginRegistry.scan 跳过被禁插件（扫描侧读本文件，见 plugin-registry.ts）；
 * - 生命周期 = 卸载时同步清除该 pluginId 条目——与卸载清 installed.json 登记对称
 *   （uninstallPlugin → recordUninstalled 先例，D2：「禁用 → 卸载 → 重装同 id」路径上
 *   重装即正常装载，不被旧标记静默挫败）。清除挂在本类的 recordUninstalled 单点：
 *   卸载链路（plugin-service.ts）无需第二处调用。
 * 残留条目（插件已不在盘）对扫描无效果——扫描对象是插件目录，无目录即无装载候选
 * （D2）；重新启用 = clearDisabled（插件管理页动作，呈现归 u-m2）。
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWriteAsync } from '../../utils/fs-utils.js'

/** 单个插件的安装登记条目。schema 冻结：只含 installedAt（ISO 时间串）。 */
export interface InstalledPluginEntry { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  installedAt: string
}

export type InstalledPluginsFile = Record<string, InstalledPluginEntry>

/** 单个插件的禁用标记条目（U7/D2：pluginId + 禁用原因 + 时间）。 */
export interface DisabledPluginEntry { // oe-exempt:20261031:framework:禁用标记清单条目——契约类型先行、单实现常态（与 InstalledPluginEntry 同族）
  /** 禁用原因（装载失败的错误摘要；呈现半边 failed 屏同文案归 u-m2）。 */
  reason: string
  /** 禁用时刻（ISO 时间串）。 */
  disabledAt: string
}

export type DisabledPluginsFile = Record<string, DisabledPluginEntry>

// ── 写读共享原语（branch-review dmg-r1-3 单源收敛）─────────────────────────

/** 禁用条目形状谓词：非对象 / 缺 reason / 缺 disabledAt → false（条目级容错判据单源）。 */
function isDisabledEntryShape(value: unknown): value is DisabledPluginEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as { reason?: unknown; disabledAt?: unknown }
  return typeof entry.reason === 'string' && typeof entry.disabledAt === 'string'
}

/** disabled.json 原文解析结果：entries 恒有值（失败时为空表）；failure 标记失败种类供调用方 fail-visible。 */
export interface DisabledFileParseResult {
  entries: DisabledPluginsFile
  /** 解析失败种类；undefined = 解析成功。'shape' = 顶层非对象（含数组/null）；'parse' = JSON 损坏。 */
  failure?: 'shape' | 'parse'
  /** 'parse' 失败的原始错误（warn 附带用）。 */
  detail?: unknown
}

/**
 * disabled.json 原文解析（写读两侧共用单源）：文件级容错（JSON 损坏 / 顶层非对象 →
 * 空表）+ 条目级容错（形状不合丢弃该条，不连坐其余条目）。文件读取失败（缺失/权限）
 * 不进本函数——两侧同语义静默空表（合法态）。warn 策略（日志前缀 / 是否去重）归
 * 调用方：写侧 loadDisabled 每次留痕，读侧 loadDisabledIds 实例生命周期去重。
 */
export function parseDisabledFile(raw: string): DisabledFileParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { entries: {}, failure: 'parse', detail: err }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { entries: {}, failure: 'shape' }
  }
  const entries: DisabledPluginsFile = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isDisabledEntryShape(value)) entries[key] = { reason: value.reason, disabledAt: value.disabledAt }
  }
  return { entries }
}

// ── 登记写链串行化（branch-review dmg-r1-4）────────────────────────────────

/**
 * 登记写链（模块级 promise 链）：全部「读改写」写点（recordDisabled / clearDisabled /
 * recordUninstalled）经同一链排队——前一写点完成后才进下一写点的 load→改→write，
 * 封住 recordUninstalled 双文件四步写 await 交错窗口内并发写点的覆盖丢失。模块级
 * （非实例级）使跨实例指向同目录的写点同样串行。链只保序不吞错：任务失败照常上抛
 * 调用方（既有 catch 呈报语义不变），且不阻断后续排队写点。
 */
let storeWriteChain: Promise<unknown> = Promise.resolve()

function enqueueStoreWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = storeWriteChain.then(task, task)
  storeWriteChain = run.catch(() => {})
  return run
}

const INSTALLED_FILE = 'installed.json'
/** disabled.json 文件名（路径公式单源，branch-review dmg-r1-3 收敛）：InstalledStore 写侧
 *  与 PluginRegistry 读侧（loadDisabledIds）均 import 本常量拼装同一文件路径；
 *  plugin-disabled-registry.test.ts 对账测试保留为写读两半回归锁。 */
export const DISABLED_FILE = 'disabled.json'
/** 登记文件序列化缩进（人读 diff 友好；纯展示选择非逻辑参数） */
const JSON_INDENT = 2

export class InstalledStore {
  private readonly filePath: string
  private readonly disabledFilePath: string

  /** @param pluginsDir 插件安装根目录（与 NpmPluginInstaller 同一注入值）。 */
  constructor(pluginsDir: string) {
    this.filePath = join(pluginsDir, INSTALLED_FILE)
    this.disabledFilePath = join(pluginsDir, DISABLED_FILE)
  }

  /** installed.json 绝对路径（测试断言用）。 */
  get path(): string {
    return this.filePath
  }

  /** disabled.json 绝对路径（测试断言用；registry 读侧直接 import DISABLED_FILE 拼装同一路径公式——单源见常量注释）。 */
  get disabledPath(): string {
    return this.disabledFilePath
  }

  /** 读全部登记；文件缺失或 JSON 损坏 → 空表（warn 留痕，不抛）。 */
  async load(): Promise<InstalledPluginsFile> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf-8')
    } catch {
      return {}
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn(`[installed-store] ${INSTALLED_FILE} has unexpected shape, treating as empty`)
        return {}
      }
      const result: InstalledPluginsFile = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const installedAt =
          typeof value === 'object' && value !== null && typeof (value as { installedAt?: unknown }).installedAt === 'string'
            ? (value as { installedAt: string }).installedAt
            : undefined
        // 条目形状不合（缺 installedAt / 非对象）按损坏丢弃该条，不影响其余条目
        if (installedAt !== undefined) result[key] = { installedAt }
      }
      return result
    } catch (err) {
      console.warn(`[installed-store] failed to parse ${INSTALLED_FILE}, treating as empty:`, err)
      return {}
    }
  }

  /** 读禁用标记清单；容错语义与 load 对称（缺失/损坏 → 空表，warn 留痕不抛）。
   *  解析容错经 parseDisabledFile 单源（plugin-registry 读侧共用，dmg-r1-3）。 */
  async loadDisabled(): Promise<DisabledPluginsFile> {
    let raw: string
    try {
      raw = await readFile(this.disabledFilePath, 'utf-8')
    } catch {
      return {}
    }
    const { entries, failure, detail } = parseDisabledFile(raw)
    if (failure === 'shape') {
      console.warn(`[installed-store] ${DISABLED_FILE} has unexpected shape, treating as empty`)
    } else if (failure === 'parse') {
      console.warn(`[installed-store] failed to parse ${DISABLED_FILE}, treating as empty:`, detail)
    }
    return entries
  }

  /** 登记安装时间（installedAt = 当前时刻 ISO 串）。幂等覆盖。 */
  async recordInstalled(pluginId: string, installedAt: string = new Date().toISOString()): Promise<void> {
    const all = await this.load()
    all[pluginId] = { installedAt }
    await this.write(this.filePath, all)
  }

  /**
   * 写禁用标记（U7/D2：「[禁用并重试]」动作的落盘半边；disabledAt 缺省当前时刻）。
   * 幂等覆盖（重复禁用刷新原因与时间）。经登记写链排队（dmg-r1-4）。
   */
  recordDisabled(pluginId: string, reason: string, disabledAt: string = new Date().toISOString()): Promise<void> {
    return enqueueStoreWrite(async () => {
      const all = await this.loadDisabled()
      all[pluginId] = { reason, disabledAt }
      await this.write(this.disabledFilePath, all)
    })
  }

  /** 清除禁用标记（插件管理页「重新启用」动作的落盘半边）。条目不存在时 no-op。经登记写链排队（dmg-r1-4）。 */
  clearDisabled(pluginId: string): Promise<void> {
    return enqueueStoreWrite(async () => {
      const all = await this.loadDisabled()
      if (!(pluginId in all)) return
      delete all[pluginId]
      await this.write(this.disabledFilePath, all)
    })
  }

  /**
   * 移除登记（卸载编排收尾）。条目不存在时 no-op。
   *
   * [U7/D2] 同步清除该 pluginId 的禁用标记条目——与卸载清 installed.json 登记对称
   * 的单点实装（卸载链路 recordUninstalled 调用即同时清两份登记；「禁用 → 卸载 →
   * 重装同 id」路径上重装即正常装载）。清除失败不吞：与登记写失败同路上抛，由
   * 卸载调用方 catch 呈报（既有 recordUninstalled 的 catch 形态不变）。双文件
   * 四步写整体经登记写链排队（dmg-r1-4）——四步的 await 交错窗口不再暴露给
   * 并发写点，无覆盖丢失。
   */
  recordUninstalled(pluginId: string): Promise<void> {
    return enqueueStoreWrite(async () => {
      const all = await this.load()
      if (pluginId in all) {
        delete all[pluginId]
        await this.write(this.filePath, all)
      }
      const disabled = await this.loadDisabled()
      if (pluginId in disabled) {
        delete disabled[pluginId]
        await this.write(this.disabledFilePath, disabled)
      }
    })
  }

  private async write(filePath: string, all: InstalledPluginsFile | DisabledPluginsFile): Promise<void> {
    // pluginsDir 可能尚不存在（首次登记先于任何安装落盘的调用形态），写入原语
    // 不自建父目录——先确保目录在（fail-safe：登记写失败由调用方 catch 呈报）
    await mkdir(dirname(filePath), { recursive: true })
    await atomicWriteAsync(filePath, JSON.stringify(all, null, JSON_INDENT))
  }
}
