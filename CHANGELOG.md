# Changelog

All notable changes to this project will be documented in this file, newest
first, grouped by user impact.

## [Unreleased]

### Added

- **Per-agent model and thinking assignment.** `spawn_agent` accepts optional
  `model` (`provider/model-id`) and `thinking` (`off`…`max`). Omitted fields
  inherit the spawning agent, set fields flow down the tree, and the model is
  validated against Pi's live registry (existence plus configured credentials)
  before any capacity is reserved. The resolved `provider/model-id` is written
  into the child's fork seed so a restored session reports the model it really
  used.

### Changed

- The spawn schema is now a deliberate divergence from upstream's hidden-metadata
  profile: `model` and `thinking` are allowed, all other hidden fields
  (`agent_type`, `reasoning_effort`, `service_tier`, `nickname`) remain rejected.

## [0.1.0] — 2026-10-21

First native Windows release of the ported subagents extension.

### Added

- **Native Windows process ownership.** Child Pi agents are launched through
  `CreateProcessW(CREATE_SUSPENDED)` and assigned to a Windows Job Object with
  `KILL_ON_JOB_CLOSE` before being resumed, so descendants cannot escape the
  owned tree. No WSL, cgroup, `bwrap`, or `systemd-run` is required.
- **Windows named-pipe broker transport.** `\\.\pipe\pi-subagents-<24 hex>`
  replaces Unix domain sockets on win32, with the same reserved namespace,
  authenticated handshake, and fail-closed path validation.
- **Cooperative Windows shutdown.** Graceful phase closes the RPC stdin so the
  child can flush state, then escalates to `TerminateJobObject` after the
  configured grace period, with leader termination as a fallback.
- **Nested delegation proven on Windows.** A root session spawns a child, the
  child spawns a grandchild, and the grandchild's final answer returns through
  `wait_agent`. Depth is enforced before every spawn.
- **Windows child environment essentials.** Children inherit `SystemRoot`,
  `SystemDrive`, `TEMP`/`TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
  `HOMEDRIVE`/`HOMEPATH`, `USERNAME`, `PATHEXT`, `ComSpec`, and processor
  metadata. Without these a child Pi process could not start, so grandchildren
  could not be spawned.
- **Cached Job launcher.** The C# Job Object launcher is compiled once per user
  and per launcher-source revision, cutting a Windows spawn from ~2.5 s to
  ~150–300 ms.
- Standalone package metadata, a root extension entry point, and portable Node
  test/typecheck entry points that need no Bash.
- Windows-specific test coverage: named-pipe broker endpoints, atomic launch
  ordering, helper hang/error recovery, tampered-environment rejection, real
  descendant reaping, and three-level nested depth enforcement.

### Fixed

- `wait_agent`'s parameter schema is now a root `type: "object"` with an
  explicit `anyOf` mode constraint. Providers that reject a root `anyOf`
  schema (observed with strict OpenAI-compatible endpoints) can now load the
  tool.
- Pi 1.4.0 `ProviderHeaders` (`string | null`) values are filtered before
  compaction summarization instead of failing typecheck and passing `null`
  headers through.

### Changed

- On Windows the broker treats pipe endpoints as ephemeral: no filesystem
  socket files, mode-bit checks, inode identity, or stale-socket scavenging.
- POSIX-only broker invariants (owner/mode/inode checks, symlink-directory
  rejection, stale-socket scavenging) are explicitly skipped on win32 instead
  of failing.

### Known limitations

- A Job Object bounds lifetime, not privilege: this is not a Linux-grade
  sandbox, and same-user processes remain in one trust domain.
- Three unit tests that exercise back-to-back broker responses on a
  freshly-settling Bun Windows named pipe are skipped on Windows; real nested
  delegation is covered by the live smoke test instead.
- A Windows installation whose system directory is not `C:\Windows` fails
  closed for process ownership rather than trusting environment variables.
