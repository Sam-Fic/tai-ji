#!/usr/bin/env node
/**
 * probe-opendesign-catalog.mjs —— OpenDesign 模型目录探测 → provider-model-metadata 域草案。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * OpenDesign 网关（https://amr-link.open-design.ai/v1）不发布机器可读的能力清单：
 * - `GET /v1/models`（需 Bearer）给出 metadata.context_limit / context_budget /
 *   output_budget / cost / capability 与 architecture.input_modalities——**没有思考能力**；
 * - 公开价格表 `amr-api.open-design.ai/api/v1/public/model-prices` 给出每百万 token 的
 *   input/output/cacheRead/cacheWrite（+ claude/gpt 系 longContext 阶梯）——只有 id 和价格；
 * - 官方 GitHub 仓（nexu-io/open-design）的 AMR 运行时走 vela CLI 运行时发现，
 *   `fallbackModels: []`，刻意不内置模型表。
 * 所以 thinking 档位只能**探测**：对每个模型逐档发一次最小请求，把
 * `invalid_request_error` 判为「端点显式拒绝该档」，其余失败（网络/限流/上游抖动）重试。
 *
 * ── 产出 ────────────────────────────────────────────────────────────
 * 生成 `configs/remote/provider-model-metadata.json` 的 providers[0]（opendesign）段：
 * 每个模型的 contextWindow / maxTokens / reasoning / input / cost / thinkingLevelMap /
 * compat。写盘前与现有文件做内容比较，**有变化才写**（无变化 = 零输出、零 diff），
 * 供 CI 判定「是否开 PR」。
 *
 * ── 与运行时 / CI 的关系（ADR-0190）────────────────────────────────
 * 本脚本是**纯手动工具**：探测要打 14 × 7 ≈ 100 次真实请求、耗时数分钟、消耗额度，
 * 因此不在 GitHub Actions 里跑（2026-11-24 裁决）——CI 的固定预算不该被一把按需 key
 * 的额度消耗与跨境链路耗时占据。
 *
 * 运行时同样从不调用它：模型元数据的运行时更新走 provider-model-metadata 域的远程
 * 拉取（4h 节流 + 双源），不带任何探测。
 *
 * 使用节奏建议：模型目录按天级变化，每月或怀疑元数据过期时手动跑一次；产出有差异才
 * 写文件，review 后随任意 commit 推到 `configs/remote/provider-model-metadata.json`
 * 即对所有客户端生效（无需发版）。
 *
 * 用法：
 *   node scripts/probe-opendesign-catalog.mjs                 # 探测并写入（无变化时不改文件）
 *   node scripts/probe-opendesign-catalog.mjs --check         # 只比不写：有差异 exit 1
 *   node scripts/probe-opendesign-catalog.mjs --json          # 只打印草案，不写文件
 *   node scripts/probe-opendesign-catalog.mjs --levels minimal,high   # 只探指定档（排障用）
 * env:
 *   OPENDESIGN_API_KEY  必填（Bearer）。CI 用 secret；本地从 shell 环境取。
 * 退出码：0 = 探测完成且与磁盘一致（或 `--json` 打印完成）；1 = 有差异 / 探测失败；2 = 用法或环境错误。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_PATH = join(ROOT, 'configs/remote/provider-model-metadata.json')
/** 编译期快照（附加段 provider 模型的基线）。脚本只输出**与快照有差异**的补丁条目。 */
const SNAPSHOT_PATH = join(ROOT, 'packages/runtime/src/generated/builtin-providers.json')

const BASE_URL = 'https://amr-link.open-design.ai/v1'
const PRICES_URL = 'https://amr-api.open-design.ai/api/v1/public/model-prices'
const PROVIDER_ID = 'opendesign'

