// src/__tests__/node-executor.test.ts
//
// W9 启动解析（宿主 × 平台二维矩阵）正反例（impl-plan §2.9）。
//（原 probeNodeExecutor 探针行为契约套件已随探针机制删除——执行器好坏由引擎
// spawn 后的实际退出/握手链兜底报错。）

import { describe, expect, it } from "vitest";

import {
  ENGINE_NODE_ENV,
  hostKindOf,
  resolveEngineNodeLaunch,
} from "../node-executor.ts";

describe("resolveEngineNodeLaunch 矩阵", () => {
  it("① pi-extension：env 缺 TAIJI_AGENT_ENGINE_NODE → engine_not_found + 指引", async () => {
    await expect(
      resolveEngineNodeLaunch({
        hostKind: "pi-extension",
        entryPath: "/engines/pi/index.js",
        env: {},
      }),
    ).rejects.toMatchObject({
      code: "engine_not_found",
      recovery: expect.stringContaining(ENGINE_NODE_ENV),
    });
  });

  it("① pi-extension：注入执行器 + 探针通过 → [executor, entry, ...args]，Electron 形态带 RUN_AS_NODE 语义", async () => {
    const launch = await resolveEngineNodeLaunch({
      hostKind: "pi-extension",
      entryPath: "/engines/pi/index.js",
      args: ["--flag"],
      env: { [ENGINE_NODE_ENV]: process.execPath, ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(launch).toEqual({
      command: process.execPath,
      args: ["/engines/pi/index.js", "--flag"],
      electronRunAsNode: true,
    });
  });

  it("① pi-extension：注入执行器路径原样返回（不探针——执行器好坏由 run 后退出/握手链兜底）", async () => {
    const launch = await resolveEngineNodeLaunch({
      hostKind: "pi-extension",
      entryPath: "/engines/pi/index.js",
      env: { [ENGINE_NODE_ENV]: "/nonexistent/node" },
    });
    expect(launch.command).toBe("/nonexistent/node");
    expect(launch.args[0]).toBe("/engines/pi/index.js");
  });

  it("② runtime-sidecar：process.execPath 权威 + isElectronHost 决定 RUN_AS_NODE", async () => {
    const launch = await resolveEngineNodeLaunch({
      hostKind: "runtime-sidecar",
      entryPath: "/engines/zcode/index.js",
      execPath: process.execPath,
      isElectronHost: true,
    });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toBe("/engines/zcode/index.js");
    expect(launch.electronRunAsNode).toBe(true);

    const asNode = await resolveEngineNodeLaunch({
      hostKind: "runtime-sidecar",
      entryPath: "/e.js",
      execPath: process.execPath,
      isElectronHost: false,
    });
    expect(asNode.electronRunAsNode).toBe(false);
  });

  it("③ standalone：PATH node 探针通过 → [node, entry]", async () => {
    const launch = await resolveEngineNodeLaunch({
      hostKind: "standalone",
      entryPath: "/engines/pi/index.js",
    });
    expect(launch.command).toBe("node");
    expect(launch.args).toEqual(["/engines/pi/index.js"]);
  });

  it("Windows + .cmd 入口 → 显式 cmd.exe /c + 参数数组（禁 shell:true 形态）", async () => {
    const launch = await resolveEngineNodeLaunch({
      hostKind: "standalone",
      entryPath: "C:\\engines\\zcode\\zcode-subagent-cli.cmd",
      args: ["--x"],
      platform: "win32",
    });
    expect(launch).toEqual({
      command: "cmd.exe",
      args: ["/c", "C:\\engines\\zcode\\zcode-subagent-cli.cmd", "--x"],
      electronRunAsNode: false,
    });
  });
});

describe("hostKindOf（EngineClient 自由字符串归一）", () => {
  it("runtime* → runtime-sidecar", () => {
    expect(hostKindOf("runtime", {})).toBe("runtime-sidecar");
  });

  it("env 带 TAIJI_AGENT_ENGINE_NODE → pi-extension（打包态注入通道）", () => {
    expect(hostKindOf("pi", { [ENGINE_NODE_ENV]: process.execPath })).toBe("pi-extension");
  });

  it("其余（standalone pi / zsw，无注入）→ standalone", () => {
    expect(hostKindOf("pi", {})).toBe("standalone");
    expect(hostKindOf("zsw", { [ENGINE_NODE_ENV]: " " })).toBe("standalone");
  });
});
