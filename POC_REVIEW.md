# PR Review POC — file-by-file review in px0 web UI

Branch: `rahul/pr-review-poc` (in `px0-ref/`, depth-1 clone of `github.com/px0-ai/px0`)

## 1. Goal
Prove we can do GitHub-PR-style file-by-file review inside px0's existing web UI,
powered by local `gh auth login` (no custom token plumbing), minimal and fast:

- open `px0 <pr-url>`, see PR diff scoped to merge-base (existing)
- checklist of changed files, checkbox per file to mark done, progress `3/12`
- clicking a file shows FULL file with red/green diff highlight (VSCode-like),
  auto-focused on first hunk, no extra clicks to read whole file
- toggle Full / Hunks
- Approve / Request Changes / Comment (existing submit path)
- viewed state persists across tabs/windows/refreshes (px0-level global store)

## 2. Approach
Build on px0 foundation, do not fork UI paradigm:

- Backend stays single Go binary, `gh` CLI stays sole auth source.
  Keep `github.go:84 resolveGitHubToken()` order as-is
  (`settings > GITHUB_TOKEN > GH_TOKEN > gh auth token`) — do not fight it.
- Viewed state lives in `~/.px0/pr-viewed.json` (same philosophy as
  `settings.go:11` — no state inside workspace), keyed by `owner/repo#num`.
  Backend file beats `localStorage` because it is shared across windows/tabs.
- Full-file diff = same renderer, bigger context: `git diff -U100000 base`
  instead of `-U3`. `web/src/diff.js parseDiff()` already handles any context
  size; one giant hunk = full file. No new renderer for POC.
- Checklist UI lives in existing `#pr-bar` (`web/index.html:72`), owned by
  `web/src/pr.js`. Click reuses `tabs.js openFile()` + `diff.js setDiffMode()`.

## 3. In scope
- [x] Branch + this doc
- [ ] Backend: `GET /api/pr/files` (name-status + numstat against `diffBase`)
- [ ] Backend: `GET/POST /api/pr/viewed` + `~/.px0/pr-viewed.json` store
- [ ] Backend: `/api/diff?full=1` via `git diff -U100000`
- [ ] Frontend: checklist drawer, checkboxes, progress, Next/Prev, Full/Hunks toggle
- [ ] Frontend: click-to-open full-file diff + auto-scroll to first change
- [ ] Frontend: Approve warns when files unchecked
- [ ] `go vet` + `go test ./...` (pr-related) green, manual `go run . -dev . <pr-url>` smoke

## 4. Out of scope
- Native VSCode/Cursor extension (after POC proves flow)
- Syncing viewed state to GitHub (`markFileAsViewed` GraphQL)
- New diff renderer / virtualized full-file side-by-side
- Auth flow changes, token UI changes
- Push-fix / agent batch-apply changes (already works)
- LSP / indexing changes

## 5. Progress log
- 2026-09-22: branch `rahul/pr-review-poc` created, POC doc written.
- 2026-09-23: backend `/api/pr/files` implemented (`pr_viewed.go` + routes in `server.go`).
- 2026-09-23: backend `/api/pr/viewed` store implemented (`~/.px0/pr-viewed.json`, shared across tabs/windows).
- 2026-09-23: backend `/api/diff?full=1` implemented (`git.go:gitDiffAgainstContext` with `-U100000`).
- 2026-09-23: frontend checklist + full-file autofocus implemented (`pr.js`, `diff.js`, `index.html`, `style.css`).
- 2026-09-23: verified — `node --check` clean on `pr.js`/`diff.js`, `node scripts/build-web.js` bundles OK (287 KB, no name collisions), Go code hand-reviewed (no Go toolchain on this machine).
- TODO (needs Go): `go vet ./...`, `go test ./...`, smoke `go run . -dev . <pr-url>` with `gh auth login`.
- 2026-09-23: local-only (no-PR) variant briefly prototyped, then reverted — decision: fork px0 to own account and raise the POC as a PR there instead.
