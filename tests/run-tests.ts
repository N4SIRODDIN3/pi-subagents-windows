import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith("PI_SUBAGENT_")) delete env[name];
}

const requestedTests = process.argv.slice(2);
const args = [
  "test",
  ...(requestedTests.length > 0
    ? requestedTests
    : ["extensions/subagents/tests"]),
];
const bun = fileURLToPath(
  new URL("../node_modules/bun/bin/bun.exe", import.meta.url),
);
const result = spawnSync(bun, args, {
  cwd: new URL("..", import.meta.url),
  env,
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(`Unable to start Bun: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
