import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createProcessOwnership,
  type ProcessOwnershipLifecycle,
} from "../runtime/process-ownership.ts";
import {
  launchWindowsJobProcess,
  resolveTrustedPowerShell,
  WindowsJob,
  type WindowsJobHelperProcess,
} from "../runtime/windows-job.ts";
import { RpcProcess } from "../rpc-process.ts";

function lifecycle(waits: boolean[]): {
  value: ProcessOwnershipLifecycle;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    value: {
      async gracefulTerminate() {
        calls.push("graceful");
      },
      forceTerminate() {
        calls.push("force-fallback");
      },
      async waitForTermination(graceMs) {
        calls.push(`wait:${graceMs}`);
        return waits.shift() ?? false;
      },
      async awaitTreeTermination(graceMs) {
        calls.push(`tree:${graceMs}`);
      },
      reportDiagnostic(error) {
        calls.push(`diagnostic:${error.message}`);
      },
    },
  };
}

describe("process ownership", () => {
  test("Windows escalates cooperative shutdown to forced Job cleanup", async () => {
    const ownerLifecycle = lifecycle([false, true]);
    const calls: string[] = [];
    const ownership = createProcessOwnership({
      platform: "win32",
      lifecycle: ownerLifecycle.value,
      createWindowsJob: () => ({
        async attach(pid) {
          calls.push(`attach:${pid}`);
        },
        async terminate() {
          calls.push("job-terminate");
        },
        async dispose() {
          calls.push("job-dispose");
        },
      }),
    });

    await ownership.attach(4242);
    await ownership.terminate(25);
    await ownership.dispose();

    expect(ownerLifecycle.calls).toEqual([
      "graceful",
      "wait:25",
      "wait:25",
      "tree:25",
    ]);
    expect(calls).toEqual(["attach:4242", "job-terminate", "job-dispose"]);
  });

  test("helper termination error still uses leader fallback and preserves the diagnostic", async () => {
    const ownerLifecycle = lifecycle([false, true]);
    const ownership = createProcessOwnership({
      platform: "win32",
      lifecycle: ownerLifecycle.value,
      createWindowsJob: () => ({
        async attach() {},
        async terminate() {
          throw new Error("helper did not exit after forced close");
        },
        async dispose() {},
      }),
    });

    await ownership.attach(99);
    await ownership.terminate(10);

    expect(ownerLifecycle.calls).toEqual([
      "graceful",
      "wait:10",
      "diagnostic:helper did not exit after forced close",
      "force-fallback",
      "wait:10",
      "tree:10",
    ]);
  });

  test("Linux retains its injected force/tree lifecycle without constructing a Windows job", async () => {
    const ownerLifecycle = lifecycle([false, true]);
    let windowsJobs = 0;
    const ownership = createProcessOwnership({
      platform: "linux",
      lifecycle: ownerLifecycle.value,
      createWindowsJob: () => {
        windowsJobs++;
        throw new Error("must not run");
      },
    });

    await ownership.attach(31337);
    await ownership.terminate(10);
    await ownership.dispose();

    expect(windowsJobs).toBe(0);
    expect(ownerLifecycle.calls).toEqual([
      "graceful",
      "wait:10",
      "force-fallback",
      "wait:10",
      "tree:10",
    ]);
  });
});

function fakeHelper(
  killResult = true,
  emitExit = true,
): WindowsJobHelperProcess & EventEmitter {
  const child = new EventEmitter() as WindowsJobHelperProcess & EventEmitter;
  Object.assign(child, {
    pid: 9876,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill() {
      if (!killResult) return false;
      if (emitExit) {
        child.exitCode = 1;
        queueMicrotask(() => child.emit("exit", 1, null));
      }
      return true;
    },
  });
  return child;
}

