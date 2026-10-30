import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_HELPER_TIMEOUT_MS = 5_000;
const STDERR_LIMIT = 4_096;

export interface WindowsJobHandle {
  attach(pid: number): Promise<void>;
  terminate(): Promise<void>;
  dispose(): Promise<void>;
}

export interface WindowsJobHelperProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

export type SpawnWindowsJobHelper = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => WindowsJobHelperProcess;

export interface WindowsJobOptions {
  timeoutMs?: number;
  resolvePowerShell?: () => string;
  spawnHelper?: SpawnWindowsJobHelper;
}

const WINDOWS_JOB_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class PiWindowsJob {
  const uint PROCESS_TERMINATE = 0x0001;
  const uint PROCESS_SET_QUOTA = 0x0100;
  const uint JobObjectExtendedLimitInformation = 9;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public long Affinity;
    public uint PriorityClass, SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok, string operation) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
  }

  public static IntPtr Attach(uint pid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
    IntPtr process = IntPtr.Zero;
    IntPtr info = IntPtr.Zero;
    try {
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int size = Marshal.SizeOf(limits);
      info = Marshal.AllocHGlobal(size);
      Marshal.StructureToPtr(limits, info, false);
      Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, (uint)size), "SetInformationJobObject");
      process = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, pid);
      if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed");
      Check(AssignProcessToJobObject(job, process), "AssignProcessToJobObject");
      return job;
    } catch {
      CloseHandle(job);
      throw;
    } finally {
      if (process != IntPtr.Zero) CloseHandle(process);
      if (info != IntPtr.Zero) Marshal.FreeHGlobal(info);
    }
  }

  public static void Terminate(IntPtr job) { Check(TerminateJobObject(job, 1), "TerminateJobObject"); }
  public static void Close(IntPtr job) { if (job != IntPtr.Zero) Check(CloseHandle(job), "CloseHandle"); }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$pidValue = 0
if (-not [uint32]::TryParse($env:PI_WINDOWS_JOB_PID, [ref]$pidValue) -or $pidValue -eq 0) { throw 'Invalid child PID' }
$job = [PiWindowsJob]::Attach($pidValue)
[Console]::Out.WriteLine('attached')
try {
  while (($command = [Console]::In.ReadLine()) -ne $null) {
    if ($command -eq 'terminate') {
      [PiWindowsJob]::Terminate($job)
      [Console]::Out.WriteLine('terminated')
    } elseif ($command -eq 'dispose') {
      [PiWindowsJob]::Close($job)
      $job = [IntPtr]::Zero
      [Console]::Out.WriteLine('disposed')
      break
    } else { throw "Unknown command: $command" }
  }
} finally {
  if ($job -ne [IntPtr]::Zero) { [PiWindowsJob]::Close($job) }
}
`;

export class WindowsJob implements WindowsJobHandle {
  private helper?: WindowsJobHelperProcess;
  private stdoutBuffer = "";
  private stderr = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly lines: string[] = [];
  private waiter?: { resolve(line: string): void; reject(error: Error): void };
  private failure?: Error;
  private disposed = false;

  constructor(private readonly options: WindowsJobOptions = {}) {}

  async attach(pid: number): Promise<void> {
    if (this.helper) throw new Error("Windows Job Object already attached");
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid child PID ${pid}`);
    const command = (this.options.resolvePowerShell ?? resolvePowerShell)();
    const encoded = Buffer.from(WINDOWS_JOB_HELPER, "utf16le").toString("base64");
    const spawnHelper = this.options.spawnHelper ?? defaultSpawnHelper;
    const helper = spawnHelper(command, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: windowsHelperEnvironment(pid),
    });
    this.helper = helper;
    this.attachHelperListeners(helper);
    const response = await this.nextLine("attach");
    if (response !== "attached")
      throw new Error(`Windows Job Object helper returned unexpected attach response: ${response}`);
  }

  async terminate(): Promise<void> {
    if (this.disposed) return;
    await this.command("terminate", "terminated");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const helper = this.helper;
    if (!helper) return;
    if (helper.exitCode === null && !this.failure) {
      try {
        await this.command("dispose", "disposed");
      } catch (error) {
        helper.kill();
        throw error;
      }
    }
    this.detachHelperListeners(helper);
    this.helper = undefined;
  }

  private async command(command: string, expected: string): Promise<void> {
    const helper = this.helper;
    if (!helper) throw new Error("Windows Job Object is not attached");
    if (this.failure) throw this.failure;
    helper.stdin.write(`${command}\n`);
    const response = await this.nextLine(command);
    if (response !== expected)
      throw new Error(`Windows Job Object helper returned unexpected ${command} response: ${response}`);
  }

  private attachHelperListeners(helper: WindowsJobHelperProcess): void {
    helper.stdout.on("data", this.onStdoutData);
    helper.stderr.on("data", this.onStderrData);
    helper.once("error", this.onHelperError);
    helper.once("exit", this.onHelperExit);
  }

  private detachHelperListeners(helper: WindowsJobHelperProcess): void {
    helper.stdout.off("data", this.onStdoutData);
    helper.stderr.off("data", this.onStderrData);
    helper.off("error", this.onHelperError);
    helper.off("exit", this.onHelperExit);
  }

  private readonly onStdoutData = (chunk: Buffer | string): void => {
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    while (this.stdoutBuffer.includes("\n")) {
      const index = this.stdoutBuffer.indexOf("\n");
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line) continue;
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter.resolve(line);
      } else this.lines.push(line);
    }
  };

  private readonly onStderrData = (chunk: Buffer | string): void => {
    this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_LIMIT);
  };

  private readonly onHelperError = (error: Error): void => {
    this.fail(new Error(`Windows Job Object helper error: ${error.message}`));
  };

  private readonly onHelperExit = (code: number | null): void => {
    if (this.disposed && code === 0) return;
    const detail = this.stderr.trim();
    this.fail(new Error(
      `Windows Job Object helper exited with code ${code}${detail ? `: ${detail}` : ""}`,
    ));
  };

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(error);
  }

  private nextLine(operation: string): Promise<string> {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiter) return Promise.reject(new Error("Concurrent Windows Job Object commands are not supported"));
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.resolve !== complete) return;
        this.waiter = undefined;
        reject(new Error(`Windows Job Object helper timed out during ${operation} after ${timeoutMs}ms`));
      }, timeoutMs);
      const complete = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.waiter = { resolve: complete, reject: fail };
    });
  }
}

function windowsHelperEnvironment(pid: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PI_WINDOWS_JOB_PID: String(pid) };
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function resolvePowerShell(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const candidates = [
    systemRoot
      ? path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : undefined,
    process.env.ProgramFiles
      ? path.win32.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")
      : undefined,
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of candidates) {
    try {
      return fs.realpathSync(candidate);
    } catch {
      // Only fixed installation paths are accepted; PATH is never searched.
    }
  }
  throw new Error("No trusted PowerShell executable found at a fixed Windows installation path");
}

const defaultSpawnHelper: SpawnWindowsJobHelper = (command, args, options) =>
  spawn(command, args, options) as ChildProcessWithoutNullStreams;
