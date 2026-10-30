import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchWindowsJobProcess } from "../runtime/windows-job.ts";

const winOnly = process.platform === "win32";

/**
 * The Job launcher caches a compiled assembly in a user-writable directory.
 * These tests pin the integrity contract: bytes are only loaded when they match
 * a sidecar SHA-256, and an unverifiable cache is rebuilt rather than trusted.
 */
describe("Windows launcher assembly integrity", () => {
  function tempAssemblyPath(): { directory: string; assembly: string; sidecar: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launcher-integrity-"));
    const assembly = path.join(directory, "PiWindowsJobLauncher.test.dll");
    return { directory, assembly, sidecar: `${assembly}.sha256` };
  }

  async function launch(assemblyPath: string | null): Promise<void> {
    const launched = launchWindowsJobProcess(process.execPath, ["-e", "process.exit(0)"], {
      cwd: process.cwd(),
      shell: false,
    }, { assemblyPath });
    await new Promise<void>((resolve) => launched.process.once("exit", () => resolve()));
    await launched.job.dispose().catch(() => undefined);
  }

  function sha256File(file: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
  }

  test.skipIf(!winOnly)("writes a sidecar hash beside the cached assembly", async () => {
    const { directory, assembly, sidecar } = tempAssemblyPath();
    try {
      await launch(assembly);
      expect(fs.existsSync(assembly)).toBe(true);
      expect(fs.existsSync(sidecar)).toBe(true);
      const recorded = fs.readFileSync(sidecar, "utf8").trim();
      expect(recorded).toMatch(/^[0-9A-F]{64}$/);
      expect(recorded).toBe(sha256File(assembly));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test.skipIf(!winOnly)("rebuilds a planted assembly instead of loading it", async () => {
    const { directory, assembly, sidecar } = tempAssemblyPath();
    try {
      await launch(assembly);
      const legitimateSize = fs.statSync(assembly).size;

      // Simulate a planted DLL in the cache while the sidecar is untouched.
      const planted = Buffer.from("MZ-planted-by-an-attacker");
      fs.writeFileSync(assembly, planted);

      await launch(assembly);

      const after = fs.readFileSync(assembly);
      expect(after.equals(planted)).toBe(false);
      expect(after.length).toBeGreaterThan(1_000);
      expect(after.length).toBe(legitimateSize);
      expect(fs.readFileSync(sidecar, "utf8").trim()).toBe(sha256File(assembly));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test.skipIf(!winOnly)("refuses to load a cached assembly with no sidecar", async () => {
    const { directory, assembly, sidecar } = tempAssemblyPath();
    try {
      await launch(assembly);
      fs.rmSync(sidecar);

      // Unverifiable cache must not be trusted; it is rebuilt from source.
      await launch(assembly);

      expect(fs.existsSync(sidecar)).toBe(true);
      expect(fs.readFileSync(sidecar, "utf8").trim()).toBe(sha256File(assembly));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
