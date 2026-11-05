/**
 * L2 extension 词典机制单点：词典模板渲染（t / dictionaryKeys）的唯一实现，需求方 =
 * plan / scheduler / subagent-workflow 等 extension 的 i18n 层，经本模块 import。
 *
 * 与 ui-locale 同一归属原则：机制下沉单一实现，扩展各自只持有词典数据（键值是各扩展
 * 的业务真差异，不收编）。回落链：当前 locale → en-US（DEFAULT_UI_LOCALE）→ 键名本身
 * （**禁返回空串**）——所有经 t() 赋值的字段天然非空（meta.title 依赖本保证）；占位符
 * 缺参时保留 `{name}` 原样（非空）。
 *
 * locale 读取时机 = 每次 t() 调用时读（locale 实参缺省时经 readUiLocale 现读），不带
 * 缓存失效问题：界面语言切换后下一次渲染即生效。
 */

import { DEFAULT_UI_LOCALE, readUiLocale } from "./ui-locale.ts";
import type { UiLocale } from "./ui-locale.ts";

/** 词典表形状（key → 模板串；占位符形如 `{name}`）。 */
export type UiDictionaryTable = Record<string, string>;

/** 词典消费面（扩展 i18n 层构造后按原名 re-export 给本包调用点与测试）。 */
export interface UiDictionary { // oe-exempt:20261105:framework:词典机制工厂返回契约（机制单点单一装配，本文件 createUiDictionary）
	t(key: string, params?: Record<string, string | number>, locale?: UiLocale): string;
	/** 指定语言的词典 key 集合（测试用于 zh/en 双侧对齐 + 超集断言）。 */
	dictionaryKeys(locale: UiLocale): string[];
}

/** 从 zh/en 词典表构造词典消费面（词典数据入参，机制实现在本模块单点）。 */
export function createUiDictionary(dictionaries: Record<UiLocale, UiDictionaryTable>): UiDictionary {
	return {
		t(key, params, locale) {
			const resolved = locale ?? readUiLocale();
			const template = dictionaries[resolved][key] ?? dictionaries[DEFAULT_UI_LOCALE][key] ?? key;
			return interpolateTemplate(template, params);
		},
		dictionaryKeys(locale) {
			return Object.keys(dictionaries[locale]);
		},
	};
}

function interpolateTemplate(template: string, params?: Record<string, string | number>): string {
	if (params === undefined) return template;
	return template.replace(/\{(\w+)\}/g, (match: string, name: string): string => {
		const value = params[name];
		return value === undefined ? match : String(value);
	});
}
