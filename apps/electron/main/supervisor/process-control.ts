/**
 * 进程生命周期控制（spawn / kill 进程树）。
 *
 * 对应 spec §4.2 M2 子职责「进程生命周期」+「stop 时序」。
 * 这是 supervisor 内部最危险的块——P3 已深化，含完整时序图。
 *
 * [HISTORICAL] 不变量（违反必出 bug）：
 *
 * 1. spawn 方式分两种：
 *    - 打包模式：process.execPath + ELECTRON_RUN_AS_NODE=1 运行 app.asar.unpacked/dist/runtime/index.cjs
 *    - 开发模式：node + tsx 运行 runtime/src/index.ts
 *    - cwd：打包后用 process.resourcesPath（app.getAppPath 返回 asar 虚拟路径，不能用）
 *
 * 2. ENV 注入（buildSafeEnv）：
 *    - ELECTRON_RUN_AS_NODE=1 仅打包模式
 *    - TAIJI_AGENT_PACKAGED / TAIJI_AGENT_DATA_DIR / TAIJI_AGENT_PORT_OFFSET 必须透传（实例隔离）
 *
 * 3. **stop() 时序（跨进程树）**：
 *    ```
 *    T0: 记录 descendantPids（必须在发信号前——runtime 退出后 pi 的 PPID 变为 1，pgrep -P 查不到）
 *    T1: child.kill('SIGTERM')
 *    T2: 立即 SIGKILL 整棵进程树（倒序：孙→子→根，无等待窗）
 *    T3: 等 child 'exit' 事件（进程死亡的权威信号）→ flush stderr sink → resolve
 *    ```
 *
 * 4. 进程树 kill 顺序：先杀后代（倒序：孙→子），再杀根。
 *
 * 5. Windows 用 taskkill /PID /T /F 原子终止整棵进程树；Unix 保留上述信号时序。
 *
 * 依赖方向：process-control → node:child_process + safe-env + windows-process + electron(app)
 */
import { type ChildProcess, spawn, execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync, chmodSync, type WriteStream } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { app } from 'electron'
import { RUNTIME_ID_ENV } from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'
import { readMainLogMaxBytes } from '../logs/main-logger.js'
import { buildSafeEnv } from './safe-env.js'
import { terminateWindowsProcessTree } from './windows-process.js'
import { readRemoteAccessConfig } from '../remote-access/store.js'
import { resolveMobileDistEnv, resolveMobileDistPath, type MobileDistEnv } from '../remote-access/mobile-dist.js'

/**
 * 打包模式 runtime stderr 兜底写流（module 级单例，lazy 创建）。
 *
 * M5（perf-quick-batch）：打包禁用 stdout/stderr 的 console 转发后，runtime 内部
 * initLogger 只覆盖 runtime 进程启动后的 console.*。启动前（模块加载/早期 throw）
 * 与原生崩溃期的 stderr 不被 tee，会丢排查证据。此流只兜底 stderr（不动 stdout，
 * stdout 高吞吐且 initLogger 已覆盖），非阻塞 append 写到 dataDir/logs/。
 *
 * dev 模式不用（dev 保留 console 转发方便终端调试）。
 *
 * size 轮转（D6-⑦）：本文件是该固定名文件的唯一 writer，rename
 * 轮转**同进程安全**（对齐 runtime logger rotateMain 语义）。设计 v7 定案：固定名 +
 * writer 持有型 append fd 的文件**不做超龄清理**（unlink 后 fd 写入落孤儿 inode 静默
 * 丢失，恰在崩溃取证时刻失效），治理唯一归 writer 侧 size 轮转——见
 * rotateStderrSinkIfNeeded / writeStderrSink。
 */
let stderrSink: WriteStream | null = null
/** stderrSink 对应文件路径（轮转 rename 目标；创建成功才记录）。 */
let stderrSinkFile: string | null = null
/** 自本次打开以来写入 stderr 主文件的字节（size 轮转判定，对齐 runtime 字节计数法）。 */
let stderrSinkBytes = 0

