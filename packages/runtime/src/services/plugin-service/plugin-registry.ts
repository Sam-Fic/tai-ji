import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { TaijiPackageJson, PluginDescriptor, PluginState, PluginContributes, PluginSource, TaijiManifest } from './plugin-types.js'
import { checkPluginCompatibility } from './plugin-version-checker.js'

/**
 * 插件注册中心：扫描本地插件目录，解析 package.json 中的 taijiPlugin manifest，
 * 产成 PluginDescriptor 缓存在内存。
 *
 * 扫描目录优先级：
 *   1. <configDir>/plugins/        （全局插件，configDir 由组合根注入）
 *   2. <projectRoot>/.taiji/plugins/  （项目级插件）
 *   3. built-in 目录（resolveBuiltinPluginsDir：--builtin-plugins-dir 显式注入优先，
 *      缺失时回退多形态候选探测，见其注释）
 *
 * ── 禁用标记跳过（startup-readiness §7.5 / D2 / U7 机制半边）──────────────────
 *
 * `<pluginsDir>/disabled.json`（InstalledStore 同目录维护，条目 = pluginId + reason +
 * disabledAt）命中的插件在 scan 时整体跳过（不出现在 descriptor 列表 = 不装载、不
 * 激活）。判定按 pluginId（目录名），对全部三个扫描目录生效。清单读取失败按空表
 * 容错（禁用机制故障不阻断正常装载）；条目残留（插件已不在盘）自然无效果——扫描
 * 对象是插件目录，无目录即无装载候选（D2）。
 *
 * ── [V8] 插件装载错误分类边界（startup-readiness D2 / §7.5，枚举记录在案）──────
 *
 * 装载链（pluginService.initialize → bootstrapPluginService 9 步 → scan → 激活）的
 * 错误来源按「确定性 vs 环境性」分类（D2 采用段：确定性 → 阻断（u-m2 呈现 failed
 * 屏）；环境性 → 不阻断、按现状重试语义）：
 *
 * 确定性错误（代码/声明缺陷，重试必然复现 → 阻断语义）：
 *   R1 manifest 非法——package.json JSON 解析失败（parseManifest catch 分支）；
 *   R2 manifest 缺失/版本不符——无 taijiPlugin 段或 manifestVersion !== 1；
 *   R3 入口越权——manifest.main 解析到插件目录外（resolveEntry 逃逸拒绝）；
 *   R4 engines 不兼容——taiji engine range 不含当前版本（DEPS_MISSING descriptor）；
 *   R5 依赖缺失——激活期 import 失败 / worker 加载抛错（plugin-bootstrap load 链）；
 *   R6 激活抛错——onStartupFinished / 激活事件 handler 抛错（activator 链）。
 *
 * 环境性错误（外部条件瞬态，重试可恢复 → 不阻断、按现状重试语义）：
 *   E1 网络拉取失败——安装/更新通道（pluginInstaller npm 拉取）失败；不属装载链
 *   （装载读的是已落盘目录），永不该由装载阻断兜底。
 *
 * 边界注记：scan 侧的目录不可读（readdir/stat 失败）是本地 IO 形态，现状按跳过 +
 * warn 容错（本文件既有语义），不进确定性分类——「目录级缺席」与「插件级坏」是
 * 两个失败面，前者不指名插件、无法进 failed 屏。分类判定的消费（business 能力判据
 * + failed 屏 + [禁用并重试]）归 u-m2 呈现半边（M2-5）；本单元交付机制半边（禁用
 * 标记 + 扫描跳过 + 卸载清理）。
 */
export class PluginRegistry {
  private cache = new Map<string, PluginDescriptor>()
  private projectRoot: string
  private pluginsConfigDir: string
  private builtinPluginsDir: string | undefined
  /** [U7] 禁用清单读取的 warn 去重（读失败每轮 scan 一次即可，不刷屏）。 */
  private warnedDisabledRead = false

