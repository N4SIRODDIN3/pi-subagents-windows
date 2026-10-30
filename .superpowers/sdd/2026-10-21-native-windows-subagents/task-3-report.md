# Task 3 Report: Native Windows process ownership adapter

## Status

Implemented Task 3 and committed the implementation as `f36ad43` (`feat: add native Windows subagent process ownership`).

The RPC child process now uses a Windows Job Object ownership adapter on Windows while retaining the existing Linux bwrap/cgroup launch and teardown path. RPC JSONL framing, request/startup/shutdown timeouts, broker authentication, and child environment construction were not weakened.

## Changes

- `extensions/subagents/runtime/process-ownership.ts`
  - Added the `ProcessOwnership` interface with `attach(pid)`, `terminate(graceMs)`, and `dispose()`.
  - Added injected lifecycle transports for test-first graceful-to-forced escalation.
  - Windows force cleanup delegates to the attached Job Object; Linux/non-Windows force cleanup delegates to the existing process lifecycle implementation.
  - Windows attachment failures are fail-closed and include the PID plus the native/helper diagnostic.

- `extensions/subagents/runtime/windows-job.ts`
  - Added a transparent PowerShell/.NET Job Object helper using static, encoded PowerShell and in-process C# P/Invoke declarations for `CreateJobObject`, `SetInformationJobObject`, `AssignProcessToJobObject`, `TerminateJobObject`, and `CloseHandle`.
  - Sets `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so helper failure, parent pipe closure, or explicit disposal closes the retained handle and reaps the owned job.
  - Resolves PowerShell only from fixed Windows installation paths; it never searches inherited `PATH`.
  - Passes only a numeric PID through a dedicated helper environment variable and uses `shell: false`.
  - Bounds helper stderr and helper command timeouts for actionable failure diagnostics.

- `extensions/subagents/rpc-process.ts`
  - Selects Windows Job Object ownership on Windows without invoking `/usr/bin/bwrap`, `/usr/bin/systemd-run`, or cgroup code.
  - Keeps the Linux wrapper/cgroup implementation and process-tree fallback unchanged in its Linux branch.
  - Attaches ownership before the RPC startup handshake and fails startup closed if ownership cannot be established.
  - Preserves the existing graceful timeout before forced cleanup and disposes ownership only after confirmed termination/drain handling.
  - Added narrow internal injection seams for platform and Windows Job construction tests.

- `extensions/subagents/tests/process-ownership.test.ts`
  - Added injected transport tests for Windows Job attachment, graceful-to-forced escalation, Linux fallback behavior, fail-closed diagnostics, fixed PowerShell resolution, absence of Linux executable use, and RPC integration.

## Security review

- No broker authentication or capability logic changed.
- No child environment allowlist logic changed.
- No shutdown timeout default changed.
- The helper command and C# source are static; no child-provided string is interpolated into shell code.
- The PID is validated as a positive safe integer in TypeScript and parsed as `uint32` in PowerShell.
- PowerShell is resolved from fixed absolute installation paths and spawned with `shell: false`.
- Job attachment failure aborts RPC startup rather than silently running an unowned persistent child.

## Verification

### Focused ownership tests

Command:

```text
npm test -- extensions/subagents/tests/process-ownership.test.ts
```

Result: **5 passed, 0 failed**.

Covered:

- Windows Job attachment and escalation from graceful termination to `TerminateJobObject`.
- Linux lifecycle fallback without Windows helper construction.
- Fail-closed attachment diagnostics.
- RPC spawn remains the requested Windows command with no Linux wrapper executable.
- Fixed PowerShell executable and static encoded helper transport.

### Focused RPC tests

Command:

```text
npm test -- extensions/subagents/tests/rpc-process.test.ts
```

Result: **29 passed, 1 failed**.

The sole failure is the existing Linux-signal-specific assertion:

```text
RpcProcess transport and OS invariants > hard-tears the owned tree after the RPC child ignores SIGTERM
Expected fake_signal event: true; received false
```

On Windows, Node maps `SIGTERM` process termination to Windows termination semantics rather than delivering the fixture's POSIX signal handler. The Job Object path still terminates and drains the child successfully; the new injected Windows escalation test verifies the graceful timeout followed by forced job cleanup. Before this task, real un-injected RPC startup on Windows failed earlier because ownership required Linux cgroup v2.

### Typecheck

Command:

```text
npm run typecheck
```

Result: **baseline failure outside Task 3 scope**. No Task 3 files reported type errors. Existing errors:

- `extensions/subagents/summaries/completion.ts:67` — `ProviderHeaders` permits `null`, incompatible with `Record<string, string>`.
- `extensions/subagents/summaries/handoff.ts:134` — same `ProviderHeaders` incompatibility.

### Full suite

Command:

```text
npm test
```

Result: **208 passed, 66 failed, 1 error** on the current Windows host.

Known failures are predominantly pre-existing Windows-port gaps outside Task 3 scope:

- Unix broker socket directory mode/ownership assumptions (`expected 0700`).
- The inherited `PI_SUBAGENT_BRIDGE_DIR` test-runner environment assertion.
- Existing broker/mailbox/residency tests depending on Unix socket behavior.
- The one POSIX `SIGTERM` fixture assertion described above.

The complete captured output was emitted by the test command; no unrelated failing tests were modified or suppressed.

## Limitations and concerns

1. **PowerShell/.NET fallback rather than an in-process native addon.** The current Node/Bun runtime exposes no direct Win32 Job Object API. The implementation therefore uses a source-visible PowerShell/.NET helper, not an opaque binary dependency.
2. **Attach-after-spawn race.** Node's standard `spawn` API does not expose `CREATE_SUSPENDED`, so the Job Object is attached immediately after process creation but cannot prevent a malicious or extremely fast child from creating a descendant before attachment. Normal descendants created after assignment inherit the Job Object. Eliminating this race requires a reviewed native launcher/addon that creates the child suspended, assigns the job, then resumes it.
3. **PowerShell availability.** Startup fails closed if neither the fixed Windows PowerShell location nor the fixed PowerShell 7 location exists.
4. **Windows graceful signal semantics.** Node's `SIGTERM` on Windows is not POSIX signal delivery. The adapter preserves the existing grace interval/escalation contract, but OS-level termination may occur immediately; `TerminateJobObject` remains the forced whole-tree guarantee.
5. **Helper startup cost.** Compiling the small C# P/Invoke bridge with `Add-Type` adds several hundred milliseconds to real Windows RPC startup in focused tests.

## Fix round 1 (reviewer P1/P2 findings)

Implementation commit: `7fb9921` (`fix: harden Windows process ownership`). This section supersedes the original attach-after-spawn and Windows graceful-signal descriptions above.

### Corrective changes

- Replaced attach-after-spawn ownership with a source-visible PowerShell/.NET launcher that calls `CreateProcessW` with `CREATE_SUSPENDED`, assigns the suspended leader to a kill-on-close Job Object, and only then calls `ResumeThread`.
- Added an assignment/resume readiness marker filtered out before RPC stdout framing begins. RPC startup fails closed if the launcher exits, errors, or cannot complete atomic assignment.
- Returned the launcher process as the RPC transport owner while the child inherits its stdin/stdout/stderr handles. Killing the launcher closes the retained Job handle and reaps the complete child tree.
- Replaced Windows `child.kill("SIGTERM")` with documented Pi RPC cooperative shutdown: close child stdin, wait the existing shutdown grace period, then force-close the Job if the child has not exited.
- On Job-helper kill error or timeout, ownership records the diagnostic, attempts the leader fallback, and continues bounded termination confirmation.
- Removed PowerShell selection from mutable `SystemRoot`, `WINDIR`, and `ProgramFiles`. Selection now uses the canonical protected-root path `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, verifies `realpath` does not escape that path, and ignores environment tampering.
- Deduplicated Windows child environment keys case-insensitively and pins `SystemRoot`/`WINDIR` to the protected root without expanding the inherited allowlist.
- Added Windows/POSIX test branching and a real Windows descendant cleanup test. The descendant is created immediately after child startup and is confirmed dead after Job cleanup.