function getStderrSink(): WriteStream | null {
  if (!app.isPackaged) return null
  if (stderrSink) return stderrSink
  const logsDir = path.join(getDataDir(), 'logs')
  const file = path.join(logsDir, 'electron-runtime-stderr.log')
  try {
    mkdirSync(logsDir, { recursive: true })
    // 打开前若既有文件已超帽（上次运行崩溃未轮转 / 历史大文件），先滚动一次——进程内
    // 字节计数不覆盖历史，此 stat 弥合跨重启的 size 上限（对齐 runtime openMainStream）。
    if (existsSync(file) && statSync(file).size > readMainLogMaxBytes()) {
      renameSync(file, `${file}.1`)
    }
    stderrSink = createWriteStream(file, { flags: 'a' })
    // 异步 open/write 失败必须有监听（无监听的 'error' 事件会升级为 uncaughtException）：
    // 流关闭等待删除裁决后 destroy 可落在 open 在途窗口，IO 失败经 'error' 事件消费
    // （首错留痕，后续静默防刷屏——对齐 main-logger attachStreamErrorHandler 模式）。
    // console.error 走进程 stderr，不经本 sink 自身（无递归风险）。
    let sinkErrorReported = false
    stderrSink.on('error', (err) => {
      if (sinkErrorReported) return
      sinkErrorReported = true
      console.error(
        `[runtime] stderr sink error for ${file}: ${err instanceof Error ? err.message : String(err)}`
        + ' — 后续同类错误静默，stderr 文件取证可能缺失',
      )
    })
    stderrSinkFile = file
  } catch (e) {
    stderrSink = null
    // 可观测性：建流失败（logs 目录不可写 / 只读卷 / 权限）时 runtime 原生崩溃期
    // stderr 文件取证通道整体失效，必须留痕。console.error 走进程 stderr 不依赖
    // 文件系统，无递归风险（对齐同文件其余失败路径的响亮日志形态）。
    console.error(
      `[runtime] stderr sink create failed for ${file}: ${e instanceof Error ? e.message : String(e)}`
      + ' — stderr 文件取证不可用，仅进程控制台可见',
    )
  }
  return stderrSink
}

/**
 * end stderr sink 并立即 destroy（时间机制删除裁决：流关闭等待删除——不等 'close'
 * 事件回执；stderr 仅排查证据，在途缓冲尾部丢失可接受）。destroy 同步释放 fd 与
 * 写入侧——rename 落在 fd 已释放之后，无「旧流在途写落进已改名 inode」的孤儿写入窗。
 */
function endAndDestroy(stream: WriteStream): void {
  if (stream.closed) return
  if (!stream.writableEnded) stream.end()
  stream.destroy()
}

/**
 * stderr sink size 轮转：destroy 旧流（写入侧同步封闭）→ rename `.1` → 下次写入经
 * getStderrSink 重建新流写**新文件**（append fd 重建发生在 rename 之后，
 * 不会写进已改名 inode）。
 */
function rotateStderrSink(): void {
  const old = stderrSink
  const file = stderrSinkFile
  if (!old || !file) return
  stderrSink = null
  stderrSinkBytes = 0
  endAndDestroy(old)
  try {
    renameSync(file, `${file}.1`)
  // eslint-disable-next-line taste/no-silent-catch -- rename 失败（IO 错/权限）：旧文件保持原名，新流 append 续写同名文件，数据不丢仅丢滚动（对齐 runtime rotateMain）
  } catch {
    // no-op
  }
}

/**
 * stderr 兜底写入唯一出口（spawnRuntimeProcess 的 stderr data handler 调用）。
 *
 * 写入前按字节计数预测超帽（对齐 runtime writeLogEntry 语义）：超帽 → 触发轮转，
 * 当前 chunk 计入下一轮。非打包（sink 不存在）no-op——调用方无须自行分流 dev/prod。
 */
function writeStderrSink(data: Buffer): void {
  if (stderrSinkFile && stderrSinkBytes + data.length > readMainLogMaxBytes()) {
    rotateStderrSink()
  }
  const sink = getStderrSink()
  if (!sink) return
  sink.write(data)
  stderrSinkBytes += data.length
}

