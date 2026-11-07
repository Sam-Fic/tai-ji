/**
 * provider-store-paths.ts 单测：provider 域跨进程落盘文件（providers.json /
 * quota-cache.json）路径纯公式。
 *
 * 被测函数是纯路径字符串推导（agentDir/dataDir 入参），全程不触任何真实数据目录、
 * 不做任何 fs 读断言；期望值用显式字符串字面量（POSIX 与 win32 形态各断言一遍，与
 * 跑测试的宿主平台无关——公式按基址内分隔符形态选分隔符，win32 基址输入必须产出
 * win32 形态输出，joinPath 注释见源文件）。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/provider-store-paths.test.ts
 */
import { describe, it, expect } from 'vitest'
import { getProviderExtrasPath, getQuotaCachePath, PROVIDERS_EXTRAS_FILENAME, QUOTA_CACHE_FILENAME } from '../provider-store-paths'

describe('getProviderExtrasPath（providers.json = <agentDir>/config/）', () => {
  it('POSIX agentDir 派生 config/providers.json 两段', () => {
    expect(getProviderExtrasPath('/home/u/.taiji/agent')).toBe('/home/u/.taiji/agent/config/providers.json')
  })

  it('文件名常量 = providers.json，且派生值以其收尾', () => {
    expect(PROVIDERS_EXTRAS_FILENAME).toBe('providers.json')
    expect(getProviderExtrasPath('/data/agent')).toBe('/data/agent/config/providers.json')
  })

  it('win32 agentDir 输入产出 win32 分隔符形态（\\ 拼接，不替换基址内分隔符）', () => {
    expect(getProviderExtrasPath('C:\\data\\taiji\\agent')).toBe('C:\\data\\taiji\\agent\\config\\providers.json')
  })

  it('基址以分隔符收尾时不重复补分隔符', () => {
    expect(getProviderExtrasPath('/data/agent/')).toBe('/data/agent/config/providers.json')
    expect(getProviderExtrasPath('C:\\data\\agent\\')).toBe('C:\\data\\agent\\config\\providers.json')
  })
})

describe('getQuotaCachePath（quota-cache.json = <dataDir>/ 根）', () => {
  it('dataDir 根直接派生文件名（无子目录段）', () => {
    expect(getQuotaCachePath('/home/u/.taiji')).toBe('/home/u/.taiji/quota-cache.json')
  })

  it('win32 dataDir 输入产出 win32 分隔符形态', () => {
    expect(getQuotaCachePath('C:\\data\\taiji')).toBe('C:\\data\\taiji\\quota-cache.json')
  })

  it('文件名常量 = quota-cache.json，且派生值以其收尾', () => {
    expect(QUOTA_CACHE_FILENAME).toBe('quota-cache.json')
    expect(getQuotaCachePath('/data')).toBe('/data/quota-cache.json')
  })

  it('扩展侧推导形态（dirname(getAgentDir()) 作 dataDir）与 runtime 侧（getDataDir）同值', () => {
    // 契约前提：托管形态 agentDir = <dataDir>/agent（AS6）。两侧基址不同进程各自解析，
    // 但喂进同一公式后必须产出同一路径——本断言以同一字符串模拟两侧输入。
    const dataDir = '/home/u/.taiji'
    const agentDir = `${dataDir}/agent`
    expect(getQuotaCachePath(dataDir)).toBe(getQuotaCachePath(dirnameOf(agentDir)))
  })
})

/** 测试局部 dirname（模拟扩展侧对 getAgentDir() 结果取 dirname 的推导步骤）。 */
function dirnameOf(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}