### Fix-round verification

Focused command:

```text
npm test -- extensions/subagents/tests/process-ownership.test.ts extensions/subagents/tests/rpc-process.test.ts
```

Result: **39 passed, 0 failed**.

Coverage includes:

- `CREATE_SUSPENDED` launch and assign-before-resume ordering.
- Tampered Windows path environment cannot select a fake PowerShell.
- Helper force-close error and helper-hang timeout handling.
- Cooperative EOF shutdown before forced Job cleanup.
- Platform-specific signal assertions.
- Real Windows descendant inheritance and cleanup.
- Existing RPC framing, timeout, drain, error, and bounded-state tests on Windows.

Typecheck command:

```text
npm run typecheck
```

Result: only the two pre-existing `ProviderHeaders` incompatibilities remain in `summaries/completion.ts:67` and `summaries/handoff.ts:134`; no Task 3 files report type errors.

Full-suite command:

```text
npm test
```

Result on this Windows host: **212 passed, 68 failed, 1 error**. Focused process ownership and RPC suites are fully green. The full-suite failures remain dominated by out-of-scope Windows broker socket mode/ownership assumptions, inherited `PI_SUBAGENT_BRIDGE_DIR`, and broader timing-sensitive manager tests. Parallel full-suite load also exposed PowerShell `Add-Type` startup cost in unrelated manager tests; the atomic launcher fails closed rather than running an unowned child.

### Remaining concerns

1. The protected-root resolver currently supports the standard `C:\\Windows` installation only. A Windows installation on another volume fails closed; supporting it without trusting mutable environment variables requires a small reviewed native `GetSystemWindowsDirectoryW` resolver.
2. Each launch starts PowerShell and compiles the source-visible C# bridge with `Add-Type`. Focused RPC tests pass, but high parallel test load can incur several hundred milliseconds per launch and can amplify unrelated suite timeouts.
3. The helper is source-visible and has no checked-in binary dependency, but it remains a PowerShell/.NET fallback rather than an in-process Node native binding.

## Scope

All implementation/test edits are within the Task 3 runtime and test paths, including the reviewer-requested `rpc-process.test.ts` platform coverage. This report is at the explicitly requested report path. Pre-existing untracked `NUL` and `docs/superpowers/plans/` entries were not modified or committed.