/** pi 的档位全序（EXTENDED_THINKING_LEVELS，低→高）。 */
const ALL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 全网关统一 thinking 声明。OpenDesign 只认 deepseek 线格式：pi 的 openai 格式在 off 时
 * 发 `reasoning_effort:'off'`，实测对 claude-haiku-5.5 / gpt-6-luna / minimax-m3.1-flash
 * 等直接 400；故 compat 不可照抄同名 pi catalog 模板（glm 用 zai、gpt 用 openai）。
 */
const COMPAT = {
  thinkingFormat: 'deepseek',
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  requiresReasoningContentOnAssistantMessages: true,
}

/** 探测请求的超时（远程网络调用超时属 ADR-0190 白名单①）。 */
const PROBE_TIMEOUT_MS = 60_000
/** 单格最多尝试次数（抖动重试；`invalid_request_error` 立即终局，不重试）。 */
const MAX_ATTEMPTS = 4
/** 重试间隔基数（毫秒，线性递增）；刻意很短——抖动多为限流瞬时态。 */
const RETRY_BACKOFF_MS = 2_000
/** 探测 prompt：短到不烧额度，长到能触发思考。 */
const PROBE_PROMPT = 'hi'
const PROBE_MAX_TOKENS = 16

function die(code, msg) {
  console.error(`[probe-opendesign] ${msg}`)
  process.exit(code)
}

/**
 * 进度日志走 stderr（`--json` 模式下 stdout 只能是纯 JSON）。
 * 本次实测踩过：混在 stdout 会让 `--json > file` 产出的文件不可解析。
 */
const log = (...a) => console.error('[probe-opendesign]', ...a)

