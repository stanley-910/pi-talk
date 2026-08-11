# Papercuts

Small frictions hit while working here — dead-end tool calls, broken links,
confusing setup steps, flaky commands, misleading errors, non-obvious gotchas.
Not blocking; logged so this repo can be sanded down. Distinct from tracked
bugs and from a work log.

Append with `papercut "<what got in the way>"`. Check off (`- [x]`) or delete
entries as they're fixed.

## Open

- [ ] 2026-08-10 — glab-board grab/close failed on a GitHub-backed board with 'GitHub canonical project unset; run glab-board setup --board first' — had to claim via raw 'gh issue edit --add-assignee/--add-label' instead. Board close also left the agent::researching label behind since the claim wasn't board-recorded. Probably needs a fallback path when the Projects v2 board id isn't cached. · _opus5_
- [ ] 2026-08-10 — glab-board view <iid> printed nothing and exited 0 on a GitHub-origin repo; had to fall back to 'gh issue view 24 --json body' to read the ticket contract. Likely the view subcommand is GitLab-only or its gh path swallows output. · _opus-5_
- [ ] 2026-08-10 — Reading issue #25's contract: 'glab-board view 25' exited 0 with completely empty output (no error), and 'gh issue view 25' came back as rtk-compacted CSV mush with the two longest contract bullets truncated to <<ccr:...>> placeholders. Had to fall back to 'gh api ... --jq .body' redirected to a file. glab-board view should at least warn when it renders nothing. · _opus-5_
- [ ] 2026-08-10 — Implementing #25's 'talk status' needed the speaker pidfile path, but #24 (which owns the pidfile) fixes only the state dir ~/.claude/cc-talk/ and never names the file — and #24 isn't implemented yet, so there was nothing to grep. Had to glob *.pid defensively. Sibling tickets that share a filesystem contract should name the exact paths. · _opus-5_
- [ ] 2026-08-10 — Fresh glab-board worktree has no node_modules, so 'npm test' fails on test/keybindings.test.ts with ERR_MODULE_NOT_FOUND (@earendil-works/pi-tui) before any of your code runs. README's 'Automated coverage' should say to run 'npm install' in a new worktree first. · _opus-5_
- [ ] 2026-08-10 — Node 23+ strip-only type stripping rejects TypeScript parameter properties (constructor(private readonly x)). Test fakes written in that style die with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX; declare the field and assign in the body instead. · _opus-5_
