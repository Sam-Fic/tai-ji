/**
 * staged 特殊资产目录单一登记表（MF-1-17）——「builtin 包 short 名 → staged 包根下
 * 专项资产目录数组」的唯一登记处，bundle / verify 两端共读，禁止在任一侧另持字面量表。
 *
 * 两端契约：
 *  - bundle-extensions.mjs：bundleOne 按 short 查表分发专项拷贝（copySpecialAssets，
 *    按目录名分发到对应拷贝函数：templates → copyTemplatesDir / bin → copyBinDir）。
 *    新增条目须同步实现拷贝函数并在分发处接线，漏实现 = staged 缺目录 → verify 侧
 *    红灯（fail-fast 暴露）。
 *  - verify-staged-extensions.mjs：按 staged 目录名（pi-<short>，查表前去 pi- 前缀）
 *    校验每个登记目录存在且非空。这些目录不走 pi manifest 三字段（agents/skills/
 *    workflows），manifest 模式的 resource-discovery 不扫 staged 目录，checkManifest
 *    探测不到——登记表是缺失/为空的唯一 postbuild 拦截点。
 *
 * 现有条目：
 *  - plan 的 templates/ —— 内置计划模板 .md，<available-plans> 清单注入与
 *    select-template 的数据源（templates.ts 被 esbuild inline 进包根 index.js 后按同级
 *    templates/ 定位，双形态探测见该文件 getBuiltinTemplateDir 注释）。缺失后果：打包版
 *    templates/ 恒空（scanTemplateDir 对缺失/空目录防御性返回空清单、listTemplates 仅
 *    warn 不 throw 的静默失效），<available-plans> 清单为空、agent 被引导自行组织章节，
 *    内置模板能力整体丢失。
 *  - base-tool-enhance 的 bin/ —— 前台空闲转后台包装脚本 taiji-fg-wrap（可执行 bash
 *    脚本，经 chmod 可执行位随 cp 保留；bash-tool.ts 被 esbuild inline 进包根 index.js
 *    后由 resolveFgWrapScriptPath 双形态探测定位同级 bin/）。缺失后果：打包版改写层构造
 *    的每条包装命令串都指向不存在的脚本——全部常规前台命令 exit 127（command not
 *    found），核心路径断裂（fail-fast 可见，与 templates 的静默失效形态相反）。
 *
 * 分发链与 workflows 同理：bundle staged（bundle-extensions.mjs）→
 * electron-builder extraResources 整目录携带，无需改 yml。
 */
export const PACKAGE_ASSET_DIRS = {
	plan: ["templates"],
	"base-tool-enhance": ["bin"],
};
