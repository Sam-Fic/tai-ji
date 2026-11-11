/**
 * DialogContent elevated 档回归测试（2026-11-10 权限审批弹窗遮盖死锁修复）。
 *
 * 事故形态：插件权限批准弹窗与 provider 安装确认弹窗同为 --z-modal(1000) 层，
 * DOM 先序的审批弹窗被后序安装弹窗整块遮盖（真机 CDP 实证：安装弹窗矩形完全
 * 包含审批弹窗矩形）——审批门无时限，confirm RPC 永不返回，UI 卡「安装中」。
 * 消费接线断言（PermissionRequestDialog 传 elevated）在 extension-host 侧
 * PermissionRequestDialog.test.ts。
 *
 * 本文件锁三点：
 *  1. 缺省档 z 字面量不变（既有消费方像素级不变：var(--z-modal)）
 *  2. elevated 档遮罩+面板都升到 calc(var(--z-modal)+1)（只升其一 = 底层弹窗仍可
 *     交互的半修复形态，即红）
 *  3. elevated 是原语形态档不落 DOM（variant 同款 omit 语义）
 *
 * 测试模式：ConfirmDialog.test.ts 同款（reka Portal teleport 到 body，attachTo +
 * flushPromises 后查 body）。
 *
 * 运行：cd packages/ui && TAIJI_TEST_DOMAIN=shell npx vitest run src/primitives/dialog/__tests__/DialogContent.elevation.test.ts（本文件登记在 domain-map.json shell 域，默认档被排除）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import Dialog from '../Dialog.vue'
import DialogContent from '../DialogContent.vue'

/** 宿主组件：Dialog open + 单个 DialogContent（真实 Portal 链路） */
function mountContent(props: Record<string, unknown> = {}) {
  const Host = defineComponent({
    setup() {
      return () => h(Dialog, { open: true }, { default: () => h(DialogContent, { 'data-testid': 'probe-content', ...props }) })
    },
  })
  const wrapper = mount(Host, { attachTo: document.body })
  return wrapper
}

/** body 中面板元素（Portal 目标） */
function probeEl(): HTMLElement {
  const el = document.body.querySelector('[data-testid="probe-content"]')
  if (!(el instanceof HTMLElement)) throw new Error('probe-content 未渲染到 body（Portal 链路断？）')
  return el
}

/** body 中的遮罩元素（reka DialogOverlay，class 含 bg-scrim） */
function overlayEl(): HTMLElement {
  const el = Array.from(document.body.querySelectorAll('*')).find((n) => n.className.includes('bg-scrim'))
  if (!(el instanceof HTMLElement)) throw new Error('overlay 未渲染到 body')
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('DialogContent elevated 档（权限审批弹窗遮盖死锁修复）', () => {
  it('缺省档：面板与遮罩 z 字面量保持 var(--z-modal)（既有消费方形态不变）', async () => {
    mountContent()
    await flushPromises()
    expect(probeEl().className).toContain('z-[var(--z-modal)]')
    expect(probeEl().className).not.toContain('calc(var(--z-modal)+1)')
    expect(overlayEl().className).toContain('z-[var(--z-modal)]')
    expect(overlayEl().className).not.toContain('calc(var(--z-modal)+1)')
  })

  it('elevated 档：面板与遮罩 z 同升 calc(var(--z-modal)+1)（半修复形态 = 只升其一即红）', async () => {
    mountContent({ elevated: true })
    await flushPromises()
    expect(probeEl().className).toContain('z-[calc(var(--z-modal)+1)]')
    expect(probeEl().className).not.toContain('z-[var(--z-modal)]')
    expect(overlayEl().className).toContain('z-[calc(var(--z-modal)+1)]')
    expect(overlayEl().className).not.toContain('z-[var(--z-modal)]')
  })

  it('elevated 是原语形态档不落 DOM（variant 同款 omit 语义）', async () => {
    mountContent({ elevated: true })
    await flushPromises()
    expect(probeEl().hasAttribute('elevated')).toBe(false)
  })
})
