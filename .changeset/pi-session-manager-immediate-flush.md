---
"@zhushanwen/pi-session-manager": minor
---

托管会话完成/死亡通知的 50ms trailing 攒批窗退役：每笔 watch 应答到达即单独投递，通知不再延迟合并（单次 flush 内已到达的多笔仍按既有分拣规则合并）。