  /** @param projectRoot 项目根（项目级插件扫描用）
   *  @param pluginsConfigDir 全局配置根（~/.taiji/，全局插件扫描用），由组合根注入。
   *  @param builtinPluginsDir 显式 built-in 插件目录（S1-W4/D3：Electron 主进程经
   *    --builtin-plugins-dir 注入的绝对路径）。提供时 built-in 扫描只用该目录，
   *    不做 cwd 探测（防用户 repo 预置同名目录冒充 built-in 插件，供应链攻击面）；
   *    缺失时回退旧探测链（dev 直跑/测试无主进程场景兼容）并落 warning。 */
  constructor(projectRoot: string, pluginsConfigDir: string, builtinPluginsDir?: string) {
    this.projectRoot = projectRoot
    this.pluginsConfigDir = pluginsConfigDir
    this.builtinPluginsDir = builtinPluginsDir
  }

  async scan(): Promise<PluginDescriptor[]> {
    const dirs: Array<{ path: string; source: PluginSource }> = [
      { path: join(this.pluginsConfigDir, 'plugins'), source: 'external' },
      { path: join(this.projectRoot, '.taiji', 'plugins'), source: 'external' },
      { path: await this.resolveBuiltinPluginsDir(), source: 'built-in' },
    ]
    // [U7/D2] 禁用标记清单（<pluginsConfigDir>/plugins/disabled.json，InstalledStore
    // 同目录同 schema 族）：命中 pluginId 的目录整体跳过。读取失败按空表容错
    // （fail-open——禁用机制自身故障不阻断正常装载，warn 留痕）。
    const disabled = await this.loadDisabledIds()
    if (disabled.size > 0) {
      console.info(`[plugin-registry] skipping ${disabled.size} disabled plugin(s): ${[...disabled].join(', ')}`)
    }
    const results: PluginDescriptor[] = []
    for (const { path: dir, source } of dirs) {
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch {
        // 目录不存在 → 跳过（首次运行时 ~/.taiji/plugins/ 可能尚未创建）
        continue
      }
      for (const entry of entries) {
        // 辅助目录跳过：安装暂存区（.staging）等 dot 条目不是插件（scoped 包目录名
        // 解耦后安装目录为 scope__pkg 一级形态，扫描口径与安装目录名对齐——U4）
        if (entry.startsWith('.')) continue
        if (disabled.has(entry)) continue // [U7] 禁用标记跳过（装载阻断链路的重试半边）
        const fullPath = join(dir, entry)
        try {
          const st = await stat(fullPath)
          if (!st.isDirectory()) continue
        } catch {
          console.warn(`[plugin-registry] cannot stat ${fullPath}, skipping`)
          continue
        }
        const descriptor = await this.parsePlugin(entry, fullPath, source)
        if (descriptor) results.push(descriptor)
      }
    }
    this.cacheDescriptors(results)
    return results
  }

