export default {
  toggleSidebar: '切换侧栏',
  expandSidebar: '展开侧栏',
  collapseSidebar: '收起侧栏',
  resizeSidebar: '调整侧栏宽度',
  goBack: '后退',
  goForward: '前进',
  close: '关闭',
  minimize: '最小化',
  maximize: '最大化',
  // ── 宿主薄命令失败回执（tray-panel-interact §3.3 D4，RL6）──
  // commandExecutor 分叉：taiji.* 命中直转 session 域 RPC，reject 时经 useToast 出声
  // （失败原因 + 恢复指引）；行状态不写、不乐观翻转（事实源 = 扩展进程 RecordStore 重推）。
  hostCommand: {
    cancelFailed: '取消失败：{error}。请在该子代理所属的会话中重试',
    retryFailed: '重试失败：{error}。请在该子代理所属的会话中重试',
    abortFailed: '中止失败：{error}。请在该工作流所属的会话中重试',
    resumeFailed: '续跑失败：{error}。请在该工作流所属的会话中重试',
    noTargetSession: '操作未执行：未定位到目标会话，请先打开一个会话再试',
    missingArg: '按钮未提供 {param} 参数（扩展声明缺失）',
  },
}
