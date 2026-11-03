// scheduler 任务库子出口（node:fs 依赖，不进桶出口——浏览器消费方结构性不触达 node 内建）。
// 扁平构建入口（与 background-task-entry 同款）：dist 产物落在 dist 根，
// 避免 dist 路径出现源码分组目录形态（extensions/{taiji|universal}/ 约定）。
export * from './extensions/scheduler/store.js'
