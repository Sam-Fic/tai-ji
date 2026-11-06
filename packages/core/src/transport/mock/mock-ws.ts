/* eslint-disable no-magic-numbers -- mock WS 桩的握手延迟/状态码等字面量属桩行为参数，非逻辑魔数 */
/**
 * Mock WebSocket —— VITE_MOCK=true 时替代真实 WS 连接。
 *
 * 重建最小版：只模拟连接状态机（connecting → connected），
 * 不灌业务数据（连接骨架不需要 session/chat 数据）。
 * WebSocketLike 桩只处理 ping → pong（维持心跳语义）。
 *
 * 后续加业务功能时，在此扩展 mock 数据响应（参考 git 历史的 mock/data.ts）。
 *
 * 依赖方向：renderer 的 resolve-platform 在 VITE_MOCK 时 providePlatform(
 * createMockPlatform(globalThis.localStorage))；core ws-client 经
 * platform.webSocket.create(url) 拿桩（回调以 WebSocketLike 事件注入）。
 * mock-ws 不 import ws-client（避免循环依赖）。
 */
import type { ClientMessage, ServerMessage } from '@taiji/shared'
// 相对路径直达定义处（platform/port.ts）：经 '@taiji/core' barrel 回引会成环，ESM 序隐患
import type { PlatformPort, WebSocketLike, KVStorage } from '../../platform/port'
import { WS_READY_STATE } from '../../platform/port'

// ── createMockPlatform（platform 注入层 mock）──────────────────────────

/**
 * 播种源最小结构（宿主同步 storage 的读子集，结构性声明、不引 DOM 类型）：
 * core 包 lint 禁 localStorage 裸标识符（no-restricted-globals），宿主 localStorage
 * 由壳侧（renderer resolve-platform VITE_MOCK 分支）读取后经参数注入。
 */
interface SyncStorageSeed {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
}

/**
 * 最小 in-memory KVStorage 实现（get 不存在返回 null）。
 *
 * 创建时从注入的播种源同步读一次（**读路径保真**）：桌面 platform 的 storage 是
 * LocalStorageAdapter（boot 读直连 localStorage），纯内存 Map 会让「重启重放」类断言
 * （font-system RL7：seed localStorage → reload → 生产 boot 链读回）在 mock 层无法表达
 * 给定条件。播种只发生在 create 时刻、只读不写——写仍是内存态（reload 即失，与桌面
 * 持久化写不同；本 mock 只承诺 boot 读路径与桌面同形）。
 * 播种源为注入参数，core 不自行读宿主：未注入（undefined/null，含无 DOM 环境的单测）
 * 时静默跳过播种，回落纯内存语义。
 */
function createInMemoryStorage(seedStorage?: SyncStorageSeed | null): KVStorage {
  const map = new Map<string, string>()
  if (seedStorage) {
    for (let index = 0; index < seedStorage.length; index += 1) {
      const key = seedStorage.key(index)
      if (key !== null) map.set(key, seedStorage.getItem(key) ?? '')
    }
  }
  return {
    async get(key) {
      return map.has(key) ? (map.get(key) as string) : null
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
  }
}

/**
 * 创建 mock WebSocketLike 桩，复刻旧 mockConnect + mockSend 语义：
 * - 初始 readyState=CONNECTING，200ms 后 readyState=OPEN 并 trigger onopen（连接建立）
 * - send(data) 解析 JSON，type==='ping' 时 10ms 后 trigger onmessage 回灌 pong（心跳响应）
 * - close() readyState=CLOSED 并 trigger onclose
 *
 * ws-client(core) 经 platform.webSocket.create(url) 拿到此桩，行为与旧 VITE_MOCK 路径一致。
 */
function createMockWebSocket(_url: string): WebSocketLike {
  let readyState: number = WS_READY_STATE.CONNECTING
  const ws: WebSocketLike = {
    get readyState() {
      return readyState
    },
    send(data: string) {
      try {
        const msg = JSON.parse(data) as ClientMessage
        if (msg.type === 'ping') {
          const pong: ServerMessage = { type: 'pong', payload: {} }
          setTimeout(() => ws.onmessage?.({ data: JSON.stringify(pong) }), 10)
        }
        // eslint-disable-next-line taste/no-silent-catch -- 非 JSON 消息解析失败，跳过
      } catch {
        // 非 JSON 消息，忽略
      }
    },
    close() {
      readyState = WS_READY_STATE.CLOSED
      ws.onclose?.()
    },
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
  }
  // 复刻 mockConnect 200ms connecting→connected
  setTimeout(() => {
    readyState = WS_READY_STATE.OPEN
    ws.onopen?.()
  }, 200)
  return ws
}

/**
 * 创建 mock PlatformPort —— 供后续 wave bootstrap 在 VITE_MOCK=true 时
 * providePlatform(createMockPlatform(globalThis.localStorage))，使 core ws-client
 * 走 mock 连接路径。
 *
 * - kind: 'mock'
 * - storage: 最小 in-memory KVStorage（seedStorage 注入播种源，create 时读一次）
 * - webSocket: WebSocketFactory（create 返回复刻旧 mock 语义的桩）
 */
export function createMockPlatform(seedStorage?: SyncStorageSeed | null): PlatformPort {
  return {
    kind: 'mock',
    storage: createInMemoryStorage(seedStorage),
    webSocket: { create: createMockWebSocket },
  }
}
