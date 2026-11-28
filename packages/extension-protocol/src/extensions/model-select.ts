/**
 * 模型切换信号词表（custom_message customType 单源）：写侧 = @zhushanwen/pi-host-internals 的
 * `model_select` 转发，读侧 = runtime event-interpreter 分诊。
 * pi 的 `model_select` 事件不经 RPC 转发——切换事实全靠这条隐藏通知（display:false）过河；
 * 隐藏的原因：回放侧 pi 落盘的同一 custom message 由分组层按 display:false 透明跳过，
 * 切换行只由 model_change entry 派生（live ≡ reload，不重行）。
 */
export const MODEL_SELECT_CUSTOM_TYPE = 'taiji:model-select' as const
