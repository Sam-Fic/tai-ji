/**
 * settings 域类型 SSOT —— core 包内唯一 SystemSettings 定义点。
 *
 * [迁移] strangler 迁移自 packages/renderer/src/api/domains/settings.ts 的本地定义（DM1）。
 * 与 @taiji/shared 核对结果（C-W1-1）：
 * - shared 无 SystemSettings（shared/src/settings.ts 仅 ToolPermission/ThemeMode/ThemePreset）
 *   → 本文件定义并导出，renderer 侧 W4 收编为从 core import。
 * - ThemeMode 与 shared 的 'light'|'dark'|'system' 等价（= SystemSettings['theme']）。
 * - themePreset 保持宽松 string（renderer 消费方按 string 处理；shared 的 ThemePreset
 *   联合属后续收紧项，不在迁移 wave 内展开）。
 */
import type { ExtensionInfo } from '@taiji/shared'

export interface SystemSettings {
  locale: 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
  themePreset: string
  /** 字体大小：small/medium/large，缺省按 medium（D17） */
  fontSize?: 'small' | 'medium' | 'large'
  /**
   * 分区字号档位（sidebar/chat/drawer 三区域独立缩放；档位→倍率映射见 style.css data-fs-* 规则）。
   * 缺省 medium（×1）。区域子树内 --text-* 链乘以对应 --font-scale-<region>。
   * 语义分区（chat-font-scope）：chat = 对话流域——MessageStream 根自挂 data-fs-scope="chat"，
   * 嵌套在 drawer 内的对话流（subagent tab / btw 线 / workflow agent 详情）恒跟 chat 档；
   * drawer/sidebar = 区域 chrome（头栏/列表/详情/文档等非对话流文字）。
   */
  fontScales?: FontScales
  /**
   * [一次性迁移标记] 分区字号默认档位迁移（sidebar 旧默认 large → medium）。
   * system-storage.getSystem 读到未标记的存量数据时执行迁移：等于旧默认（large）的
   * sidebar 档回落 DEFAULT_FONT_SCALES.sidebar，并置位本标记（随既有启动写回落盘）。
   * 置位后用户显式选择的 large 不再被改写（尊重显式选择）。
   */
  fontScalesDefaultMigrated?: boolean
  /** 后台完成提示音开关 */
  completionSound?: boolean
  /**
   * 成功完成提示音：系统声音 id（如 'Glass' / 'complete' / 'Windows Notify System Generic'）。
   * undefined / 空串 → 用平台默认（mac=Glass, win=Windows Notify System Generic, linux=complete）。
   * 跨平台失效兜底（W3）：保存的 id 在当前平台不存在时（如 mac 的 'Hero' 切到 linux），
   * main 侧 sound:play 据 kind 回落到对应平台默认（成功音→平台默认成功音），不再静默。
   */
  successSound?: string
  /** 失败完成提示音：语义同 successSound，默认 mac=Funk / win=Windows Notify Email / linux=message-new-instant */
  errorSound?: string
  /**
   * 字体选择（font-system §3.3 D2/D3）：槽位 → 字体家族名。
   * 核心层只存家族名字符串（如 'Maple Mono'），不存路径、不存来源类型、不存字重映射——
   * 系统已装字体在 API 层根本不提供路径（`queryLocalFonts()` 只有 family/style/blob），
   * 存路径会让两种来源的数据模型分裂（D3）。字体文件位置的知识完全归来源层。
   * 缺省（字段省略 / 槽位省略）= 落到构建期系统栈（style.css 的 var() 缺省参数）。
   */
  fonts?: FontsConfig
  /**
   * 用户导入的字体登记表（font-system §3.3 D11）：启动时按表重放注册为可用字体。
   * 唯一写方 = 用户导入/删除动作；启动重放只读不写。
   */
  fontLibrary?: FontLibraryEntry[]
}

