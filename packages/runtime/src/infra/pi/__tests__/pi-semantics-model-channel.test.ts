/**
 * PS-100 探针：模型调用通道对虚拟模型的感知能力不对称（扩展侧选通道的依据）。
 *
 * 登记条目（docs/pi-semantics.json PS-100）：
 * - ① `@earendil-works/pi-ai/compat` 的 streamSimple/completeSimple 是静态目录分发层：
 *   按 `model.api` 查 compat 自带的 apiProviderRegistry（BUILTIN_APIS 十项，无 `pi-virtual`），
 *   虚拟模型恒抛 `No API provider registered for api: ${api}`（resolveApiProvider）。
 * - ② `ModelRegistry.streamSimple`（→ ModelRuntime.streamSimple）有 `if (isVirtualModel(model))`
 *   分支：先 resolveModel 选物理端点与档位，再递归走物理端点通道。
 * - ③ `lazyStream` 把 setup 期异常转成 `stopReason:"error"` + `errorMessage`（content 空、
 *   不 reject）——消费方必须读 errorMessage 才能拿到失败原因。
 *
 * 漂移后果：①的通路被扩展误用 = 会话模型是聚合路由时所有扩展侧 LLM 调用全灭
 * （2026-11-23 事故：smart-context 后台压缩连续失败三次熔断，错误仅进 warn 日志）；
 * ③漂移 = 失败原因再次不可见。
 *
 * 形态 = 静态断言（直读 node_modules 实装 dist）+ 运行时对拍（真实 compat 调虚拟模型必抛
 * 该错误；ModelRegistry 原型上两条通路俱在）。dist 不可达整文件 skip。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-model-channel.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { completeSimple } from '@earendil-works/pi-ai/compat'
import { describe, expect, it } from 'vitest'
import { locatePiCodingAgentDist, locatePiDist, methodWindow } from './helpers/pi-semantics-probe.js'

const PI_DIST = locatePiCodingAgentDist()
const AI_DIST = locatePiDist('pi-ai', 'compat.js')

const SKIP_REASON = PI_DIST && AI_DIST ? '' : 'node_modules/@earendil-works/{pi-coding-agent,pi-ai}/dist 不可达（cwd 上溯 6 级未命中）'

const COMPAT_SRC = AI_DIST ? readFileSync(join(AI_DIST, 'compat.js'), 'utf-8') : ''
const LAZY_SRC = AI_DIST ? readFileSync(join(AI_DIST, 'api', 'lazy.js'), 'utf-8') : ''
const RUNTIME_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'model-runtime.js'), 'utf-8') : ''
const REGISTRY_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'model-registry.js'), 'utf-8') : ''
const VIRTUAL_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'virtual-models.js'), 'utf-8') : ''

describe.skipIf(!PI_DIST || !AI_DIST)(
  `PS-100 探针：模型调用通道 × 虚拟模型（${SKIP_REASON || 'compat 静态分发 / registry 虚拟分支 / lazyStream 错误载荷'}）`,
  () => {
    it('① compat 是静态 api 分发层：BUILTIN_APIS 不含 pi-virtual，未命中即 throw', () => {
      expect(
        COMPAT_SRC.includes('const BUILTIN_APIS = ['),
        'PS-100 漂移：BUILTIN_APIS 常量消失/改名——复核 PS-100 锚点 pi-ai dist/compat.js',
      ).toBe(true)
      expect(
        COMPAT_SRC.includes('pi-virtual'),
        'PS-100 漂移：compat 现在认识 pi-virtual —— 通道不对称消失，PS-100 结论与 ①锚点需重写（扩展侧可直连 compat）',
      ).toBe(false)
      const win = methodWindow(COMPAT_SRC, 'function resolveApiProvider(api) {')
      expect(win, 'PS-100 漂移：resolveApiProvider 消失/改名——复核 PS-100 锚点').not.toBe('')
      expect(
        win.includes('No API provider registered for api:'),
        'PS-100 漂移：compat 未命中错误文案变更（taiji 侧排障串与事故归因依据）——复核 PS-100',
      ).toBe(true)
      // streamSimple / completeSimple 都经 resolveApiProvider 分发（不是各自持有注册表）
      expect(
        COMPAT_SRC.includes('const provider = resolveApiProvider(model.api);'),
        'PS-100 漂移：compat 的 streamSimple/completeSimple 不再经 resolveApiProvider 分发——复核 PS-100',
      ).toBe(true)
    })

    it('② ModelRuntime.streamSimple 有虚拟模型分支（先 route 再递归物理端点），completeSimple 委托它', () => {
      const win = methodWindow(RUNTIME_SRC, '    streamSimple(model, context, options) {')
      expect(win, 'PS-100 漂移：ModelRuntime.streamSimple 消失/改名——复核 PS-100').not.toBe('')
      expect(
        win.includes('if (isVirtualModel(model))'),
        'PS-100 漂移：虚拟模型分支消失——扩展侧唯一的虚拟模型感知通路断裂（压缩/标题/分类器全灭）',
      ).toBe(true)
      expect(
        win.includes('resolveModel(model, transcript.messages'),
        'PS-100 漂移：虚拟分支不再先 resolveModel（路由）——复核 PS-100',
      ).toBe(true)
      expect(
        win.includes('this.streamSimple(route.model'),
        'PS-100 漂移：虚拟分支不再递归转发到物理端点——复核 PS-100',
      ).toBe(true)
      expect(
        win.includes('thinkingLevel: options?.reasoning ?? "off"'),
        'PS-100 漂移：路由此刻的档位取值变更（缓存一致性前提：调用方 reasoning 必须与会话同值透传）——复核 PS-100',
      ).toBe(true)
      const completeWin = methodWindow(RUNTIME_SRC, '    completeSimple(model, context, options) {')
      expect(
        completeWin.includes('this.streamSimple(model, context, options).result()'),
        'PS-100 漂移：completeSimple 不再委托 streamSimple（虚拟分支绕行）——复核 PS-100',
      ).toBe(true)
    })

    it('② 扩展侧门面：ModelRegistry.streamSimple / complete 委派随 runtime（虚拟感知通路可达）', () => {
      const win = methodWindow(REGISTRY_SRC, '    streamSimple(model, context, options) {')
      expect(win, 'PS-100 漂移：ModelRegistry.streamSimple 消失/改名——复核 PS-100').not.toBe('')
      expect(
        win.includes('this.runtime.streamSimple(model, context, options)'),
        'PS-100 漂移：门面不再委派 runtime（虚拟分支丢失）——复核 PS-100',
      ).toBe(true)
      expect(
        REGISTRY_SRC.includes('this.runtime.complete(model, context, options)'),
        'PS-100 漂移：ModelRegistry.complete 不再委派 runtime——复核 PS-100',
      ).toBe(true)
      // 虚拟模型 api 常量（taiji 侧 provider-aggregation 的注册语义与探针共享同一字面值）
      expect(
        VIRTUAL_SRC.includes('export const VIRTUAL_MODEL_API = "pi-virtual"'),
        'PS-100 漂移：pi-virtual 常量值变更——provider-aggregation 注册与所有虚拟模型判定失效',
      ).toBe(true)
    })

    it('③ lazyStream 把 setup 失败转成 errorMessage（content 空、不 reject）', () => {
      const win = methodWindow(LAZY_SRC, 'function createSetupErrorMessage(model, error) {')
      expect(win, 'PS-100 漂移：createSetupErrorMessage 消失/改名——复核 PS-100').not.toBe('')
      expect(
        win.includes('errorMessage: error instanceof Error ? error.message : String(error)'),
        'PS-100 漂移：setup 失败不再写入 errorMessage——失败原因对消费方不可见（压缩失败只剩「未返回结果」）',
      ).toBe(true)
      expect(
        win.includes('stopReason: "error"'),
        'PS-100 漂移：setup 失败不再标记 stopReason="error"——复核 PS-100',
      ).toBe(true)
      // lazyStream 体内 setup()…catch(…) 两段：methodWindow 的边界正则会把 `setup()` 误判为
      // 下一个方法头，故这层断言直接对全文（函数与 body 同文件、符号名唯一）。
      expect(
        LAZY_SRC.includes('setup()\n        .then((inner) => forwardStream(outer, inner))\n        .catch((error) => {'),
        'PS-100 漂移：lazyStream 不再 catch setup 异常（改为 reject）——消费方错误归一路径需同步复核',
      ).toBe(true)
    })

    it('运行时对拍：真实 compat 对虚拟模型必抛该错误（通道不对称的活证据）', async () => {
      const virtualModel = {
        id: 'route',
        provider: 'aggregation',
        name: 'GLM-Flash',
        api: 'pi-virtual',
        baseUrl: '',
        reasoning: false,
      }
      await expect(completeSimple(virtualModel as never, { messages: [] }, {})).rejects.toThrow(
        /No API provider registered for api: pi-virtual/,
      )
    })
  },
)