describe("atomic Windows Job launcher", () => {
  test("uses CREATE_SUSPENDED, assigns the Job before resume, and never invokes a Linux executable", () => {
    const helper = fakeHelper();
    let helperCommand = "";
    let helperArgs: readonly string[] = [];
    let launchPayload = "";
    const launched = launchWindowsJobProcess(
      "C:\\trusted\\pi.exe",
      ["--mode", "rpc", "argument with spaces"],
      {
        cwd: "C:\\work",
        env: { SAFE_VALUE: "yes", SYSTEMROOT: "C:\\attacker" },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
      {
        resolvePowerShell: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        spawnHelper(command, args, options) {
          helperCommand = command;
          helperArgs = args;
          launchPayload = String(options.env?.PI_WINDOWS_JOB_LAUNCH);
          const rawStdout = helper.stdout as PassThrough;
          queueMicrotask(() => rawStdout.write("__PI_WINDOWS_JOB_ASSIGNED__\n"));
          return helper;
        },
      },
    );

    const encodedIndex = helperArgs.indexOf("-EncodedCommand") + 1;
    const source = Buffer.from(helperArgs[encodedIndex]!, "base64").toString("utf16le");
    const payload = JSON.parse(Buffer.from(launchPayload, "base64").toString("utf8"));
    expect(helperCommand).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(helperArgs.join(" ")).not.toContain("/usr/bin/");
    expect(source).toContain("CREATE_SUSPENDED");
    expect(source.indexOf("Check(AssignProcessToJobObject")).toBeLessThan(
      source.indexOf("if (ResumeThread"),
    );
    expect(payload.command).toBe("C:\\trusted\\pi.exe");
    expect(payload.args).toEqual(["--mode", "rpc", "argument with spaces"]);
    expect(payload.env).toEqual({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      SAFE_VALUE: "yes",
    });
    expect(launched.process === (helper as unknown)).toBe(true);
  });

  test("ignores tampered Windows path environment and accepts only canonical protected-root PowerShell", () => {
    const inspected: string[] = [];
    const trusted = resolveTrustedPowerShell({
      env: {
        SystemRoot: "C:\\attacker",
        WINDIR: "C:\\attacker",
        ProgramFiles: "C:\\attacker",
      },
      realpath(candidate) {
        inspected.push(candidate);
        if (candidate.toLowerCase() === "c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe")
          return "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        throw new Error("missing");
      },
    });

    expect(trusted).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(inspected.every((candidate) => !candidate.includes("attacker"))).toBe(true);
  });

  test("hanging helper force-close times out instead of being treated as Job termination", async () => {
    const job = new WindowsJob(fakeHelper(true, false), { timeoutMs: 5 });
    await job.attach(9876);
    await expect(job.terminate()).rejects.toThrow(
      "did not exit after forced close within 5ms",
    );
  });

  test("failed helper kill is reported instead of being treated as Job termination", async () => {
    const job = new WindowsJob(fakeHelper(false), {
      timeoutMs: 5,
      forceKill() {
        throw new Error("access denied");
      },
    });
    await job.attach(9876);
    await expect(job.terminate()).rejects.toThrow("could not forcibly terminate Windows Job helper");
  });
});

describe("RpcProcess Windows ownership integration", () => {
  test("requests cooperative EOF shutdown before forcing the atomically launched Job", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as any;
    let input = "";
    let stdinEnded = false;
    const stdin = new PassThrough();
    stdin.on("data", (chunk) => {
      input += chunk.toString();
      while (input.includes("\n")) {
        const index = input.indexOf("\n");
        const command = JSON.parse(input.slice(0, index));
        input = input.slice(index + 1);
        if (command.type === "get_state")
          stdout.write(`${JSON.stringify({ type: "response", id: command.id, success: true, data: {} })}\n`);
      }
    });
    stdin.on("finish", () => {
      stdinEnded = true;
    });
    Object.assign(child, {
      pid: 9876,
      stdin,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill() {
        throw new Error("RPC graceful phase must not use child.kill on Windows");
      },
    });
    const jobCalls: string[] = [];
    const job = {
      async attach(pid: number) {
        jobCalls.push(`attach:${pid}`);
      },
      async terminate() {
        jobCalls.push(`terminate:stdinEnded=${stdinEnded}`);
        child.signalCode = "SIGKILL";
        stdout.end();
        stderr.end();
        child.emit("exit", null, "SIGKILL");
        child.emit("close", null, "SIGKILL");
      },
      async dispose() {
        jobCalls.push("dispose");
      },
    };
    const client = new RpcProcess("C:\\trusted\\pi.exe", ["--mode", "rpc"], {
      cwd: process.cwd(),
      env: {},
      platform: "win32",
      shutdownTimeoutMs: 5,
      drainTimeoutMs: 20,
      launchWindowsProcess: () => ({ process: child, job }),
    });

    await client.start();
    await client.stop();

    expect(jobCalls).toEqual([
      "attach:9876",
      "terminate:stdinEnded=true",
      "dispose",
    ]);
  });
});