function parseArgs(argv) {
  const out = { check: false, json: false, levels: ALL_LEVELS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') out.check = true
    else if (a === '--json') out.json = true
    else if (a === '--levels') {
      const raw = argv[++i]
      if (!raw) die(2, '--levels 需要逗号分隔的档位列表')
      const levels = raw.split(',').map((s) => s.trim()).filter(Boolean)
      const bad = levels.filter((l) => !ALL_LEVELS.includes(l))
      if (bad.length > 0) die(2, `--levels 含未知档位：${bad.join(', ')}`)
      out.levels = levels
    } else if (a === '--help' || a === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('*/')[0])
      process.exit(0)
    } else die(2, `未知参数：${a}`)
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 统一 fetch + 超时（远程网络调用超时白名单）+ 抖动重试。
 *
 * 两个目录端点在实测中会出现瞬时 `fetch failed` / 连接超时（跨境链路 + 边缘节点预热），
 * 单次失败不足以判定端点不可用——这只是探测脚本（CI/手动），重试成本可忽略。
 */
async function fetchJson(url, headers = {}) {
  let lastErr
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(RETRY_BACKOFF_MS * (attempt - 1))
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const text = await res.text()
      if (!res.ok) {
        lastErr = new Error(`${url} answered HTTP ${res.status}: ${text.slice(0, 200)}`)
        continue
      }
      try {
        return JSON.parse(text)
      } catch (e) {
        lastErr = new Error(`${url} answered non-JSON: ${text.slice(0, 200)} (${e.message})`)
        continue
      }
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`${url} 连续 ${MAX_ATTEMPTS} 次失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}

/** 拉模型目录（鉴权）。 */
async function fetchModels(apiKey) {
  const doc = await fetchJson(`${BASE_URL}/models`, { authorization: `Bearer ${apiKey}` })
  if (!Array.isArray(doc?.data)) throw new Error('/v1/models: body.data 不是数组')
  return doc.data.filter((m) => typeof m?.id === 'string' && m.id !== '')
}

/** 价格表数值归一：非有限非负数 → undefined（缺项由调用方补 0）。 */
function priceNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/**
 * 价格行 → pi ModelCostSchema 形状。
 *
 * pi 的 ModelCostSchema 要求 input/output/cacheRead/cacheWrite 四字段齐全（缺任一字段 =
 * 拒载整个 models.json），故价格表缺项一律补 0；`longContext` 阶梯映射为 `tiers`。
 */
function toPiCost(pricing) {
  const p = pricing ?? {}
  const cost = {
    input: priceNumber(p.input) ?? 0,
    output: priceNumber(p.output) ?? 0,
    cacheRead: priceNumber(p.cacheRead ?? p.cache_read) ?? 0,
    cacheWrite: priceNumber(p.cacheWrite ?? p.cache_write) ?? 0,
  }
  const lc = p.longContext ?? p.long_context
  if (lc && typeof lc.inputTokensAbove === 'number') {
    cost.tiers = [
      {
        inputTokensAbove: lc.inputTokensAbove,
        input: priceNumber(lc.input) ?? cost.input,
        output: priceNumber(lc.output) ?? cost.output,
        cacheRead: priceNumber(lc.cacheRead) ?? cost.cacheRead,
        cacheWrite: priceNumber(lc.cacheWrite) ?? cost.cacheWrite,
      },
    ]
  }
  return cost
}

/** 拉公开价格表（无鉴权）→ id → pi cost 形状。 */
async function fetchPrices() {
  const doc = await fetchJson(PRICES_URL)
  const rows = Array.isArray(doc) ? doc : Array.isArray(doc?.data) ? doc.data : []
  const out = new Map()
  for (const row of rows) {
    const id = typeof row?.model === 'string' ? row.model : typeof row?.id === 'string' ? row.id : undefined
    if (!id) continue
    out.set(id, toPiCost(row.pricing ?? row.price))
  }
  return out
}

/**
 * 单模型单档探测。返回 'accepted' | 'rejected'（端点显式拒绝）| 'unstable'（重试耗尽）。
 *
 * off 档用 `thinking:{type:'disabled'}`（不叠 reasoning_effort）；其余档用
 * `thinking:{type:'enabled'}` + `reasoning_effort:<level>`——即 pi 在
 * thinkingFormat='deepseek' 下的真实线格式，探测结论才能直接对应线上行为。
 */
async function probeLevel(apiKey, modelId, level) {
  const body = {
    model: modelId,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
    max_tokens: PROBE_MAX_TOKENS,
    ...(level === 'off'
      ? { thinking: { type: 'disabled' } }
      : { thinking: { type: 'enabled' }, reasoning_effort: level }),
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(RETRY_BACKOFF_MS * (attempt - 1))
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const text = await res.text()
      let doc
      try {
        doc = JSON.parse(text)
      } catch {
        continue // 非 JSON（网关抖动）：重试
      }
      if (doc?.error) {
        // 只有 invalid_request_error 是「参数被端点拒绝」的确定性信号；其余（upstream_error /
        // tier_limit_exceeded 等）是抖动，重试。
        if (doc.error.code === 'invalid_request_error') return 'rejected'
        continue
      }
      if (res.ok) return 'accepted'
      continue
    } catch {
      continue // 网络/超时：重试
    }
  }
  return 'unstable'
}

/** architecture.input_modalities → pi 的 input（只留 text/image）。 */
function toPiInput(architecture) {
  const mods = Array.isArray(architecture?.input_modalities) ? architecture.input_modalities : []
  const input = ['text']
  if (mods.includes('image')) input.push('image')
  return input
}

/**
 * 探测一个模型 → 元数据条目。
 *
 * 探测顺序：先 off（确定能否关思考），再逐档。`unstable` 一律按「不支持」处理并打印
 * WARN——探测不确定时宁可少给档位（用户看到少了会来问），也不给一个会 400 的档。
 */
async function probeModel(apiKey, model, levels) {
  const md = model.metadata ?? {}
  const contextWindow = typeof md.context_limit === 'number' && md.context_limit > 0 ? md.context_limit : undefined
  const maxTokens = typeof md.output_budget === 'number' && md.output_budget > 0 ? md.output_budget : undefined
  if (contextWindow === undefined) {
    // 单个模型元数据不全不拖垮整轮探测：跳过并告警（pi models.json 的 contextWindow 是必需
    // 字段，凭空填默认值会让压缩阈值错位——宁可让该模型留在快照里由人工裁决）。
    console.warn(`[probe-opendesign] WARN ${model.id}: metadata.context_limit 缺失或非法，跳过该模型`)
    return null
  }

  const verdicts = new Map()
  for (const level of levels) {
    const v = await probeLevel(apiKey, model.id, level)
    verdicts.set(level, v)
    if (v === 'unstable') {
      console.warn(`[probe-opendesign] WARN ${model.id} level=${level}: 探测不确定（重试耗尽），按不支持处理`)
    }
  }
  return { contextWindow, maxTokens, verdicts }
}

/**
 * 由探测结论生成 thinkingLevelMap：
 * - 任何一档 accepted → reasoning:true（否则 reasoning:false，pi 会把档位钳成 ['off']）
 * - identity 映射（档位名直接作为 reasoning_effort）
 * - 探测被拒 / 不确定 / 未探测的档 → null（pi 语义 = 不支持）
 *
 * 注意 pi 的 xhigh/max 语义：未显式列出的 xhigh/max 视为不支持，所以这里必须把全 7 档
 * 都写出来（identity 或 null），不能只写可用档——只写可用档会让「未探测」变成「不支持」
 * 之外的另一层歧义。
 */
function buildThinkingLevelMap(verdicts) {
  const map = {}
  for (const level of ALL_LEVELS) {
    const v = verdicts.get(level)
    map[level] = v === 'accepted' ? level : null
  }
  return map
}

function hasAnyAccepted(verdicts) {
  for (const v of verdicts.values()) if (v === 'accepted') return true
  return false
}

/** 生成 provider 段草案（不含 version，由调用方包装）。 */
async function buildDraft(apiKey, { levels }) {
  const models = await fetchModels(apiKey)
  const prices = await fetchPrices()
  log(`目录 ${models.length} 个模型；探测档位 = ${levels.join(',')}`)

  const entries = []
  for (const model of models) {
    const probed = await probeModel(apiKey, model, levels)
    if (!probed) continue
    const { contextWindow, maxTokens, verdicts } = probed
    const accepted = levels.filter((l) => verdicts.get(l) === 'accepted')
    const reasoning = hasAnyAccepted(verdicts)
    const cost = prices.get(model.id)
    if (!cost) console.warn(`[probe-opendesign] WARN ${model.id}: 价格表无此 id，cost 按 0 落盘`)
    const outputBudget = maxTokens ?? 32000

    log(
      `  ${model.id.padEnd(30)} reasoning=${reasoning} accepted=[${accepted.join(',')}] ctx=${contextWindow} max=${outputBudget}`,
    )

    entries.push({
      id: model.id,
      contextWindow,
      maxTokens: outputBudget,
      reasoning,
      input: toPiInput(model.architecture),
      ...(cost ? { cost } : {}),
      ...(reasoning
        ? { thinkingLevelMap: buildThinkingLevelMap(verdicts), compat: COMPAT }
        : {}),
    })
  }

  // 稳定排序（按 id），diff 才可读
  entries.sort((a, b) => a.id.localeCompare(b.id))
  return { version: 1, providers: [{ id: PROVIDER_ID, models: entries }] }
}

/**
 * 读编译期快照里该 provider 的模型表（基线）。缺失 → undefined（脚本退化为全量输出）。
 */
function readSnapshotModels() {
  if (!existsSync(SNAPSHOT_PATH)) return undefined
  try {
    const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'))
    const p = (snap.providers ?? []).find((x) => x?.id === PROVIDER_ID)
    if (!p?.models) return undefined
    return new Map(p.models.filter((m) => typeof m?.id === 'string').map((m) => [m.id, m]))
  } catch {
    return undefined
  }
}

/**
 * 探测结果 ⊕ 快照 → **差异补丁**（这是本脚本的落盘形态）。
 *
 * 为什么只写差异：远程域是「补丁层」而非「第二事实源」。若把全量结果写进远程，
 * 下次发版更新快照后，远程里的旧值会反过来覆盖新快照——「发了版反而回退」。
 * 只写差异时，快照修好后差异自然消失，远程补丁退化为空（幂等、零漂移）。
 *
 * 差异判据 = 该模型在探测结果里的每一个「上游可决定」字段（contextWindow /
 * maxTokens / reasoning / input / cost / thinkingLevelMap / compat）与快照逐字段
 * 比对（JSON 序列化等价比较，与 remote-provider-sync 的 noChange 判据同源）。
 * name / api / baseUrl 不参与（探测不产出，始终由快照提供）。
 */
function diffAgainstSnapshot(draft, snapshot) {
  if (!snapshot) {
    console.warn('[probe-opendesign] WARN 快照不可读，退化为全量输出（请人工核对 remote 与快照的一致性）')
    return draft
  }
  const FIELDS = ['contextWindow', 'maxTokens', 'reasoning', 'input', 'cost', 'thinkingLevelMap', 'compat']
  const patches = []
  for (const m of draft.providers[0].models) {
    const snap = snapshot.get(m.id)
    if (!snap) {
      log(`  差异 ${m.id}: 快照无此模型（新增）`)
      patches.push(m)
      continue
    }
    const changed = FIELDS.filter((f) => JSON.stringify(snap[f] ?? null) !== JSON.stringify(m[f] ?? null))
    if (changed.length === 0) continue
    log(`  差异 ${m.id}: ${changed.join(',')}`)
    // 只带差异字段（+ id），其余由快照提供
    const patch = { id: m.id }
    for (const f of changed) if (m[f] !== undefined) patch[f] = m[f]
    // 差异是「快照有、探测无」的字段（如 reasoning 从 true 变 false）→ 显式给值
    for (const f of changed) if (m[f] === undefined && f === 'reasoning') patch.reasoning = false
    patches.push(patch)
  }
  const removed = [...snapshot.keys()].filter((id) => !draft.providers[0].models.some((m) => m.id === id))
  for (const id of removed) log(`  差异 ${id}: 快照有、目录已下线（记入 removeModels）`)
  return {
    version: 1,
    providers: [
      {
        id: PROVIDER_ID,
        models: patches,
        ...(removed.length > 0 ? { removeModels: removed } : {}),
      },
    ],
  }
}

function readCurrent() {
  if (!existsSync(OUT_PATH)) return undefined
  try {
    return JSON.parse(readFileSync(OUT_PATH, 'utf-8'))
  } catch {
    return undefined
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = process.env.OPENDESIGN_API_KEY
  if (!apiKey) die(2, '缺少环境变量 OPENDESIGN_API_KEY（Bearer key）')

  const probed = await buildDraft(apiKey, args)
  const draft = diffAgainstSnapshot(probed, readSnapshotModels())
  const json = JSON.stringify(draft, null, 2) + '\n'

  if (args.json) {
    process.stdout.write(json)
    return
  }

  const current = readCurrent()
  const currentJson = current ? JSON.stringify(current, null, 2) + '\n' : ''
  if (currentJson === json) {
    log('与磁盘一致，无需更新')
    return
  }

  if (args.check) {
    console.error('[probe-opendesign] 探测结果与磁盘不一致：重新运行（去掉 --check）以更新配置')
    process.exit(1)
  }

  writeFileSync(OUT_PATH, json, 'utf-8')
  log(`已写入 ${OUT_PATH}`)
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main().catch((e) => {
    console.error(`[probe-opendesign] 失败：${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
}

// 供单测使用（纯函数）
export { ALL_LEVELS, COMPAT, buildThinkingLevelMap, toPiInput, diffAgainstSnapshot, PROVIDER_ID }
