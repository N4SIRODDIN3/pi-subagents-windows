# Pi Subagents for Windows

A standalone port of the persistent collaboration-agents extension from
[`h4ni0/pi`](https://github.com/h4ni0/pi). The package keeps the upstream
extension entry point and canonical collaboration tool contract while native
Windows process support is developed.

> **Current status:** the source in this scaffold is the unchanged upstream
> Linux implementation. It still requires Linux process-isolation tools at
> runtime. Native Windows launching and cleanup are planned follow-up work.

## Development

Requirements:

- Node.js 22.18 or newer
- npm (dependencies install a project-local Bun executable)

```text
npm install
npm run typecheck
npm test
```

The test and typecheck scripts are Node entry points and do not require Bash.
They remove inherited `PI_SUBAGENT_*` control variables before starting child
processes so a live Pi collaboration identity cannot leak into the suite.

## Package entry point

Pi loads `index.ts`, which delegates directly to the upstream
`extensions/subagents/index.ts` factory. The package manifest declares the
host-provided Pi modules as peer dependencies to avoid loading duplicate Pi
runtime instances when installed as a Pi package.

## Upstream attribution

The extension source and tests are derived from
[`h4ni0/pi`](https://github.com/h4ni0/pi) and remain available under the MIT
License. See [LICENSE](LICENSE).
