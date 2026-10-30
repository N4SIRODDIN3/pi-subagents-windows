# Native Windows Port of Pi Subagents

## Intent

Create a standalone public repository containing a native Windows port of the
`extensions/subagents` extension from `h4ni0/pi`. Preserve its broker/RPC,
persistent-agent, lifecycle, and UI behavior without WSL, `bwrap`, cgroups, or
`systemd-run`.

The primary use case is nested delegation: a root agent spawns a child, and
that child can spawn a grandchild subject to an explicit maximum depth.

## Goals

- Launch and supervise child Pi processes natively on Windows.
- Preserve authenticated broker transport and bounded child environment rules.
- Preserve graceful shutdown, forced cleanup, persistence, and protocol semantics.
- Prove root → child → grandchild delegation with depth enforcement.
- Replace Bash-only maintenance and verification entry points with portable Node
  runners and PowerShell wrappers where useful.
- Publish a clean standalone public GitHub repository with attribution.

## Non-goals

- Reimplement Linux cgroup or `bubblewrap` sandboxing on Windows.
- Modify or replace `pi-agents-team` in the published project.
- Share runtime state with another collaboration extension.
- Change canonical behavior when this extension runs alone.

## Constraints

- Node.js/Bun-compatible TypeScript; Windows 10/11 is the primary target.
- Spawn without `shell: true`.
- Use `node:path`; no hard-coded Linux path assumptions in Windows paths.
- Resolve a trusted absolute Pi executable.
- Clean up process trees normally and after failures; prefer Windows Job Objects,
  with a transparent PowerShell/.NET fallback if needed.

## Approaches considered

### Native Windows launcher — selected

Keep the broker and protocol. Put process ownership behind a platform adapter.
Linux retains the existing `bwrap`/cgroup path. Windows uses
`child_process.spawn` plus a Windows Job Object adapter, with a documented
fallback only when the optional native helper is unavailable.

### WSL-only compatibility

Run the existing Linux implementation under WSL. This minimizes changes but is
not a native Windows port and does not support normal Windows Pi installs.

### Direct spawning without tree ownership

Use `spawn()` and `kill()` only. This can orphan descendants, so it is not the
default; it may remain an explicitly documented emergency fallback.

## Local installation and coexistence

For local validation, the installed `pi-agents-team` package may be disabled or
removed from Pi's package list after backing up its settings and package
version. This avoids duplicate canonical registrations while testing nested
delegation. The port will use canonical collaboration tool names when installed
standalone, matching the upstream contract.

It will still use independent runtime state by default:

- dedicated `subagents.json` configuration;
- dedicated session root, such as `~/.pi/agent/sessions/subagents-windows`;
- dedicated broker runtime directory/socket prefix;
- independent UI/state symbols and labels.

If Pi exposes extension discovery, startup will fail closed with a clear message
when another extension has already registered the canonical collaboration tools.

## Standalone package layout

The port is packaged as a Pi package rather than as a parent Pi checkout.
`index.ts` is the declared package extension and delegates to the preserved
`extensions/subagents/index.ts` entry point. Host-provided Pi modules remain
peer dependencies, while development dependencies make the upstream source and
tests typecheckable in isolation.

Portable `tests/run-tests.ts` and `tests/run-typecheck.ts` Node entry points
replace Bash as the package-level verification interface. They scrub inherited
`PI_SUBAGENT_*` controls before spawning Bun or TypeScript and invoke child
processes without `shell: true`. The original upstream shell runners remain in
the copied test tree for provenance, but package scripts do not depend on them.

The extraction baseline was attempted on native Windows before behavior
changes. Both upstream shell runners failed during their Linux-specific
symlink bootstrap (`ln ... node_modules/@earendil-works/pi-agent-core: No such
file or directory`), before the compiler or test suite started. This is a
harness/platform failure, not a known source-test failure.

## Implementation outline

1. Extract platform-specific process ownership and signal behavior from
   `rpc-process.ts` into Linux and Windows adapters.
2. Implement Windows executable/path handling and child environment rules.
3. Implement Job Object ownership and a tested cleanup fallback.
4. Port broker runtime directory validation to Windows path/permission semantics.
5. Replace shell-script verification with Node runners and PowerShell wrappers.
6. Add nested-agent tests covering depth, capacity, authorization, and cleanup.
7. Add standalone package metadata, README, LICENSE attribution, Windows/Linux
   CI, and changelog.

## Verification and acceptance

- Typecheck and unit tests pass on Windows and Linux.
- Windows smoke test starts a child, exchanges broker messages, and verifies
  graceful and forced cleanup.
- Nested smoke test proves root → child → grandchild, confirms inherited depth
  metadata, and proves the configured maximum rejects the next spawn.
- Standalone compatibility test confirms canonical tools work when this is the
  only collaboration extension loaded.
- README documents installation, prerequisites, isolation limitations, nested
  delegation, and upstream attribution.

## Remaining builder decisions

- Choose the smallest maintainable Job Object implementation without an opaque
  binary dependency.
- Preserve existing test semantics unless a platform difference is documented.
- Choose the new GitHub repository name after checking availability.
