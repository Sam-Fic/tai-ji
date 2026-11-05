/**
 * 侧栏拖拽的共享 MIME 常量。
 *
 * session 拖拽（移动到项目）：发起点 = SessionItem 根行（dragstart 写入）；
 * 落点识别 = useSessionDropTarget（dragover/drop 按 types 命中判断，文件拖入等
 * 无关拖拽不误触高亮）。
 * project 拖拽（组头换位）：发起点 = ProjectGroup 组头（dragstart 写入）；
 * 落点 = 其他命名组头（dragover 高亮 + drop 换位）；与 session 落点同元素共存，
 * 按 types 分流互不误触。
 * 自定义 MIME 类型：dataTransfer.getData 在 dragover 阶段不可读（安全限制），
 * types 列表是唯一可在 dragover 判别拖拽来源的通道。
 */
export const SESSION_DRAG_MIME = 'application/x-taiji-session'

/** project 组头换位拖拽：dataTransfer 携带被拖组的 projectId，drop 目标组头读取后换位 */
export const PROJECT_DRAG_MIME = 'application/x-taiji-project'
