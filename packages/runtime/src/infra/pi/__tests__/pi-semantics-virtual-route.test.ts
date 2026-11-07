/**
 * PS-98 / PS-99 探针：pi 虚拟模型路由凭据拦截词形 + 虚拟模型注册语义（provider-aggregation 域）。
 *
 * 登记条目（docs/pi-semantics.json）：
 * - PS-98：resolveModel 凭据拦截恒抛 `Virtual model <p>/<id> routed to <p>/<id>,
 *   which has no credentials.`（model-runtime.js:748-749），同函数 not-a-physical 前置分支
 *   （:746-747）同前缀非凭据形态——taiji 出站呈现映射按 PI_VIRTUAL_ROUTE_NO_CREDENTIALS_PATTERN
 *   整体形态判定（@taiji/shared formatCredentialMissingPresentation 形态二先行分流）。
 * - PS-99：registerVirtualModel 幂等替换（models.set 覆盖 + 物理冲突 throw + 纯虚拟 provider
 *   virtual auth 占位）+ 启动时序（pendingVirtualModelRegistrations 在 createAgentSessionServices
 *   内 flush，先于 main.js createRuntime 后段的 --model/--models 解析消费 modelRuntime）。
 *
 * 漂移后果：PS-98 词形漂移 = 出站错误结构化映射失守（错误原文经 stream_error 裸透传）；
 * PS-99 时序漂移 = CLI --model 引用虚拟路由 id 时注册未生效。pi 升级若改词形/时序，本探针
 * 变红拦截（C-proc-08 版本门禁强制重验）。
 *
 * 形态 = 探针族静态断言（直读 node_modules 实装 dist；dist 不可达整文件 skip）+ 双向对拍
 * （用 pi 模板串按运行时拼接方式合成错误文本，喂 taiji 词表断言仍命中）——pi 侧词形变化或
 * taiji 侧词表漂移任一发生都红。装置（locatePiCodingAgentDist / methodWindow /
 * methodWindowUntil）复用探针族共享单源 helpers/pi-semantics-probe.ts。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-semantics-virtual-route.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { locatePiCodingAgentDist, methodWindow, methodWindowUntil } from './helpers/pi-semantics-probe.js'
import {
  PI_CREDENTIAL_MISSING_PREFIX,
  PI_VIRTUAL_ROUTE_NO_CREDENTIALS_PATTERN,
  formatCredentialMissingPresentation,
} from '@taiji/shared'

const PI_DIST = locatePiCodingAgentDist()

const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'

const MODEL_RUNTIME_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'model-runtime.js'), 'utf-8') : ''
const SERVICES_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'core', 'agent-session-services.js'), 'utf-8') : ''
const MAIN_SRC = PI_DIST ? readFileSync(join(PI_DIST, 'main.js'), 'utf-8') : ''

describe.skipIf(!PI_DIST)(
  `PS-98 探针：虚拟模型路由凭据拦截词形（resolveModel 双分支 + taiji 词表对拍${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('resolveModel 内 routed 复合串模板与 not-a-physical / no-credentials 两分支 throw 词形在位', () => {
      const win = methodWindow(MODEL_RUNTIME_SRC, 'async resolveModel(model, messages, options) {')
      expect(win, 'PS-98 漂移：resolveModel 方法消失/改签名——复核 PS-98 锚点 dist/core/model-runtime.js').not.toBe('')
      expect(
        win.includes('const routed = `${name} routed to ${route.model.provider}/${route.model.id}`'),
        'PS-98 漂移：routed 复合串模板变更（词形 `<p>/<id> routed to <p>/<id>` 不再成立）——复核 PS-98 与 provider.ts 词表注释',
      ).toBe(true)
      expect(
        win.includes('which is not a physical model.'),
        'PS-98 漂移：not-a-physical 前置分支消失/改名（同前缀封闭性判定基准变化）——复核 PS-98',
      ).toBe(true)
      expect(
        win.includes('which has no credentials.'),
        'PS-98 漂移：凭据拦截分支词形变更（taiji 出站映射失守）——复核 PS-98 与 PI_VIRTUAL_ROUTE_NO_CREDENTIALS_PATTERN',
      ).toBe(true)
    })

    it('双向对拍：按 pi 模板运行时拼接的错误文本命中 taiji 词表并提取端点复合串', () => {
      // pi 实际拼接（model-runtime.js:744-745/749）：name = `Virtual model ${model.provider}/${model.id}`，
      // routed = `${name} routed to ${route.model.provider}/${route.model.id}`，终串附 `, which has no credentials.`
      const name = 'Virtual model agg-provider/route-1'
      const routed = `${name} routed to endpoint-provider/endpoint-1`
      const errorText = `${routed}, which has no credentials.`
      expect(
        errorText.startsWith(PI_CREDENTIAL_MISSING_PREFIX),
        '形态二不以 No API key 开头（formatCredentialMissingPresentation 先行分流的前提）',
      ).toBe(false)
      const captured = PI_VIRTUAL_ROUTE_NO_CREDENTIALS_PATTERN.exec(errorText)
      expect(
        captured,
        'PS-98 漂移：taiji 词表未命中 pi 实际词形——PI_VIRTUAL_ROUTE_NO_CREDENTIALS_PATTERN 须随 pi 词形同步改',
      ).not.toBeNull()
      expect(captured?.[1], 'PS-98 漂移：端点复合串捕获组偏移（routed to 与尾锚之间不再是端点标识）').toBe(
        'endpoint-provider/endpoint-1',
      )
      const presentation = formatCredentialMissingPresentation(errorText)
      expect(
        presentation,
        'PS-98 漂移：结构化映射未命中——formatCredentialMissingPresentation 对 pi 实际词形返回 undefined（错误原文将裸透传）',
      ).toBeDefined()
      expect(presentation).toContain('endpoint-provider/endpoint-1')
    })

    it('封闭性：not-a-physical 形态不被凭据词表误捕获（非凭据缺失走原文透传）', () => {
      const notPhysical =
        'Virtual model agg-provider/route-1 routed to endpoint-provider/endpoint-1, which is not a physical model.'
      expect(
        PI_VIRTUAL_ROUTE_NO_CREDENTIALS_PATTERN.exec(notPhysical),
        'PS-98 漂移：非凭据形态被误捕获——词表需收紧（which is not a physical model 不属凭据缺失）',
      ).toBeNull()
      expect(formatCredentialMissingPresentation(notPhysical)).toBeUndefined()
    })
  },
)

describe.skipIf(!PI_DIST)(
  `PS-99 探针：registerVirtualModel 幂等替换 + pending flush 先于 --model 解析（${SKIP_REASON ? `skip：${SKIP_REASON}` : '注册替换语义 + 启动时序'}）`,
  () => {
    it('registerVirtualModel：物理冲突 throw + models.set 覆盖注册（重复注册替换旧定义）+ virtual auth 占位', () => {
      const win = methodWindow(MODEL_RUNTIME_SRC, 'registerVirtualModel(definition) {')
      expect(win, 'PS-99 漂移：registerVirtualModel 消失/改名——复核 PS-99 锚点 dist/core/model-runtime.js').not.toBe('')
      expect(
        win.includes('conflicts with a physical model'),
        'PS-99 漂移：物理模型冲突拦截消失（物理 id 可被虚拟定义覆盖）——复核 PS-99',
      ).toBe(true)
      expect(
        win.includes('models.set(id, '),
        'PS-99 漂移：覆盖注册形态变更（重复注册不再替换旧定义，幂等前提失效）——复核 PS-99',
      ).toBe(true)
      expect(
        win.includes('source: "virtual"'),
        'PS-99 漂移：纯虚拟 provider 的 virtual auth 占位消失（session restore 在 refresh 落地前判 configured 的前提变化）——复核 PS-99',
      ).toBe(true)
    })

    it('启动时序：pendingVirtualModelRegistrations 在 createAgentSessionServices 内 flush（注册→清空→refresh）', () => {
      // 窗口下界 = flush 段首个出现点（:98 循环），上界 = 其后的 createAgentSessionFromServices（:129）
      const win = methodWindowUntil(SERVICES_SRC, 'pendingVirtualModelRegistrations', 'createAgentSessionFromServices')
      expect(win, 'PS-99 漂移：pending flush 段消失——复核 PS-99 锚点 dist/core/agent-session-services.js').not.toBe('')
      expect(
        win.includes('modelRuntime.registerVirtualModel(definition)'),
        'PS-99 漂移：flush 不再逐条调 registerVirtualModel——扩展注册通路断裂',
      ).toBe(true)
      const clearIdx = win.indexOf('pendingVirtualModelRegistrations = []')
      const refreshIdx = win.indexOf('await modelRuntime.refresh({ allowNetwork: false })')
      expect(clearIdx, 'PS-99 漂移：flush 后不再清空队列（重复 flush / 重复注册）——复核 PS-99').toBeGreaterThanOrEqual(0)
      expect(
        refreshIdx,
        'PS-99 漂移：flush 后的 refresh({allowNetwork:false}) 消失——快照不含虚拟模型',
      ).toBeGreaterThan(clearIdx)
    })

    it('main.js createRuntime 内 services 创建（flush 点）先于 --model/--models 解析消费 modelRuntime', () => {
      // 窗口 = createRuntime 函数体（定义起点到其后 time("createRuntime") 计时点，两边界全文唯一）
      const win = methodWindowUntil(MAIN_SRC, 'const createRuntime = async (', 'time("createRuntime")')
      expect(win, 'PS-99 漂移：createRuntime 结构变化——复核 PS-99 锚点 dist/main.js').not.toBe('')
      const servicesIdx = win.indexOf('await createAgentSessionServices(')
      const scopeIdx = win.indexOf('await resolveModelScope(modelPatterns, modelRuntime')
      const optionsIdx = win.indexOf('buildSessionOptions(parsed, scopedModels')
      expect(servicesIdx, 'PS-99 漂移：services 创建点消失——复核 PS-99').toBeGreaterThanOrEqual(0)
      expect(scopeIdx, 'PS-99 漂移：resolveModelScope 消费点消失——复核 PS-99').toBeGreaterThanOrEqual(0)
      expect(optionsIdx, 'PS-99 漂移：buildSessionOptions 消费点消失——复核 PS-99').toBeGreaterThanOrEqual(0)
      expect(
        servicesIdx < scopeIdx && servicesIdx < optionsIdx,
        `PS-99 漂移：--model/--models 解析（offset ${scopeIdx}/${optionsIdx}）先于 services 创建（offset ${servicesIdx}）——虚拟路由注册晚于解析，--model 引用路由 id 将未定义`,
      ).toBe(true)
    })
  },
)
