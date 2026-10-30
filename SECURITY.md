# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

## Reporting a vulnerability

Open a private security advisory on this repository
(`Security` → `Advisories` → `Report a vulnerability`), or email the maintainer
listed on the repository profile. Please do not file public issues for
exploitable bugs. Expect an initial response within 7 days.

Include: affected version/commit, the platform, the exact command or tool call
involved, and what an attacker gains. A proof-of-concept is ideal.

## Attack surface (what this software actually does)

This is a Pi extension. It has no network listener, no HTTP routes, and no
runtime dependencies. Its security-relevant behavior is:

1. **Child process launching.** It spawns child `pi` processes and owns their
   process trees (Windows Job Objects; Linux cgroup v2 + `bwrap`).
2. **A local broker endpoint.** On Windows a named pipe under
   `\\.\pipe\pi-subagents-<24 hex>`; on POSIX a Unix socket with `0600` in a
   `0700` directory. Agents authenticate with a one-time capability token.
3. **A cached native launcher (Windows).** A source-visible C# helper is
   compiled once by PowerShell and cached under `%LOCALAPPDATA%` (or the process
   temp directory), keyed by a hash of the launcher source.

## Trust model

- **Same-user processes are one trust domain.** Broker capabilities and
  connection generations stop *cooperative* agents from overstepping, but they
  do not isolate a hostile process running as the same OS user. That process can
  read accessible files, environment, and process state. Hostile children need a
  separate UID, container, or OS sandbox.
- **A Windows Job Object bounds lifetime and tree membership, not privilege.**
  It is not a filesystem or network sandbox and is not a substitute for one.
- **Children inherit a filtered environment** (an allowlist including `PATH`,
  provider API keys, and Windows essentials such as `SystemRoot`, `TEMP`, and
  profile directories). Loader controls (`NODE_OPTIONS`, `NODE_PATH`,
  `LD_*`, `DYLD_*`, `PI_SUBAGENT_*`) are never inherited, and the collaboration
  manager re-injects only the explicit child grant.

## Hardening already in place

- The Windows launcher's cached assembly is only loaded when its bytes match a
  sidecar SHA-256 written at compile time, and it is loaded from the exact buffer
  that was hashed. A planted or swapped DLL is rejected and rebuilt
  (`extensions/subagents/tests/windows-launcher-integrity.test.ts`).
- The trusted PowerShell path is resolved to a protected root and must not
  escape it; a tampered `SystemRoot`/`WINDIR` cannot redirect execution.
- Children are created suspended, assigned to their Job, then resumed, so no
  descendant can be created outside the owned tree.
- Broker endpoints reject unauthenticated connections, forged capabilities,
  sibling impersonation, duplicate identities, and cross-agent mutation
  (covered by `broker-transport`, `ask-parent-security`, and `root-tree-broker`
  tests).
- Agent paths, root session ids, and broker pipe names are validated against
  traversal payloads (`nested-agents`, `platform-paths` tests).
- No `shell: true` anywhere; every child spawn uses an argument array.

## Known limitations (accepted)

- **Named pipe DACL**: the broker pipe is created with the process default
  security descriptor rather than an explicit owner-only ACL. Access is limited
  by the OS default (owner, SYSTEM, Administrators) and the name carries 96 bits
  of randomness, so guessing or squatting is impractical. An explicit DACL is
  planned.
- **`PATH` inheritance**: children inherit `PATH` so their tools work. A
  hostile parent-controlled `PATH` could influence which binaries a child
  resolves. This is inherent to giving a child a shell.
- **Non-`C:\Windows` installations** fail closed for process ownership rather
  than trusting environment-derived system paths.
- Three Bun-on-Windows named-pipe delivery tests are skipped on win32; see the
  README's known limitations.

## Out of scope

Vulnerabilities that require an attacker to already run code as the same user,
physical access, or denial of service against your own machine.
