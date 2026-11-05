/**
 * plan 包 i18n 层（u-locale-channel 消费端）：只本地化「给人看的交互侧」——complete
 * 执行方式选择的 FormOverlay 单 choice 问题（question/header/options）与 ctx.ui.notify
 * 提示。tool result 里的英文是给 LLM 的执行指令，不进词典（agent 会以会话语言转述，
 * 指令语言 ≠ UI 语言）。
 *
 * locale 读取（readUiLocale）与词典模板渲染机制（t / dictionaryKeys，回落链当前
 * locale → en-US → 键名，scheduler r4 S1 同款禁返回空串）下沉在
 * `@zhushanwen/pi-llm-shared` 单一实现（@data-owner #39 注解随实现持有），本包
 * 经 createUiDictionary 消费机制、只持有词典数据；env `TAIJI_AGENT_DATA_DIR` 缺失 /
 * 文件缺失 / JSON 损坏 → 回落 `en-US`（与 runtime readUiPreferences 的降级口径一致）。
 */
import { DEFAULT_UI_LOCALE, readUiLocale } from "@zhushanwen/pi-llm-shared/ui-locale";
import { createUiDictionary } from "@zhushanwen/pi-llm-shared/ui-dictionary";

export { DEFAULT_UI_LOCALE, readUiLocale };

/** 词典 key 集合（exec-choice 交互侧 + notify；键缺失回落链见 t()）。 */
type Dictionary = Record<string, string>;

const EN_US: Dictionary = {
  "exec.question": "Plan is ready. Choose how to execute:",
  "exec.header": "Execution method",
  "exec.viaSkill": "Execute via skill: {name}",
  "exec.viaSkillDesc": "Load the {name} skill and follow its workflow to execute the plan.",
  "exec.execute": "Execute",
  "exec.executeDesc":
    "Set up goal tracking when available, then execute: delegate independent tasks to subagents, run small or tightly-coupled steps in this session.",
  "exec.later": "Not now",
  "exec.laterDesc": "Keep the plan and stay in plan mode. You can execute it later.",
  "exec.goalFailedNotify": "Goal tracking was not started ({reason}).",
};

const ZH_CN: Dictionary = {
  "exec.question": "计划已就绪，请选择执行方式：",
  "exec.header": "执行方式",
  "exec.viaSkill": "用技能「{name}」执行",
  "exec.viaSkillDesc": "加载 {name} 技能并按其工作流执行该计划。",
  "exec.execute": "执行",
  "exec.executeDesc": "可用时先建立 goal 跟踪，再自动执行：独立任务派发 subagent，小而紧耦合的步骤在本会话逐步完成。",
  "exec.later": "暂不执行",
  "exec.laterDesc": "保留计划并留在计划模式，稍后可再执行。",
  "exec.goalFailedNotify": "Goal 跟踪未能启动（{reason}）。",
};

const { t, dictionaryKeys } = createUiDictionary({ "zh-CN": ZH_CN, "en-US": EN_US });

export { t, dictionaryKeys };
