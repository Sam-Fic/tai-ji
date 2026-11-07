/**
 * shared provider.ts 凭据缺失呈现映射单测（U3/AX5 出站错误结构化映射的纯函数半边）。
 *
 * 守护：formatCredentialMissingPresentation 对 pi 凭据缺失文本三变体（形态一「No API key」
 * 前缀）+ 虚拟路由凭据拦截形态（形态二 routed to 尾锚）的提取与公共尾段产出；非命中返回
 * undefined（调用方原样透传）。消费方：runtime session-model-control（切换链分型）与
 * infra event-adapter（出站呈现映射）。pi 文本词表升级时本文件向量同步更新（同受
 * C-proc-08 探针族管辖）。
 */
import { describe, expect, it } from 'vitest'
import { PI_CREDENTIAL_MISSING_PREFIX, PI_VIRTUAL_ROUTE_NO_CREDENTIALS_PATTERN, formatCredentialMissingPresentation } from '../index.js'

describe('凭据缺失词表常量', () => {
  it('PI_CREDENTIAL_MISSING_PREFIX = No API key（pi setModel / pi-ai 出站共同前缀）', () => {
    expect(PI_CREDENTIAL_MISSING_PREFIX).toBe('No API key')
  })

  it('PI_VIRTUAL_ROUTE_NO_CREDENTIALS_PATTERN 命中 routed to 与尾锚之间的端点标识', () => {
    const matched = PI_VIRTUAL_ROUTE_NO_CREDENTIALS_PATTERN.exec(
      'Virtual model taiji-aggregate/glm-x routed to openai/gpt-4, which has no credentials.',
    )
    expect(matched?.[1]).toBe('openai/gpt-4')
  })
})

describe('formatCredentialMissingPresentation（形态一：No API key 前缀三变体）', () => {
  it('变体 1「No API key for <p>/<m>」：提取 provider/model 复合串', () => {
    expect(formatCredentialMissingPresentation('No API key for openai/gpt-4')).toBe(
      '模型调用失败：openai/gpt-4 的凭据缺失或已失效，请到设置页 Provider 分区更新该渠道的 API Key',
    )
  })

  it('变体 2「No API key for provider: <p>」：提取 provider 名', () => {
    expect(formatCredentialMissingPresentation('No API key for provider: deepseek')).toBe(
      '模型调用失败：deepseek 的凭据缺失或已失效，请到设置页 Provider 分区更新该渠道的 API Key',
    )
  })

  it('变体 3「No API key provided for provider "<p>"」：提取引号内 provider 名', () => {
    expect(formatCredentialMissingPresentation('No API key provided for provider "anthropic"')).toBe(
      '模型调用失败：anthropic 的凭据缺失或已失效，请到设置页 Provider 分区更新该渠道的 API Key',
    )
  })

  it('前缀命中但端点不可解析：退化为原文尾部（不丢呈现）', () => {
    expect(formatCredentialMissingPresentation('No API key')).toBe(
      '模型调用失败：No API key 的凭据缺失或已失效，请到设置页 Provider 分区更新该渠道的 API Key',
    )
  })
})

describe('formatCredentialMissingPresentation（形态二：虚拟路由凭据拦截）', () => {
  it('routed to 复合串提取：端点标识进入呈现文案（不以 No API key 开头，先行判定）', () => {
    expect(
      formatCredentialMissingPresentation(
        'Virtual model taiji-aggregate/glm-x routed to openai/gpt-4, which has no credentials.',
      ),
    ).toBe(
      '模型调用失败：openai/gpt-4 的凭据缺失或已失效，请到设置页 Provider 分区更新该渠道的 API Key',
    )
  })
})

describe('formatCredentialMissingPresentation（非命中透传）', () => {
  it('无前缀且无 routed to 形态：返回 undefined（调用方原样透传原文）', () => {
    expect(formatCredentialMissingPresentation('HTTP 429 too many requests')).toBeUndefined()
    expect(formatCredentialMissingPresentation('')).toBeUndefined()
  })
})
