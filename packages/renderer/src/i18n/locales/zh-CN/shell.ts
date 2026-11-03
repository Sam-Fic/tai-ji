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
  // ── 宿主薄命令回执（tray-panel-interact §3.3 D4，RL6 + 终态交互样例/V3/V4）──
  // commandExecutor 分叉：taiji.* 命中直转 session 域 RPC，回执经 useToast 出声——
  // 成功 info 回执（目标 id 回显，终态交互样例/V3/V4「toast 回执出现」）+ reject 错误
  // toast（失败原因 + 恢复指引）；两条路径都不写行状态、不乐观翻转（事实源 = 扩展进程
  // RecordStore 重推）。
  hostCommand: {
    cancelDone: '已取消 {target}',
    retryDone: '已重新派发 {target}',
    abortDone: '已中止 {target}',
    resumeDone: '已续跑 {target}',
    cancelFailed: '取消失败：{error}。请在该子代理所属的会话中重试',
    retryFailed: '重试失败：{error}。请在该子代理所属的会话中重试',
    abortFailed: '中止失败：{error}。请在该工作流所属的会话中重试',
    resumeFailed: '续跑失败：{error}。请在该工作流所属的会话中重试',
    noTargetSession: '操作未执行：未定位到目标会话，请先打开一个会话再试',
    missingArg: '按钮未提供 {param} 参数（扩展声明缺失）',
  },
}