/**
 * 显式 flush stderrSink（app quit 时调用）。
 *
 * 正常 stop 路径走 stopRuntimeProcess→done() 已 end()；但若 app 在 runtime 自然退出后
 * 通过 before-quit 直接 quit（未触发 stop 链，或 stop 链已 resolve 但 end 后又有新 spawn 写入），
 * sink 可能未 close。
 *
 * 时间机制删除裁决：流关闭等待删除——end + destroy 即返回，不等 'finish' 事件回执
 * （[HISTORICAL] 原实现 1s 内未 finish 也强制 resolve 的兜底窗随之退役）。底层 fs 卡住时
 * 不再阻断退出；stderr 仅排查证据，在途缓冲尾部丢失可接受。
 *
 * 幂等：done() 已 end() 后 stderrSink=null，再次调用为 no-op（直接 resolve）。
 *
 * @returns 立即 resolve 的 Promise（调用方 before-quit handler await 形态保持不变）。
 */
export function flushStderrSink(): Promise<void> {
  if (!stderrSink) return Promise.resolve()
  const sink = stderrSink
  stderrSink = null
  try {
    if (!sink.writableEnded) sink.end()
    sink.destroy()
  } catch (e) {
    // end/destroy 失败不阻断退出（stderr 仅排查证据），但必须留痕（禁止静默吞错）：
    // console.warn 走进程 stderr，不经本 sink 自身（无递归风险）
    console.warn(`[runtime] stderr sink flush failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return Promise.resolve()
}
/** tsup(CJS) runtime 入口文件名，须与 runtime/tsup.config.ts format 一致 */
export const RUNTIME_ENTRY_FILE = 'index.cjs'

/**
 * spawn 'error' 事件哨兵退出码（W5 改动 5）。
 *
 * [HISTORICAL] spawn 失败（命令不存在/权限不足等）不会产生真实退出码，
 * 用 -1 表示「spawn 失败」走与 exit 相同的清理路径（onExit(-1)）。
 * 真实进程退出码 >= 0，-1 不会与之冲突。
 */
export const SPAWN_ERROR_EXIT_CODE = -1

/**
 * spawn 结果：child 进程 + 本次生成的 WS auth token（S1-W1，spec §3.3 D4）。
 * token 双通道分发——env TAIJI_RUNTIME_TOKEN（runtime 自身 + renderer 经 IPC 读 supervisor）+
 * <dataDir>/runtime-token 文件（CLI / 脚本消费）。每次 spawn 重新生成（旧 token 随旧进程死亡）。
 * runtimeId（connection-datasync-ssot §6.1）：本次 spawn 的实例标识（randomBytes 8 字节 hex），
 * 与 token 同点签发、经 env TAIJI_RUNTIME_ID 注入 runtime（auth 成功应答回传，供连接
 * 控制器与目标快照核对「连的是谁」）。与 token 的职责分工：token 是鉴权凭据，runtimeId 是
 * 进程身份——凭据可热轮换，身份只在 spawn 时签发。
 */
export interface SpawnRuntimeResult {
  child: ChildProcess
  token: string
  runtimeId: string
}

/** runtime WS auth token 熵：32 字节 = 256 bit（hex 编码后 64 字符）。 */
const RUNTIME_TOKEN_BYTES = 32

/** runtime 实例标识熵：8 字节 = 64 bit（hex 编码后 16 字符），协议 RuntimeTargetSnapshot.runtimeId 约束。 */
const RUNTIME_ID_BYTES = 8

/**
 * runtime-token 文件权限：owner 读写（0600）。token 等同 WS 凭据，
 * 禁 group/other 读取，防同机其他用户窃取后直连 runtime。
 */
const RUNTIME_TOKEN_FILE_MODE = 0o600

/**
 * 生成新 token 并写入 <dataDir>/runtime-token（0600，mkdir -p 数据目录）。
 * writeFileSync 的 mode 仅创建时生效；chmodSync 兜底「文件已存在但被外部放宽权限」的场景
 * （重写不收紧既有文件权限是 writeFileSync 语义）。
 */
function issueRuntimeToken(): string {
  const token = randomBytes(RUNTIME_TOKEN_BYTES).toString('hex')
  const dataDir = getDataDir()
  mkdirSync(dataDir, { recursive: true })
  const tokenFile = path.join(dataDir, 'runtime-token')
  writeFileSync(tokenFile, token, { mode: RUNTIME_TOKEN_FILE_MODE })
  chmodSync(tokenFile, RUNTIME_TOKEN_FILE_MODE)
  return token
}

/**
 * 组装 remote-access 相关 runtime argv（remote-access D3/D9）。
 *
 * 开态（enabled=true）追加 `--remote-access` 与 `--mobile-dist=<main 按运行环境
 * 解析的绝对路径>`；关态返回空数组（不拼任何 flag，argv 数组形态与既有完全一致）
 * ——argv 是开启的唯一判据，不经 env 白名单继承链，ambient 免疫；非 supervisor
 * 直跑路径不传 flag 即天然关态。
 *
 * enabled 是窄参数（只消费开关位，不传整个 config）：配置读取归调用方——
 * spawnRuntimeProcess 在每次 spawn 时刻现读 readRemoteAccessConfig().enabled 传入
 * （toggle 落盘 → 重启生效正依赖每次 spawn 现读语义，禁止改为快照传入）。
 * 本函数因此是纯字符串拼参，无隐藏全局读。
 *
 * @param env 运行环境（isPackaged / resourcesPath / appPath），供 dist 路径 dev/prod 分支
 * @param enabled remote-access 开关状态（调用方 spawn 时刻现读配置）
 * @returns 追加到基础 argv 之后的参数数组（关态恒为空数组）
 */
export function buildRemoteAccessSpawnArgs(env: MobileDistEnv, enabled: boolean): string[] {
  if (!enabled) return []
  const mobileDist = resolveMobileDistPath(env)
  return ['--remote-access', `--mobile-dist=${mobileDist}`]
}

/**
 * 启动 runtime 子进程（按打包状态选 spawn 方式）。
 *
 * 打包：process.execPath + ELECTRON_RUN_AS_NODE=1 运行 unpacked 的 index.cjs
 * 开发：node + tsx 运行 runtime/src/index.ts
 *
 * [HISTORICAL] onExit 回调：子进程自然退出（崩溃）时 supervisor 必须清 child/port，
 * 否则幂等检查误判存活、start() 返回死端口，前端 WS 永连不上（应用假死）。
 * 旧 runtime-manager 的 child.on('exit') 会 this.child=null，重构拆出自由函数后由 onExit 传递。
 *
 * @param port runtime 监听端口
 * @param onExit 子进程退出回调（传入 code），supervisor 用它清理状态
 * @returns { child, token, runtimeId }——child 为已绑定 stdout/stderr/exit 事件的进程实例；
 *          token 为本次 spawn 生成的 WS auth token（supervisor 持有并经 get-runtime-target-snapshot 快照并置暴露给 renderer）；
 *          runtimeId 为本次 spawn 签发的实例标识（supervisor 并入目标快照经 IPC 暴露）
 * @throws runtime 入口文件不存在
 */
export function spawnRuntimeProcess(port: number, onExit?: (code: number | null) => void): SpawnRuntimeResult {
  // S1-W1：每次 spawn 生成新 token（env 注入 + 文件双通道），renderer 重连时经 IPC 拿新值。
  // runtimeId（§6.1）：与 token 同点签发的实例标识（每次 spawn 必新——身份随进程生灭，
  // 复用旧值会让重启后的 runtime 被误判为同一实例）。
  const runtimeToken = issueRuntimeToken()
  const runtimeId = randomBytes(RUNTIME_ID_BYTES).toString('hex')

  // 根据打包状态选择 runtime 启动方式
  const projectRoot = app.getAppPath()
  // remote-access（D3/D9）：开态追加 --remote-access + --mobile-dist=<绝对路径>，关态空数组不拼。
  // enabled 在 spawn 时刻现读配置（非快照）：toggle 落盘 → 重启 runtime 生效正依赖此语义
  const remoteAccessArgs = buildRemoteAccessSpawnArgs(
    resolveMobileDistEnv(),
    readRemoteAccessConfig().enabled,
  )
  let cmd: string
  let args: string[]

  if (app.isPackaged) {
    // 生产环境：运行 asar unpack 后的预编译 JS
    // asarUnpack 将 dist/runtime 解压到 app.asar.unpacked/
    const runtimeDist = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'dist',
      'runtime',
      RUNTIME_ENTRY_FILE,
    )
    if (!existsSync(runtimeDist)) {
      throw new Error(`Runtime bundle not found at ${runtimeDist}`)
    }
    cmd = process.execPath
    // S1-W4（D3）：built-in 插件目录显式注入（打包形态 = electron-builder
    // extraResources 拷贝目标 Resources/resources/plugins）。registry 收到后不再做
    // cwd 探测，防用户 repo 内预置同名目录冒充 built-in 插件获得 trusted 权限。
    const builtinPluginsDir = path.join(process.resourcesPath, 'resources', 'plugins')
    args = [runtimeDist, `--port=${port}`, `--builtin-plugins-dir=${builtinPluginsDir}`, ...remoteAccessArgs]
    console.log(`[runtime] ${cmd} ${runtimeDist} --port=${port} --builtin-plugins-dir=${builtinPluginsDir}`)
  } else {
    // 开发环境：tsx 运行 TS 源码
    // projectRoot = app.getAppPath() = apps/electron。
    // runtime 源码在 packages/runtime/src/（与 apps/electron 平级）。
    // repo root 相对 apps/electron 是 ../..
    const repoRoot = path.join(projectRoot, '..', '..')
    const runtimeEntry = path.join(repoRoot, 'packages', 'runtime', 'src', 'index.ts')

    // [HISTORICAL] tsx 路径必须用 require.resolve 动态解析，不能写死 repoRoot/node_modules。
    // 根因链（dev 启动崩溃的真实原因）：
    //   1. ada6c0466 把 .npmrc 从 hoisted 切到 isolated（控制 builtin extension 的 pnpm deploy 体积），
    //      但本处写死 repoRoot/node_modules/tsx 的解析未同步更新。
    //   2. isolated 布局下 repoRoot 没有 node_modules/tsx——tsx 只被 apps/electron（本 supervisor
    //      所在包）声明为 devDependency，实际位于 node_modules/.pnpm/tsx@x.y.z/node_modules/tsx/。
    //      旧实现长期靠 root 残留的 hoisted 时代污染物掩盖，干净重装后即刻崩溃。
    //   3. 33ed23e91 把启动入口从 .bin/tsx 换成 dist/cli.mjs，但路径仍写死 repoRoot，
    //      干净 isolated 安装下依旧找不到。另注：pnpm isolated 下 .bin 条目本就是
    //      @pnpm/cmd-shim 生成的跨平台 shell 脚本（非 symlink），「还原 .bin 为 symlink」
    //      既不可能也不必要——node <任何路径>/.bin/tsx 必然把 shell 当 JS 解析崩溃。
    // 正确做法：require.resolve 从 projectRoot（= apps/electron，tsx 声明方）按 Node 解析算法
    // 定位 tsx 真实位置——isolated → .pnpm/tsx@x.y.z/...；hoisted → 向上遍历到 repoRoot。
    // 与打包模式用 dist/runtime/index.cjs 同思路（解析包内 JS 入口，不依赖 .bin 或固定
    // node_modules 形态），跨 linker 模式稳定，merge 到 main（hoisted）不坏。
     
    const tsxPkgPath = require.resolve('tsx/package.json', { paths: [projectRoot] })
    const tsxPath = path.join(path.dirname(tsxPkgPath), 'dist', 'cli.mjs')

    if (!existsSync(tsxPath)) {
      throw new Error(`tsx cli not found at ${tsxPath} (resolved pkg: ${tsxPkgPath}). Run: pnpm install`)
    }
    if (!existsSync(runtimeEntry)) {
      throw new Error(`Runtime entry not found at ${runtimeEntry}`)
    }

    // S1-W4（D3）：dev 形态 built-in 插件目录 = repo 根 resources/plugins（repoRoot 已知），
    // 与打包形态同参数名显式注入（registry 不做 cwd 探测）。
    const builtinPluginsDir = path.join(repoRoot, 'resources', 'plugins')
    cmd = 'node'
    args = [tsxPath, runtimeEntry, `--port=${port}`, `--builtin-plugins-dir=${builtinPluginsDir}`, ...remoteAccessArgs]
    console.log(`[runtime] node ${tsxPath} ${runtimeEntry} --port=${port} --builtin-plugins-dir=${builtinPluginsDir}`)
  }

  if (remoteAccessArgs.length > 0) {
    console.log(`[runtime] remote access enabled: ${remoteAccessArgs.join(' ')}`)
  }

  // 打包后 app.getAppPath() 返回 app.asar（虚拟路径），不能作为 cwd
  const cwd = app.isPackaged ? process.resourcesPath : projectRoot
  // eslint-disable-next-line no-magic-numbers -- TypeScript tuple index, not a business constant
  const spawnOptions: Parameters<typeof spawn>[2] = {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    // 打包后用 ELECTRON_RUN_AS_NODE 让 Electron 二进制以纯 Node 运行 sidecar；
    // 开发模式也显式设置 env 确保行为一致
    env: buildSafeEnv({
      ELECTRON_RUN_AS_NODE: app.isPackaged ? '1' : undefined,
      TAIJI_AGENT_PACKAGED: app.isPackaged ? '1' : undefined,
      // 透传实例隔离 env var，使 runtime 子进程使用隔离的数据目录
      TAIJI_AGENT_DATA_DIR: process.env.TAIJI_AGENT_DATA_DIR,
      TAIJI_AGENT_PORT_OFFSET: process.env.TAIJI_AGENT_PORT_OFFSET,
      // S1-W1：WS auth token（token 分发通道①env；通道② <dataDir>/runtime-token 文件
      // 在 issueRuntimeToken 内写入）。TAIJI_ 前缀在 ENV_WHITELIST_PREFIXES 白名单内。
      TAIJI_RUNTIME_TOKEN: runtimeToken,
      // 实例标识（connection-datasync-ssot §6.1）：与 token 同点签发同点注入（buildSafeEnv
      // 同一批 extras）。env 名 SSOT = shared RUNTIME_ID_ENV；TAIJI_ 前缀同在白名单内。
      [RUNTIME_ID_ENV]: runtimeId,
    }),
  }
  const child = spawn(cmd, args, spawnOptions)

  // [HISTORICAL] W5 改动 5：spawn 'error' 事件（如命令不存在/权限不足）必须走与 exit 相同的清理路径。
  // 旧实现仅 console.error 记日志，supervisor 收不到通知 → child 引用残留 →
  // 下次 start 幂等检查误判存活（exitCode 此时仍是 null）→ 返回死端口（应用假死）。
  // 改为调 onExit(SPAWN_ERROR_EXIT_CODE) 哨兵退出码（真实 exit 不会产生负退出码），
  // 让 supervisor 清 child/port。
  child.on('error', (err) => {
    console.error(`[runtime] Spawn error: ${err.message}`)
    onExit?.(SPAWN_ERROR_EXIT_CODE)
  })

  // 打包态 stderr 背压丢弃计数（dev 走 console 转发无此路径，恒 0）：闭包变量生命周期
  // = 本次 spawn，对齐 stderrBytes 的「本次 spawn 累计」语义（与 writeStderrSink 的
  // 文件级字节计数职责不同）。首丢 warn 一条 + 累计计数，exit（spawn 收尾）汇总一行，
  // 可观测形态对齐轮转通道 stderrRotationDropped 的「窗口结束合并 warn」。
  let stderrBackpressureDropped = 0

  // M5（perf-quick-batch）：runtime 日志转发按打包状态分流。
  // - dev：stdout + stderr 全量 console 转发（终端调试可见）
  // - prod：stdout 不转发（runtime initLogger 已 tee 落盘，console 转发会阻塞主进程）；
  //         stderr 保留非阻塞文件兜底（覆盖 runtime 启动前 + 原生崩溃期，initLogger 不覆盖）
  if (!app.isPackaged) {
    child.stdout?.on('data', (data: Buffer) => {
      console.log(`[runtime:out] ${data.toString().trimEnd()}`)
    })
    child.stderr?.on('data', (data: Buffer) => {
      console.error(`[runtime:err] ${data.toString().trimEnd()}`)
    })
  } else {
    // W6 背压保护保留在调用侧（stderrBytes 是「本次 spawn 累计」语义，与 writeStderrSink
    // 的文件级字节计数职责不同）：累计超 1MB 后丢弃，防 pi 崩溃循环高频 stderr 撑爆磁盘。
    // 写入统一走 writeStderrSink（惰性建流 + size 轮转 + 轮转窗口丢弃），dev/prod 分流
    // 收敛到其内部的 app.isPackaged 判定。
    // eslint-disable-next-line no-magic-numbers -- 1MB stderr 背压上限（非业务常量）
    const WRITE_BUFFER_LIMIT = 1024 * 1024
    let stderrBytes = 0
    let stderrDropWarned = false
    child.stderr?.on('data', (data: Buffer) => {
      if (stderrBytes > WRITE_BUFFER_LIMIT) {
        stderrBackpressureDropped++
        if (!stderrDropWarned) {
          stderrDropWarned = true
          // 首丢留痕：超限后静默丢弃 = 取证通道部分失效，须可归因（热路径不逐 chunk 记）
          console.warn(`[runtime] stderr backpressure: exceeded ${WRITE_BUFFER_LIMIT} bytes this session — dropping further stderr (total reported on exit)`)
        }
        return
      }
      stderrBytes += data.length
      writeStderrSink(data)
    })
  }
  child.on('exit', (code) => {
    console.log(`[runtime] Process exited with code ${code}`)
    // 背压丢弃汇总（spawn 收尾）：丢弃总数一行留痕，崩溃取证时 stderr 文件缺口有账可查
    // （对齐轮转窗口 stderrRotationDropped 完成后合并 warn 的形态）
    if (stderrBackpressureDropped > 0) {
      console.warn(`[runtime] stderr backpressure: dropped ${stderrBackpressureDropped} stderr chunk(s) total this session`)
    }
    // 通知 supervisor 清理 child/port 状态（自然退出/崩溃路径）
    onExit?.(code)
  })

  return { child, token: runtimeToken, runtimeId }
}

/**
 * 查询单个 PID 的直接子进程 PID 列表（pgrep -P，getDescendantPids 的 BFS 单步）。
 *
 * 静默分支（输出为空 / pgrep exit 1 无匹配 / ENOENT 无 pgrep）与其他真实错误
 * 统一返回 []——对 BFS 编排语义一致（该分支无后代），差异只在可观测性
 * （真实错误经 reportPgrepFailure warn），由调用方继续处理队列剩余分支。
 */
function queryChildPids(pid: number): number[] {
  try {
    // execFileSync 不经 shell（pid 已是 number 无注入风险，但更稳健——避免 shell 解析/路径差异）。
    // 原实现用 `pgrep -P ${pid} 2>/dev/null || true` + shell:true 吞 stderr 和 exit code 1；
    // execFileSync 不支持 shell 重定向，需在 catch 里处理 pgrep 无匹配时 exit code 1。
    const output = execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (!output) return []
    return output.split('\n').map(Number).filter(n => !isNaN(n) && n > 0)
  } catch (e) {
    reportPgrepFailure(pid, e)
    return []
  }
}

/**
 * pgrep 失败的可观测性兜底（原 getDescendantPids catch 内联逻辑）。
 *
 * exit 1（无子进程，属正常）与 ENOENT（pgrep 不存在，极少见）静默不阻断 stop 流程；
 * 其他真实错误才 warn。
 */
function reportPgrepFailure(pid: number, e: unknown): void {
  // execFileSync 抛出的错误对象带 status（exit code）/ code（spawn 错误如 ENOENT）字段。
  const status = (e && typeof e === 'object' && 'status' in e) ? e.status : undefined
  const code = (e && typeof e === 'object' && 'code' in e) ? e.code : undefined
  if (status !== 1 && code !== 'ENOENT') {
    console.warn(`[runtime] getDescendantPids failed for PID ${pid}:`, e instanceof Error ? e.message : String(e))
  }
}

/**
 * 递归获取指定 PID 的所有后代进程 PID（广度优先，按代排列：子→孙→...）。
 *
 * [HISTORICAL] 仅支持 macOS/Linux（依赖 pgrep -P）。
 * 必须在 SIGTERM runtime 之前调用——否则 runtime 退出后 pi 的 PPID 变 1，查不到。
 *
 * @param parentPid 根进程 PID
 * @returns 后代 PID 数组（不含 parentPid 本身）
 */
export function getDescendantPids(parentPid: number): number[] {
  if (process.platform === 'win32' || !parentPid || isNaN(parentPid)) return []
  const result: number[] = []
  const queue = [parentPid]
  while (queue.length > 0) {
    const childPids = queryChildPids(queue.shift()!)
    result.push(...childPids)
    queue.push(...childPids)
  }
  return result
}

/**
 * 强制杀掉整棵进程树（父进程 + 所有后代）。
 * 用于 stop() 超时后的强制清理。
 *
 * 顺序：先杀后代（倒序：孙→子），再杀根。全部用 SIGKILL。
 *
 * @param rootPid 根进程 PID
 * @param precomputedDescendants 可选预计算的后代 PID（避免重复查询）
 */
export function killProcessTree(rootPid: number, precomputedDescendants?: number[]): void {
  if (process.platform === 'win32') {
    terminateWindowsProcessTree(rootPid)
    return
  }
  const pids = precomputedDescendants ?? getDescendantPids(rootPid)
  // 先杀后代（倒序：孙→子）
  for (const pid of pids.reverse()) {
    // eslint-disable-next-line taste/no-silent-catch -- process may have already exited
    try { process.kill(pid, 'SIGKILL') } catch { /* 可能已退出 */ }
  }
  // 再杀根进程
  // eslint-disable-next-line taste/no-silent-catch -- process may have already exited
  try { process.kill(rootPid, 'SIGKILL') } catch { /* 可能已退出 */ }
}

/**
 * 优雅停止 runtime（SIGTERM → 立即 SIGKILL 整棵进程树 → 等 exit）。
 *
 * 时序见文件顶部注释。关键：先预记录后代 PID 再发信号（runtime 退出后 pi 的
 * PPID 变 1，pgrep -P 查不到）；SIGTERM 与 SIGKILL 之间无等待窗，进程树的
 * 终止不依赖任何时间阈值，完成以 child 的 'exit' 事件为权威信号。
 *
 * @param child runtime 子进程（null 或已退出直接 resolve）
 * @returns 处置完成后 resolve
 */
export function stopRuntimeProcess(child: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    // 已退出（exitCode=退出码 / signalCode=信号杀死，exit 事件均已派发过）或已执行过
    // kill 链（killed）：不再重复处置，否则 'exit' 不会再次触发，本 Promise 永不 resolve
    if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const childPid = child.pid
    if (!childPid || isNaN(childPid)) {
      resolve()
      return
    }
    if (process.platform === 'win32') {
      // taskkill /T /F handles descendants atomically and is safe to repeat when the tree already exited.
      terminateWindowsProcessTree(childPid)
      void flushStderrSink().finally(resolve)
      return
    }

    let resolved = false

    // 在发信号之前记录所有后代 PID（runtime 退出后 pi 的 PPID 变为 1，pgrep -P 查不到）
    const descendantPids = getDescendantPids(childPid)

    const done = async () => {
      if (resolved) return
      resolved = true
      // 子进程树已全部 kill，stderr 不再有新数据 → flush 并关闭 sink，
      // 防止 app.quit() 前 WriteStream 内部 buffer 未落盘丢失崩溃期证据。
      // flushStderrSink 内置幂等（stderrSink=null 后 no-op）。
      // [HISTORICAL] W2：必须 await 等 'finish' 落盘，否则 stop() resolve 后 before-quit
      // 紧接 app.quit() 可能丢尾部 stderr。
      await flushStderrSink()
      resolve()
    }
    child.once('exit', done)
    child.kill('SIGTERM')
    // 立即 SIGKILL 整棵进程树：无 SIGTERM→SIGKILL 升级等待窗（先孙后代后根）
    killProcessTree(childPid, descendantPids)
  })
}
