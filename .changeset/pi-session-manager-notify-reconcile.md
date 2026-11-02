---
"@zhushanwen/pi-session-manager": patch
---

Managed-session completion and death notifications are no longer silently lost: a notify-reconcile pass re-delivers pending notifications whose delivery was never acknowledged (host-rejected deliveries, or deliveries lost across a restart), running on session start, agent settle, and session switch-back. Reconcile criteria now read their facts (pending registers, delivery traces, delivery journal) from the persisted session file on disk instead of the in-memory entry list, so entries whose persistence failed can no longer make a notification look delivered and suppress re-delivery; sessions without persistence fall back to the in-memory ledger with a warning. A delivery rejected by the host is retried once immediately through the same delivery channel, with record-level dedup guarding against double delivery.
