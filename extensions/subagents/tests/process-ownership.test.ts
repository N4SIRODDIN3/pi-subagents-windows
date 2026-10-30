import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createProcessOwnership,
  type ProcessOwnershipLifecycle,
} from "../runtime/process-ownership.ts";
import {
  WindowsJob,
  type WindowsJobHelperProcess,
} from "../runtime/windows-job.ts";
import { RpcProcess, type RpcSpawnProcess } from "../rpc-process.ts";

function lifecycle(waits: boolean[]): {
  value: ProcessOwnershipLifecycle;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    value: {
      gracefulTerminate() {
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
    },
  };
}

describe("process ownership", () => {
  test("Windows attaches a Job Object and escalates graceful shutdown to forced cleanup", async () => {
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
    expect(ownerLifecycle.calls).not.toContain("force-fallback");
  });

  test("Linux keeps its injected force/tree lifecycle without constructing a Windows job", async () => {
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

  test("fails closed with an actionable diagnostic when Windows ownership cannot attach", async () => {
    const ownership = createProcessOwnership({
      platform: "win32",
      lifecycle: lifecycle([]).value,
      createWindowsJob: () => ({
        async attach() {
          throw new Error("AssignProcessToJobObject failed with Win32 error 5");
        },
        async terminate() {},
        async dispose() {},
      }),
    });

    await expect(ownership.attach(99)).rejects.toThrow(
      "Windows Job Object ownership unavailable for PID 99: AssignProcessToJobObject failed with Win32 error 5",
    );
  });
});

function fakeHelper(): {
  child: WindowsJobHelperProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const child = new EventEmitter() as unknown as WindowsJobHelperProcess & EventEmitter;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    kill() {
      child.exitCode = 1;
      child.emit("exit", 1, null);
      return true;
    },
  });
  return { child, stdin, stdout, stderr };
}

describe("RpcProcess Windows ownership integration", () => {
  test("spawns the requested command without Linux wrappers and forces the attached job after grace expires", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as any;
    const signals: NodeJS.Signals[] = [];
    let input = "";
    const stdin = new EventEmitter() as any;
    stdin.writable = true;
    stdin.write = (chunk: Buffer | string, callback?: (error?: Error | null) => void) => {
      input += chunk.toString();
      while (input.includes("\n")) {
        const index = input.indexOf("\n");
        const command = JSON.parse(input.slice(0, index));
        input = input.slice(index + 1);
        if (command.type === "get_state")
          stdout.write(`${JSON.stringify({ type: "response", id: command.id, success: true, data: {} })}\n`);
      }
      queueMicrotask(() => callback?.(null));
      return true;
    };
    Object.assign(child, {
      pid: 9876,
      stdin,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill(signal: NodeJS.Signals) {
        signals.push(signal);
        return true;
      },
    });
    let spawnedCommand = "";
    let spawnedArgs: readonly string[] = [];
    const jobCalls: string[] = [];
    const client = new RpcProcess("C:\\trusted\\pi.exe", ["--mode", "rpc"], {
      cwd: process.cwd(),
      env: {},
      platform: "win32",
      shutdownTimeoutMs: 5,
      drainTimeoutMs: 20,
      spawnProcess: ((command, args) => {
        spawnedCommand = command;
        spawnedArgs = args;
        return child;
      }) as RpcSpawnProcess,
      createWindowsJob: () => ({
        async attach(pid) {
          jobCalls.push(`attach:${pid}`);
        },
        async terminate() {
          jobCalls.push("terminate");
          child.signalCode = "SIGKILL";
          stdout.end();
          stderr.end();
          child.emit("exit", null, "SIGKILL");
          child.emit("close", null, "SIGKILL");
        },
        async dispose() {
          jobCalls.push("dispose");
        },
      }),
    });

    await client.start();
    await client.stop();

    expect(spawnedCommand).toBe("C:\\trusted\\pi.exe");
    expect(spawnedArgs).toEqual(["--mode", "rpc"]);
    expect(`${spawnedCommand} ${spawnedArgs.join(" ")}`).not.toContain("/usr/bin/");
    expect(signals).toEqual(["SIGTERM"]);
    expect(jobCalls).toEqual(["attach:9876", "terminate", "dispose"]);
  });
});

describe("WindowsJob PowerShell transport", () => {
  test("uses a fixed PowerShell executable and a static encoded helper, never Linux tools", async () => {
    const helper = fakeHelper();
    let command = "";
    let args: readonly string[] = [];
    let helperPid: string | undefined;
    const job = new WindowsJob({
      timeoutMs: 100,
      resolvePowerShell: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      spawnHelper(spawnCommand, spawnArgs, options) {
        command = spawnCommand;
        args = spawnArgs;
        helperPid = options.env?.PI_WINDOWS_JOB_PID;
        queueMicrotask(() => helper.stdout.write("attached\n"));
        return helper.child;
      },
    });

    await job.attach(1234);

    expect(command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args).toContain("-EncodedCommand");
    expect(args.join(" ")).not.toContain("/usr/bin/");
    expect(helperPid).toBe("1234");

    const commands: string[] = [];
    helper.stdin.on("data", (chunk) => commands.push(chunk.toString()));
    const terminating = job.terminate();
    queueMicrotask(() => helper.stdout.write("terminated\n"));
    await terminating;
    const disposing = job.dispose();
    queueMicrotask(() => helper.stdout.write("disposed\n"));
    await disposing;
    expect(commands.join("")).toBe("terminate\ndispose\n");
  });
});
