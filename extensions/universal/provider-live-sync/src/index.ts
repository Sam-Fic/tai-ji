/**
 * provider-live-sync —— pi 进程模型快照的**加载时同步**扩展。
 *
 * 问题（根因①）：pi 1.0.0 的可用模型集合冻结在 **spawn 时刻**——`set_model` 从
 * `session.modelRuntime.getAvailableSnapshot()` 解析（`dist/modes/rpc/rpc-mode.js`
 * case "set_model"），
 * 该快照建于 `ModelRuntime.create()` 的 refresh（`dist/core/model-runtime.js`
 * create 内 ModelConfig.load + rebuildProviders），
 * 而 pi 自身**没有文件 watcher、没有 refresh RPC**。于是「会话开着 → 在设置页新增 provider/
 * 模型/凭据 → 直接切到新模型」会报 `Model not found`（缺凭据与缺模型同文案），只能重开会话。
 *
 * 解法（加载时同步，一次性）：本扩展在 **session_start 时**调 pi 自己的
 * `ctx.modelRegistry.refresh({ allowNetwork: false })`——`ModelRuntime.refresh()`
 * 首行即 `ModelConfig.load(modelsPath)` **重读磁盘配置**，随后 `rebuildProviders()` 按新配置重组
 * （`dist/core/model-runtime.js` refresh），因此新增/删除 provider、模型与凭据都在会话加载时生效；
 * `allowNetwork:false` 走本地恢复相位并在任何凭据解析/入网前返回（pi-ai `dist/models.js`
 * runProviderRefreshPhase）——**零网络请求**。
 *
 * 「会话开着改配置 → 立即生效」的运行中热更新不提供（周期轮询已退役）：新配置在
 * 下次会话加载时生效。
 *
 * 目录投喂（第二个职责，设计 §3.3 D1/D2）：taiji 的模型目录缓存
 * （`<getDataDir()>/provider-catalog-overlay.json`）经 pi 官方注册点
 * `pi.registerProvider` 注入注册表，修的是「上游目录新模型在 pi 执行侧不可见」那类
 * 断裂（rename 静默跳过 / `set_model` 报 ENGINE_MODEL_MISSING / spawn `--model`
 * 近似回退等 8 个同根因症状）。注册发生在**工厂函数体内**（pi 内部进 pending 队列，
 * 装配链在 `--model` 解析之前统一 flush）；session_start 时先做**注册对账**
 * （`reconcile`：对当前 fresh 且尚未注册的 provider 补 `registerProvider`——工厂期
 * expired / never-seen / 损坏的 provider 没有 `refreshModels` 钩子，pi 的刷新不会碰它，
 * 单靠刷新重建不了注入；工厂返回后的注册直连注册表立即生效，PS-88），再触发同一次
 * 零网络刷新，由注册时携带的 `refreshModels` 钩子重读缓存返回新并集。实装在
 * `src/catalog-bridge.ts`。
 *
 * 安全护栏：models.json 缺失（读出 ENOENT）时**跳过刷新**——refresh 会重读磁盘、
 * 以「无 override 的空配置」重建可用集合，配置源缺失窗口内刷新会把一次坏写放大成
 * 用户自定义 provider 的真正丢失（引擎保留 spawn 期快照；文件写回后的下一次会话
 * 加载恢复同步）。catalog-only 安装（models.json 从未存在）spawn 快照本就无自定义
 * provider，跳过刷新无损失。
 *
 * 设计取舍（行为语义以本头注释为权威；包定位与投喂写入单点见根 AGENTS.md 的
 * provider-live-sync 括注与 constraints.json 约束 C-ext-32；术语见 docs/CONTEXT.md
 * 「目录投喂（catalog overlay）」词条）：
 * - **不解析文件内容**：判定权全交 pi（pi 对 JSONC/BOM 的宽容与本扩展无关）。
 * - **错误可见性靠 pi 自己的诊断**：`refresh()` 只返回 `{aborted, errors}`，本退化类
 *   （models.json 解析失败 / schema 非法）实测 `errors.size=0`、`aborted=false`——**唯一有效判据是
 *   `ctx.modelRegistry.getError()`**（`dist/core/model-runtime.js:305-317` 合成 config error +
 *   per-provider composition error）。非空即原样落 ERROR 日志（不解析、不分类、不新增判定层）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";
import { injectCatalogOverlay, type CatalogOverlayBridge } from "./catalog-bridge.ts";

/** pi 的 models.json 授权源文件名（加载时同步的存在性护栏判据）。 */
const MODELS_JSON = "models.json";

