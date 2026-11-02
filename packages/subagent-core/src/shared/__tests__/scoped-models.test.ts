// src/shared/__tests__/scoped-models.test.ts
//
// scoped-models 白名单纯函数（scopedModelKey / assertModelWithinScoped）行为锁：
// 归一化口径（剥 :thinkingLevel 后缀——写入侧放行带后缀条目，比对必须无后缀）、
// 空数组全量放行、命中/未命中、错误文案（列白名单 + 恢复指引）。IO 读取
//（readScopedModels）在 execution/__tests__/model-config-service.test.ts 经
// ModelConfigService.getScopedModels 覆盖。

import { describe, expect, it } from "vitest";

import { assertModelWithinScoped, scopedModelKey } from "../scoped-models.ts";

describe("scopedModelKey（归一化比对键）", () => {
  it("剥 :thinkingLevel 后缀", () => {
    expect(scopedModelKey("zai/glm-4.7:xhigh")).toBe("zai/glm-4.7");
    expect(scopedModelKey("zai/glm-4.7")).toBe("zai/glm-4.7");
  });

  it("id 段内斜杠保留（account:xxx/some/model 形态）", () => {
    expect(scopedModelKey("acct-1/some/model:high")).toBe("acct-1/some/model");
  });
});

describe("assertModelWithinScoped（白名单断言）", () => {
  it("空数组 = 未启用 = 全量放行", () => {
    expect(() => assertModelWithinScoped("any/model", [], "test")).not.toThrow();
  });

  it("命中放行（精确 + 剥后缀口径）", () => {
    const scoped = ["zai/glm-4.7", "xiaomi/mimo-v2.6-pro"];
    expect(() => assertModelWithinScoped("zai/glm-4.7", scoped, "test")).not.toThrow();
    // 派发参数带档位后缀 → 剥后缀比对命中
    expect(() => assertModelWithinScoped("zai/glm-4.7:high", scoped, "test")).not.toThrow();
    // 白名单条目带后缀落盘（写入侧放行形态）→ 同样归一后命中
    expect(() => assertModelWithinScoped("zai/glm-4.7", ["zai/glm-4.7:xhigh"], "test")).not.toThrow();
  });

  it("未命中抛错：文案含校验源、白名单清单与恢复指引", () => {
    const scoped = ["zai/glm-4.7", "xiaomi/mimo-v2.6-pro"];
    try {
      assertModelWithinScoped("kimi/k2", scoped, "paramOverride");
      expect.unreachable("should throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('"kimi/k2" (paramOverride)');
      expect(message).toContain("scoped-models allowlist");
      expect(message).toContain("zai/glm-4.7");
      expect(message).toContain("xiaomi/mimo-v2.6-pro");
      expect(message).toContain("ask the user to extend the allowlist");
    }
  });

  it("白名单超过 20 条时清单截断 + 计数尾注", () => {
    const scoped = Array.from({ length: 25 }, (_, i) => `p/m-${i}`);
    try {
      assertModelWithinScoped("p/other", scoped, "test");
      expect.unreachable("should throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("p/m-19");
      expect(message).not.toContain("p/m-20");
      expect(message).toContain("...and 5 more");
    }
  });
});
