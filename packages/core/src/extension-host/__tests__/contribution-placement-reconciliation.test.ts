// contribution-placement-reconciliation.test.ts —— 贡献类型 ↔ placement ↔ 壳注册挂载点清单三方对账（机器防线）。
//
// 防的缺口：PLACEMENT_BY_TYPE 的映射值与壳实际注册的挂载点清单失配——贡献被 routeAll
// 判 available=false 并刷 unregistered-mount-point 告警。prod console 每次启动 6 条
// 「贡献 X 引用未注册挂载点 'slash'/'commands'，已置灰」即历史失配实例（这两个名字
// 自初始导入提交起就不存在；configuration 的 'settings' 同为失配名，正确名 =
// settings.section，本次已对齐）。
//
// 取数源（单一权威，禁 grep 源码扫描）：
//   - 映射表 = contribution-registry.ts 的 PLACEMENT_BY_TYPE（导出常量）
//   - 注册清单 = bootstrap.ts 的 REGISTERED_MOUNT_POINTS（registerMountPoints 循环消费它，
//     注册序即数组序——改注册点只改这一处）
//   - 豁免清单 = contribution-registry.ts 的 MOUNT_POINT_CHECK_EXEMPT_TYPES（逐条带理由）
//
// 断言四向：
//   ① 正向：PLACEMENT_BY_TYPE 每个映射值 ∈ REGISTERED_MOUNT_POINTS，或其类型 ∈ 豁免清单；
//   ② 豁免卫生：豁免清单每条带非空理由、键 ⊆ PLACEMENT_BY_TYPE 键（无死豁免、无无理由豁免）；
//   ③ 清单卫生：REGISTERED_MOUNT_POINTS 无重复项；
//   ④ 行为锁定：builtin 全贡献经 routeAll 后 available=true 且零 unregistered-mount-point
//     emit（6 条误告警的回归锚）；同时反向对照 view 型未注册 placement 仍判 unavailable
//     （豁免只关 command/slashCommand，没有把真失配检查一起关掉）。
import { describe, it, expect } from 'vitest'
import {
  ContributionRegistry,
  MOUNT_POINT_CHECK_EXEMPT_TYPES,
  PLACEMENT_BY_TYPE,
} from '../contribution-registry'
import { REGISTERED_MOUNT_POINTS } from '../../bootstrap'
import { InternalEventBus } from '../internal-event-bus'
import { MountPointRegistry } from '../mount-point-registry'
import type { InternalEvent } from '../types'

const registeredMountPoints = new Set<string>(REGISTERED_MOUNT_POINTS)
const exemptTypes = new Set<string>(Object.keys(MOUNT_POINT_CHECK_EXEMPT_TYPES))

