/**
 * Composer task tray (built-in kinds: bash / session / canvas) — English copy.
 * Design: docs/design/composer-task-tray.md（已删除，git 可追溯）§3.3 D2/D9 + §3.5 error spec.
 * [container unification §6.6/U9+U10] subagent / workflow copy removed with the kinds' migration
 * (plugin-pushed widget tree; title/copy carried by plugin meta and tree content, not host i18n;
 * workflowInterrupted excepted — the overlay runs-state status pill still consumes it).
 *
 * Namespace shape: default export holds only the `tray` subtree; the aggregator
 * (locales/en-US.ts) spreads it into the `panel` namespace
 * (`panel: { ...panel, ...tray }`) so runtime keys are `panel.tray.*`.
 * Key set must mirror zh-CN/tray.ts exactly (guards: .githooks/check_i18n_locale_sync.py
 * + __tests__/i18n/locale-sync-check.test.ts).
 *
 * Vocabulary note: bash is a process-domain kind and keeps "Running" (runningProcess) —
 * mirrors the domain split registered in sidebar.ts; the task-domain "In progress" labels
 * (bucket.running / empty.running) were removed with the workflow kind.
 */
export default {
  tray: {
    /** Tray row aria-label (the icon row as one landmark; each icon carries title.<kind>) */
    trayLabel: 'Task tray',
    /** Kind titles (panel aria-label; the shell reuses them for icon title/aria) */
    title: {
      bash: 'Background commands',
      session: 'Child sessions',
      canvas: 'Canvases',
    },
    /** Bucket view labels (runningProcess is bash-only, see header note) */
    bucket: {
      runningProcess: 'Running',
      ended: 'Finished',
    },
    loading: 'Loading…',
    /** Empty-bucket hint ({name} = kind title) */
    empty: {
      runningProcess: 'No {name} running',
      ended: 'No finished {name}',
    },
    /** Actionable empty state (D9: explicit bucket switch, never auto-jump) */
    viewEnded: 'View finished ({count})',
    /** Row actions (background commands) */
    kill: 'Stop',
    killConfirm: 'Confirm stop',
    killFailed: 'Failed to stop background command: {msg}',
    /**
     * [D2] interrupted-run status text (visible on workflow rows + WorkflowTab header;
     * zh literal is the scenario-25 CDP assertion anchor): paused, resumable via resume.
     */
    workflowInterrupted: 'Interrupted (resumable)',
    pidLabel: 'pid',
    exitLabel: 'exit',
    /** Background-command status text fallback (aria-label / icon title; judging lives in background-task-bucket SSOT) */
    status: {
      running: 'Running',
      killing: 'Stopping',
      orphaned: 'Orphaned',
      killed: 'Stopped',
      succeeded: 'Succeeded',
      failed: 'Failed',
    },
    /**
     * Closed-enum mapping for list-tree row status pills (composer-tray-protocol D3):
     * host i18n fallback for the protocol's three-value TreeItem.status set, consumed by
     * the ListTree primitive; the pusher's statusLabel field is the first-tier override
     * (render order = override ?? mapping). Distinct family from `status` above (bash
     * process-domain six states): this maps only the protocol status enum — judging
     * lives with the pusher, not an extension of the bash status vocabulary.
     */
    statusLabel: {
      running: 'Running',
      done: 'Done',
      failed: 'Failed',
    },
    /** Panel top banners (bash) */
    corruptBanner: 'Task data corrupted; ignored (.corrupt snapshot kept)',
    disconnectBanner: 'Disconnected; refreshes automatically after reconnect',
    /**
     * Protocol widget panel disconnect banner (tray-panel-interact §3.3 D7): shown while the
     * ws connection is not connected and the panel is open; disappears on reconnect. Worded
     * differently from bash's disconnectBanner — widget content is extension-pushed (absolute
     * projection), so a disconnect shows the previous frame and "may be stale" is the honest
     * wording; bash is host-fetched and refetches on reconnect.
     */
    widgetDisconnectBanner: 'Disconnected; content may be stale',
    /**
     * Protocol widget button hover title (D8: host-side template; fact fields come from
     * extension meta — extension supplies facts, host supplies the copy template).
     * {title} = meta.title, {badge} = badge fallback chain value, {total} = progress.total.
     * Segment omission rules and membership judging (viewId closed set) live in
     * TrayWidgetButton.vue.
     */
    widgetTitle: {
      /** Running-count progress entries (set members subagent / workflow) */
      running: '{title} · {badge} running / {total}',
      /** Entries outside the set (todo / goal etc.: completion count or percentage, no "running" notion) */
      plain: '{title} · {badge}',
    },
    /** Order-4 aggregate entry (single layers icon + running-count badge, W3a): title / aria-label is always "All tools" (count lives in the badge, not the title) */
    aggregate: {
      allTools: 'All tools',
    },
    /**
     * Fourth entry "child sessions" (u7, design mode-system-composer-density §6.7 D7).
     * Row status copy mirrors TraySessionPanel's process-level status map (see DISPLAY_STATUS in
     * composables/logic/sessionStatus.ts).
     */
    session: {
      /** Header summary ({total} total · {running} running) */
      header: '{total} total · {running} running',
      empty: 'No child sessions',
      status: {
        running: 'Running',
        done: 'Done',
        error: 'Failed',
        stopped: 'Stopped',
      },
      stop: 'Stop',
      stopConfirm: 'Confirm stop',
      stopFailed: 'Failed to stop child session: {msg}',
      openFailed: 'Failed to open child session: {msg}',
    },
    /**
     * Fifth entry "canvases" (u-tray-entry, problem-solve-canvas §3.1(3)).
     * Phase badges are derived display values (growing / reviewing / converged); derivation
     * rules live in TrayCanvasPanel's header comment. Creation goes through the three-element
     * form modal (all required = invariant-1 pre-check; the missing list names each item).
     */
    canvas: {
      /** Header summary ({total} canvases · {active} in progress — active = not converged) */
      header: '{total} canvases · {active} in progress',
      empty: 'No canvases yet — create one below',
      create: 'New canvas',
      /** Phase badges (derived value vocabulary) */
      phase: {
        growing: 'Growing',
        reviewing: 'In review',
        converged: 'Converged',
      },
      mustFix: '{count} to fix',
      /** Missing-item list separator (zh uses a dun-hao mark, en uses a comma — read before join) */
      listSep: ', ',
      missing: 'Missing: {items}',
      createFailed: 'Failed to create canvas: {msg}',
      form: {
        title: 'New canvas',
        description: 'The three elements of a problem-solving canvas: statement, criterias, scope exclusions — all required',
        statement: 'Problem statement',
        statementPlaceholder: 'The core problem to solve, in one sentence',
        criterias: 'Completion criterias (one per line)',
        criteriasPlaceholder: 'Falsifiable completion criterias, one per line',
        scopeExclusions: 'Scope exclusions (one per line)',
        scopeExclusionsPlaceholder: 'State what is explicitly out of scope, one per line',
        submit: 'Create canvas',
        cancel: 'Cancel',
      },
    },
  },
}
