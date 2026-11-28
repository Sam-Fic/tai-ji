#!/usr/bin/env node
/**
 * AC-MOTION 探针（真实浏览器，离线最小页，不启动开发实例）：
 * 入场动效用位移（translateY）时，滚动容器在动效期间的内容高度被撑大；只用透明度时不改变。
 *
 * 这是过程卡窗口内动效「只用透明度、不用位移」的设计依据：窗口的贴底判定读
 * scrollHeight，位移造成的临时增量会把贴底的窗口判成未贴底（内容不满窗口高度时也会
 * 留下「回到最新」）。断言写死两个方向，位移被加回共享动效时本探针转红。
 */
import { createRequire } from 'node:module'

const require = createRequire(process.cwd() + '/package.json')
const { chromium } = require('playwright')

/** 行距参数照抄过程卡窗口：行高 24px、行间 1.75px、首行上方 3.5px */
const PAGE = (keyframes) => `<!doctype html><style>
  body { margin: 0; }
  .win { max-height: 120px; overflow-y: auto; }
  .body { display: flex; flex-direction: column; gap: 1.75px; margin-top: 3.5px; }
  .row { height: 24px; animation: row-in 300ms ease-out backwards; }
  @keyframes row-in { from { opacity: 0;${keyframes} } }
</style><div class="win" id="w"></div>`

/** 挂载 4 行（内容不足窗口高度），返回「挂载瞬间」与「动效结束后」的离底距离 */
async function sample(browser, keyframes) {
  const page = await browser.newPage({ deviceScaleFactor: 2 })
  await page.setContent(PAGE(keyframes))
  const geo = await page.evaluate(async () => {
    const w = document.getElementById('w')
    for (let i = 0; i < 4; i += 1) {
      const row = document.createElement('div')
      row.className = 'row'
      row.style.animationDelay = `${30 + i * 10}ms`
      w.appendChild(row)
    }
    const gap = () => w.scrollHeight - w.clientHeight - w.scrollTop
    const atMount = gap()
    await new Promise((resolve) => setTimeout(resolve, 600))
    return { atMount, settled: gap() }
  })
  await page.close()
  return geo
}

const browser = await chromium.launch()
const withShift = await sample(browser, ' transform: translateY(6px);')
const opacityOnly = await sample(browser, '')
await browser.close()

const problems = []
if (withShift.atMount - withShift.settled < 5) {
  problems.push(`带位移的动效没有撑大内容高度（挂载 ${withShift.atMount}px / 稳定 ${withShift.settled}px）——前提不成立，设计依据需重核`)
}
if (opacityOnly.atMount !== opacityOnly.settled) {
  problems.push(`只用透明度的动效改变了内容高度（挂载 ${opacityOnly.atMount}px / 稳定 ${opacityOnly.settled}px）`)
}
if (problems.length > 0) {
  console.error(`[probe] 失败：${problems.join('；')}`)
  process.exit(1)
}
console.log(
  `OK-MOTION 位移：挂载离底 ${withShift.atMount}px → 稳定 ${withShift.settled}px；仅透明度：挂载 ${opacityOnly.atMount}px = 稳定 ${opacityOnly.settled}px`,
)
