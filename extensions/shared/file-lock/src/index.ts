// src/index.ts
//
// 包入口。runtime 侧经 `@zhushanwen/pi-file-lock/core` 子入口直接用锁原语，不经
// 本文件；extension 侧经本文件入口使用。

export { withFileLockSync } from "./file-lock";
