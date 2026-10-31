import { defaultExclude } from "vitest/config";
import { taijiTestConfig, guardProjectSetup } from "../../test-guard/factory.ts";
import { loadZeroMockPool } from "../../test-guard/zero-mock-pool.ts";

/**
 * Vitest config for @zhushanwen/subagent-core.
 *
 * 三池维护契约（shared 零特征共享池 + isolated 隔离池 + live 手动门池，调度契约见
 * packages/runtime/vitest.config.ts 文件头同款：`sequence.groupOrder` 分桶键，同号同
 * maxWorkers 并组、组间严格串行；混 isolate true/false 同组会互拆 worker，故 isolated
 * 显式 order 1）：
 * - **shared**：零特征文件 isolate:false——模块图与 worker 进程跨文件复用（实证 2.13x，
 *   .tmp/round6/process-reuse-reeval.md §3.4 两轮全绿逐用例零差异）。成员清单唯一来源 =
 *   docs/testing/zero-mock-pool.json（经 loadZeroMockPool 派生，判据/检查 =
 *   scripts/check-zero-mock-pool.mjs；给池内文件引入 vi.mock 等特征会被检查 G3 拦截）。
 * - **isolated**：其余文件（mock/共享状态特征文件 + 集成门控文件 + 动态出场文件），
 *   每文件新进程，语义与分池前完全一致。
 * - **live**：ENGINE_CONFORMANCE_LIVE 手动门资产（conformance/engine-conformance.live，
 *   公网真调模型、本地默认 skip），隔离语义对齐 isolated（每文件新进程、同组串行）；
 *   独立成池使全量跑可用 --project '!live' 排除（显式路径单独跑不受
 *   影响——isolated 已 exclude 该文件防跨池重复收集；包 test 脚本当前未接该旗标，
 *   env 未设时收集即 skip 的计数仍进全量输出）；真机执行走 e2e-map
 *   E2E-INTEG-71 登记的显式路径命令（档位语义 = docs/TEST-STRATEGY.md
 *   「集成测试门控约定」节）。
 * - 池成员变更流程：check-zero-mock-pool.mjs --update 重写登记表 → 三包各两轮全量
 *   （TAIJI_SKIP_REAL_PI=1 pnpm test）全绿 + junit 用例名守恒，红则该文件出局进隔离池
 *   并登记 dynamicExclusions（静态扫描有原理性漏判，零特征 ≠ 零污染）。
 *
 * 本包测试对 pi-ai / pi-tui / typebox 零运行时触点，无 alias、无 mocks/：
 * 消费方测试 format.test.ts / sdk-contract.test.ts 留在壳包（pi-subagent-workflow），
 * 壳包 vitest.config.ts 自带同款 alias；pi-coding-agent 仅剩 import type，
 * 转译擦除后无运行时解析，无需 alias。
 */
const shared = loadZeroMockPool(__dirname, "subagent-core");

export default taijiTestConfig({
  test: {
    projects: [
      {
        // 零特征共享池：模块图/进程跨文件复用；清单来自登记表（禁手抄）
        test: guardProjectSetup({
          name: "shared",
          include: shared,
          isolate: false,
          // 对齐壳侧 F-R5：每个测试文件加载前净化四键 opt-in env（见 vitest.setup.ts），
          // 防宿主 shell export 假红。projects 内 setupFiles 不继承 root 级，逐 project 挂。
          setupFiles: ["./vitest.setup.ts"],
        }),
      },
      {
        // 隔离池：特征/门控/出场文件，每文件新进程（分池前行为）；live 手动门文件已
        // 划入下方 live 池，此处 exclude 防跨池重复收集（显式路径模式同文件双跑）
        test: guardProjectSetup({
          name: "isolated",
          include: ["src/**/*.test.ts"],
          exclude: [
            ...defaultExclude,
            ...shared,
            "src/execution/engine/__tests__/conformance/engine-conformance.live.test.ts",
          ],
          setupFiles: ["./vitest.setup.ts"],
          sequence: { groupOrder: 1 },
        }),
      },
      {
        // live 池：ENGINE_CONFORMANCE_LIVE 手动门资产（隔离语义对齐 isolated：每文件
        // 新进程、同组串行）；全量入口未接 --project '!live' 排除旗标（env 未设时收集
        // 即 skip 的计数仍进全量输出），真机执行 = e2e-map E2E-INTEG-71 的显式路径命令
        test: guardProjectSetup({
          name: "live",
          include: ["src/execution/engine/__tests__/conformance/engine-conformance.live.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
          sequence: { groupOrder: 1 },
        }),
      },
    ],
  },
});
