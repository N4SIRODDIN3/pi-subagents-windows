# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Standalone Pi package metadata and root extension entry point.
- Portable Node entry points for the upstream Bun test suite and TypeScript
  typecheck.
- Upstream subagents source and tests as the native Windows port baseline.

### Known limitations

- Runtime process ownership is still the upstream Linux-only implementation;
  native Windows launching and cleanup are not included in this scaffold.
- The native-Windows baseline suite is not green: Linux cgroup v2, POSIX
  permission, Unix socket, and process assumptions fail before later porting
  tasks address them. Earlier integration failures can also leave
  `PI_SUBAGENT_BRIDGE_DIR` visible to the runner-environment test.
- Typechecking against Pi 1.4.0 currently reports two `ProviderHeaders` API
  mismatches in the preserved completion and handoff summary sources.
