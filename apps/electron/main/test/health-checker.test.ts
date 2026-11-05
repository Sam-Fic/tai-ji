/**
 * health-checker 端口占用探测测试（isPortInUse，port-discoverer 选端口消费）。
 *
 * 被测语义：TCP socket 连接尝试——监听中的回环端口返回 true；连接失败
 * （ECONNREFUSED）返回 false。无连接超时（时间机制删除裁决：回环探测以
 * connect/error 事件为准）。
 *
 * Mock 策略：真实 net server 绑 127.0.0.1 随机端口（listen 0），不触外网。
 *
 * 运行：cd apps/electron/main && npx vitest run test/health-checker.test.ts
 */
import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:net'
import { isPortInUse } from '../supervisor/health-checker.js'

/** 在 127.0.0.1 随机端口上启动 TCP server，返回实际端口。 */
async function listenOnRandomPort(): Promise<{ server: Server; port: number }> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { server, port }
}

/** 关闭 server 并等 'close' 事件（否则句柄悬挂拖慢 vitest 收尾）。 */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe('health-checker isPortInUse（TCP 端口占用探测）', () => {
  it('监听中的回环端口 → true（存在监听者即占用）', async () => {
    const { server, port } = await listenOnRandomPort()
    try {
      await expect(isPortInUse(port)).resolves.toBe(true)
    } finally {
      await closeServer(server)
    }
  })

  it('已释放的回环端口 → false（ECONNREFUSED 按「空闲」处理）', async () => {
    const { server, port } = await listenOnRandomPort()
    await closeServer(server)
    await expect(isPortInUse(port)).resolves.toBe(false)
  })
})
