import { defaultExclude } from "vitest/config";
import { taijiTestConfig, guardProjectSetup } from "../../test-guard/factory.ts";
import { loadZeroMockPool } from "../../test-guard/zero-mock-pool.ts";

/**
 * Vitest config for @zhushanwen/zcode-subagent-cli.
 *
 * 照 AGENTS.md 测试纪律（W5 任务书：新包 vitest 配置带 junit reporter + fs-guard）：
 * - junit reporter 落盘用例级耗时（test-results/ 已 gitignore）；
 * 防线经仓库根 test-guard/factory 统一注入（taijiTestConfig），[HISTORICAL]
 * 2026-09-02 会话丢失事故双层防线 + 2026-09-16 prod 数据目录删除事故升级为仓库级强制。
 * - live 真机测试仅在 ENGINE_CONFORMANCE_LIVE=1 时真正执行（随迁原 core 侧口径）。
 *
 * 三池维护契约（shared 零特征共享池 + isolated 隔离池 + live 手动门池，完整契约见
 * packages/subagent-core/vitest.config.ts 文件头同款）：shared = 静态零特征 ∧ 非门控文件
 * isolate:false（清单唯一来源 = docs/testing/zero-mock-pool.json，检查 =
 * scripts/check-zero-mock-pool.mjs）；isolated = 特征/门控/出场文件每文件新进程。
 * 本包门控文件（集成 zcode-engine.* 族 / session-channel）全部出局共享池——门控档
 * （TAIJI_TEST_INTEGRATION）执行语义保持与分池前完全一致。
 * live 池 = ENGINE_CONFORMANCE_LIVE 手动门资产（zcode-engine.live，公网真调模型、
 * 本地默认 skip）：从 isolated 池划出独立成池，隔离语义与 isolated 一致（每文件新进程），
 * 使全量门禁可用 --project '!live' 排除它（零 skip 计数，显式路径单独跑不受影响——
 * isolated 已 exclude 该文件防跨池重复收集）；真机执行走 e2e-map E2E-INTEG-71 登记
 * 的显式路径命令（档位语义 = docs/TEST-STRATEGY.md「集成测试门控约定」节）。
 * 池 CLI 语义注意：package.json test 脚本的 --pool=threads 是 CLI 级覆盖，对全部
 * project 同时生效（vitest projects 语义，见 runtime config 文件头）；isolate 差异
 * 写在 project 级。
 */
const shared = loadZeroMockPool(__dirname, "zcode-subagent-cli");

export default taijiTestConfig({
  test: {
    projects: [
      {
        // 零特征共享池：模块图/线程跨文件复用（threads 池同机制）；清单来自登记表（禁手抄）
        test: guardProjectSetup({
          name: "shared",
          include: shared,
          isolate: false,
        }),
      },
      {
        // 隔离池：特征/门控/出场文件，每文件新 worker（分池前行为）；live 手动门文件
        // 已划入下方 live 池，此处 exclude 防跨池重复收集（显式路径模式同文件双跑）
        test: guardProjectSetup({
          name: "isolated",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: [...defaultExclude, ...shared, "src/__tests__/zcode-engine.live.test.ts"],
          sequence: { groupOrder: 1 },
        }),
      },
      {
        // live 池：ENGINE_CONFORMANCE_LIVE 手动门资产（隔离语义对齐 isolated：每文件
        // 新进程）；全量门禁以 --project '!live' 排除本池（env 未设时收集即 skip 的
        // 3 条计数不再进全量输出），真机执行 = e2e-map E2E-INTEG-71 的显式路径命令
        test: guardProjectSetup({
          name: "live",
          include: ["src/__tests__/zcode-engine.live.test.ts"],
          sequence: { groupOrder: 1 },
        }),
      },
    ],
  },
});
