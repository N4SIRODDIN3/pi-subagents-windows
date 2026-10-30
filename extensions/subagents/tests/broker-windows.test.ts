import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultBrokerSocketDirectory,
  isBrokerPipePath,
  maintainBrokerSockets,
  makeBrokerSocketPath,
  prepareBrokerSocketLocation,
  safeRemoveBrokerSocket,
  scavengeStaleBrokerSockets,
  secureAndVerifyBrokerSocket,
  verifyBrokerSocket,
} from "../runtime/broker-socket.ts";

// `\\.\pipe` built from escapes so the source stays readable.
const PIPE_ROOT = "\\\\" + "." + "\\" + "pipe";
const PIPE_PREFIX = PIPE_ROOT + "\\" + "pi-subagents-";

describe("broker endpoint on Windows named pipes", () => {
  test("issues pipe endpoints under the reserved pi-subagents namespace", () => {
    const socketPath = makeBrokerSocketPath("root-session-id", "win32");
    expect(isBrokerPipePath(socketPath)).toBe(true);
    expect(socketPath.startsWith(PIPE_PREFIX)).toBe(true);
    const digest = socketPath.slice(PIPE_PREFIX.length);
    expect(digest).toMatch(new RegExp("^[a-f0-9]{24}$"));
    expect(defaultBrokerSocketDirectory("win32")).toBe(PIPE_ROOT);
    expect(new Set([socketPath, makeBrokerSocketPath("root-session-id", "win32")]).size).toBe(2);
  });

  test("keeps POSIX filesystem endpoints on POSIX platforms", () => {
    const socketPath = makeBrokerSocketPath("root-session-id", "linux");
    expect(socketPath.endsWith(".sock")).toBe(true);
    expect(isBrokerPipePath(socketPath)).toBe(false);
  });

  test("accepts pipe endpoints and rejects filesystem paths on Windows", () => {
    const pipe = makeBrokerSocketPath("root-session-id", "win32");
    const prepared = prepareBrokerSocketLocation(pipe, "win32");
    expect(prepared.createdDirectory).toBe(false);
    expect(secureAndVerifyBrokerSocket(pipe, "win32")).toEqual(prepared.directoryIdentity);
    expect(verifyBrokerSocket(pipe, "win32")).toEqual(prepared.directoryIdentity);

    const posixStyle = path.join(os.tmpdir(), "pi-subagents-test", "broker.sock");
    expect(() => prepareBrokerSocketLocation(posixStyle, "win32")).toThrow(/Unsafe broker pipe path/);
    expect(() => verifyBrokerSocket(posixStyle, "win32")).toThrow(/Unsafe broker pipe path/);
  });

  test("rejects pipe names outside the reserved prefix", () => {
    expect(() =>
      prepareBrokerSocketLocation(PIPE_ROOT + "\\attacker-controlled", "win32"),
    ).toThrow(/Unsafe broker pipe path/);
    expect(() =>
      prepareBrokerSocketLocation(PIPE_PREFIX + "XYZ", "win32"),
    ).toThrow(/Unsafe broker pipe path/);
  });

  test("treats named pipes as ephemeral: no filesystem scavenging or removal", async () => {
    const pipe = makeBrokerSocketPath("root-session-id", "win32");
    expect(fs.existsSync(pipe)).toBe(false);
    safeRemoveBrokerSocket(pipe, { dev: 0, ino: 0 }, { dev: 0, ino: 0 }, true, "win32");
    expect(
      await maintainBrokerSockets(defaultBrokerSocketDirectory("win32"), {
        apply: true,
        excludeSocketPath: pipe,
        platform: "win32",
      }),
    ).toMatchObject({ mode: "apply", stale: [], removed: [] });
    expect(await scavengeStaleBrokerSockets(PIPE_ROOT, pipe, "win32")).toMatchObject({
      stale: [],
      removed: [],
    });
  });
});
