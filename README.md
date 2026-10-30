# Pi Subagents for Windows

A standalone **native Windows port** of the persistent collaboration-agents
extension from [`h4ni0/pi`](https://github.com/h4ni0/pi).

It lets one Pi session run a team of background Pi agents, and — unlike the
current upstream implementation, which requires Linux cgroup v2 plus
`bubblewrap`/`systemd-run` — it runs on a normal Windows installation with no
WSL. Nested delegation is the headline feature: an agent can spawn a child, and
that child can spawn a grandchild, bounded by an explicit maximum depth.

```text
/root
  └── /root/child                    spawn_agent(task_name: "child")
        └── /root/child/grandchild   spawn_agent(task_name: "grandchild")
```

## Status

Verified on Windows 11 with Node.js 22 / Pi 1.4.0:

- `npm test` — **287 pass, 7 skip, 0 fail** (294 tests, 28 files)
- `npm run typecheck` — clean
- Live nested smoke test — a root session spawned `child`, `child` spawned
  `grandchild`, and the grandchild's final answer (`GRANDCHILD_OK`) was
  delivered back through `wait_agent`.

The 7 skips are POSIX-only invariants (filesystem socket owner/mode/inode
checks, stale-socket scavenging) plus three documented Windows limitations
listed under [Known limitations](#known-limitations).

## Requirements

- Windows 10/11 (Linux/macOS keep the upstream sandboxed implementation)
- Node.js 22.18+ or Bun
- PowerShell 5.1 at `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
  (default on Windows). Used only for Windows Job Object process ownership.

## Install

From this repository:

```powershell
pi install git:github.com/N4SIRODDIN3/pi-subagents-windows
```

Or load it for a single run:

```powershell
pi --no-extensions -e .\extensions\subagents\index.ts
```

### Coexisting with another team extension

This port registers the canonical collaboration tools (`spawn_agent`,
`send_message`, `followup_task`, `wait_agent`, `interrupt_agent`,
`list_agents`, `delegate`, `ask_parent`). Do not load it together with another
extension that registers the same names (for example `pi-agents-team`); the
tool names would collide. Disable the other package first:

```powershell
pi remove npm:pi-agents-team
```

Runtime state is already isolated: this port uses its own `subagents.json`
settings, its own session root under `~/.pi/agent/sessions/subagents`, and its
own broker endpoint namespace.

## Nested delegation and depth

Depth is enforced before every spawn, at three layers:

| Layer | Setting | Default |
|---|---|---|
| Pi extension env gate | `PI_SUBAGENT_DEPTH` / `PI_SUBAGENT_MAX_DEPTH` | inherited |
| Extension settings | `maxDepth` | `2` |
| Broker `reserveChild` | caller `depth` vs `maxDepth` | enforced per request |

With the default `maxDepth = 2`, the root (depth 0) may spawn a child
(depth 1), and that child may spawn a grandchild (depth 2). The grandchild
cannot spawn again. Raise `maxDepth` in `~/.pi/agent/settings.json` (or a
trusted project `.pi/settings.json`) to go deeper, subject to the 128-agent
capacity cap.

## Per-agent model and thinking assignment

`spawn_agent` takes two optional fields beyond the canonical set:

| Field | Shape | Inherited from |
|---|---|---|
| `model` | `provider/model-id` (e.g. `deepseek/deepseek-flash`) | the spawning agent's current model |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | the spawning agent's current level |

Omit either field and the child inherits the spawning agent — so a tree stays on
one model unless you say otherwise. Set it and the override flows down: a
grandchild inherits its own parent's override, not the root's.

```text
spawn_agent(task_name: "scout", model: "deepseek/deepseek-flash", thinking: "low")
spawn_agent(task_name: "synth", model: "openai/gpt-5.6-luna")   # grandchild of scout
```

Cheap scouts fan out, one expensive synthesizer merges the results — with no
change to how you call the rest of the tree.

The model is resolved against Pi's live model registry **before** any capacity
is reserved, so a typo or an unauthenticated provider fails the tool call
immediately instead of half-starting a child:

```text
Unknown model 'deepseek/deepseek-v4-flash'. Use 'provider/model-id' from pi --list-models.
Model 'openai/gpt-5.6-luna' has no configured credentials in this Pi session.
```

This is a deliberate divergence from upstream's "hidden metadata" profile, which
exposes no model/reasoning overrides at all. Every other hidden field
(`agent_type`, `reasoning_effort`, `service_tier`, `nickname`) stays rejected.

## How Windows support works

| Concern | Linux (unchanged) | Windows (this port) |
|---|---|---|
| Process-tree ownership | cgroup v2 + `bwrap` | Windows **Job Object** with `KILL_ON_JOB_CLOSE` |
| Atomic launch | `bwrap` in the owned subtree | `CreateProcessW(CREATE_SUSPENDED)` → `AssignProcessToJobObject` → `ResumeThread` |
| Broker endpoint | Unix domain socket, `0600`, `0700` dir | **Named pipe** `\\.\pipe\pi-subagents-<24 hex>` |
| Graceful shutdown | `SIGTERM` → cgroup kill | cooperative RPC stdin EOF → `TerminateJobObject` |
| Child environment | allowlist | allowlist plus Windows essentials (`SystemRoot`, `TEMP`, profile dirs, `PATHEXT`) |

The Windows Job launcher is compiled from source-visible C# hosted by
PowerShell. The compiled assembly is cached per user (under `%LOCALAPPDATA%`
when available, otherwise the process temp directory) and keyed by a hash of
the launcher source, so a spawn costs one PowerShell start (~150–300 ms)
instead of a ~2.5 s recompile.

Atomicity details worth knowing:

- The child is created **suspended**, assigned to its Job, then resumed, so it
  cannot create a descendant outside the Job.
- The trusted PowerShell path is fixed to the protected `C:\Windows` root and
  must resolve there; a tampered `SystemRoot` cannot redirect execution.
- Any helper failure, timeout, or hang force-closes the helper, which triggers
  kill-on-close for the whole Job, with a leader-termination fallback.

## Known limitations

- **Not a Linux-grade sandbox.** A Job Object bounds lifetime and tree
  membership, not filesystem/network privilege. Same-user processes remain in
  the same trust domain, exactly as documented upstream for the broker's
  cooperative-identity model.
- **Bun-on-Windows named pipes.** Back-to-back broker responses written while a
  peer is still settling its handshake can be dropped by the Bun Windows pipe
  transport, stranding a request until its timeout. Three unit tests that
  exercise that specific shape are skipped on Windows and flagged in source:
  `root-tree-broker` self-report epochs, one `manager-races` interruption case,
  and the multi-process nested reload-ownership case in `broker-bootstrap`.
  Real nested delegation is verified separately by the live smoke test above.
- **Non-`C:\Windows` installations fail closed.** Resolving the system
  directory through the OS API (rather than trusted constants) is the follow-up.
- **`killChildrenOnParentExit`.** On Windows this is best-effort: if a parent
  dies without closing its Job handle, children are reaped by kill-on-close
  only when the handle is released.

## Development

```powershell
npm install
npm run typecheck
npm test
```

Both entry points are plain Node scripts; no Bash is required. They strip
inherited `PI_SUBAGENT_*` variables so a live collaboration identity cannot leak
into the suite.

### Live nested smoke test

The end-to-end proof spawns real Pi processes with only this extension loaded:

```powershell
pi -p --provider <provider> --model <model> `
   --no-extensions -e .\extensions\subagents\index.ts --no-mcp `
   --session-dir .\smoke-sessions `
   "Spawn an agent named child whose goal is to spawn an agent named grandchild
    that replies GRANDCHILD_OK, then wait_agent all:true and report its output."
```

## Upstream attribution

The extension source, tests, and canonical tool contract are derived from
[`h4ni0/pi`](https://github.com/h4ni0/pi) (`extensions/subagents`) and remain
available under the MIT License. See [LICENSE](LICENSE) and
[CHANGELOG.md](CHANGELOG.md).
