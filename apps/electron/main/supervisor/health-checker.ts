/**
 * 端口占用探测（TCP socket 连接尝试）。
 *
 * 供 port-discoverer 在选端口时探测候选端口是否已被占用。
 *
 * 依赖方向：health-checker → node:net
 */
import { createConnection } from 'node:net'

/**
 * 检测端口是否被监听（TCP socket 连接尝试）。
 *
 * 仅检测「端口有人占」，不验证业务就绪（无 HTTP /health 探活——启动成败
 * 由 runtime 进程的 exit 事件上报，不轮询）。
 *
 * 无连接超时（时间机制删除裁决：本机回环探测的连接等待删除）——回环地址的
 * 连接要么立即成功要么立即 ECONNREFUSED，结果以 connect/error 事件为准。
 *
 * @param port 目标端口
 * @returns true=端口在监听 / false=空闲或连接失败
 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
}
