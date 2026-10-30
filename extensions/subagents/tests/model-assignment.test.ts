import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CollaborationManager } from "../runtime/collaboration-manager.ts";
import { createSubagentRuntimeState } from "../runtime/state.ts";
import { RpcProcess } from "../rpc-process.ts";
import { DEFAULT_SETTINGS } from "../settings.ts";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-rpc-child.mjs", import.meta.url),
);

interface Harness {
  manager: CollaborationManager;
  ctx: any;
  invocations: Array<{ command: string; args: string[] }>;
  processes: RpcProcess[];
  cleanup: () => Promise<void>;
}

function createHarness(options: { models?: Array<{ provider: string; id: string; auth?: boolean }> } = {}): Harness {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-assignment-"));
  const tools: any[] = [];
  const pi = {
    registerTool: (tool: any) => tools.push(tool),
    getActiveTools: () => [],
    getAllTools: () => [],
    getThinkingLevel: () => "medium",
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    on: () => undefined,
  } as unknown as ExtensionAPI;

  const registryModels = (options.models ?? []).map((entry) => ({
    provider: entry.provider,
    id: entry.id,
  }));
  const ctx = {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    hasUI: false,
    mode: "rpc",
    model: { provider: "root-provider", id: "root-model" },
    signal: new AbortController().signal,
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        registryModels.find(
          (model) => model.provider === provider && model.id === modelId,
        ),
      hasConfiguredAuth: (model: { provider: string; id: string }) => {
        const entry = (options.models ?? []).find(
          (candidate) => candidate.provider === model.provider && candidate.id === model.id,
        );
        return entry?.auth !== false;
      },
    },
    sessionManager: {
      getSessionId: () => "model-assignment-root",
      getSessionFile: () => undefined,
      getSessionDir: () => sessionDir,
      getEntries: () => [],
      getBranch: () => [],
    },
  } as any;

  const state = createSubagentRuntimeState({
    pi,
    settings: {
      ...DEFAULT_SETTINGS,
      sessionDir,
      rpcStartupTimeoutMs: 1_000,
      rpcRequestTimeoutMs: 1_000,
      rpcShutdownTimeoutMs: 250,
    },
    currentDepth: 0,
    envMaxDepth: 2,
    extensionPath: "/extension/index.ts",
    currentPath: "/root",
    guardToken: {},
    invocationBase: { command: process.execPath, prefixArgs: [] },
  });
  state.latestCtx = ctx;
  state.projectTrusted = true;
  state.treeMaxResidentAgents = 4;
  state.treeMaxActiveAgents = 4;
  state.broker = {
    endpoint: { socketPath: "/tmp/fake-model-broker.sock" },
    reserveChild: async (input: any) => ({
      path: `/root/${input.taskName}`,
      capability: "a".repeat(64),
      generation: 1,
    }),
    awaitChildRegistration: async () => undefined,
    commitChildRegistration: async () => undefined,
    abortChildRegistration: async () => undefined,
    releaseReservation: async () => undefined,
    updateAgent: async () => undefined,
    list: async () => ({ agents: [] }),
    close: async () => undefined,
  } as any;

  const invocations: Array<{ command: string; args: string[] }> = [];
  const processes: RpcProcess[] = [];
  let sequence = 0;
  const manager = new CollaborationManager(state, (command, args, spawnOptions) => {
    invocations.push({ command, args: [...args] });
    const client = new RpcProcess(process.execPath, [fixture], {
      ...spawnOptions,
      env: {
        ...spawnOptions.env,
        FAKE_SETTLE_DELAY_MS: "0",
        FAKE_SESSION_SUFFIX: String(++sequence),
      },
    });
    processes.push(client);
    return client;
  });
  state.manager = manager;

  return {
    manager,
    ctx,
    invocations,
    processes,
    cleanup: async () => {
      for (const client of processes) await client.stop().catch(() => undefined);
      await manager.shutdown().catch(() => undefined);
      fs.rmSync(sessionDir, { recursive: true, force: true });
    },
  };
}

describe("per-agent model and thinking assignment", () => {
  test("launches the child with the requested model and thinking level", async () => {
    const harness = createHarness({
      models: [{ provider: "deepseek", id: "deepseek-v4-pro" }],
    });
    try {
      await harness.manager.spawnAgent(
        {
          task_name: "scout",
          message: "read the repo",
          fork_turns: "none",
          model: "deepseek/deepseek-v4-pro",
          thinking: "low",
        } as any,
        undefined,
        harness.ctx,
        "call-model-1",
      );
      const args = harness.invocations[0]?.args ?? [];
      expect(args[args.indexOf("--model") + 1]).toBe("deepseek/deepseek-v4-pro");
      expect(args[args.indexOf("--thinking") + 1]).toBe("low");
    } finally {
      await harness.cleanup();
    }
  }, 30_000);

  test("inherits the spawning agent's model when no override is given", async () => {
    const harness = createHarness();
    try {
      await harness.manager.spawnAgent(
        { task_name: "inherit", message: "work", fork_turns: "none" } as any,
        undefined,
        harness.ctx,
        "call-model-2",
      );
      const args = harness.invocations[0]?.args ?? [];
      expect(args[args.indexOf("--model") + 1]).toBe("root-provider/root-model");
      expect(args[args.indexOf("--thinking") + 1]).toBe("medium");
    } finally {
      await harness.cleanup();
    }
  }, 30_000);

  test("rejects an unknown model before any capacity or process exists", async () => {
    const harness = createHarness({
      models: [{ provider: "deepseek", id: "deepseek-v4-pro" }],
    });
    try {
      await expect(
        harness.manager.spawnAgent(
          {
            task_name: "typo",
            message: "work",
            fork_turns: "none",
            model: "deepseek/deepseek-v4-proo",
          } as any,
          undefined,
          harness.ctx,
          "call-model-3",
        ),
      ).rejects.toThrow(/Unknown model 'deepseek\/deepseek-v4-proo'/);
      expect(harness.invocations).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  }, 30_000);

  test("rejects a model with no configured credentials", async () => {
    const harness = createHarness({
      models: [{ provider: "openai", id: "gpt-5.6-luna", auth: false }],
    });
    try {
      await expect(
        harness.manager.spawnAgent(
          {
            task_name: "noauth",
            message: "work",
            fork_turns: "none",
            model: "openai/gpt-5.6-luna",
          } as any,
          undefined,
          harness.ctx,
          "call-model-4",
        ),
      ).rejects.toThrow(/no configured credentials/);
      expect(harness.invocations).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  }, 30_000);
});