/**
 * 日志出口 = @zhushanwen/pi-extension-logger（logging-conventions.md 三层通道分类）。
 * pi 自身不捕获 extension 的 stderr——`process.stderr.write` 直写在独立 pi 用户形态下
 * 不落任何文件（taiji 托管形态的落盘链也只是 runtime rpc-client 转发），故不走 stderr：
 * - error（config 消失 / 引擎拒绝配置 / refresh 报错 / 同步异常）→ pi.appendEntry 持久化
 *   （session JSONL custom entry `provider-live-sync:log`，不进 LLM 上下文）+
 *   `TAIJI_AGENT_DEBUG=1` / `TAIJI_AGENT_EXT_LOG=1` 时文件日志（`<agentDir>/logs/`）；
 * - debug（同步的正常观察 `refreshing model snapshot`）→ 仅文件日志，默认 no-op
 *   （taiji 托管环境 runtime spawn 恒注入 `TAIJI_AGENT_EXT_LOG=1`，INFO 级落盘）。
 * 消息前缀 `[provider-live-sync]` 由 logger 按 extName 自动补（getLogger 名即前缀唯一来源）。
 */
const logger = getLogger("provider-live-sync");

/** models.json 是否存在：ENOENT → false；其它读错误（EACCES 等）按存在处理——此时刷新无害。 */
async function isModelsJsonPresent(): Promise<boolean> {
  try {
    await readFile(join(getAgentDir(), MODELS_JSON), { encoding: "utf8" });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code !== "ENOENT";
  }
}

/** 零网络本地刷新 + 结果报告（`getError()` 全文是唯一有效判据，见模块头注释）。 */
async function refreshAndReport(modelRegistry: ExtensionContext["modelRegistry"]): Promise<void> {
  const result = await modelRegistry.refresh({ allowNetwork: false });
  // 有效判据 = getError() 全文（本退化类 errors.size/aborted 恒为空/假，见模块头注释）。
  const error = modelRegistry.getError();
  if (error) {
    // 不限定来源（models.json/auth.json/目录投喂注入集都可能被拒）：composition error 的
    // 归因在各自产生侧（目录投喂侧见 catalog-bridge.ts 的 registerProvider/skipped 日志）。
    logger.error(`model config rejected by the engine: ${error}`);
  } else if (result.errors.size > 0 || result.aborted) {
    logger.error(`refresh finished with errors (aborted=${String(result.aborted)}, providers=${result.errors.size})`);
  }
}

export default function providerLiveSync(pi: ExtensionAPI): void {
  // 最早期注入 pi handle——上方 logger 的 error 通道（appendEntry）由此生效（session-reader 同款）。
  setPiHandle(pi);
  // 目录投喂（设计 D1）：必须在同步的工厂体内完成——pi 的 pending 队列在全部工厂返回后
  // 统一 flush，晚于 `--model` 解析就覆盖不了 spawn 近似回退。返回 null = 非 taiji 托管
  // 环境（R1），注册对账整条不挂。
  const overlayBridge: CatalogOverlayBridge | null = injectCatalogOverlay(pi);

  pi.on("session_start", async (_event, sessionCtx) => {
    try {
      // 注册对账先行（D5）：工厂期 expired / never-seen / 损坏的 provider 在缓存修复 /
      // 变 fresh 后，由此补注册（挂 refreshModels 钩子）；随后的刷新才会碰到它们。
      if (overlayBridge !== null) overlayBridge.reconcile();

      if (!(await isModelsJsonPresent())) {
        logger.debug(
          "models.json absent — refresh skipped (rebuilding from an empty config would drop "
          + "the user's custom providers; the engine keeps its spawn-time snapshot)",
        );
        return;
      }

      logger.debug("session start → refreshing model snapshot (local, no network)");
      await refreshAndReport(sessionCtx.modelRegistry);
    } catch (err) {
      // 同步失败不阻断会话启动：下次 session_start 重试。
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`session-start sync failed: ${message}`);
    }
  });
}
