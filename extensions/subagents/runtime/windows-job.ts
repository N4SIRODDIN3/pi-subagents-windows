import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";

const DEFAULT_HELPER_TIMEOUT_MS = 5_000;
const PROTECTED_WINDOWS_ROOT = "C:\\Windows";
const ATOMIC_ASSIGNMENT_MARKER = "__PI_WINDOWS_JOB_ASSIGNED__";

export interface WindowsJobHandle {
  attach(pid: number): Promise<void>;
  terminate(): Promise<void>;
  dispose(): Promise<void>;
}

export interface WindowsJobHelperProcess {
  pid?: number;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

export interface WindowsJobLaunch {
  process: ChildProcessWithoutNullStreams;
  job: WindowsJobHandle;
}

export type SpawnWindowsJobHelper = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => WindowsJobHelperProcess;

export interface WindowsJobOptions {
  timeoutMs?: number;
  forceKill?: (pid: number) => void;
}

export interface WindowsJobLaunchOptions {
  resolvePowerShell?: () => string;
  spawnHelper?: SpawnWindowsJobHelper;
  timeoutMs?: number;
  forceKill?: (pid: number) => void;
}

export interface TrustedPowerShellResolutionOptions {
  /** Accepted for regression tests; executable selection intentionally ignores it. */
  env?: NodeJS.ProcessEnv;
  realpath?: (candidate: string) => string;
}

const WINDOWS_JOB_LAUNCHER = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class PiWindowsJobLauncher {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint JobObjectExtendedLimitInformation = 9;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const int STD_INPUT_HANDLE = -10;
  const int STD_OUTPUT_HANDLE = -11;
  const int STD_ERROR_HANDLE = -12;
  const uint INFINITE = 0xffffffff;

  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES { public uint nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public uint cb; public string lpReserved, lpDesktop, lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public long Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment,
    string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr GetStdHandle(int standardHandle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok, string operation) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
  }
  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new [] {' ', '\t', '"'}) < 0) return value;
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append(ch); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(ch);
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }

  public static int Run(string application, string[] args, string cwd) {
    IntPtr job = IntPtr.Zero, info = IntPtr.Zero;
    var pi = new PROCESS_INFORMATION();
    try {
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int infoSize = Marshal.SizeOf(limits); info = Marshal.AllocHGlobal(infoSize);
      Marshal.StructureToPtr(limits, info, false);
      Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, (uint)infoSize), "SetInformationJobObject");

      var startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(startup);
      startup.dwFlags = STARTF_USESTDHANDLES;
      startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
      startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
      startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
      var commandLine = new StringBuilder(Quote(application));
      foreach (string arg in args) commandLine.Append(' ').Append(Quote(arg));
      Check(CreateProcessW(application, commandLine, IntPtr.Zero, IntPtr.Zero, true,
        CREATE_SUSPENDED, IntPtr.Zero, cwd, ref startup, out pi), "CreateProcessW(CREATE_SUSPENDED)");
      try {
        Check(AssignProcessToJobObject(job, pi.hProcess), "AssignProcessToJobObject");
      } catch {
        TerminateProcess(pi.hProcess, 1);
        throw;
      }
      if (ResumeThread(pi.hThread) == 0xffffffff)
        throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
      Console.Out.WriteLine("__PI_WINDOWS_JOB_ASSIGNED__");
      Console.Out.Flush();
      WaitForSingleObject(pi.hProcess, INFINITE);
      uint exitCode; Check(GetExitCodeProcess(pi.hProcess, out exitCode), "GetExitCodeProcess");
      return unchecked((int)exitCode);
    } finally {
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
      if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      if (info != IntPtr.Zero) Marshal.FreeHGlobal(info);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PI_WINDOWS_JOB_LAUNCH))
