import { taijiTestConfig, GLOBAL_SETUP_PATH, guardProjectSetup } from '../../test-guard/factory.ts'

// apps/electron 壳包（@taiji/electron）的 vitest 防线挂载点。本包 package.json 的 test
// script 委托 main/（cd main && vitest run），本 config 不改变该执行入口；存在意义 =
// check-vitest-guard 检查要求的防线挂载点 + 从本包 cwd 直接跑 vitest 时的防线齐备入口
// （test-guard factory 注入）。
//
// 分池：
// - scripts：本包 scripts/__tests__（dev-instance-lib 纯函数层 / merge 判定脚本回归），
//   无 electron 运行时依赖、无文件写，纯 include 即可（与 main config legacy 池对
//   ../scripts/__tests__ 的挂载语义一致）。
// - main-guarded：main/test 真实文件 IO 测试经本包 cwd 可直达（增量测试命令
//   `vitest run main/test/main-run-state.test.ts` 的收集来源）。防线与 main config
//   guarded 池等价：globalSetup（TAIJI_AGENT_DATA_DIR 钉 tmp + 真实数据目录 fail-fast）
//   + guardProjectSetup 双挂载（fs-guard + env-purity）——main-run-state.test.ts 的
//   写删目标 = tmp 数据目录 run/，且 app.isPackaged=true 的打包 pin 分支改写 env 后
//   写通路必须在 fs-guard 拦截范围内（[HISTORICAL] 2026-09-23 污染事故同款防线）。
//   main/test/ 其余文件仍归 main config（guarded/legacy 两池）收集，不在本处重复
//   （防同一文件双执行）。
export default taijiTestConfig({
  test: {
    globalSetup: [GLOBAL_SETUP_PATH],
    projects: [
      {
        test: {
          name: 'scripts',
          include: ['scripts/__tests__/**/*.test.mjs'],
          // 机器检查要求：显式 project 一律挂双防线（fs-guard + env-purity）——
          // scripts 用例为纯逻辑/自有 fixture，挂载后行为不变（防线只拦白名单外写删）
          ...guardProjectSetup({}),
        },
      },
      {
        test: {
          name: 'main-guarded',
          include: ['main/test/main-run-state.test.ts'],
          ...guardProjectSetup({}),
        },
      },
    ],
  },
})
