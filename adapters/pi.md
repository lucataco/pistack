# pstack in pi

pstack skills use Cursor names. In pi, read this file once per session, then map each Cursor name in a skill with the tables below. The pistack extension provides every tool named here. The `<pistack>` section of the system prompt gives the absolute paths this file uses: `<pstack>` (the folder that holds `skills/`, `agents/`, and `docs/`), the session transcript, the agent store, and the model rule. If a Cursor field has no row, drop it and say so. Never pass a field or value the tool schema rejects.

## Tools

| Cursor | pi |
| --- | --- |
| `Task` | `pistack_agent`. It runs a pi child process with its own context window and returns the child's final reply, or returns an agent id at once with `background: true`. |
| `AskQuestion` | `pistack_ask`, with the same `questions` shape: `id`, `prompt`, `options` of `{ id, label }`, and `allow_multiple`. In `-p` or JSON mode, and inside a subagent, nobody can answer, so ask in plain text in your reply and stop. |
| Open a todolist | `pistack_todo` with `todos` (`id`, `content`, `status`: `pending`, `in_progress`, `completed`, or `cancelled`) and `merge`. The list follows the session branch. |
| Run another pstack skill (`/name` or "the **name** skill") | `read` `<pstack>/skills/<name>/SKILL.md` and follow it. When you tell the user to type it, write `/skill:<name>`. `/poteto-mode` also exists as a command. |
| `Grep`, `Glob` | The `grep` and `find` tools when they are active, else `bash` with `rg` and `find`. |
| `/loop` | `pistack_loop`. Use `every` for a heartbeat (`"30m"`, `"1h"`), `until` for a shell check that exits 0 when the run is done, and `prompt` for what each wake should do. With neither, the loop continues after each turn until you call it with `action: "stop"`. When you tell the user to type it, write `/pstack-loop`. A loop lives in this pi process: it stops when the check passes, on `max_iterations` (default 25), on abort, or when pi exits. In `-p` or JSON mode nothing can wake the process later, so the loop continues right after each turn. |
| `/create-skill` | Not in pi. Follow the Authoring a skill playbook and the Agent Skills format: a folder named like the skill, holding `SKILL.md` with `name` and `description` frontmatter. |
| Custom Mode | `/poteto-mode` turns on sticky poteto mode, a reminder on every turn until `/poteto-mode off`. `pi --poteto` starts a session with it on. |

## Subagent fields

| Cursor | `pistack_agent` |
| --- | --- |
| `subagent_type: generalPurpose` | `subagent_type: "general-purpose"`, the default. |
| `poteto-agent`, `comment-sicko` | `subagent_type: "poteto-agent"` or `"comment-sicko"`. pistack gives the child `<pstack>/agents/<name>.md` as instructions. |
| `readonly: true` | `readonly: true`. The child gets `read`, `grep`, `find`, `ls`, and `bash`, plus only those other tools annotated read-only, and pistack blocks file-changing shell commands. Like Cursor, a read-only child loses other MCP tools, so pass `readonly: false` when it needs them (as `why` does). Still check `git status` afterward. |
| `readonly: false` | Omit. The child gets the parent's active tools, MCP included. |
| `environment: "cloud"` | `isolation: "worktree"`. pistack creates a git worktree at `.pi/worktrees/<id>` on a new branch `pistack/<id>` and reports its path and branch. Name the starting point with `base`. When the child finishes, an untouched worktree is removed; one with changes or commits is kept for you to review or merge. |
| `environment: "local"` | Omit. |
| `cloud_base_branch: <b>` | `base: "<b>"`, the branch, tag, or commit the worktree starts from. |
| `run_in_background: true` | `background: true`. The completion arrives as a message that wakes you, so do not poll or sleep. `pistack_agents` lists, waits for, stops, or cleans up agents. |
| `resume` | `resume: "<agent id>"` with the follow-up as `prompt`. The child continues its own session, in its worktree if it had one. |
| `file_attachments` | `files: [paths]`. pistack lists them in the brief and the child reads them. |
| `model` | `model`, or `role` to use that role's line from the model rule. See Models. |

Subagents can spawn subagents up to three levels deep. A subagent at the limit has no `pistack_agent`, so it does the work itself or reports back.

## Models

