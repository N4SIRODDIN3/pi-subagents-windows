import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  requireAbsoluteRuntimePath,
  resolveSessionDirectory,
  resolveTrustedPiInvocation,
} from "../runtime/platform-paths.ts";

function fakeRealpath(existing: string[]) {
  const paths = new Set(existing.map((value) => path.win32.normalize(value)));
  return (value: string): string => {
    const normalized = path.win32.normalize(value);
    if (!paths.has(normalized)) {
      const error = new Error(`missing: ${value}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return normalized;
  };
}

describe("trusted Pi invocation resolution", () => {
  test("uses an absolute pi.exe directly without consulting PATH", () => {
    const executable = String.raw`C:\Program Files\Pi\pi.exe`;
    expect(resolveTrustedPiInvocation({
      platform: "win32",
      execPath: executable,
      argv: [executable],
      env: { PATH: String.raw`C:\untrusted` },
      homeDir: String.raw`C:\Users\Agent`,
      realpath: fakeRealpath([executable]),
    })).toEqual({ command: executable, prefixArgs: [] });
  });

  test("keeps a spaced absolute script path as one node.exe prefix argument", () => {
    const executable = String.raw`C:\Program Files\nodejs\node.exe`;
    const script = String.raw`C:\Users\Agent Name\.pi\agent\pi launcher.js`;
    expect(resolveTrustedPiInvocation({
      platform: "win32",
      execPath: executable,
      argv: [executable, script],
      env: {},
      homeDir: String.raw`C:\Users\Agent Name`,
      realpath: fakeRealpath([executable, script]),
    })).toEqual({ command: executable, prefixArgs: [script] });
  });

  test("keeps a spaced absolute script path as one bun.exe prefix argument", () => {
    const executable = String.raw`C:\Tools\Bun Runtime\bun.exe`;
    const script = String.raw`C:\Pi Install\dist\bundle\cli.js`;
    expect(resolveTrustedPiInvocation({
      platform: "win32",
      execPath: executable,
      argv: [executable, script],
      env: {},
      homeDir: String.raw`C:\Users\Agent`,
      realpath: fakeRealpath([executable, script]),
    })).toEqual({ command: executable, prefixArgs: [script] });
  });

  test("uses the explicit Pi module candidate for a bun.exe virtual script", () => {
    const executable = String.raw`C:\Tools\bun.exe`;
    const moduleDir = String.raw`C:\Pi Modules\@earendil-works\pi-coding-agent`;
    const cli = path.win32.join(moduleDir, "dist", "bundle", "cli.js");
    expect(resolveTrustedPiInvocation({
      platform: "win32",
      execPath: executable,
      argv: [executable, "/$bunfs/root/pi"],
      env: {
        PATH: String.raw`C:\untrusted`,
        PI_CODING_AGENT_MODULE_DIR: moduleDir,
      },
      homeDir: String.raw`C:\Users\Agent`,
      realpath: fakeRealpath([executable, cli]),
    })).toEqual({ command: executable, prefixArgs: [cli] });
  });
});

describe("platform runtime paths", () => {
  test("preserves an absolute Windows session path containing spaces", () => {
    const sessionDir = String.raw`C:\Users\Agent Name\Pi Sessions\subagents`;
    expect(resolveSessionDirectory(sessionDir, {
      platform: "win32",
      cwd: String.raw`D:\workspace`,
      homeDir: String.raw`C:\Users\Agent Name`,
    })).toBe(sessionDir);
  });

  test("expands a home-relative session path with the selected platform rules", () => {
    expect(resolveSessionDirectory("~/.pi/agent/sessions/subagents", {
      platform: "win32",
      cwd: String.raw`D:\workspace`,
      homeDir: String.raw`C:\Users\Agent Name`,
    })).toBe(String.raw`C:\Users\Agent Name\.pi\agent\sessions\subagents`);
  });

  test("rejects relative broker paths instead of resolving them against cwd", () => {
    expect(() => requireAbsoluteRuntimePath(
      String.raw`broker\tree.pipe`,
      "Child broker socket path",
      "win32",
    )).toThrow("Child broker socket path must be an absolute safe path");
  });

  test("accepts absolute Windows broker paths containing spaces", () => {
    const brokerPath = String.raw`C:\Users\Agent Name\AppData\Local\pi\broker.pipe`;
    expect(requireAbsoluteRuntimePath(
      brokerPath,
      "Child broker socket path",
      "win32",
    )).toBe(brokerPath);
  });
});
