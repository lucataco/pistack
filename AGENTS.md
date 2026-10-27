# Working on pistack

pistack ports pstack (cursor/plugins) to pi 1.4. Read README.md first.

- `pstack/`, `cursor-team-kit/`, `docs/fidelity.md`, and `.generated-files.json` are generated. Never edit them. Change `adapters/pi.md` or `scripts/generate.mjs`, then run `npm run generate`.
- Keep upstream skill prose unchanged. Fix a mapping in the adapter, not in a skill.
- After a change, run `npm run check`. It runs the generated-tree drift check, the typecheck, and the unit and end-to-end tests. A fresh clone needs `npm run vendor` first.
- End-to-end scenarios live in `test/fixtures/faux.ts` (scripted replies) and `test/e2e/`. Add one for every behavior change in the extension.
- pi APIs: use the types in `node_modules/@earendil-works/pi-coding-agent/dist` and the docs shipped with pi. Don't guess.
- Don't publish, push, install globally, or read credentials unless the user asks.
- Keep the MIT notices in NOTICE.md, pstack/LICENSE, and cursor-team-kit/LICENSE.
