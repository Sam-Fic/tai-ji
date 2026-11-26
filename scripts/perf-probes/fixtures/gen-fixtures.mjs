#!/usr/bin/env node
/**
 * 批5 fixture 生成器（零依赖，确定性输出——同 seed 同字节，可复跑可复现）。
 *
 * 背景（GLM 对抗审查 S4）：首轮 fixture 形态极端——单个 600 行 fence 占全文 60% 字符 +
 * 180 连续 bullet，缺「多小代码块 / 工具调用 / 重 thinking」三种形态。本脚本补这三种，
 * 与 original-45k.json（首轮原始 fixture 的逐字节副本）共同构成批5 的 fixture 集。
 *
 * 形态契约（与 original-45k 对齐，保证窗口可比）：
 *   - 单轮 text 目标 ~40-48K 字符（faux 200TPS 下 ≈ 60-70s 流式窗，对齐首轮 45,326 字符）；
 *   - markdown 结构真实（标题/段落/列表/表格/围栏），禁纯重复字符——否则前缀缓存与
 *     markdown-it 的分块行为与真实对话不可比；
 *   - 每步是一个 FauxStep（{thinking?, text?, toolCalls?}，见 faux-llm-ext.ts ScriptedStep）。
 *
 * 用法：node scripts/perf-probes/fixtures/gen-fixtures.mjs [--out scripts/perf-probes/fixtures]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 确定性 LCG（同 seed 同序列——fixture 字节可复现）。 */
