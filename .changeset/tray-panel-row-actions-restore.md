---
'@zhushanwen/pi-subagent-workflow': minor
'@zhushanwen/extension-protocol': minor
---

Tray panel rows are now interactive, and the workflow tray widget recovers
after session restore.

`@zhushanwen/extension-protocol`: action-bar items accept an optional
`confirm` message. Supporting hosts render a two-step confirmation (first
click arms a danger-styled confirm state with this message, second click
executes; the confirm state resets on timeout or pointer leave). Older
hosts ignore the field and execute on first click as before — the protocol
version is not bumped.

`@zhushanwen/pi-subagent-workflow`:

- Tray rows declare host actions: clicking a subagent or workflow row
  navigates the host UI (a workflow row opens the run visualization
  overlay positioned on that run). Row-end action buttons are declared
  for running subagents (cancel), failed subagents (retry), running
  workflows (abort) and interrupted workflows (resume), with two-step
  confirmation on destructive actions.
- Tray panel strings (titles, section labels, action buttons and confirm
  texts) are now localized (zh-CN / en-US) following the UI locale
  preference.
- Fix: the workflow tray widget no longer stays empty after a session
  restore — a one-shot disk cold read recovers runs when the in-memory
  projection is empty, and interrupted (still resumable) runs are no
  longer treated as terminally settled by the rebuild (only entries with
  status `done` count as terminal proof), so resumable runs remain
  visible and actionable after restore.