$payload = $payloadJson | ConvertFrom-Json
foreach ($entry in [Environment]::GetEnvironmentVariables().Keys) {
  [Environment]::SetEnvironmentVariable([string]$entry, $null, 'Process')
}
foreach ($property in $payload.env.PSObject.Properties) {
  [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
}
$exitCode = [PiWindowsJobLauncher]::Run(
  [string]$payload.command,
  [string[]]$payload.args,
  [string]$payload.cwd
)
[Environment]::Exit($exitCode)
`;

export class WindowsJob implements WindowsJobHandle {
  private attached = false;
  private disposed = false;
  private exited = false;
  private readonly exitPromise: Promise<void>;

  constructor(
    private readonly helper: WindowsJobHelperProcess,
    private readonly options: WindowsJobOptions = {},
    private readonly ready: Promise<void> = Promise.resolve(),
  ) {
    this.exited = helper.exitCode !== null || helper.signalCode != null;
    this.exitPromise = this.exited
      ? Promise.resolve()
      : new Promise((resolve) => {
          helper.once("exit", () => {
            this.exited = true;
            resolve();
          });
        });
  }

  async attach(pid: number): Promise<void> {
    if (this.attached) throw new Error("Windows Job Object already attached");
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid !== this.helper.pid)
      throw new Error(`Atomic Windows Job launcher PID mismatch: expected ${this.helper.pid ?? "?"}, received ${pid}`);
    await this.ready;
    this.attached = true;
  }

  async terminate(): Promise<void> {
    if (this.exited || this.disposed) return;
    const pid = this.helper.pid;
    if (!pid) throw new Error("Windows Job helper has no PID");
    let requested = false;
    let firstError: unknown;
    try {
      requested = this.helper.kill("SIGKILL");
    } catch (error) {
      firstError = error;
    }
    if (!requested) {
      try {
        (this.options.forceKill ?? defaultForceKill)(pid);
        requested = true;
      } catch (error) {
        throw new Error(
          `could not forcibly terminate Windows Job helper ${pid}: ${errorMessage(firstError ?? error)}`,
        );
      }
    }
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    if (!exited)
      throw new Error(`Windows Job helper ${pid} did not exit after forced close within ${timeoutMs}ms`);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (!this.exited) await this.terminate();
    this.disposed = true;
  }
}

export function launchWindowsJobProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  launchOptions: WindowsJobLaunchOptions = {},
): WindowsJobLaunch {
  if (!path.win32.isAbsolute(command))
    throw new Error("Atomic Windows Job launch requires an absolute child executable");
  if (options.shell)
    throw new Error("Atomic Windows Job launch forbids shell execution");
  const cwd = typeof options.cwd === "string" ? options.cwd : undefined;
  if (!cwd || !path.win32.isAbsolute(cwd))
    throw new Error("Atomic Windows Job launch requires an absolute working directory");
  const childEnv: Record<string, string> = {
    SystemRoot: PROTECTED_WINDOWS_ROOT,
    WINDIR: PROTECTED_WINDOWS_ROOT,
  };
  const canonicalNames = new Map<string, string>([
    ["systemroot", "SystemRoot"],
    ["windir", "WINDIR"],
  ]);
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) continue;
    const folded = name.toLowerCase();
    if (folded === "systemroot" || folded === "windir") continue;
    const previous = canonicalNames.get(folded);
    if (previous) delete childEnv[previous];
    canonicalNames.set(folded, name);
    childEnv[name] = value;
  }
  const payload = Buffer.from(JSON.stringify({
    command,
    args,
    cwd,
    env: childEnv,
  }), "utf8").toString("base64");
  const powershell = (launchOptions.resolvePowerShell ?? resolveTrustedPowerShell)();
  const encoded = Buffer.from(WINDOWS_JOB_LAUNCHER, "utf16le").toString("base64");
  const helperEnv = minimalPowerShellEnvironment(payload);
  const helper = (launchOptions.spawnHelper ?? defaultSpawnHelper)(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ], {
    cwd,
    env: helperEnv,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  const readiness = filterAtomicAssignmentMarker(
    helper,
    launchOptions.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
  );
  return {
    process: helper as ChildProcessWithoutNullStreams,
    job: new WindowsJob(helper, {
      timeoutMs: launchOptions.timeoutMs,
      forceKill: launchOptions.forceKill,
    }, readiness),
  };
}

export function resolveTrustedPowerShell(
  options: TrustedPowerShellResolutionOptions = {},
): string {
  const candidate = path.win32.join(
    PROTECTED_WINDOWS_ROOT,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const realpath = options.realpath ?? fs.realpathSync.native;
  let resolved: string;
  try {
    resolved = realpath(candidate);
  } catch (error) {
    throw new Error(`Trusted Windows PowerShell is unavailable at ${candidate}: ${errorMessage(error)}`);
  }
  if (path.win32.normalize(resolved).toLowerCase() !== path.win32.normalize(candidate).toLowerCase())
    throw new Error(`Trusted Windows PowerShell path escaped protected root: ${resolved}`);
  return resolved;
}

function filterAtomicAssignmentMarker(
  helper: WindowsJobHelperProcess,
  timeoutMs: number,
): Promise<void> {
  const raw = helper.stdout;
  const protocol = new PassThrough();
  helper.stdout = protocol;
  let buffer = Buffer.alloc(0);
  let settled = false;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      raw.off("data", onData);
      helper.off("exit", onExit);
      helper.off("error", onError);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) {
        protocol.write(chunk);
        return;
      }
      buffer = Buffer.concat([
        buffer,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      if (line !== ATOMIC_ASSIGNMENT_MARKER) {
        fail(new Error(`Atomic Windows Job launcher returned unexpected readiness record: ${line}`));
        return;
      }
      const remainder = buffer.subarray(newline + 1);
      buffer = Buffer.alloc(0);
      settled = true;
      cleanup();
      raw.on("data", (data) => protocol.write(data));
      raw.once("end", () => protocol.end());
      raw.once("close", () => protocol.end());
      raw.once("error", (error) => protocol.destroy(error));
      if (remainder.length > 0) protocol.write(remainder);
      resolve();
    };
    const onExit = () => fail(new Error("Atomic Windows Job launcher exited before assigning the child"));
    const onError = (error: Error) => fail(new Error(`Atomic Windows Job launcher error: ${error.message}`));
    const timer = setTimeout(() => {
      fail(new Error(`Atomic Windows Job launcher did not assign the child within ${timeoutMs}ms`));
    }, timeoutMs);
    raw.on("data", onData);
    helper.once("exit", onExit);
    helper.once("error", onError);
  });
}

function minimalPowerShellEnvironment(payload: string): NodeJS.ProcessEnv {
  return {
    SystemRoot: PROTECTED_WINDOWS_ROOT,
    WINDIR: PROTECTED_WINDOWS_ROOT,
    PI_WINDOWS_JOB_LAUNCH: payload,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultForceKill = (pid: number): void => {
  process.kill(pid, "SIGKILL");
};

const defaultSpawnHelper: SpawnWindowsJobHelper = (command, args, options) =>
  spawn(command, args, options) as ChildProcessWithoutNullStreams;
