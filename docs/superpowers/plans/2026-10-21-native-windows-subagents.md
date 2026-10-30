# Native Windows Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a standalone native-Windows port of Pi's persistent collaboration extension with reliable nested delegation and enforced spawn depth.

**Architecture:** Preserve the existing broker/RPC protocol and collaboration manager. Isolate OS-specific child-process ownership behind a launcher adapter: Linux keeps its existing sandbox path, while Windows uses direct spawning plus Job Object/cleanup support. Keep canonical tool names for standalone installation and isolate this port's config, persistence, and broker runtime state.

**Tech Stack:** TypeScript, Node.js/Bun, Pi extension API, `node:child_process`, Windows PowerShell/.NET fallback, Vitest/Node test runner as inherited from upstream, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-21-native-windows-subagents-design.md`

## Global Constraints

- Windows 10/11 is the primary target; Linux behavior must remain supported.
- Child processes must spawn without `shell: true`.
- Windows code must not depend on WSL, `bwrap`, cgroups, or `systemd-run`.
- Nested delegation must support root → child → grandchild and enforce `maxDepth` before every spawn.
- This extension must not share runtime state with another collaboration extension.
- Do not publish secrets, build output, or the local Pi installation.

## Review Focus

- A child spawning a grandchild must inherit the correct depth/path and be rejected at the configured limit; test in the nested smoke suite.
- A Windows child that itself spawns descendants must not survive parent shutdown; test Job Object/fallback cleanup.
- Windows paths containing spaces and backslashes must remain valid in executable, cwd, socket, and session paths; test launcher/path helpers.
- A missing or unavailable Windows cleanup primitive must fail safely and report the limitation; test fallback/error handling.
- Loading the port after another collaboration extension must not silently overwrite state or register duplicate canonical tools; test startup conflict handling.

---

### Task 1: Standalone repository and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `README.md`, `CHANGELOG.md`
- Create: `index.ts` and the standalone `extensions/subagents/**` source tree copied from upstream
- Create: `tests/tsconfig.json`, `tests/run-tests.ts`, `tests/run-typecheck.ts`
- Modify: `docs/superpowers/specs/2026-10-21-native-windows-subagents-design.md`

**Interfaces:**
- Produces the same extension entry point and public tool contract as upstream.
- Produces portable Node test/typecheck commands used by later tasks.

- [ ] Copy only the upstream subagents implementation, tests, and required metadata into the new repository; do not copy the parent Pi checkout.
- [ ] Add a package entry point that exports/registers the extension and scripts that run on Windows without Bash.
- [ ] Run the baseline typecheck/tests and record any pre-existing Linux-only failures before changing behavior.
- [ ] Commit: `chore: scaffold standalone subagents port`.

### Task 2: Cross-platform trusted path and child executable resolution

**Files:**
- Modify: `extensions/subagents/utils.ts`
- Modify: `extensions/subagents/settings.ts`
- Create: `extensions/subagents/runtime/platform-paths.ts`
- Test: `extensions/subagents/tests/platform-paths.test.ts`

**Interfaces:**
- Produces `resolveTrustedPiInvocation(): { command: string; prefixArgs: string[] }`.
- Produces platform-safe runtime/session directory resolution used by launcher and broker code.

- [ ] Write failing tests for Windows executable names (`pi.exe`, `node.exe`, `bun.exe`), spaces in paths, absolute session paths, and rejection of unsafe relative broker paths.
- [ ] Implement platform helpers using `node:path`, `process.execPath`, explicit candidate paths, and existing environment controls; never consult child-controlled `PATH` for the trusted launcher.
- [ ] Run focused tests and typecheck.
- [ ] Commit: `fix: resolve subagent paths on Windows`.

### Task 3: Native Windows process ownership adapter

**Files:**
- Create: `extensions/subagents/runtime/process-ownership.ts`
- Create: `extensions/subagents/runtime/windows-job.ts`
- Modify: `extensions/subagents/rpc-process.ts`
- Test: `extensions/subagents/tests/process-ownership.test.ts`

**Interfaces:**
- Produces `ProcessOwnership` with `attach(pid)`, `terminate(graceMs)`, and `dispose()` semantics.
- `rpc-process.ts` consumes the adapter and retains existing RPC framing, timeout, and error behavior.

- [ ] Write failing tests with injected process transports proving Windows uses no Linux executable and that graceful shutdown escalates to forced cleanup.
- [ ] Implement Windows ownership using a transparent Job Object adapter where available; isolate native calls behind the adapter and provide a narrowly scoped PowerShell/.NET fallback or explicit fail-closed diagnostic.
- [ ] Preserve Linux `bwrap`/cgroup behavior unchanged behind the Linux adapter.
- [ ] Run process and RPC tests on the current host plus Linux-compatible tests where available.
- [ ] Commit: `feat: add native Windows subagent process ownership`.

### Task 4: Broker/runtime Windows compatibility

**Files:**
- Modify: `extensions/subagents/runtime/broker-socket.ts`
- Modify: `extensions/subagents/runtime/broker-protocol.ts`
- Modify: `extensions/subagents/runtime/persistence.ts`
- Modify: `extensions/subagents/runtime/launcher.ts`
- Test: `extensions/subagents/tests/broker-windows.test.ts`

**Interfaces:**
- Keeps existing authenticated broker message types and authorization rules.
- Uses the dedicated Windows runtime/session root without changing message semantics.

- [ ] Write failing tests for Windows private runtime directories, socket names/paths, stale endpoint validation, session paths with spaces, and independent persistence roots.
- [ ] Implement only platform-specific path/permission handling; retain capability, generation, lineage, and environment allowlist checks.
- [ ] Run broker, persistence, and launcher tests.
- [ ] Commit: `fix: isolate Windows subagent broker runtime`.

### Task 5: Nested delegation depth and lifecycle smoke tests

**Files:**
- Modify: `extensions/subagents/runtime/launcher.ts`
- Modify: `extensions/subagents/prompts.ts`
- Modify: `extensions/subagents/constants.ts`
- Create: `extensions/subagents/tests/fixtures/nested-worker.ts`
- Create: `extensions/subagents/tests/nested-agents.test.ts`
- Create: `extensions/subagents/tests/windows-smoke.test.ts`

**Interfaces:**
- `maxDepth` and `allowChildSubagents` remain enforced before each spawn.
- Child environment includes only the validated depth/path/broker values needed for nested routing.

- [ ] Write a failing root → child → grandchild test that checks canonical paths, inherited depth, completion routing, and a rejected fourth level at `maxDepth = 2`.
- [ ] Add shutdown-race coverage proving nested children are cleaned up and completion deduplication remains bounded.
- [ ] Implement the minimum launcher/prompt changes needed for Windows nested execution; do not weaken the pre-spawn depth gate.
- [ ] Run the nested smoke test, full test suite, and typecheck.
- [ ] Commit: `test: verify nested Windows subagents`.

### Task 6: Portable maintenance, documentation, and CI

**Files:**
- Modify: `extensions/subagents/bin/broker-socket-maintenance.ts`
- Create: `scripts/run-tests.ts`, `scripts/run-typecheck.ts`
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Maintenance and verification run via `npm`/`bun` on Windows and Linux.
- README documents installation, disabling `pi-agents-team`, nested depth settings, cleanup/isolation limitations, and upstream attribution.

- [ ] Add portable Node entry points and optional PowerShell wrappers; remove README dependence on `.sh` commands for Windows users.
- [ ] Add CI jobs for Windows and Linux running typecheck, tests, build, and package smoke validation.
- [ ] Document that Windows process ownership is not Linux cgroup/bubblewrap isolation and explain the configured fallback.
- [ ] Run all local gates and inspect the package file list for unwanted files.
- [ ] Commit: `docs: document native Windows subagents`.

### Task 7: Final review and public GitHub publication

**Files:**
- Modify: any files required by final review only

- [ ] Run full verification: typecheck, tests, build, package listing, `git diff --check`, and Windows nested smoke test.
- [ ] Review staged diff for secrets, local paths, copied sessions, and generated artifacts.
- [ ] Create a new public GitHub repository in the authenticated account, push `main`, and verify the public clone and default-branch contents.
- [ ] Create an initial release tag only if the repository metadata and tests are green.