| Cursor | pi |
| --- | --- |
| The `pstack-models.mdc` rule, `~/.cursor/rules/pstack-models.mdc` | `~/.pi/agent/pstack/models.md`. A trusted project's `.pi/pstack/models.md` overrides it. The `<pistack>` section quotes its lines, so the role lines are already in context. If the file or the role's line is missing, use the skill's default. |
| A slug such as `claude-opus-5-5-xhigh`, `grok-4.7-xhigh-fast`, or `gpt-5.6-sol-high` | Pass it as `model` unchanged. pistack drops `-fast`, takes the effort suffix as the thinking level, and runs the model with that id from any provider that has credentials. When none has it, the child runs on the parent model and the result says so. |
| `auto` or `inherit-parent` | Omit `model`. The child runs on the parent chat model and thinking level. |
| A role value in the pi rule | `[provider/]id[:thinking]`, such as `anthropic/claude-opus-5-5:xhigh`. The `:thinking` suffix is the effort. Pass the value as `model`. |
| A panel role (arena runners, arena cross-judge pool, architect runners, interrogate reviewers) | One `pistack_agent` per entry: pass the entry as `model`, or pass `role` with `seat` 0, 1, 2, and so on. |

## setup-pstack

Prefer the `/setup-pstack` command. It detects models from pi's registry, asks for a budget, and writes the rule. If you follow the skill instead, apply these changes:

- Detect. Run `pi --list-models` with `bash`. It lists the models that have credentials. Write each model as `provider/id:thinking`.
- Budget. The effort is the `:thinking` suffix. `unlimited`, `large`, `medium`, and `small` set it to `max`, `xhigh`, `high`, and `medium`.
- Defaults. Map each default slug as in Models: `claude-opus-5-5-xhigh` is the detected `claude-opus-5-5` model with `:xhigh`. A family with no detected model is `inherit-parent`.
- Write. Write `~/.pi/agent/pstack/models.md` with no frontmatter: the comment lines, the `# budget` line, then one line per role. Overwrite the whole file. Never put the role lines in `AGENTS.md`.

## Paths

| Cursor | pi |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `.pi/skills/` (or `.agents/skills/`), `~/.pi/agent/skills/` |
| `~/.cursor/plugins/`, `plugins/cache/`, `.cursor-plugin/plugin.json` | `<pstack>`, inside the installed pistack package. Treat it as read-only: copy a skill to `.pi/skills/` or `~/.pi/agent/skills/` before you edit it. |
| `.cursor/rules/*.mdc`, always-applied rules | `AGENTS.md` (pi also reads `CLAUDE.md`). The model rule is the exception. See Models. |
| `https://github.com/cursor/plugins/blob/main/pstack/<path>` | `<pstack>/<path>` when that file exists. Read the local copy and never fetch it. Give the user the URL when they need a link. |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | pi sessions. The `<pistack>` section names the current session file and this workspace's session folder. `pistack_sessions` with `current` names this session and its subagent transcripts, `list` shows this workspace's sessions, and `read` renders a session's active branch. It never crosses workspaces. |
| The agent store (path in the system prompt) | The agent store path in the `<pistack>` section. A subagent's section names both its own store and the root agent's store. |
| `cursor-team-kit` (`deslop`, `control-ui`, `control-cli`) | Bundled with pistack at the cursor-team-kit path in the `<pistack>` section, also `/skill:<name>`. They install nothing, so use the project's own tooling. |

## Cursor-only features

pi has no Cursor Automations, Bugbot, Cursor cloud agents, or built-in PR tool. When a step needs one, put one line in your reply, `Skipped in pi: <step>. <reason>.`, then go on to the next step. Do not stop, ask, or retry. When a later step needs what the skipped step made, such as a URL or a key, leave a placeholder and name it in the line.

| Cursor | pi |
| --- | --- |
| Cursor Automations: routines, `update_state` routine calls, `api2.cursor.sh/automations` webhooks, routine wakes, and `SendToUser` secret requests | Skip with the line. |
| Bugbot | Bugbot comments on a GitHub PR are ordinary review threads, so triage them with the forge command the step gives. Skip a step that starts, waits for, or configures Bugbot when the PR has no Bugbot check or comment. |
| Cursor cloud agents | `environment: "cloud"` maps to a worktree, as in Subagent fields. A worktree is not a VM or a sandbox. Skip a step that needs the cloud agent itself, such as its dashboard or its own machine. |
| A built-in PR tool | Use the forge command the step gives, such as `gh pr create`. That is not a skip, so write no line. |

## Helper scripts

`scripts/orch/orch.ts`, `scripts/watch-pr/watch-pr`, and the statechart CLI run under bun, as upstream ships them, and install their own dependencies on first run. Run them by path from `<pstack>/skills/<skill>/`. Without bun, say so and do the step by hand.
