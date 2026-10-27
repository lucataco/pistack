# pistack

[pstack](https://github.com/cursor/plugins/tree/main/pstack) for [pi](https://pi.dev) 1.4. pstack is Lauren Tan's set of engineering workflows for Cursor. Its center is **poteto-mode**: restate the goal, pick a playbook, cite only principles you have read, and prove changes on the real artifact.

pistack ships all 58 pstack skills unchanged and adds the runtime pieces Cursor provides and pi doesn't: subagents, worktree isolation, per-role models, questions, todos, transcripts, and bounded loops.

```bash
pi install git:git@github.com:lucataco/pistack
```

There's no npm package. pi clones the repo over SSH (so your GitHub SSH key covers the private repo), loads it in place, and has nothing to `npm install`.

| To | Run |
| --- | --- |
| Try it for one session without installing | `pi -e git:git@github.com:lucataco/pistack` |
| Update to the latest `main` | `pi update git:git@github.com:lucataco/pistack` (or `pi update --extensions` for all packages) |
| Pin a release | `pi install git:git@github.com:lucataco/pistack@v0.2.0` |
| Remove it | `pi remove git:git@github.com:lucataco/pistack` |

Then, in pi:

```text
/poteto-mode fix the flaky checkout test
```

## What you get

- **All of pstack 0.15.35**: 58 skills, 23 playbooks, 24 principles, 2 agents, and the guide, generated from a pinned upstream commit. 150 of the 181 shipped upstream files are byte-identical to upstream. The rest differ only by a one-line pointer to the pi adapter or by links to files that aren't shipped. Skill prose is never rewritten ([docs/fidelity.md](docs/fidelity.md)). The cursor-team-kit skills pstack relies on (deslop, control-ui, control-cli) are included.
- **A pi adapter** that maps Cursor names (`Task`, `AskQuestion`, `readonly`, `environment: "cloud"`, `pstack-models.mdc`, `/loop`) to pi tools. Skills that use Cursor terms link to it.
- **Native subagents** (`pistack_agent`). Each subagent is a separate `pi` process with your providers, extensions, and MCP servers. Options: read-only (enforced), git worktree isolation, background runs that report back when done, resume, per-role models, and nesting up to three levels.
- **Sticky poteto mode** (Cursor's Custom Mode): `/poteto-mode`, `pi --poteto`, or `ctrl+alt+p`. Every new task gets the poteto-mode reminder until you turn it off.
- **Per-role models**: `/setup-pstack` writes `~/.pi/agent/pstack/models.md`. Each configured role also becomes a virtual model, so `/model pstack/how-explainer` follows your rule.
- **The citation rule, checked by code**: if a reply cites a principle whose skill wasn't read in the session, pistack has the agent read it and correct the citation.
- **Bounded loops** (Cursor's `/loop`): stop when a shell check passes, after `max_iterations`, on abort, or when pi exits.
- **A status line** showing the mode, the playbook, todo progress, principles read, running agents, and loop progress.

Nothing loads into the prompt until you use a pstack skill. Before that, pistack adds no tools and no prompt text.

## Use

| Type | To |
| --- | --- |
| `/poteto-mode <task>` | Run a task under poteto-mode and turn sticky mode on |
| `/poteto-mode on\|off\|status` | Control sticky mode (also `pi --poteto` and `ctrl+alt+p`) |
| `/skill:<name> [args]` | Run any pstack skill, such as `/skill:how explain the cache layer` |
| `/how`, `/why`, `/architect`, `/arena`, `/swarm`, `/interrogate`, `/reflect`, `/unslop`, `/figure-it-out`, `/tdd`, `/recall`, `/poteto-help` | Shortcuts for `/skill:<name>` |
| `/setup-pstack` | Choose the models pstack roles use |
| `/pstack-loop [30m] [until "npm test"\|until done] [--max N] [prompt]` | Start a bounded loop. Also `/pstack-loop stop` and `/pstack-loop status` |
| `/pstack-agents [stop <id>\|stop all\|cleanup]` | List or stop subagents, or remove finished worktrees |

New to pstack? Start with `/poteto-help` or the [guide](pstack/docs/guide/).

### Models

`/setup-pstack` asks for a reasoning budget (unlimited, large, medium, or small; these map to max, xhigh, high, and medium thinking), then how to assign roles:
- two models: a fast one for code and exploration, a strong one for judgment, with panels getting both;
- every role on the parent chat model;
- or a rule you write yourself.

You review the file in an editor before it's saved. If you have a tstack rule at `~/.pi/agent/tstack/models.md`, setup offers to import it. A trusted project can override the rule with `.pi/pstack/models.md`.

```text
# budget: large (xhigh)
how explorer: opencode-cf/glm-5.3:xhigh
how explainer: opencode-cf/claude-opus-5-5:xhigh
arena runners: opencode-cf/claude-opus-5-5:xhigh, openai/gpt-6.1-sol:xhigh
swarm workers: inherit-parent
```

Values use pi's `[provider/]id[:thinking]` syntax. Upstream's Cursor slugs (`claude-opus-5-5-xhigh`, `grok-4.7-xhigh-fast`) also work: pistack drops `-fast`, reads the effort suffix as the thinking level, and finds that model id under any provider you have credentials for. Without a rule, or when a model isn't available, the subagent runs on the parent model and its report says so. pistack never picks a paid model you didn't name.

### Subagents

Skills ask for subagents in Cursor's words (`Task`, `subagent_type`, `readonly`, `run_in_background`), and pistack accepts those field names. A few details:

- **Read-only** subagents get only `read`, `grep`, `find`, `ls`, and `bash`, plus other tools annotated read-only. pistack blocks shell commands that change files, git state, packages, or remote state. It is a guard, not a sandbox.
- **Worktree** subagents run in `.pi/worktrees/<id>` on branch `pistack/<id>`. When one finishes untouched, its worktree is removed; one with changes or commits is kept for review. pistack never pushes or merges.
- **Background** subagents report back as a message that starts a new turn. In `pi -p` or JSON mode, pistack waits for them before the run ends.
- **Transcripts** are kept under `~/.pi/agent/pstack/agents/<session>/`, separate from your sessions list. `pistack_sessions` reads them.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PISTACK_MAX_DEPTH` | 3 | How deep subagents can nest |
| `PISTACK_MAX_CONCURRENCY` | 4 | Subagents running at once per pi process |
| `PISTACK_AGENT_TIMEOUT_MINUTES` | 60 | Default subagent timeout |
| `PISTACK_VIRTUAL_MODELS` | on | Set to `0` to skip registering `pstack/<role>` models |

## What doesn't carry over

Cursor Automations, Bugbot, cloud VMs, and Cursor's PR tool have no pi equivalent. When a step needs one, the agent writes `Skipped in pi: <step>. <reason>.` and moves on. Worktrees stand in for cloud agents but are not VMs. The orchestrate, watch-pr, and statechart helper scripts run under [bun](https://bun.sh), as upstream ships them. Loops live in the pi process and end when it exits.

## Develop

```bash
npm install
npm run vendor     # snapshot the pinned upstream commit into .upstream/ (gitignored)
npm run check      # generated tree drift, typecheck, unit tests, end-to-end tests
pi -e .            # try the working copy
```

The end-to-end tests run real `pi` processes, including subagents, against a scripted provider: no tokens and no network. They cover engagement, sticky mode, read-only enforcement, worktrees, background delivery, nesting limits, loops, and the citation check.

`pstack/`, `cursor-team-kit/`, and `docs/fidelity.md` are generated. Never edit them by hand. Edit `adapters/pi.md` or `scripts/generate.mjs`, then run `npm run generate`. To move to a newer upstream, run `node scripts/vendor.mjs --commit <sha> && npm run generate`, then review the diff, `docs/fidelity.md`, and `npm run check`.

## Credits

pstack is by [Lauren Tan](https://github.com/poteto) and cursor-team-kit is by Cursor, both under the MIT license. pistack is an unofficial port and isn't affiliated with Cursor or pi. See [NOTICE.md](NOTICE.md).
