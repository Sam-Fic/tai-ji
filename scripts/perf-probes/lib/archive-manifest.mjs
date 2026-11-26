/**
 * 归档采集物定位与 md5 对账（branch-review dmg-r1-2 收尾共享件，零依赖）。
 *
 * 背景：docs/perf/final-measurement/ 的原始 CPU 采集物（pi/runtime cpuprofile +
 * cpu-analysis.txt）因内嵌 worktree 绝对路径出库（rule-22①），本体归档于会话 artifacts
 * <sessionsRoot>/<sessionId>/artifacts/final-measurement-raw/，去向登记在
 * docs/perf/final-measurement/raw-artifacts-manifest.json（md5/bytes，与 gpu-trace-manifest.json 同模式）。
 *
 * 解析约定（与 gpu-trace 清单的会话扫描一致）：
 *   ① MEAS 原位优先（库内仍在的形态 / 本地重跑产物）；
 *   ② 缺位时按清单扫描会话树定位，命中即 md5 复算比对（漂移 = 红灯）；
 *   ③ 归档不可达（会话树被清理）→ 返回 null，调用方按「归档不可达」显式降级——
 *      不可达与未篡改是两件事，禁止静默 PASS。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export function readArchiveManifest (measDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(measDir, 'raw-artifacts-manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

function md5Of (file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')
}

function matchMeta (measDir, name, file) {
  const meta = readArchiveManifest(measDir)?.artifacts?.[name]
  return meta?.md5 ? md5Of(file) === meta.md5 : null
}

/**
 * 定位归档采集物。返回 { where: 'repo'|'archive', file, md5Match: boolean|null }；
 * null = MEAS 与归档均不可达（清单缺失或会话树已清理）。清单有 md5 即比对，md5Match 恒 boolean。
 */
export function locateArchivedArtifact (measDir, name) {
  const local = path.join(measDir, name)
  if (fs.existsSync(local)) return { where: 'repo', file: local, md5Match: matchMeta(measDir, name, local) }
  const meta = readArchiveManifest(measDir)?.artifacts?.[name]
  if (!meta) return null
  const sessionsRoot = path.join(os.homedir(), '.taiji', 'ext-sessions')
  let hit = null
  try {
    for (const sid of fs.readdirSync(sessionsRoot)) {
      const cand = path.join(sessionsRoot, sid, 'artifacts', 'final-measurement-raw', name)
      if (fs.existsSync(cand)) { hit = cand; break }
    }
  } catch { /* sessionsRoot 不存在 = 归档不可达 */ }
  if (!hit) return null
  return { where: 'archive', file: hit, md5Match: meta.md5 ? md5Of(hit) === meta.md5 : null }
}
