export default {
  toggleSidebar: 'Toggle sidebar',
  expandSidebar: 'Expand sidebar',
  collapseSidebar: 'Collapse sidebar',
  resizeSidebar: 'Resize sidebar',
  goBack: 'Back',
  goForward: 'Forward',
  close: 'Close',
  minimize: 'Minimize',
  maximize: 'Maximize',
  // Host thin-command failure receipts (tray-panel-interact §3.3 D4, RL6): the
  // commandExecutor fork routes taiji.* hits straight to session-domain RPCs; a
  // rejection surfaces via useToast (reason + recovery guidance). No row state is
  // written and nothing flips optimistically (source of truth = extension
  // RecordStore re-push).
  hostCommand: {
    cancelFailed: 'Cancel failed: {error}. Retry in the session that owns this subagent',
    retryFailed: 'Retry failed: {error}. Retry in the session that owns this subagent',
    abortFailed: 'Abort failed: {error}. Retry in the session that owns this workflow',
    resumeFailed: 'Resume failed: {error}. Retry in the session that owns this workflow',
    noTargetSession: 'Action not performed: no target session found. Open a session and try again',
    missingArg: 'Button is missing the {param} argument (extension declaration)',
  },
}
