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

## Scope

All implementation/test edits are within the assigned paths. This report is at the explicitly requested report path. Pre-existing untracked `NUL` and `docs/superpowers/plans/` entries were not modified or committed.
