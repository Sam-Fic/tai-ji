#!/usr/bin/env node
/**
 * 批3 真机探针 T5：CSP 双形态 × Web Worker（真实 Electron 二进制）。
 *
 * 判据 = 运行时读取 packages/renderer/index.html 的 CSP meta（不手抄，防漂移），
 * 在真实 Electron（与桌面壳同版本）里验证：
 *   ① file:// 文档（打包态形态）+ 该 CSP → 同源 file:// module worker（含 import 链）可建；
 *   ② http://127.0.0.1 文档（dev 态形态）+ 同 CSP → 同源 module worker 可建。
 * worker 形态与被测实装一致：new Worker(new URL('./x', import.meta.url), {type:'module'})
 * 编译后即「同源 URL + module + import 链」。
 *
 * 形态：env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/perf-probes/csp-worker-probe.cjs
 *   （ELECTRON_RUN_AS_NODE=1 会令 electron 退化为裸 Node，必须剥掉）
 *
 * 单窗口两次导航（不建第二个 BrowserWindow）：本环境第二个窗口的 GPU 进程
 * MachPort rendezvous 被拒（Permission denied）→ 二次创建窗口的加载恒 ERR_FAILED。
 *
 * 输出：FILE_MODULE_WORKER=OK / HTTP_MODULE_WORKER=OK；exit 0 = 双形态均 OK。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

// ── 运行时读取桌面壳 CSP（SSOT = packages/renderer/index.html）────────────────
const rendererHtml = fs.readFileSync(path.resolve(__dirname, '../packages/renderer/index.html'), 'utf8')
const cspMatch = rendererHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)
if (!cspMatch) {
  console.error('CSP meta not found in packages/renderer/index.html')
  app.exit(2)
}
const CSP = cspMatch[1]
console.log('CSP-IN-USE ' + CSP)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-csp-worker-'))
const write = (name, content) => fs.writeFileSync(path.join(dir, name), content)

// worker 与其 import 链（复刻 ui 包 worker「配置模块 + worker 本体」的 import 形态）
write('helper.mjs', "export const greet = (n) => 'hello-' + n\n")
write('worker.mjs', "import { greet } from './helper.mjs'\nself.onmessage = (e) => { self.postMessage({ echo: greet(e.data.who) }) }\n")
// 页面脚本外置：renderer CSP script-src 'self' 无 'unsafe-inline'，inline module script 会被拦
const pageScript = `
const log = (s) => { document.getElementById('out').textContent += ' | ' + s; console.log('PROBE ' + s) }
;(async () => {
  try {
    const w = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' })
    const r = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker-timeout-3s')), 3000)
      w.onmessage = (e) => { clearTimeout(timer); resolve(e.data) }
      w.onerror = (e) => { clearTimeout(timer); reject(new Error('worker-error-event: ' + (e.message || e.type))) }
      w.postMessage({ who: 'worker' })
    })
    log('FILE_MODULE_WORKER=OK ' + JSON.stringify(r))
    w.terminate()
  } catch (e) { log('FILE_MODULE_WORKER=FAIL ' + e.message) }
  log('DONE')
})()`
write('page.mjs', pageScript)
const page = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body><div id="out">pending</div><script type="module" src="./page.mjs"></script></body></html>`

/** 在当前窗口加载 url（file 路径或 http URL），等 #out 出现 DONE 后返回文本 */
async function probe(win, load) {
  await load()
  const deadline = Date.now() + 10000
  let text = ''
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      text = await win.webContents.executeJavaScript("document.getElementById('out')?.textContent ?? ''")
    } catch {
      continue // 导航中上下文被替换，重试
    }
    if (/DONE/.test(text)) break
  }
  return text
}

app.whenReady().then(async () => {
  write('file.html', page)
  write('http.html', page)
  const server = http.createServer((req, res) => {
    const p = req.url === '/' ? '/http.html' : req.url.split('?')[0]
    const f = path.join(dir, p)
    if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': f.endsWith('.mjs') ? 'text/javascript' : 'text/html' })
    res.end(fs.readFileSync(f))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })

  const fileText = await probe(win, () => win.loadFile(path.join(dir, 'file.html')))
  console.log('=== file:// (packaged form)')
  console.log(fileText)
  const fileOk = /FILE_MODULE_WORKER=OK/.test(fileText)

  const httpText = await probe(win, () => win.loadURL('http://127.0.0.1:' + port + '/http.html'))
  console.log('=== http://127.0.0.1 (dev form)')
  console.log(httpText)
  const httpOk = /FILE_MODULE_WORKER=OK/.test(httpText)
  console.log('HTTP_MODULE_WORKER=' + (httpOk ? 'OK' : 'FAIL'))

  win.destroy()
  server.close()
  const ok = fileOk && httpOk
  console.log('RESULT csp-worker-forms=' + (ok ? 'PASS' : 'FAIL'))
  // stdout 管道 flush：app.exit 是即时终止，重定向输出时未 flush 的行会丢
  setTimeout(() => app.exit(ok ? 0 : 1), 300)
})
