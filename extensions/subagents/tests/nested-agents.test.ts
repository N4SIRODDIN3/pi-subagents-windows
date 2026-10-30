import { describe, expect, test } from "bun:test";
import { RootTreeBroker } from "../runtime/root-tree-broker.ts";
import { readChildBrokerBootstrapEnvironment } from "../utils.ts";

interface Tree {
  root: RootTreeBroker;
  child: RootTreeBroker;
  grandchild: RootTreeBroker;
}

async function createTree(maxDepth: number): Promise<Tree> {
  const root = await RootTreeBroker.createRoot({
    identity: { id: "root-id", path: "/root", depth: 0, maxDepth } as any,
    maxResidentAgents: 8,
    maxActiveAgents: 8,
    dispatch: async () => ({}) as any,
  } as any);
  try {
    const childReservation = await root.reserveChild({
      id: "child-id",
      taskName: "child",
      maxDepth,
      lastTaskMessage: "child task",
      reloadable: true,
    } as any);
    const child = await RootTreeBroker.connectChild({
      identity: {
        id: "child-id",
        path: childReservation.path,
        parentId: "root-id",
        parentPath: "/root",
        depth: 1,
        maxDepth,
      } as any,
      maxResidentAgents: 8,
      maxActiveAgents: 8,
      socketPath: root.endpoint!.socketPath,
      capability: childReservation.capability,
      dispatch: async () => ({}) as any,
    } as any);
    const grandchildReservation = await child.reserveChild({
      id: "grandchild-id",
      taskName: "grandchild",
      maxDepth,
      lastTaskMessage: "grandchild task",
      reloadable: true,
    } as any);
    const grandchild = await RootTreeBroker.connectChild({
      identity: {
        id: "grandchild-id",
        path: grandchildReservation.path,
        parentId: "child-id",
        parentPath: childReservation.path,
        depth: 2,
        maxDepth,
      } as any,
      maxResidentAgents: 8,
      maxActiveAgents: 8,
      socketPath: root.endpoint!.socketPath,
      capability: grandchildReservation.capability,
      dispatch: async () => ({}) as any,
    } as any);
    return { root, child, grandchild };
  } catch (error) {
    await root.close().catch(() => undefined);
    throw error;
  }
}

async function closeTree(tree: Tree | undefined): Promise<void> {
  await tree?.grandchild.close().catch(() => undefined);
  await tree?.child.close().catch(() => undefined);
  await tree?.root.close().catch(() => undefined);
}

describe("nested delegation depth", () => {
  test("a child spawns a grandchild and both appear in the live agent list", async () => {
    const tree = await createTree(2);
    try {
      const namesOf = (agents: any[]) =>
        agents
          .map((agent) => agent.agent_name)
          .filter((name: string) => name !== "/root")
          .sort();

      const fromRoot = namesOf((await tree.root.list()).agents);
      expect(fromRoot).toEqual(["/root/child", "/root/child/grandchild"]);

      // Any member of the tree sees the same live registry, so the grandchild
      // is reachable from the intermediate child and from itself.
      expect(namesOf((await tree.child.list()).agents)).toEqual(fromRoot);
      expect(namesOf((await tree.grandchild.list()).agents)).toEqual(fromRoot);
    } finally {
      await closeTree(tree);
    }
  }, 20_000);

  test("depth is inherited and the configured maximum blocks the next spawn", async () => {
    const tree = await createTree(2);
    try {
      // Depth 2 equals maxDepth, so this agent may not spawn again.
      await expect(
        tree.grandchild.reserveChild({
          id: "great-grandchild-id",
          taskName: "great-grandchild",
          maxDepth: 2,
          lastTaskMessage: "must not spawn",
          reloadable: true,
        } as any),
      ).rejects.toThrow("maxDepth 2 reached at depth 2");

      // One level up the same gate stays open, so the grandchild's rejection is
      // its own depth limit rather than a tree-wide shutdown.
      expect((tree.child as any).options.identity).toMatchObject({ depth: 1, maxDepth: 2 });
    } finally {
      await closeTree(tree);
    }
  }, 20_000);

  test("child bootstrap environment carries inherited depth and limits", () => {
    const bootstrap = readChildBrokerBootstrapEnvironment({
      PI_SUBAGENT_BROKER_SOCKET: "\\\\" + ".\\" + "pipe\\pi-subagents-0123456789abcdef01234567",
      PI_SUBAGENT_BROKER_CAPABILITY: "0".repeat(64),
      PI_SUBAGENT_BROKER_GENERATION: "1",
      PI_SUBAGENT_ID: "grandchild-id",
      PI_SUBAGENT_PATH: "/root/child/grandchild",
      PI_SUBAGENT_PARENT_ID: "child-id",
      PI_SUBAGENT_PARENT_PATH: "/root/child",
      PI_SUBAGENT_ROOT_ID: "root-id",
      PI_SUBAGENT_DEPTH: "2",
      PI_SUBAGENT_MAX_DEPTH: "2",
      PI_SUBAGENT_MAX_RESIDENT_AGENTS: "8",
      PI_SUBAGENT_MAX_ACTIVE_AGENTS: "8",
    } as NodeJS.ProcessEnv);
    expect(bootstrap.identity).toMatchObject({
      depth: 2,
      maxDepth: 2,
      path: "/root/child/grandchild",
      parentPath: "/root/child",
    });
    expect(bootstrap.maxResidentAgents).toBe(8);
    expect(bootstrap.maxActiveAgents).toBe(8);
  });

  test("a partial or depth-inconsistent bootstrap envelope fails closed", () => {
    const base = {
      PI_SUBAGENT_BROKER_SOCKET: "\\\\" + ".\\" + "pipe\\pi-subagents-0123456789abcdef01234567",
      PI_SUBAGENT_BROKER_CAPABILITY: "0".repeat(64),
      PI_SUBAGENT_BROKER_GENERATION: "1",
      PI_SUBAGENT_ID: "grandchild-id",
      PI_SUBAGENT_PATH: "/root/child/grandchild",
      PI_SUBAGENT_PARENT_ID: "child-id",
      PI_SUBAGENT_PARENT_PATH: "/root/child",
      PI_SUBAGENT_ROOT_ID: "root-id",
      PI_SUBAGENT_DEPTH: "2",
      PI_SUBAGENT_MAX_DEPTH: "2",
      PI_SUBAGENT_MAX_RESIDENT_AGENTS: "8",
      PI_SUBAGENT_MAX_ACTIVE_AGENTS: "8",
    } as Record<string, string>;

    const missingMaxDepth = { ...base };
    delete missingMaxDepth.PI_SUBAGENT_MAX_DEPTH;
    expect(() => readChildBrokerBootstrapEnvironment(missingMaxDepth as NodeJS.ProcessEnv))
      .toThrow(/PI_SUBAGENT_MAX_DEPTH/);

    expect(() =>
      readChildBrokerBootstrapEnvironment({
        ...base,
        PI_SUBAGENT_DEPTH: "3",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
