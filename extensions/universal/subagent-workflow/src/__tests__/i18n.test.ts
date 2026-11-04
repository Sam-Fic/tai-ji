// i18n.test.ts —— subagent-workflow 扩展的 L2 呈现层词典 + locale 读取接线
// （tray-panel-interact 设计 §3.3 D9：托盘面板文案随 UI 语言）。
//
// 三视角：
//   ①使用者（宿主 widget 区 / TUI 呈现层）——每个托盘文案键在 zh-CN 与 en-US 两域都有
//     非空值，且值随 locale 切换（标题「子代理 / Subagents」、分段「进行中 / In progress」、
//     按钮「取消 / Cancel」等）——界面语言一切，面板文案即切；
//   ②构建者——t() 回落链（locale 命中 → en 兜底 → 键名本身，禁空串）与占位符插值；
//   ③观察者——readUiLocale 的 ui-preferences.json 读取 / 值域外回落 / env 或文件缺失
//     回落 en-US 且不出声（降级 ≠ 吞错由 llm-shared 单测覆盖，本文件锁消费端接线）。
//
// 判据单点：locale 读取器（readUiLocale + mtime/size 缓存 + 降级）在
// `@zhushanwen/pi-llm-shared/ui-locale` 单一实现（先例 = scheduler / plan 的 i18n 层），
// 本文件经 import 消费同一实现，不复制第二份读取逻辑。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_UI_LOCALE,
  dictionaryKeys,
  readUiLocale,
  t,
  type UiLocale,
} from "../i18n.ts";

/** 托盘面板全部文案键（标题 / 分段标签 / 行内操作按钮与确认文案 / interrupted 状态覆盖字）——新增键必须同批补两侧词典。 */
const TRAY_COPY_KEYS = [
  "tray.subagent.title",
  "tray.workflow.title",
  "tray.segment.running",
  "tray.segment.ended",
  "tray.action.cancel",
  "tray.action.cancelConfirm",
  "tray.action.retry",
  "tray.action.abort",
  "tray.action.abortConfirm",
  "tray.action.resume",
  "tray.workflow.interruptedLabel",
] as const;

