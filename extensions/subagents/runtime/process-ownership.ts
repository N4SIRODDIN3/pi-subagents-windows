import { errorMessage } from "../utils.ts";
import type { WindowsJobHandle } from "./windows-job.ts";

export interface ProcessOwnership {
  attach(pid: number): Promise<void>;
  terminate(graceMs: number): Promise<void>;
  dispose(): Promise<void>;
}

export interface ProcessOwnershipLifecycle {
  gracefulTerminate(): void | Promise<void>;
  forceTerminate(): void | Promise<void>;
  waitForTermination(timeoutMs: number): Promise<boolean>;
  awaitTreeTermination(timeoutMs: number): Promise<void>;
  reportDiagnostic?(error: Error): void;
}

export interface ProcessOwnershipOptions {
  platform?: NodeJS.Platform;
  lifecycle: ProcessOwnershipLifecycle;
  createWindowsJob?: () => WindowsJobHandle;
}

class EscalatingProcessOwnership implements ProcessOwnership {
  private pid?: number;
  private job?: WindowsJobHandle;
  private disposed = false;

  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly lifecycle: ProcessOwnershipLifecycle,
    private readonly createWindowsJob: () => WindowsJobHandle,
  ) {}

  async attach(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error(`Invalid child process PID ${pid}`);
    if (this.pid !== undefined) throw new Error("Process ownership already attached");
    if (this.disposed) throw new Error("Process ownership already disposed");
    this.pid = pid;
    if (this.platform !== "win32") return;
    const job = this.createWindowsJob();
    this.job = job;
    try {
      await job.attach(pid);
    } catch (error) {
      await job.dispose().catch(() => undefined);
      this.job = undefined;
      throw new Error(
        `Windows Job Object ownership unavailable for PID ${pid}: ${errorMessage(error)}`,
      );
    }
  }

  async terminate(graceMs: number): Promise<void> {
    if (this.pid === undefined) return;
    const timeoutMs = Math.max(0, graceMs);
    let terminated = false;
    try {
      await this.lifecycle.gracefulTerminate();
    } catch (error) {
      this.lifecycle.reportDiagnostic?.(
        new Error(`Cooperative child shutdown failed: ${errorMessage(error)}`),
      );
    }
    terminated = await this.lifecycle.waitForTermination(timeoutMs);
    if (!terminated) {
      let ownershipError: Error | undefined;
      if (this.job) {
        try {
          await this.job.terminate();
        } catch (error) {
          ownershipError = new Error(errorMessage(error));
          this.lifecycle.reportDiagnostic?.(ownershipError);
        }
      }
      if (!this.job || ownershipError) {
        try {
          await this.lifecycle.forceTerminate();
        } catch (error) {
          const fallback = new Error(errorMessage(error));
          if (ownershipError)
            throw new Error(`${ownershipError.message}; leader fallback failed: ${fallback.message}`);
          throw fallback;
        }
      }
      terminated = await this.lifecycle.waitForTermination(timeoutMs);
    }
    if (!terminated)
      throw new Error(
        `Child process ${this.pid} did not terminate after forced cleanup`,
      );
    await this.lifecycle.awaitTreeTermination(timeoutMs);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const job = this.job;
    this.job = undefined;
    if (job) await job.dispose();
  }
}

export function createProcessOwnership(
  options: ProcessOwnershipOptions,
): ProcessOwnership {
  return new EscalatingProcessOwnership(
    options.platform ?? process.platform,
    options.lifecycle,
    options.createWindowsJob ?? (() => {
      throw new Error("Windows ownership requires an atomic Job launcher");
    }),
  );
}
