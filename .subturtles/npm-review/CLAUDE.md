## Current Task
Write the review report to `docs/reviews/npm-package-review.md`.

## End Goal with Specs
A markdown report at `docs/reviews/npm-package-review.md` covering:
1. Every file in the published tarball — is it needed? Any hardcoded paths, secrets, or dev-only content?
2. CLI commands (`superturtle init`, `start`, `stop`, `status`) — do they handle errors gracefully? Edge cases?
3. Setup flow — what happens when a fresh user runs `superturtle init` then `superturtle start`?
4. Dependencies — are prerequisites (Bun, tmux, Claude Code) clearly documented and checked at runtime?
5. package.json — version, description, keywords, engines, repo URL, author — all correct?
6. Templates (.env.example, CLAUDE.md.template) — are they helpful for new users?
7. Multi-instance isolation — does the published package support running multiple instances cleanly?
8. Any broken imports, missing files, or things that would fail on a fresh npm install?

Run `npm pack --dry-run` from `super_turtle/` to see the exact file list.

## Backlog
- [x] Run `npm pack --dry-run` and catalog every file in the tarball
- [x] Read `bin/superturtle.js` — audit all CLI commands for correctness and error handling
- [x] Read `setup` script — audit the init/onboarding flow
- [x] Check templates (.env.example, CLAUDE.md.template) for completeness
- [x] Spot-check key source files for hardcoded paths or issues
- [x] Review package.json fields
- [ ] Write the review report to `docs/reviews/npm-package-review.md` <- current
- [ ] Commit the report

## Notes
- Package root is `super_turtle/` (that's where package.json lives)
- This is MIT open source — no need to hide prompts or code
- The `files` array in package.json controls what gets published
- Focus on what would break or confuse a first-time user doing `npm install -g superturtle`
