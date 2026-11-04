/**
 * 字体来源层契约（font-system §3.3 D4，u-foundation）。
 *
 * 分层分工（AX2/X2）：
 * - **核心层**（core settings 的 `SystemSettings.fonts`）只持有家族名字符串；
 * - **来源层**（本文件）负责「有哪些字体可用」与「字体字节怎么进浏览器」——
 *   具体来源的知识（Chromium 的 `queryLocalFonts`、磁盘路径、IPC 读字节）全部封在
 *   实现里，新增来源 = 往 `use-font-registry` 的来源数组加一项，不改核心层渲染计算。
 *
 * v1 只有两个实现：`SystemFontSource`（系统已装）与 `FileFontSource`（用户本地文件）。
 * **不预留 `'remote'`**（D12：v1 不做下载，为零实现方的来源预留枚举值会让每处 switch
 * 都拖着一条不可达分支）。
 */

/**
 * 可用字体项（列表面板的行数据）。
 *
 * 家族名是唯一身份：系统字体按 family 聚合去重（同家族多 style 只出现一次）。
 * 导入字体与系统字体同名时由来源层改名（如 `Maple Mono (导入)`），否则用户无法选回
 * 系统字体。
 */
export interface FontEntry { // oe-exempt:20261104:wip:来源层契约的第二个实现在 u-m2-sources 同批落地（M1/M2 之间为过渡态）
  /** 家族名（可直接作为 `SystemSettings.fonts.ui` / `.mono` 的值） */
  family: string
  /** 来源标识——只有两个取值，不预留 'remote' */
  source: 'system' | 'file'
}

/**
 * 字体来源适配器（D4）。
 *
 * 只声明「列出可用字体」这一个方法：取字节/注册字体是各实现自己的内部细节
 * （`FileFontSource` 在 `list()` 里按登记表重放注册，`SystemFontSource` 只需枚举）。
 * 取字节的实现可以依赖来源层私有通道，不进本接口——否则核心层就被迫知道「字体有字节」。
 */
export interface FontSource { // oe-exempt:20261104:wip:设计 D4 已登记两个真实变体（system/file），第二个实现在 u-m2-sources 落地
  /** 列出本来源当前可用的字体（家族名 + 来源标识） */
  list(): Promise<FontEntry[]>
}