/**
 * 字体选择槽位（font-system §3.3 D2）：两个独立槽位各存一个家族名。
 *
 * 两个槽位是兄弟字段——写入时必须 spread 既有值（`{ ...settings.fonts, ui }`），
 * 照抄 fontScales 的整体替换模式而漏 spread 会互相清空。
 */
export interface FontsConfig {
  /** 界面正文字体家族名；省略 = 构建期系统栈 */
  ui?: string
  /** 代码与等宽字体家族名；省略 = 构建期等宽栈 */
  mono?: string
}

/**
 * 导入字体登记项（font-system §3.3 D11）。
 *
 * **只有三个字段**（不加 `byteSize`：校验发生在读字节时，持久化值在源文件被替换后会失真，
 * 构成第二权威；不加 `source`：v1 只有 file 一种；不加 `broken`：失效标注是本次会话内的
 * 内存态，写进本表会造成「重放只读不写」的自相矛盾）。
 */
export interface FontLibraryEntry {
  /** 用户可见的家族名（导入时派生；与系统字体同名时改名） */
  family: string
  /** 源文件绝对路径——**仅供来源层重建使用（启动重放按它重读字节），渲染路径不读** */
  path: string
  /** 导入时刻毫秒 epoch（列表按导入时间倒序） */
  addedAt: number
}

/** 外观模式：暗色 / 亮色 / 跟随系统（与 SystemSettings.theme 对齐） */
export type ThemeMode = SystemSettings['theme']

/** 分区字号档位（与 fontSize 档位范式一致，档位→倍率映射在 style.css data-fs-* 规则） */
export type FontScaleTier = 'small' | 'medium' | 'large' | 'xlarge'

/** 分区字号：key = 区域（sidebar/chat/drawer），value = 档位；setSystem 浅合并，更新须传完整对象 */
export interface FontScales {
  sidebar?: FontScaleTier
  chat?: FontScaleTier
  drawer?: FontScaleTier
}

/**
 * 分区字号默认档位（SSOT）：sidebar=标准（×1），chat=小（×0.9，chat-font-default-small：
 * 长文阅读场景用户裁决默认小档），drawer=标准（×1）。
 *
 * 三处消费点必须都从这里取缺省值，禁止写死档位字面量：
 *   1. DEFAULT_SYSTEM.fontScales（新用户 / 无 fontScales 存量数据的保存默认）
 *   2. applySystemToDom（ui 包，部分缺省区域的 data-fs-* 回落）
 *   3. AppearancePage 区域 Select（部分缺省区域的显示回落）
 * getSystem 是浅合并（{ ...DEFAULT_SYSTEM, ...parsed }），老数据整体覆盖 fontScales 时
 * 可能缺个别区域 key——故 2/3 的逐区域回落同样必须走本常量，而非假设对象完整。
 */
export const DEFAULT_FONT_SCALES: Required<FontScales> = {
  sidebar: 'medium',
  chat: 'small',
  drawer: 'medium',
}

/** 配色主题：由 settings-shell spec §4 System 菜单定义，默认为空串（= 玄/皓默认主题，无 preset 覆盖） */
export type ColorTheme = string

/**
 * Extension 类型：直接复用 shared ExtensionInfo（SSOT）。
 * 此前本地重复定义 ExtensionItem（tools 必填），但 shared ExtensionInfo 的 tools
 * 是可选（runtime 扫描到时才填），本地必填假设在真实 runtime 下导致 undefined.length 报错。
 * 现在 import ExtensionInfo 并 alias 为 ExtensionItem 保持现有 import 路径兼容。
 */
export type ExtensionItem = ExtensionInfo

/** 默认系统偏好（getSystem 损坏回退与 store system 初始值共用）。 */
export const DEFAULT_SYSTEM: SystemSettings = {
  locale: 'zh-CN',
  theme: 'dark',
  themePreset: '',
  fontSize: 'medium',
  fontScales: { ...DEFAULT_FONT_SCALES },
  completionSound: true,
}