  /**
   * [U7/D2] 读禁用标记清单的 pluginId 集（scan 跳过判定面）。
   *
   * 直接读文件而不 import InstalledStore 类：InstalledStore 是登记写入域的类（含
   * atomicWrite 依赖链），扫描侧只需要读半边；条目 schema 由 installed-store 侧
   * DisabledPluginEntry 形状单源定义（本读侧消费 pluginId 键 + 条目形状校验）。文件路径公式
   * （join(pluginsConfigDir, 'plugins', 'disabled.json')）与 installed-store 的
   * DISABLED_FILE 常量（模块私有未导出）是两份独立实装——改名需双侧同步，
   * plugin-disabled-registry.test.ts 同时测写半边（InstalledStore）与读半边
   * （本类 scan）兜底；读侧解析容错与 InstalledStore.loadDisabled 全同语义
   * （文件级：损坏/非对象 → 空表 + warn；条目级：形状不合丢弃该条不连坐——
   * 读侧禁用集与写侧读写视图一致，clearDisabled 的「重新启用」通道对
   * 形状不合条目同样闭合，不产生 scan 认 / enable 不认的缝隙）。
   */
  private async loadDisabledIds(): Promise<Set<string>> {
    const disabledPath = join(this.pluginsConfigDir, 'plugins', 'disabled.json')
    let raw: string
    try {
      raw = await readFile(disabledPath, 'utf-8')
    } catch {
      return new Set() // 文件缺失 = 无禁用插件（常态）
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        if (!this.warnedDisabledRead) {
          this.warnedDisabledRead = true
          console.warn(`[plugin-registry] disabled.json has unexpected shape, treating as empty`)
        }
        return new Set()
      }
      // 条目形状校验与 InstalledStore.loadDisabled 同款（逐条，不连坐）：非对象 /
      // 缺 reason / 缺 disabledAt 的条目按损坏丢弃该键——禁用集只含两视图共识条目。
      const ids = new Set<string>()
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { reason?: unknown }).reason === 'string' &&
          typeof (value as { disabledAt?: unknown }).disabledAt === 'string'
        ) {
          ids.add(key)
        }
      }
      return ids
    } catch (err) {
      if (!this.warnedDisabledRead) {
        this.warnedDisabledRead = true
        console.warn(`[plugin-registry] failed to parse disabled.json, treating as empty:`, err)
      }
      return new Set()
    }
  }

  /**
   * 解析 built-in 插件目录（resources/plugins/）。
   *
   * S1-W4（D3）起优先级两级：
   *
   *   1. 显式注入（this.builtinPluginsDir，来自 --builtin-plugins-dir）——唯一权威来源。
   *      提供时直接使用，绝不再做 cwd 探测（探测链可被用户 repo 内预置的
   *      resources/plugins 目录劫持，冒充 built-in 插件获得 trusted 权限）。
   *      目录不存在时同样不回退到探测（scan() 的 readdir 失败分支按既有语义跳过），
   *      避免「显式路径缺失 → 捡到 cwd 里攻击者目录」的降级路径。
   *   2. 回退：cwd 多运行形态候选探测（dev 直跑 / vitest / e2e 脚本起 runtime
   *      无主进程传参的场景兼容）。使用回退时每次落 warning（fail-visible——
   *      生产主进程总是显式传参，看到此日志即说明 built-in 目录回到了
   *      可被 cwd 影响的探测路径）。
   *
   * 回退候选（projectRoot = runtime cwd，组合根 effectiveRoot）：
   *
   *   候选 1  <projectRoot>/resources/plugins
   *     - 打包形态：cwd=Resources/，electron-builder extraResources 拷贝目标即
   *       Resources/resources/plugins（electron-builder.yml `to: resources/plugins`）
   *     - cwd=仓库根：隔离 tsx 直跑（verify-plugin-e2e.sh）/ 本地 dist 运行
   *   候选 2  <projectRoot>/../../resources/plugins
   *     - pnpm dev：runtime cwd=apps/electron，仓库根在其上两层（与
   *       extension-resolver.scanBundledExtensions 的 ../.. 推导同构）
   *
   * [HISTORICAL] dev 缺口（F4 修复）：dev 下 cwd=apps/electron，旧实现只扫
   * <projectRoot>/resources/plugins（不存在）→ built-in 插件在 dev 从不被发现。候选探测同时覆盖「cwd=仓库根」与「cwd=apps/electron」两种 dev 形态，
   * 不依赖 isPackaged env（两打包形态均由候选 1 命中）。
   *
   * 全部候选缺失（如全新 checkout 未跑 prepare-builtin-plugins.sh）时返回候选 1，
   * 让 scan() 的 readdir 失败分支按既有语义静默跳过。
   */
  private async resolveBuiltinPluginsDir(): Promise<string> {
    if (this.builtinPluginsDir) return this.builtinPluginsDir

    console.warn(
      '[plugin-registry] --builtin-plugins-dir not provided; falling back to cwd-based probing for built-in plugins dir (host process should always inject it explicitly)',
    )
    const candidates = [
      join(this.projectRoot, 'resources', 'plugins'),
      resolve(this.projectRoot, '..', '..', 'resources', 'plugins'),
    ]
    for (const dir of candidates) {
      try {
        if ((await stat(dir)).isDirectory()) return dir
      } catch {
        // 候选不存在 → 试下一个
        continue
      }
    }
    return candidates[0]
  }

  cacheDescriptors(descriptors: PluginDescriptor[]): void {
    for (const d of descriptors) this.cache.set(d.pluginId, d)
  }

  getDescriptor(pluginId: string): PluginDescriptor | undefined {
    return this.cache.get(pluginId)
  }

  getAllDescriptors(): PluginDescriptor[] {
    return [...this.cache.values()]
  }

  /** Remove a descriptor from the cache (used during uninstall) */
  removeDescriptor(pluginId: string): boolean {
    return this.cache.delete(pluginId)
  }

  async reload(): Promise<PluginDescriptor[]> {
    this.cache.clear()
    return this.scan()
  }

  private async parsePlugin(dirName: string, fullPath: string, source: PluginSource): Promise<PluginDescriptor | null> {
    const pkgPath = join(fullPath, 'package.json')
    const raw = await this.readPkgRaw(pkgPath)
    if (raw === null) return null

    const pkg = this.parseManifest(raw, pkgPath, dirName)
    if (pkg === null) return null

    const manifest = pkg.taijiPlugin
    const activationEvents = this.inferActivationEvents(manifest.activationEvents ?? [], manifest.contributes)

    // 注意：descriptor.engines 存原始 engineRange（非 string 时原样落盘 ?? '*' 兜底），
    // 而 compat 校验只接受 string 形态（非 string 回落 '*'）——两值语义不同，不可合并。
    const engineRange = pkg.engines?.['taiji'] ?? '*'
    const compat = checkPluginCompatibility(typeof engineRange === 'string' ? engineRange : '*')

    const entry = this.resolveEntry(fullPath, manifest.main, dirName)
    if (entry === null) return null

    const trustLevel = this.resolveTrustLevel(source, manifest, dirName)

    const descriptor = this.buildDescriptor({
      dirName,
      pkg,
      manifest,
      main: entry.main,
      activationEvents,
      trustLevel,
      engineRange,
      entryPath: entry.entryPath,
      source,
      compatCompatible: compat.compatible,
      compatibilityReason: compat.reason,
    })

    if (!compat.compatible) {
      console.warn(`[plugin-registry] ${dirName}: ${compat.reason}`)
    }

    return descriptor
  }

  /** 读取插件 package.json 原文；不可读（缺失/权限）→ null（静默跳过，既有语义） */
  private async readPkgRaw(pkgPath: string): Promise<string | null> {
    try {
      return await readFile(pkgPath, 'utf-8')
    } catch {
      return null
    }
  }

  /** JSON 解析 + manifest 有效性校验；任一失败落 warning 并返回 null（跳过该插件） */
  private parseManifest(raw: string, pkgPath: string, dirName: string): TaijiPackageJson | null {
    let pkg: TaijiPackageJson
    try {
      pkg = JSON.parse(raw)
    } catch {
      console.warn(`[plugin-registry] invalid JSON in ${pkgPath}, skipping`)
      return null
    }

    if (!pkg.taijiPlugin || pkg.taijiPlugin.manifestVersion !== 1) {
      console.warn(`[plugin-registry] ${dirName}: missing or invalid taijiPlugin manifest, skipping`)
      return null
    }

    return pkg
  }

  /**
   * 入口文件路径解析：manifest.main 缺省 index.js（向后兼容）。
   * pluginPath 必须指向具体入口文件而非插件目录——plugin-bootstrap 的 load 分支
   * 直接 `import(pluginPath)`，ESM 禁止目录导入（ERR_UNSUPPORTED_DIR_IMPORT），
   * 存目录会导致所有插件激活必炸（built-in 插件目录曾有此形态事故）。
   *
   * 入口检查：main 必须解析到插件目录内（拒绝 ../ 逃逸与绝对路径），
   * 防止插件声明越权入口 import 插件目录外的任意文件。越权 → warning + null。
   */
  private resolveEntry(
    fullPath: string,
    manifestMain: string | undefined,
    dirName: string,
  ): { main: string; entryPath: string } | null {
    const main = manifestMain ?? 'index.js'
    const entryPath = resolve(fullPath, main)
    if (entryPath !== fullPath && !entryPath.startsWith(fullPath + sep)) {
      console.warn(`[plugin-registry] ${dirName}: main "${main}" escapes plugin directory, skipping`)
      return null
    }
    return { main, entryPath }
  }

  /**
   * S1-W4（D3）：信任级判定权归宿主，manifest 声明不参与判定——
   *   external（用户安装）一律 sandbox（进程沙箱隔离 + 权限审批照走）；
   *   built-in（随应用分发）一律 trusted。
   * external 声明非 sandbox 的 trustLevel 被忽略时落 warning（fail-visible，
   * 含插件 id 与被忽略的声明值）；声明值与强制值一致（sandbox/缺省）时无需提示。
   */
  private resolveTrustLevel(source: PluginSource, manifest: TaijiManifest, dirName: string): 'trusted' | 'sandbox' {
    if (source === 'built-in') {
      return 'trusted'
    }
    if (manifest.trustLevel && manifest.trustLevel !== 'sandbox') {
      console.warn(
        `[plugin-registry] ${dirName}: external plugin manifest declares trustLevel "${manifest.trustLevel}" — ignored and forced to 'sandbox' (trust level is host-decided by plugin source)`,
      )
    }
    return 'sandbox'
  }

  /** descriptor 装配（纯组装，无 I/O）：缺省字段兜底与兼容性状态在此落定 */
  private buildDescriptor(args: {
    dirName: string
    pkg: TaijiPackageJson
    manifest: TaijiManifest
    main: string
    activationEvents: string[]
    trustLevel: 'trusted' | 'sandbox'
    engineRange: string | undefined
    entryPath: string
    source: PluginSource
    compatCompatible: boolean
    compatibilityReason: string | undefined
  }): PluginDescriptor {
    const { dirName, pkg, manifest, main, activationEvents, trustLevel, engineRange, entryPath, source, compatCompatible, compatibilityReason } = args
    const descriptor: PluginDescriptor = {
      pluginId: dirName,
      version: pkg.version ?? '0.0.0',
      displayName: pkg.displayName ?? pkg.name ?? dirName,
      description: pkg.description ?? '',
      main,
      activationEvents,
      trustLevel,
      status: compatCompatible ? ('UNLOADED' as PluginState) : ('DEPS_MISSING' as PluginState),
      contributes: manifest.contributes ?? {} as PluginContributes,
      permissions: manifest.permissions ?? [],
      // D3 宿主接线数据源：manifest 能力声明透传 descriptor（激活链据此登记 fork
      // 放行清单）；scan 是 descriptor 唯一装配点，重扫即刷新（热重载/重装取新值）
      capabilities: manifest.capabilities ?? [],
      readPaths: manifest.readPaths,
      // S15② 本地已装条目回退的数据源（包名与命名空间声明透传，D4——安装期已做
      // 绑定校验，声明值即生效值）：与 capabilities 同点装配，scan 唯一装配点
      packageName: pkg.name,
      ...(manifest.namespace !== undefined ? { namespace: manifest.namespace } : {}),
      engines: { 'taiji': engineRange ?? '*' },
      pluginPath: entryPath,
      // npm 包名透传（ns 推导唯一事实源，providers.* 命名空间边界消费——与 capabilities
      // 同链：scan 是 descriptor 唯一装配点，重扫即刷新；畸形包缺 name 时为 undefined，
      // 消费方窄化判定）
      pkgName: pkg.name,
      source,
      extensionDependencies: manifest.extensionDependencies ?? [],
      ...(compatCompatible ? {} : { compatibilityError: compatibilityReason }),
    }
    return descriptor
  }

  /**
   * 从 contributes.slashCommands 推断隐式 activationEvent，
   * 避免插件开发者手动声明每个命令对应的 onSlashCommand:xxx。
   */
  private inferActivationEvents(
    declared: string[],
    contributes?: PluginContributes,
  ): string[] {
    const events = [...declared]
    if (contributes?.slashCommands) {
      for (const cmd of contributes.slashCommands) {
        const event = `onSlashCommand:${cmd.name}`
        if (!events.includes(event)) events.push(event)
      }
    }
    if (contributes?.tools) {
      for (const tool of contributes.tools) {
        const event = `onToolCall:${tool.name}`
        if (!events.includes(event)) events.push(event)
      }
    }
    if (contributes?.hooks) {
      for (const hook of contributes.hooks) {
        if (!events.includes(hook)) events.push(hook)
      }
    }
    // Phase 1 不为 panels 推断 activation events（无对应事件类型）
    // panels 的激活由 Phase 3+ 的 UI 扩展机制处理
    return events
  }
}