function lcg (seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const TOPICS = [
  '渲染管线的分层边界', '响应式依赖收集的开销', '虚拟滚动的度量收敛', '增量 markdown 的稳定前缀',
  'Web Worker 高亮的回填路径', '事件循环与转发队列的交错', '会话树的持久化布局', '插件体系的贡献点契约',
  '合成层的栅格化成本', '强制同步布局的读点纪律', '前缀指纹与缓存命中', '流式期的高度记账误差'
]
const SENT = [
  '这一层的职责是把上游事件归一成单一事实源，消费方只持水位不持全量。',
  '度量口径必须先于优化存在，否则任何加速都无法与基线对齐。',
  '把成本压到调用方之外的前提是契约稳定，而不是频率更低。',
  '边界清晰时，替换实现不需要通知任何上游模块。',
  '真正的瓶颈往往藏在两个都不昂贵的步骤之间的乘积上。',
  '事实驱动意味着未知必须显式呈现，而不是用乐观值填充。',
  '任何跨调用状态都要回答谁写、谁读、何时失效三个问题。',
  '把同步读挪到布局之后，成本不会消失但会从关键路径上移出。'
]

function prose (rnd, sentences) {
  const out = []
  for (let i = 0; i < sentences; i++) {
    const t = TOPICS[Math.floor(rnd() * TOPICS.length)]
    const s = SENT[Math.floor(rnd() * SENT.length)]
    out.push(`${t}方面，${s}`)
  }
  return out.join('')
}

/** 段落填充到目标字符数（合成 fixture 的体量控制——窗口长度必须与 original-45k 可比）。 */
function proseTo (rnd, targetChars) {
  let out = ''
  while (out.length < targetChars) out += prose(rnd, 4)
  return out.slice(0, targetChars)
}

const FENCES = {
  ts: (n) => `export function batch${n}(items: string[]): string[] {\n  return items\n    .filter((x) => x.length > 0)\n    .map((x) => x.trim())\n    .slice(0, ${n * 7})\n}\n`,
  python: (n) => `def batch_${n}(items):\n    return [x.strip() for x in items if x][:${n * 5}]\n\n\nclass Runner_${n}:\n    def run(self):\n        return batch_${n}(["a", "b"])\n`,
  json: (n) => `{\n  "id": ${n},\n  "name": "batch-${n}",\n  "limits": { "chars": ${n * 100}, "rounds": ${n} },\n  "tags": ["perf", "stream"]\n}\n`,
  bash: (n) => `#!/usr/bin/env bash\nset -euo pipefail\nfor i in $(seq 1 ${n}); do\n  echo "round ${'$'}{i}"\ndone\n`,
  sql: (n) => `select id, name from batches\nwhere chars > ${n * 10}\norder by id desc\nlimit ${n};\n`,
  yaml: (n) => `id: ${n}\nname: batch-${n}\nlimits:\n  chars: ${n * 100}\n  rounds: ${n}\ntags: [perf, stream]\n`,
  css: (n) => `.band-${n} {\n  height: ${n * 4}px;\n  mask-image: linear-gradient(to bottom, #000, transparent);\n  transition: opacity 140ms ease-out;\n}\n`
}

/** 形态 1：多小代码块（24 个 20-30 行 fence，语言轮换，块间夹段落/列表/表格）。
 *  体量对齐 original-45k（~45K 字符）——否则流式窗长度不可比。 */
function multiSmallFences () {
  const rnd = lcg(20261124)
  const langs = Object.keys(FENCES)
  const parts = ['# 多代码块形态：批量处理流水线评审\n']
  for (let i = 1; i <= 24; i++) {
    const lang = langs[i % langs.length]
    parts.push(`\n## 第 ${i} 段：${TOPICS[i % TOPICS.length]}\n`)
    parts.push(`\n${proseTo(rnd, 1150)}\n`)
    if (i % 4 === 0) {
      parts.push(`\n- 要点 ${i}.1：${prose(rnd, 2)}\n- 要点 ${i}.2：${prose(rnd, 2)}\n- 要点 ${i}.3：${prose(rnd, 2)}\n`)
    }
    if (i % 6 === 0) {
      parts.push(`\n| 轮次 | 字符上限 | 命中率 |\n|---|---|---|\n| ${i} | ${i * 100} | ${(60 + i)}% |\n| ${i + 1} | ${(i + 1) * 100} | ${(61 + i)}% |\n`)
    }
    const body = FENCES[lang](i).repeat(4)
    parts.push(`\n\`\`\`${lang}\n${body}\`\`\`\n`)
  }
  return parts.join('')
}

/** 形态 2：工具调用（5 轮，每轮「流式文本 + bash 工具卡」，末轮纯文本收尾）。
 *  契约关键（首跑踩坑）：faux 队列的每一步 = 一条 assistant 消息；只有 stopReason='toolUse'
 *  才会自动续跑下一轮。早期版本把 toolUse 与 text 拆成两步、text 步以 stop 收尾 ⇒ 整条链
 *  只跑 1 轮工具就结束（completes=1/10）。正确形态 = 每步同时带 text 与 toolCalls。
 */
function toolCalls () {
  const rnd = lcg(20261125)
  const steps = []
  for (let r = 1; r <= 5; r++) {
    const calls = r % 2 === 1
      ? [{ name: 'bash', args: { command: `echo probe-round-${r}` } }]
      : [{ name: 'bash', args: { command: `echo probe-a-${r}` } }, { name: 'bash', args: { command: `echo probe-b-${r}` } }]
    const text = [`## 第 ${r} 轮：${TOPICS[r % TOPICS.length]}\n`, `\n${proseTo(rnd, 7000)}\n`]
    if (r % 2 === 1) text.push(`\n\`\`\`ts\n${FENCES.ts(r)}\`\`\`\n`)
    steps.push({
      ...(r === 1 ? { thinking: `先跑探测命令，再据输出展开${'。'.repeat(6)}` } : {}),
      text: text.join(''),
      toolCalls: calls,
      stopReason: 'toolUse'
    })
  }
  steps.push({ text: `\n## 收尾\n\n${proseTo(rnd, 3000)}\n`, stopReason: 'stop' })
  return steps
}

/** 形态 3：重 thinking（~24K 思考 + ~22K 正文）。 */
function heavyThinking () {
  const rnd = lcg(20261126)
  let thinking = '让我系统地把这个问题拆开。'
  while (thinking.length < 24000) thinking += prose(rnd, 3)
  let text = '# 深度思考形态：长推理后的落地方案\n'
  while (text.length < 22000) {
    text += `\n## ${TOPICS[Math.floor(rnd() * TOPICS.length)]}\n\n${prose(rnd, 3)}\n`
    if (text.length % 3 === 0) text += `\n\`\`\`ts\n${FENCES.ts(Math.ceil(text.length / 1000))}\`\`\`\n`
  }
  return [
    { thinking: thinking.slice(0, 24000), text: text.slice(0, 22000), stopReason: 'stop' },
    { text: '好的，方案已记录。', stopReason: 'stop' }
  ]
}

function writeJson (file, data) {
  const p = path.join(HERE, file)
  fs.writeFileSync(p, `${JSON.stringify(data, null, 1)}\n`)
  const chars = data.reduce((a, s) => a + (s.text?.length ?? 0) + (s.thinking?.length ?? 0), 0)
  console.log(`${file}: steps=${data.length} chars=${chars}`)
}

const arg = process.argv[2]
if (arg === '--print') {
  console.log('multi-small-fences chars =', multiSmallFences().length)
} else {
  writeJson('multi-small-fences.json', [{ text: multiSmallFences(), stopReason: 'stop' }, { text: '多代码块形态测完。', stopReason: 'stop' }])
  writeJson('tool-calls.json', toolCalls())
  writeJson('heavy-thinking.json', heavyThinking())
}
