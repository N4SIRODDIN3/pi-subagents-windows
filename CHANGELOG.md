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
