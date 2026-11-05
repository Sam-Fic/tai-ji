// vitest.setup.ts
//
// 全局测试 env 净化：引擎宿主链路泄漏类。
//
// 2026-09-06 PR #198 事故：zcode 引擎经 app-server wrapper 启动时注入 ZCODE_ENG_*
// env，跑在其宿主下的测试进程会继承——launcher 的「ZCODE_ENG_CLI_PATH 缺失 →
// exit 2」等缺失前置用例因此假红（wrapper 拿到真 CLI 走正常路径 exit 1）。前缀
// 命中即删保证缺失前置成立；用例内显式设置不受影响（本净化先跑，模块加载前；
// appserver-launcher.test.ts 内另有针对性剥离兜底双保险）。

const HOST_CHAIN_ENV_PREFIXES = ["ZCODE_ENG_", "TAIJI_ZCODE_"] as const;

for (const prefix of HOST_CHAIN_ENV_PREFIXES) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(prefix)) delete process.env[key];
  }
}