describe("subagent-workflow i18n（D9 消费端）", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    while (tmpRoots.length > 0) {
      const root = tmpRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("zh/en 双侧词典 key 集合严格对齐（漂移即红灯）", () => {
    expect(dictionaryKeys("zh-CN").sort()).toEqual(dictionaryKeys("en-US").sort());
    expect(dictionaryKeys("en-US").length).toBeGreaterThan(0);
  });

  it("托盘文案键全覆盖：标题 / 分段 / 按钮与确认文案在两侧词典均在册", () => {
    const zh = new Set(dictionaryKeys("zh-CN"));
    const en = new Set(dictionaryKeys("en-US"));
    for (const key of TRAY_COPY_KEYS) {
      expect(zh.has(key), `zh-CN 缺键 ${key}`).toBe(true);
      expect(en.has(key), `en-US 缺键 ${key}`).toBe(true);
    }
  });

  it("文案随 locale：标题 / 分段标签 / 按钮与确认文案两域取值不同且非空", () => {
    for (const key of TRAY_COPY_KEYS) {
      const zh = t(key, { n: 3 }, "zh-CN");
      const en = t(key, { n: 3 }, "en-US");
      expect(zh.length, `键 ${key} 中文值为空`).toBeGreaterThan(0);
      expect(en.length, `键 ${key} 英文值为空`).toBeGreaterThan(0);
      expect(zh, `键 ${key} 两域取值相同（未随 locale 切换？）`).not.toBe(en);
    }
    // 措辞锚点（防词典被误改成同值或占位符漏替换）
    expect(t("tray.subagent.title", undefined, "zh-CN")).toBe("子代理");
    expect(t("tray.subagent.title", undefined, "en-US")).toBe("Subagents");
    expect(t("tray.workflow.title", undefined, "zh-CN")).toBe("工作流");
    expect(t("tray.workflow.title", undefined, "en-US")).toBe("Workflows");
    expect(t("tray.segment.running", { n: 2 }, "zh-CN")).toBe("进行中 2");
    expect(t("tray.segment.running", { n: 2 }, "en-US")).toBe("In progress 2");
    expect(t("tray.segment.ended", { n: 0 }, "zh-CN")).toBe("已结束 0");
    expect(t("tray.action.cancel", undefined, "zh-CN")).toBe("取消");
    expect(t("tray.action.cancel", undefined, "en-US")).toBe("Cancel");
    expect(t("tray.action.cancelConfirm", undefined, "zh-CN")).toBe("确认取消？");
    expect(t("tray.action.cancelConfirm", undefined, "en-US")).toBe("Confirm cancel?");
    expect(t("tray.action.abort", undefined, "en-US")).toBe("Abort");
    expect(t("tray.action.abortConfirm", undefined, "en-US")).toBe("Confirm abort?");
    expect(t("tray.action.retry", undefined, "en-US")).toBe("Retry");
    expect(t("tray.action.resume", undefined, "en-US")).toBe("Resume");
    expect(t("tray.workflow.interruptedLabel", undefined, "zh-CN")).toBe("已中断（可续跑）");
    expect(t("tray.workflow.interruptedLabel", undefined, "en-US")).toBe("Interrupted (resumable)");
  });

  it("t() 回落链：locale 命中 → 键缺失回落键名（禁空串）；缺参占位符原样保留", () => {
    expect(t("tray.subagent.title", undefined, "zh-CN")).toBe("子代理");
    expect(t("tray.nonexistent", undefined, "zh-CN")).toBe("tray.nonexistent");
    // 缺参不插值：{n} 原样保留（非空，防「分段标签变空段头」）
    expect(t("tray.segment.running", undefined, "zh-CN")).toBe("进行中 {n}");
    expect(t("tray.segment.running", { n: 5 }, "zh-CN")).toBe("进行中 5");
  });

  it("readUiLocale：ui-preferences.json zh-CN 命中 + 值域外回落", () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-wf-i18n-test-"));
    tmpRoots.push(root);
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", root);

    writeFileSync(join(root, "ui-preferences.json"), JSON.stringify({ v: 1, locale: "zh-CN" }));
    expect(readUiLocale()).toBe("zh-CN");

    // 值域外回落：换新目录（readUiLocale 有 (mtimeMs,size,filePath) 模块缓存，
    // 同尺寸同 mtime 的原地重写可能命中缓存，换 filePath 强制重读）
    const root2 = mkdtempSync(join(tmpdir(), "subagent-wf-i18n-test-"));
    tmpRoots.push(root2);
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", root2);
    writeFileSync(join(root2, "ui-preferences.json"), JSON.stringify({ v: 1, locale: "fr-FR" }));
    expect(readUiLocale()).toBe(DEFAULT_UI_LOCALE);
  });

  it("readUiLocale：env 缺失 / 文件缺失 / JSON 损坏 → 回落 en-US 不出声", () => {
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", join(tmpdir(), "subagent-wf-i18n-missing-dir"));
    expect(readUiLocale()).toBe("en-US");

    vi.stubEnv("TAIJI_AGENT_DATA_DIR", undefined);
    expect(readUiLocale()).toBe("en-US");
  });

  it("t() 不传 locale 时读进程态（推送路径口径：每次推送时读，切换后下次推送生效）", () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-wf-i18n-test-"));
    tmpRoots.push(root);
    vi.stubEnv("TAIJI_AGENT_DATA_DIR", root);
    writeFileSync(join(root, "ui-preferences.json"), JSON.stringify({ v: 1, locale: "zh-CN" }));
    const locale: UiLocale = readUiLocale();
    expect(t("tray.workflow.title", undefined, locale)).toBe("工作流");
  });
});
