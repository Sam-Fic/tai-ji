/**
 * 字体 IPC 边界 E2E —— 真机断言（font-system u-verify）。
 *
 * 本 spec 覆盖 `font:read-bytes` 这条**新增跨进程通道**的边界（设计 D10 / RL20）。
 * 为什么必须真机：它验的是「主进程真的拒了」，而不是「renderer 侧的函数返回值对不对」。
 * 纯校验函数的三关（扩展名 / 20MB / magic）与四类禁区在 L1 单测里已覆盖
 * （apps/electron/main/gateway/__tests__/font-handlers.test.ts），本文件只验真机行为。
 *
 * 覆盖：
 * - RL20(c) 请求读一个 .txt → 收到明确拒绝（不崩溃、不返回垃圾字节）
 * - RL20(d) 请求读一个 25MB 伪造字体 → 拒绝。本 spec 只断言 ① 拒绝路径（ok=false + reason）；
 *           设计判据 ③（stat 之后没有 readFile 调用形态）= L1 权威判据，已在
 *           apps/electron/main/gateway/__tests__/font-handlers.test.ts 落位（spy 注入假 IO）；
 *           判据 ②（external 内存增量）登记豁免——playwright 侧无法直接采样主进程
 *           external 内存（heapUsed 不可用的实测依据见设计 §4.2 RL20 行）
 * - 禁区 <dataDir>/agent/**：请求读凭据（auth.json）经真实 IPC → 拒绝
 *           （设计 RL20 表仅列 (b) 为 L1；此处是增补的真机拦截断言，设计行已同批回写）
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE npx playwright test e2e/font-custom-ipc.spec.ts --project=electron
 *
 * 触发条件（R2 登记，e2e-map = E2E-FONTS-03）：改 apps/electron/main/gateway/font-handlers.ts、
 * preload 的 readFontBytes、packages/shared 的 READ_FONT_BYTES 通道时跑本 spec。
 */
import { test, expect } from './fixtures/launch-app'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 建一个临时 fixture 目录（测试自建自删，禁碰真实数据目录）。 */
function makeTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `taiji-font-e2e-${label}-`))
}

test.describe('font:read-bytes 通道边界（font-system）', () => {
  test('RL20(c) 非字体文件被拒，且不返回垃圾字节', async ({ page }) => {
    const dir = makeTmpDir('txt')
    const txt = path.join(dir, 'not-a-font.txt')
    fs.writeFileSync(txt, 'this is definitely not a font file', 'utf-8')

    try {
      const result = await page.evaluate(async (filePath: string) => {
        const api = (window as unknown as { electronAPI?: { readFontBytes?: (p: string) => Promise<unknown> } }).electronAPI
        if (!api?.readFontBytes) return { unavailable: true }
        return await api.readFontBytes(filePath)
      }, txt)

      expect(result, 'preload 未暴露 readFontBytes').not.toEqual({ unavailable: true })
      const r = result as { ok: boolean; reason?: string; bytes?: unknown }
      expect(r.ok).toBe(false)
      expect(typeof r.reason).toBe('string')
      expect((r.reason ?? '').length).toBeGreaterThan(0)
      // 拒绝时不得携带字节
      expect(r.bytes).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test('RL20(d) 超过 20MB 的文件被拒，且不读入内存', async ({ page }) => {
    const dir = makeTmpDir('big')
    const big = path.join(dir, 'huge.woff2')
    // 写 25MB：用真实写盘而非稀疏文件——稀疏文件在某些 stat 实现里 byteLength 仍正确，
    // 但这里要验的是「先 stat 拦下」，两者都能命中，用真实写盘更贴近用户场景。
    const chunk = Buffer.alloc(1024 * 1024, 0x77)
    const fd = fs.openSync(big, 'w')
    for (let i = 0; i < 25; i++) fs.writeSync(fd, chunk)
    fs.closeSync(fd)

    try {
      const result = await page.evaluate(async (filePath: string) => {
        const api = (window as unknown as { electronAPI?: { readFontBytes?: (p: string) => Promise<unknown> } }).electronAPI
        if (!api?.readFontBytes) return { unavailable: true }
        return await api.readFontBytes(filePath)
      }, big)

      const r = result as { ok: boolean; reason?: string }
      expect(r.ok).toBe(false)
      expect(typeof r.reason).toBe('string')
      // 拒绝理由应指向大小（人可读，不是错误码）
      expect((r.reason ?? '').length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  test('RL20(b) 凭据目录禁区：<dataDir>/agent 下的文件被拒', async ({ page }) => {
    // 用当前 e2e 隔离数据目录构造禁区路径（launch-app 注入 TAIJI_AGENT_DATA_DIR）
    const dataDir = process.env.TAIJI_AGENT_DATA_DIR ?? ''
    test.skip(!dataDir, '未注入 TAIJI_AGENT_DATA_DIR，跳过禁区断言')

    const agentDir = path.join(dataDir, 'agent')
    fs.mkdirSync(agentDir, { recursive: true })
    const probe = path.join(agentDir, 'auth.json')
    const existed = fs.existsSync(probe)
    if (!existed) fs.writeFileSync(probe, '{"probe":true}', 'utf-8')

    try {
      const result = await page.evaluate(async (filePath: string) => {
        const api = (window as unknown as { electronAPI?: { readFontBytes?: (p: string) => Promise<unknown> } }).electronAPI
        if (!api?.readFontBytes) return { unavailable: true }
        return await api.readFontBytes(filePath)
      }, probe)

      const r = result as { ok: boolean; reason?: string }
      expect(r.ok, '凭据目录未被禁区拦截').toBe(false)
    } finally {
      if (!existed) fs.rmSync(probe, { force: true })
    }
  })
})
