import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TrustedPiInvocation {
  command: string;
  prefixArgs: string[];
}

export interface TrustedPiResolutionOptions {
  platform?: NodeJS.Platform;
  execPath?: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  realpath?: (value: string) => string;
}

export interface SessionDirectoryResolutionOptions {
  platform?: NodeJS.Platform;
  cwd?: string;
  homeDir?: string;
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Resolve and pin Pi without consulting PATH inherited by a child process. */
export function resolveTrustedPiInvocation(
  options: TrustedPiResolutionOptions = {},
): TrustedPiInvocation {
  const platform = options.platform ?? process.platform;
  const paths = pathApi(platform);
  const execPath = options.execPath ?? process.execPath;
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const realpath = options.realpath ?? fs.realpathSync;
  const currentScript = argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtualScript && paths.isAbsolute(currentScript)) {
    try {
      return {
        command: realpath(execPath),
        prefixArgs: [realpath(currentScript)],
      };
    } catch {
      // Fall through to fixed installation candidates.
    }
  }

  const executableName = paths.basename(execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executableName)) {
    return { command: realpath(execPath), prefixArgs: [] };
  }

  if (platform === "win32") {
    const scriptCandidates = [
      env.PI_CODING_AGENT_MODULE_DIR
        ? paths.join(
            env.PI_CODING_AGENT_MODULE_DIR,
            "dist",
            "bundle",
            "cli.js",
          )
        : undefined,
      paths.join(homeDir, ".pi", "agent", "bin", "pi-launcher.js"),
    ].filter((candidate): candidate is string => candidate !== undefined);
    const command = realpath(execPath);
    for (const candidate of scriptCandidates) {
      try {
        return { command, prefixArgs: [realpath(candidate)] };
      } catch {
        // Try the next fixed location; never search PATH.
      }
    }
  } else {
    for (const candidate of [
      paths.join(homeDir, ".local", "bin", "pi"),
      "/usr/local/bin/pi",
      "/usr/bin/pi",
    ]) {
      try {
        return { command: realpath(candidate), prefixArgs: [] };
      } catch {
        // Try the next fixed location; never search PATH.
      }
    }
  }

  throw new Error("Unable to resolve a trusted absolute Pi executable");
}

/** Expand a configured session root using the target platform's path rules. */
export function resolveSessionDirectory(
  value: string,
  options: SessionDirectoryResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const paths = pathApi(platform);
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const expanded = value === "~"
    ? homeDir
    : /^~[\\/]/.test(value)
      ? paths.join(homeDir, value.slice(2))
      : value;
  return paths.resolve(cwd, expanded);
}

/** Validate broker/runtime endpoints without making relative input trusted. */
export function requireAbsoluteRuntimePath(
  value: string,
  label: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!value || value.includes("\0") || !pathApi(platform).isAbsolute(value))
    throw new Error(`${label} must be an absolute safe path`);
  return value;
}
