# Changelog

## 0.2.0

A rebuild for pi 1.4 and pstack 0.15.35 (cursor/plugins `9f844cdaac06`). It replaces 0.1.0, which targeted pi 1.0 and pstack 0.15.9.

- Installs from GitHub: `pi install git:git@github.com:lucataco/pistack`. The `@lucataco/pistack` npm package is gone.
- pistack recognizes its own skills when its install path runs through a symlink (macOS `/tmp`, a symlinked `~/.pi`).

- All 58 upstream skills, including the 9 that 0.1.0 lacked: create-formal-verification-skill, in-your-own-words, ketchup, ketchup-video, maintain-formal-verification-skill, make-bot-ui, poteto-help, sharpen, and statechart. Skill prose is unchanged. Only skills that use Cursor terms get a one-line pointer to the pi adapter.
- Subagents run as separate `pi` processes with the user's own providers, extensions, and MCP servers, replacing the vendored RPC runtime. Read-only enforcement, worktree isolation, background delivery (in print and JSON mode too), resume, nesting limits, and Cursor `Task` field names are supported.
- pistack adds no tools or prompt text until a pstack skill is used.
- Model roles: `/setup-pstack` uses pi's dialogs and model registry, offers to import a tstack rule, and validates models before saving. Each configured role is also a `pstack/<role>` virtual model.
- The principle-citation rule is checked by code at the end of each run.
- The `paths:` rule of typescript-best-practices is approximated with a one-time pointer on the first TypeScript edit.
- Loops are bounded (`max_iterations`, default 25) and work in print mode.
- Commands: the 26 prompt aliases are down to 12 skill shortcuts plus `/poteto-mode`, `/setup-pstack`, `/pstack-loop`, and `/pstack-agents`.
- End-to-end tests run real pi processes against a scripted provider.
