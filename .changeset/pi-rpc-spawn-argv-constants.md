---
"@zhushanwen/pi-rpc": minor
---

spawn argv 判据常量导出为单源 `PI_SPAWN_MODE_ARGS` / `PI_SPAWN_NO_EXTENSIONS` / `PI_SPAWN_SKILL_FLAG` / `PI_SPAWN_EXTENSION_FLAG`，runtime 按 argv 形态识别 pi 进程的孤儿收割判据与 spawn 构造同引这组常量，避免构造侧改动 flag 后收割判据静默失效。
