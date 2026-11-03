/**
 * 假死进程死因取证（zombie forensics）—— 杀前采集调用栈与进程表快照落盘。
 *
 * liveness 判据分级（2026-11-03）的 zombie 路径专用：探针判定「端口可连但连续
 * 5min 无 HTTP 应答」后，supervisor 先跑本取证再执行强杀——假死强杀没有现场
 * 取证，5 分钟无应答的死因（真死锁 / 巨型同步块 / 内核态阻塞）就永久不可归因。
 *
 * 取证与杀链的关系（best-effort 边界）：
 * - 取证失败（sample 不存在 / 超时 / ps 失败）不阻塞杀链——本模块永不抛错，
 *   失败原因随结果返回，由调用方落 kill decision 日志。
 * - sample 抓栈 3s + execFile 硬超时 15s：取证有界，不会把杀链拖成无界等待。
 * - 落盘位置 = crash-journal 同目录（<dataDir>/logs/crashes/），调用方经
 *   CrashJournalEvent.detailPath 把文件路径登记进条目清单行（归因入口单一）。
 *
 * 平台形态：callstack 仅 darwin（/usr/bin/sample，同用户进程无需提权）；
 * 进程表 darwin/linux 用 ps（全表——runtime 与后代 pi 的 ppid 归属关系是
 * 跨进程归因的关键视图），win32 用 tasklist CSV。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildOutboundChildEnv } from '@taiji/shared'
import { getCrashJournalDir } from '../logs/crash-journal.js'

const execFileAsync = promisify(execFile)

/** sample 抓栈时长（s）：3s 足够覆盖多轮调度窗口，不显著延迟杀链。 */
const SAMPLE_DURATION_SEC = 3
/** sample / ps 的 execFile 硬超时（ms）：sample 自身 3s，裕量给启动与写文件。 */
const FORENSICS_TIMEOUT_MS = 15_000

/** 取证结果（纯数据形状，type 别名形态——oe-assert single-impl 先例）。 */
export type ZombieForensicsResult = {
  /** sample 调用栈文件绝对路径（非 darwin / 采集失败 = null）。 */
  callstackFile: string | null
  /** 进程表快照文件绝对路径（采集失败 = null）。 */
  procTableFile: string | null
  /** 各采集步骤失败原因（成功步骤不占位；取证 best-effort 的留档通道）。 */
  errors: string[]
}

/**
 * 采集假死进程死因证据（永不抛错，失败降级为 errors 留档）。
 *
 * @param pid 待取证的 runtime pid（假死进程仍在场——端口可连是 zombie 判定前提）
 * @param opts 注入项：dir（落盘目录，默认 crash-journal 同目录；测试注入临时目录）、
 *             run（命令执行器，测试注入 stub 免起真子进程）
 */
export async function collectZombieForensics(
  pid: number,
  opts: {
    dir?: string
    run?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>
  } = {},
): Promise<ZombieForensicsResult> {
  const dir = opts.dir ?? getCrashJournalDir()
  // C-proc-09 出站契约：子进程 env 经构建器组装（剥 TAIJI_AGENT_PACKAGED /
  // TAIJI_RUNTIME_TOKEN 等——sample/ps/tasklist 不消费任何 taiji env，剥除零副作用）
  const run =
    opts.run ??
    ((cmd, args, timeoutMs) =>
      execFileAsync(cmd, args, {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        env: buildOutboundChildEnv({ parentEnv: process.env }),
      }))
  const errors: string[] = []
  const result: ZombieForensicsResult = { callstackFile: null, procTableFile: null, errors }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  // crashes/ 目录可能尚未建过（首条事件惰性建目录的时序未到）——取证是首个写入方时自建
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    errors.push(`mkdir ${dir}: ${(e as Error).message}`)
    return result
  }

  // 调用栈抓取（darwin only）：sample <pid> 3 输出全部线程的采样调用栈
  if (process.platform === 'darwin') {
    const callstackFile = join(dir, `zombie-${pid}-${stamp}-callstack.txt`)
    try {
      // -file 形态：sample 把调用栈写进目标文件（stdout 仅进度行，不消费）
      await run('sample', [String(pid), String(SAMPLE_DURATION_SEC), '-file', callstackFile], FORENSICS_TIMEOUT_MS)
      result.callstackFile = callstackFile
    } catch (e) {
      errors.push(`sample ${pid}: ${(e as Error).message}`)
    }
  }

  // 进程表快照：全表（含 runtime 后代 pi 的 ppid 归属视图）
  const procTableFile = join(dir, `zombie-${pid}-${stamp}-proctable.txt`)
  try {
    const isWin = process.platform === 'win32'
    const { stdout } = isWin
      ? await run('tasklist', ['/v', '/fo', 'csv'], FORENSICS_TIMEOUT_MS)
      : await run('ps', ['-axo', 'pid,ppid,stat,etime,%cpu,%mem,command'], FORENSICS_TIMEOUT_MS)
    writeFileSync(procTableFile, stdout, 'utf8')
    result.procTableFile = procTableFile
  } catch (e) {
    errors.push(`process table: ${(e as Error).message}`)
  }

  return result
}
