/**
 * gh run list 查询闭包工厂（按 commit 查 workflow runs 的三态契约 SSOT）。
 *
 * 消费方：wait-for-ci.mjs（阶段 3，main push CI）与 pr-merge.mjs（阶段 2，PR
 * head CI）——同一条「按 commit 查询」的两处消费收敛于本工厂，契约演化只改
 * 此处。verify-ci-release.mjs 自带同名工厂是查询语义真差异（按 workflow 查
 * 最近 5 条，不按 commit），不在本收敛范围。
 *
 * 三态契约：查询失败（gh 退出非 0 / JSON 输出畸形 / 非数组）返回 null，与
 * 「查询成功且空」的 [] 分流——gate.mjs 对 null 持续重试到 deadline 判
 * fetch-error（调用方按工具错误处理），绝不并入 no-runs 的 30s 宽限放行
 * 路径。runImpl 注入点供测试替换，生产路径用 lib/exec.mjs 的 run。
 *
 * 双通道：BRANCH 传入时走 --branch 拉取 + headSha 客户端精确过滤（裁决锚仍是
 * commit sha）——服务端 --commit 过滤依赖 check-suite 关联元数据，push run
 * queued 早期持续返回空（2026-11 实测形态，详见分支内注释）；BRANCH 缺省保持
 * 旧 --commit 通道（向后兼容）。消费方：wait-for-ci（BRANCH=main）、pr-merge
 * （BRANCH=PR head 分支）均已接线。
 */
import { run } from './exec.mjs'
import { filterDependabot } from './gate.mjs'

export function makeFetchRuns({ REF, BRANCH, WORKFLOW, GH_REPO, runImpl = run }) {
  return async () => {
    const byBranch = BRANCH !== undefined && BRANCH !== ''
    const args = ['run', 'list']
    if (byBranch) {
      // branch 通道（2026-11 v0.13.4 债务清偿期实测）：服务端 --commit 过滤依赖
      // check-suite 关联元数据，push run 的 queued 早期该关联未建立会持续返回空——
      // 同一刻 --branch 查询立即可见，导致 wait-for-ci 的 30s 宽限窗耗尽误放行
      // no-runs。改按 branch 拉取 + headSha 客户端过滤（裁决锚 REF 仍是 commit
      // sha，判定契约不变；--limit 50 防长活分支淹没目标 head）。
      // 过滤谓词 = startsWith：与 gh --commit 服务端语义对齐——调用方常传短 sha
      // （如 git rev-parse --short 习惯、日志抄录），服务端通道接受短 sha，客户端
      // 通道若全等比对则短 sha 永不命中（冒烟实测形态）；40 位时退化为全等。
      // REF 空串守卫：startsWith('') 全命中，异常输入宁漏勿滥。
      args.push('--branch', BRANCH, '--limit', '50')
    } else {
      args.push('--commit', REF)
    }
    if (WORKFLOW !== '') args.push('--workflow', WORKFLOW)
    if (GH_REPO !== '') args.push('--repo', GH_REPO)
    args.push('--json', 'databaseId,headSha,status,conclusion,name,workflowName')
    const res = runImpl('gh', args, { stdio: 'capture' })
    if (!res.ok) return null
    try {
      const runs = JSON.parse(res.stdout)
      if (!Array.isArray(runs)) return null
      const scoped = byBranch ? runs.filter((r) => REF !== '' && r.headSha !== null && r.headSha.startsWith(REF)) : runs
      // [2026-10-13] 过滤 Dependabot Updates：event=dynamic 的平台侧依赖机器人任务
      // （updater 容器对个别依赖如 electron 偶发 unknown_error 失败），不是本次合并的
      // 代码验证线——计入判定会让发布恒被与代码无关的机器人红阻塞。
      // WORKFLOW 显式指定时不过滤（用户点名）。
      return WORKFLOW !== '' ? scoped : filterDependabot(scoped)
    } catch {
      return null
    }
  }
}
