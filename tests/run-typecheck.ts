import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith("PI_SUBAGENT_")) delete env[name];
}

const tsc = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url),
);
const result = spawnSync(process.execPath, [tsc, "-p", "tests/tsconfig.json"], {
  cwd: new URL("..", import.meta.url),
  env,
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(`Unable to start TypeScript: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
