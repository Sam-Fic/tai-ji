import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUiDictionary, type UiDictionaryTable } from "../ui-dictionary.ts";
import { DEFAULT_UI_LOCALE, readUiLocale } from "../ui-locale.ts";

// t() 的 locale 缺省档读 readUiLocale（env 驱动）：stub env 控制进程态分支；
// 显式 locale 实参分支不依赖 env（纯函数口径）。
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "llm-shared-ui-dictionary-"));
	vi.stubEnv("TAIJI_AGENT_DATA_DIR", dir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const EN: UiDictionaryTable = {
	"greet.hello": "Hello {name}",
	"greet.missing": "fallback en",
};
const ZH: UiDictionaryTable = {
	"greet.hello": "你好 {name}",
};

function makeDictionary() {
	return createUiDictionary({ "zh-CN": ZH, "en-US": EN });
}

describe("createUiDictionary —— 词典机制单点（回落链 / 插值 / 键集合）", () => {
	it("t()：显式 locale 命中对应词典 + 占位符插值", () => {
		const { t } = makeDictionary();
		expect(t("greet.hello", { name: "世界" }, "zh-CN")).toBe("你好 世界");
		expect(t("greet.hello", { name: "world" }, "en-US")).toBe("Hello world");
	});

	it("t()：当前 locale 缺键 → 回落 en-US 词典值（zh 无 greet.missing）", () => {
		const { t } = makeDictionary();
		expect(t("greet.missing", undefined, "zh-CN")).toBe("fallback en");
	});

	it("t()：双词典均缺键 → 回落键名本身（禁返回空串——meta.title 非空保证的来源）", () => {
		const { t } = makeDictionary();
		expect(t("greet.absent", undefined, "zh-CN")).toBe("greet.absent");
	});

	it("t()：locale 实参缺省 → 读进程态（ui-preferences.json zh-CN 生效；缺文件回落 en-US）", () => {
		const { t } = makeDictionary();
		writeFileSync(
			join(dir, "ui-preferences.json"),
			JSON.stringify({ v: 1, locale: "zh-CN", updatedAt: 1 }),
		);
		expect(t("greet.hello", { name: "x" })).toBe("你好 x");
		// 文件缺失 / env 缺失 → readUiLocale 回落 DEFAULT_UI_LOCALE（en-US）
		expect(t("greet.hello", { name: "x" })).toBe("你好 x"); // 缓存内仍 zh
		rmSync(join(dir, "ui-preferences.json"), { force: true });
		expect(t("greet.hello", { name: "x" })).toBe("Hello x");
		expect(DEFAULT_UI_LOCALE).toBe("en-US");
		expect(readUiLocale()).toBe("en-US");
	});

	it("t()：占位符缺参 → 保留 {name} 原样（非空）", () => {
		const { t } = makeDictionary();
		expect(t("greet.hello", undefined, "en-US")).toBe("Hello {name}");
	});

	it("dictionaryKeys：zh/en 双侧键集合对账（测试超集断言的承载面）", () => {
		const { dictionaryKeys } = makeDictionary();
		expect(dictionaryKeys("en-US").sort()).toEqual(["greet.hello", "greet.missing"]);
		expect(dictionaryKeys("zh-CN")).toEqual(["greet.hello"]);
	});
});
