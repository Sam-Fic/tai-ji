// btw-fork-exec-mock.test.ts —— fork bootstrap（watchForNewJsonl + forkViaCliPi）的
// mock 双轨单测（默认档）。
//
// 与集成门控 btw-lifecycle.test.ts 的 forkViaCliPi 用例（真 fake-pi 子进程 +
// describe.skipIf(TAIJI_TEST_INTEGRATION)）构成同一行为面的双轨：coverage gate 本地跑
// 不开集成门控，时间机制删除后 fs.watch 事件驱动重写的新增行需 mock 形态在默认档
// 覆盖。spawn 与 fs.watch 全 mock（回调手动触发，确定性收口）——零子进程、零墙钟等待；
// fork 时序保真（写序 / 收割语义）由集成门控侧承载。
//
// readSessionHeader / hasDanglingToolCall / inspectSourceState 纯函数段由
// btw-lifecycle.test.ts 默认档 describe 覆盖，不在本文件重复。

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // 只替换 watch（fork 就绪检测的注入点）；readFileSync/readdirSync/mkdirSync 等
  // 保留真实现——threadDir 用真实 tmp 目录，existing 扫描走真实 readdirSync。
  return { ...actual, watch: mocks.watch };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mocks.spawn };
});

import { forkViaCliPi } from "../btw-fork-exec.js";

/** fake bootstrap 子进程：stdout/stderr 流 + exit/error 事件 + kill spy（EventEmitter 收口）。 */
interface FakeChild extends EventEmitter {  // oe-exempt:20261105:test:mock 夹具契约面（stub 形状接口，单实现为测试常态）
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

/** mock fs.watch 返回的假 watcher（error handler 捕获 + close spy）。 */
interface FakeWatcher {  // oe-exempt:20261105:test:mock 夹具契约面（stub 形状接口，单实现为测试常态）
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let dir: string;
let fakeChild: FakeChild;
let watchers: FakeWatcher[];
let watchHandlers: Map<string, (event: string, filename: string | null) => void>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "btw-fork-exec-mock-"));
  fakeChild = makeFakeChild();
  watchers = [];
  watchHandlers = new Map();

  mocks.watch.mockImplementation(
    (watchDir: string, handler: (event: string, filename: string | null) => void) => {
      watchHandlers.set(watchDir, handler);
      const watcher: FakeWatcher = { on: vi.fn(), close: vi.fn() };
      watchers.push(watcher);
      return watcher;
    },
  );
  mocks.spawn.mockImplementation(() => fakeChild);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.clearAllMocks();
});