describe('贡献类型 ↔ placement ↔ 壳注册挂载点清单三方对账', () => {
  it('① PLACEMENT_BY_TYPE 每个映射值是已注册挂载点，或其类型在挂载点校验豁免清单内', () => {
    const unaccounted = Object.entries(PLACEMENT_BY_TYPE).filter(
      ([type, placement]) => !registeredMountPoints.has(placement) && !exemptTypes.has(type),
    )
    // 消息可操作：缺恢复动作（三选一的具体落点）+ 权威源指针
    expect(
      unaccounted.map(([type, placement]) => `${type} → '${placement}'`),
      `以下贡献类型的 placement 既不在壳注册挂载点清单内、该类型也未登记豁免：${unaccounted
        .map(([type, placement]) => `${type} → '${placement}'`)
        .join('，')}。` +
        '恢复（按贡献的实际消费方式三选一）：' +
        '① 该贡献确实渲染在某个容器 → 在 packages/core/src/bootstrap.ts 的 REGISTERED_MOUNT_POINTS 增加挂载点（壳需有对应渲染宿主）；' +
        '② 该类型不消费渲染容器 → 在 packages/core/src/extension-host/contribution-registry.ts 的 MOUNT_POINT_CHECK_EXEMPT_TYPES 登记类型与豁免理由；' +
        '③ placement 名字写错 → 改为 REGISTERED_MOUNT_POINTS 内的正确名字（历史失配例：configuration 曾写 settings，正确名 settings.section）',
    ).toEqual([])
  })

  it('② 豁免清单每条带非空理由，且键都是 PLACEMENT_BY_TYPE 已登记类型（无死豁免、无无理由豁免）', () => {
    const missingReason = Object.entries(MOUNT_POINT_CHECK_EXEMPT_TYPES)
      .filter(([, reason]) => reason.trim() === '')
      .map(([type]) => type)
    expect(
      missingReason,
      `以下豁免类型缺理由：${missingReason.join('，')}。恢复：在 contribution-registry.ts 的 MOUNT_POINT_CHECK_EXEMPT_TYPES 补该类型的豁免理由（说明命令展示/执行走哪条通道、为什么不消费渲染容器）`,
    ).toEqual([])

    const orphanKeys = Object.keys(MOUNT_POINT_CHECK_EXEMPT_TYPES).filter(
      (type) => !(type in PLACEMENT_BY_TYPE),
    )
    expect(
      orphanKeys,
      `以下豁免类型没有对应 placement 映射（死豁免）：${orphanKeys.join('，')}。恢复：在 PLACEMENT_BY_TYPE 补该类型映射，或从 MOUNT_POINT_CHECK_EXEMPT_TYPES 删除该条目`,
    ).toEqual([])
  })

  it('③ 壳注册挂载点清单无重复项', () => {
    const duplicates = REGISTERED_MOUNT_POINTS.filter(
      (name, i) => REGISTERED_MOUNT_POINTS.indexOf(name) !== i,
    )
    expect(
      duplicates,
      `REGISTERED_MOUNT_POINTS 含重复挂载点：${duplicates.join('，')}。恢复：删除 packages/core/src/bootstrap.ts 清单中的重复项`,
    ).toEqual([])
  })

  it('④ builtin 全贡献经 routeAll 后 available=true 且零 unregistered-mount-point emit（6 条误告警回归锚）', () => {
    const bus = new InternalEventBus()
    const contributions = new ContributionRegistry(bus)
    contributions.registerBuiltin()
    const mounts = new MountPointRegistry()
    for (const name of REGISTERED_MOUNT_POINTS) mounts.register(name)
    const seen: Array<Extract<InternalEvent, { kind: 'unregistered-mount-point' }>> = []
    bus.on('unregistered-mount-point', (e) => seen.push(e))

    contributions.routeAll(mounts)

    const records = contributions.getContributions()
    // prod console 6 条告警的来源 = scheduler-manager 3 条 command + tasks/scheduler 3 条 slashCommand
    const commandLike = records.filter((r) => r.type === 'command' || r.type === 'slashCommand')
    expect(commandLike).toHaveLength(6)
    // 豁免后 builtin 全部可用（command/slashCommand 走豁免，headerAction 的 panel.header 已注册）
    expect(records.every((r) => r.available)).toBe(true)
    expect(seen).toEqual([])

    // 反向对照：view 型未注册 placement 仍判 available=false + emit——豁免只关
    // command/slashCommand，真失配检查没有被一起关掉
    contributions.loadExternal([
      {
        pluginId: 'reconciliation-probe',
        contributes: { views: [{ id: 'probe.bad', title: '坏声明', placement: 'nonexistent.slot' }] },
      },
    ])
    contributions.routeAll(mounts)
    expect(contributions.getContributions({ pluginId: 'reconciliation-probe' })[0]?.available).toBe(false)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      kind: 'unregistered-mount-point',
      pluginId: 'reconciliation-probe',
      contributionId: 'probe.bad',
      expectedMountPoint: 'nonexistent.slot',
    })
  })
})
