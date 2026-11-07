/**
 * provider 域落盘文件路径纯公式模块（零 env 读写、零进程假设、零 fs、零 node 内置
 * import——路径拼接用下方 joinPath 纯函数自实现；C-state-05：shared 是浏览器/runtime
 * 共享层，node:path 在浏览器被 vite externalize 成空对象，import 即运行时崩，W1a 同因）。
 *
 * 两个跨进程文件路径公式的唯一权威源（runtime 写侧 ↔ pi 子树读侧同源消费，
 * 参照 session-store-paths 先例）：
 *   - providers.json：`<agentDir>/config/providers.json`——taiji 扩展域配置
 *     （provider 级 quota/authMethod、modelStates、routes/scopedModels，pi 引擎零
 *     消费）。写侧 = runtime ProviderExtrasStore（经 pi-paths.getProviderExtrasPath
 *     消费本公式）；读侧 = provider-aggregation 扩展 config-store 与 subagent-core
 *     scoped-models。
 *   - quota-cache.json：`<dataDir>/quota-cache.json`——额度查询缓存。写侧 = runtime
 *     QuotaCache；读侧 = provider-aggregation 扩展 quota-cache-reader。
 *
 * 为什么必须是纯模块（C-ext-31 同款约束）：pi 子树（extensions/、subagent-core）
 * 禁止 import '@taiji/shared/paths'（其 getDataDir 族内置 prod 数据目录值准入检查，
 * 打包态 pi 进程内必抛，check-pi-subtree-shared-imports.mjs 源码级拦截）。两类读侧
 * 进程与写侧进程互不可 import，路径公式若各自手抄就只能靠注释互指维护——历史上
 * 曾四处各自维护（providers.json 两侧 + quota-cache.json 两侧），一致性无任何机器
 * 信号，任一侧漂移即扩展静默读 absent、路由配置/额度快照静默失效。收敛到本模块
 * 后「同一函数」即一致性本体：两侧各传自己的基目录，公式漂移在结构上不可能。
 *
 * 本模块注释严禁逐字抄写 pi env 准入检查标记（bundler 保留注释时抄写即让合法
 * bundle 被误拦，标记清单见 scripts/lib/pi-env-admission-gate.mjs——
 * session-store-paths.ts 头注释同款红线）。
 *
 * 基目录来源（每进程自解析，不归本模块）：
 *   - runtime：getPiAgentDir() / getDataDir()（'@taiji/shared/paths'）
 *   - pi 子树：pi 官方 getAgentDir()（尊重 PI_CODING_AGENT_DIR；taiji 托管形态下
 *     runtime spawn 注入值即 `<dataDir>/agent`，quota-cache 侧基址取其 dirname，
 *     两侧同基址由 spawn env 契约保证）
 */
/** providers.json 文件名（taiji 扩展域配置，pi 引擎零消费）。 */
export const PROVIDERS_EXTRAS_FILENAME = 'providers.json'

/**
 * 零依赖路径拼接——node:path.join 在本模块输入域内的等价纯计算（shared 禁 node
 * 内置 import，见文件头）。
 *
 * 分隔符按基址内已有分隔符形态选择：win32 基址（盘符路径）必含 `\`，POSIX 基址
 * （homedir()/getDataDir()/getAgentDir() 族产出的系统目录）不含——POSIX 基址 → `/`
 * 拼接，win32 基址 → `\` 拼接，与 node:path.join 在两侧平台的标准输入下等值；基址
 * 已以分隔符收尾时不重复补。node:path.join 的 `..`/`.` 段解析在本模块无适用场景
 * （段全为字面常量）。入参须为非空目录基址（各公式函数的既有契约）。
 */
function joinPath(base: string, ...segments: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/'
  const head = base.endsWith('/') || base.endsWith('\\') ? base : base + sep
  return head + segments.join(sep)
}

/**
 * providers.json 绝对路径：`<agentDir>/config/providers.json`。
 *
 * @param agentDir pi agent 目录（runtime 传 getPiAgentDir()，pi 子树传官方
 *   getAgentDir()，托管形态下两者同值）
 */
export function getProviderExtrasPath(agentDir: string): string {
  return joinPath(agentDir, 'config', PROVIDERS_EXTRAS_FILENAME)
}

/** quota-cache.json 文件名（额度查询缓存，写侧 runtime QuotaCache 原子写）。 */
export const QUOTA_CACHE_FILENAME = 'quota-cache.json'

/**
 * quota-cache.json 绝对路径：`<dataDir>/quota-cache.json`。
 *
 * @param dataDir taiji 数据根目录（runtime 传 getDataDir()；pi 子树传
 *   dirname(getAgentDir())——托管形态 agentDir = `<dataDir>/agent`）
 */
export function getQuotaCachePath(dataDir: string): string {
  return joinPath(dataDir, QUOTA_CACHE_FILENAME)
}