/** 跨微任务链 flush（race / death IIFE / finally 链的推进；非墙钟等待）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

describe("forkViaCliPi mock 双轨（默认档）", () => {
  it("watch 回调发现新增 .jsonl → SIGTERM 收 bootstrap → 等退出 → 返回文件路径；argv 双旗标原样", async () => {
    const src = join(dir, "src.jsonl");
    const p = forkViaCliPi({ piCommand: "/fake/pi", sourceFile: src, threadDir: dir, cwd: dir });
    await flush();

    // spawn 参数：--mode rpc --fork <源> --session-dir <线目录>（reap-orphan-pi 判据②的 argv 面）
    expect(mocks.spawn).toHaveBeenCalledWith(
      "/fake/pi",
      ["--mode", "rpc", "--fork", src, "--session-dir", dir],
      expect.objectContaining({ cwd: dir }),
    );

    const handler = watchHandlers.get(dir);
    expect(handler).toBeDefined();
    handler?.("rename", "fresh.jsonl");
    await flush();

    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM"); // 文件可见即收（写入侧封闭靠等退出）
    fakeChild.emit("exit", 0);
    await expect(p).resolves.toBe(join(dir, "fresh.jsonl"));
  });

  it("filename 缺省形态（watch 回调不给文件名）→ 目录全量扫一次兜底（事件触发的一次性扫描，非周期轮询）", async () => {
    const p = forkViaCliPi({ piCommand: "/fake/pi", sourceFile: join(dir, "s.jsonl"), threadDir: dir, cwd: dir });
    await flush();

    const handler = watchHandlers.get(dir);
    handler?.("rename", null); // 无新文件 → 不 resolve（覆盖兜底扫描的空结果路径）
    await flush();
    expect(fakeChild.kill).not.toHaveBeenCalled();

    // 兜底扫描：写文件后再次 filename=null 事件 → readdirSync 扫到新增 .jsonl
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "late.jsonl"), '{"type":"session","id":"late"}\n');
    handler?.("change", null);
    await flush();

    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
    fakeChild.emit("exit", 0);
    await expect(p).resolves.toBe(join(dir, "late.jsonl"));
  });

  it("bootstrap 异常退出（无文件）→ fork_failed 携 stderr 尾三行；收口 kill 为无害 no-op", async () => {
    const p = forkViaCliPi({ piCommand: "/fake/pi", sourceFile: join(dir, "s.jsonl"), threadDir: dir, cwd: dir });
    await flush();

    fakeChild.stderr.emit("data", Buffer.from("Cannot fork: invalid source\nline2\nline3\nline4\n"));
    fakeChild.emit("exit", 1);

    await expect(p).rejects.toThrow(/exited \(code 1\).*line2 \| line3 \| line4/s);
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM"); // 死亡路径统一出口的收口调用
  });

  it("spawn 'error' 事件（ENOENT 形态）→ fork_failed 携原因（M1-b：不 uncaught、不挂起）", async () => {
    const p = forkViaCliPi({ piCommand: "/no/such/pi", sourceFile: join(dir, "s.jsonl"), threadDir: dir, cwd: dir });
    await flush();

    fakeChild.emit("error", new Error("spawn /no/such/pi ENOENT"));

    await expect(p).rejects.toThrow(/spawn failed.*spawn \/no\/such\/pi ENOENT — source=/s);
  });

  it("spawn 同步抛（参数侧异常）→ fork_failed，且就绪 watcher 显式 close（不泄漏）", async () => {
    mocks.spawn.mockImplementation(() => {
      throw new Error("bad options");
    });
    const p = forkViaCliPi({ piCommand: "/fake/pi", sourceFile: join(dir, "s.jsonl"), threadDir: dir, cwd: dir });

    await expect(p).rejects.toThrow(/pi fork bootstrap spawn failed.*bad options/s);
    expect(watchers[0]?.close).toHaveBeenCalled(); // spawn 失败分支的 readiness.close()
  });

  it("watch error（就绪检测侧失败）→ fork_failed 携 watch 失败原因，bootstrap 收掉再上抛", async () => {
    const p = forkViaCliPi({ piCommand: "/fake/pi", sourceFile: join(dir, "s.jsonl"), threadDir: dir, cwd: dir });
    await flush();

    const errorHandler = watchers[0]?.on.mock.calls.find(([event]) => event === "error")?.[1] as
      | ((e: Error) => void)
      | undefined;
    expect(errorHandler).toBeDefined();
    errorHandler?.(new Error("EPERM: watch denied"));

    await expect(p).rejects.toThrow(/watch failed.*EPERM/s);
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM"); // 非死亡路径：收掉还活着的 bootstrap
  });

  it("成功路径不泄漏 watcher（settled 后 close 为 no-op）；race 输掉方 rejection 显式吞（无 unhandled）", async () => {
    const p = forkViaCliPi({ piCommand: "/fake/pi", sourceFile: join(dir, "s.jsonl"), threadDir: dir, cwd: dir });
    await flush();

    watchHandlers.get(dir)?.("rename", "fresh.jsonl");
    await flush();
    expect(watchers[0]?.close).not.toHaveBeenCalled(); // settled=true → close() 幂等跳过
    fakeChild.emit("exit", 0);
    await p;
  });
});
