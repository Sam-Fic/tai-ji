import { taijiTestConfig, GLOBAL_SETUP_PATH, guardProjectSetup } from '../../../test-guard/factory.ts'

// main 进程纯函数测试。
// main/ 不在 workspace 包内（非 renderer/runtime/shared），但 vitest 已 hoist 到根 node_modules，
// @taiji/shared 经 workspace symlink 解析。仅测无 electron 运行时依赖的纯函数。
//
// 防线（[HISTORICAL] 2026-09-02 会话丢失事故双层防线；2026-09-16 起上收仓库根 test-guard/
// factory 统一注入，main/test/ 下的自包含副本已删除）：globalSetup（root 级，对所有池生效）
// = TAIJI_AGENT_DATA_DIR 钉 tmp + 真实数据目录白名单 fail-fast；fs-guard 切面仅 guarded 池
// 显式挂载（projects 内 setupFiles 不继承 root 级，见 runtime/vitest.config.ts 同款注释）。
//
// 分池（形态对齐 packages/runtime/vitest.config.ts 的 projects 先例；vitest 4 调度契约：
// groups 之间严格串行，先主组后尾组）：
// - guarded：u5a 起的新增真实文件 IO 测试（logs/__tests__/），挂全套
//   fs-guard 防线（仓规测试红线：破坏性 fs 只落白名单 tmp，真实 ~/.taiji 无条件拒绝）。
// - legacy：存量 40+ 测试文件。**有意不挂 fs-guard**：挂载后暴露存量用例自身的设计缺陷
//   （如 update-self-healer.test.ts 在 vitest 环境经 getOldBackupPath 的
//   dirname×3(process.execPath) 推导出真实 ~/.nvm/versions/node.old 并 rmSync——guard
//   正确拦截但该用例需 mock execPath 才能修，文件在 u5a 领地外，缺陷已上报主 agent）。
//   存量池接入 guard 是独立单元的工作，不在本配置内打折处理；globalSetup 层（env 固定 +
//   真实数据目录 fail-fast）对 legacy 池仍生效。
// - live：TAIJI_E2E_UPDATER 手动门资产（test/updater.e2e.test.ts，mac 真链三段：真
//   hdiutil/ditto/bash 全链、env 未设时整段 skip）。独立成池使全量门禁可用
//   --project '!live' 排除（env 未设时收集即 skip 的 14 条计数不再进门禁输出；显式
//   路径 / E2E 档全文件跑不受影响——legacy 池已 exclude 该文件防跨池重复收集）。
//   注意：package.json 的 test:main 入口未接该旗标——它同时是带文件参数真跑 live
//   资产的唯一正确入口（vitest 直跑因 config 上浮 no tests found，见 TEST-STRATEGY.md），
//   接旗标会堵死该入口；直接跑 test:main 时 env 未设的收集即 skip 计数仍进其输出。
//   隔离语义对齐 legacy 池（默认每文件新 worker，无 fs-guard——E2E 段全程只在
//   mkdtemp tmpdir 与 HFS+ 小容量镜像上操作，无真实数据目录触点）；root 级
//   globalSetup 对本池生效（env 钉 tmp + 真实数据目录 fail-fast 属环境防线，
//   E2E 档同受保护，无理由豁免）。执行登记 = e2e-map E2E-UPDATER-01。
export default taijiTestConfig({
  test: {
    globalSetup: [GLOBAL_SETUP_PATH],
    projects: [
      {
        test: {
          name: 'guarded',
          // images/__tests__/：u7 图片缓存生命周期（真实文件 IO，同挂
          // fs-guard；cache/images 夹具全部 mkdtemp tmpdir 自建自删）
          // diagnostics/__tests__/：crash-forensics u3a 诊断包导出（真实 zip 落盘，同挂
          // fs-guard；夹具 mkdtemp tmpdir 自建自删）
          include: [
            'logs/__tests__/**/*.test.ts',
            'images/__tests__/**/*.test.ts',
            'diagnostics/__tests__/**/*.test.ts',
            // sessions/__tests__/: 会话 JSONL 导出 IPC（真实 copyFile 落盘，同挂
            // fs-guard；夹具 mkdtemp tmpdir 自建自删，piAgentDir 经 env 注入 tmp）
            'sessions/__tests__/**/*.test.ts',
            // quota/__tests__/：cookie 登录态刷新器（真实 secrets 文件读写落盘，
            // 同挂 fs-guard；夹具 mkdtemp tmpdir 自建自删，dataDir 经 deps 注入 tmp）
            'quota/__tests__/**/*.test.ts',
            // main-run-state：真实文件 IO（run-state marker/checkpoint 写盘）+ mock 驱动
            // main.ts 真实 import 链（app.isPackaged=true 会执行打包 pin 分支改写
            // TAIJI_AGENT_DATA_DIR）——写通路必须在 fs-guard 拦截范围内
            // （[HISTORICAL] 2026-09-23 污染事故：legacy 池无拦截范围，pin 改写 env 后
            // marker 落进真实 ~/.taiji）。
            'test/main-run-state.test.ts',
            // window-state：真实文件 IO（window-state.json 持久化语义——防抖写/close
            // flush/损坏回默认），夹具 mkdtemp tmpdir 自建自删（u-window-state §6.4）
            'test/window-state.test.ts',
          ],
          // 工厂助手双挂载（fs-guard + env-purity）：此前只显式挂 FS_GUARD_PATH，
          // 漏掉 env 纯净度 setup（宿主链路泄漏 env 在用例可见前不剥除）——与工厂
          // 单 project 语义不对齐（Must-fix E）。
          ...guardProjectSetup({}),
        },
      },
      {
        test: {
          name: 'legacy',
          // update/__tests__/ 是存量 update 模块测试（原 include 第二个 glob 的匹配范围），
          // 与 guarded 的 logs/__tests__ 前缀精确互斥，防同文件跨池重复收集。
          // ../scripts/__tests__：dev-instance-lib 纯函数层（MF-8，C-build-08 装配器可测层），
          // 同样无 electron 运行时依赖，随 main 纯函数测试一起跑（dev-0.9.19 合并并入）。
          include: [
            'test/**/*.test.ts',
            '!test/main-run-state.test.ts',
            // window-state（真实文件 IO）已进 guarded 池，此处排除防跨池重复收集
            '!test/window-state.test.ts',
            // updater E2E 档（TAIJI_E2E_UPDATER 门控的 mac 真链三段）已进 live 池，
            // 此处排除防跨池重复收集（显式路径 / E2E 档全文件跑由 live 池承载）
            '!test/updater.e2e.test.ts',
            'update/__tests__/**/*.test.ts',
            '../scripts/__tests__/**/*.test.mjs',
          ],
        },
      },
      {
        test: {
          // live 池：TAIJI_E2E_UPDATER 手动门资产（E2E 档，CI 不跑；全量门禁以
          // --project '!live' 排除本池，见文件头 live 池契约注释）
          name: 'live',
          include: ['test/updater.e2e.test.ts'],
        },
      },
    ],
  },
})
