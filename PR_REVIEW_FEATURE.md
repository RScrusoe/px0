# GitHub PR review in px0: feature context

Read this before changing anything PR-related. It covers what the feature is,
how it is built, the invariants you must not break, and where to extend it.
`POC_REVIEW.md` is the historical progress log; this file is the current map.

## 1. What it is

A fast PR review workflow inside px0, laid out like Cursor's GitHub extension:
plain `px0` in any GitHub repo gets a **Pull Requests** view in the left
sidebar. Clicking a PR expands it in place with a checkbox file tree, and
opens a **Description & Review** page in the main area.

- **No clone, no worktree, no branch switch by default.** Opening a PR is a
  *preview*: only `refs/px0/pr/N` (and its base) is fetched, and PR-changed
  files are served straight from git objects. The user's working tree,
  index and branch are untouched.
- **Checkout is explicit.** A Checkout button moves the repo onto a local
  `px0/pr-N` branch at the PR head, which is what unlocks editing, LSP and
  go-to-definition. Return restores the original branch.
- **It is additive.** Nothing changes for normal px0 use until a PR is
  clicked. The legacy `px0 <pr-url>` entry point (temp worktree) still works.

User-facing flow:
1. Click the PR icon in the sidebar header. The list shows the repo's latest
   10 open PRs, taken from `origin`.
2. Click a PR. The row expands immediately and shows:
   - a mode pill (PREVIEW or CHECKED OUT) with Checkout / ↩ Return / ✕
   - the progress bar
   - Description & Review, ←/→ to jump to the previous/next unchecked
     file, and Full/Hunks
   - the file tree, with folded single-child dirs, per-file and per-folder
     checkboxes, and the M/A/D status on the right
3. Click a file to open its diff (the overview page closes). Tick files as
   you review them; ticks persist across reloads.
4. The Description & Review page shows the rendered description, the
   commits, the review box (Comment / Request Changes / Approve) and a
   top-level conversation comment box.
5. Select diff lines, then Alt+R to draft an inline review comment. Drafts
   are submitted in one GitHub review. The Comments panel below the editor
   shows existing threads.

## 2. Architecture

Single Go binary; `web/` is go:embed'd. The frontend is plain ES modules
bundled to `web/app.js`.

### Backend

| File | Role |
|---|---|
| `pr_repo.go` | Repo-PR mode:<br>• `listOpenPRs`<br>• `fetchPRRefs` (batched prefetch)<br>• `previewPR`<br>• `prMergeBase`<br>• `checkout` / `returnToPrevious`<br>• `setActivePR` / `curPR` / `ClosePR`<br>• list-meta cache<br>• `/api/prs/*` handlers |
| `pr.go` | `prSession` (modes, `metaJSON`, `Close`)<br>• legacy worktree `checkoutPR`<br>• the `/api/pr/*` review handlers<br>• `prOrFail` |
| `pr_viewed.go` | `prChangedFiles` (numstat, rev-to-rev in preview)<br>• viewed-state store `~/.px0/pr-viewed.json`<br>• `/api/pr/files`, `/api/pr/viewed` |
| `github.go` / `provider.go` | GitHub REST: meta, details, comments, `submitReview`, push-access check<br>• token resolution<br>• `PRMeta` / `PRTarget` |
| `git.go` | `gitHunks`, `gitDiffRevs(root, rel, base, head, ctx)` for preview diffs |
| `server.go` | Routes<br>• `handleFile` serves `previewFile` in preview (LSP state `"preview"`)<br>• diff/gutter go through `fileDiff`<br>• git push/pull target the PR only when not previewing |

### Session modes (`prSession.mode`)

| Mode | Created by | File contents come from | Diff | Close() does |
|---|---|---|---|---|
| `worktree` | `px0 <pr-url>` (legacy) | temp git worktree | worktree vs merge-base | removes worktree + refs |
| `preview` | `/api/prs/open` | `git show refs/px0/pr/N:path` materialised into `blobDir` (PR-changed files only; everything else is the user's working tree) | rev-to-rev: merge-base → `refs/px0/pr/N` | removes `blobDir` only (refs kept for fast reopen) |
| `checkout` | `/api/prs/checkout` | the user's repo on `px0/pr-N` | working tree vs merge-base | same as preview; the branch stays |

`Server.pr` is runtime-switchable behind `prMu`. Always use `setActivePR`,
`curPR` and `curDiffBase`; never read `s.pr` directly. `setActivePR` sets
the diff base (HEAD in preview, merge-base otherwise), closes the previous
session, and triggers the git watcher.

### API

- **Repo mode:**
  - `GET /api/prs/list` returns `{repo, token, prs, active, error}`.
  - `POST /api/prs/open {number}` returns meta. If a PR is checked out, it
    hops the checkout to the new PR and keeps the original `prevBranch`.
  - `POST /api/prs/close` returns 409 while checked out.
  - `POST /api/prs/checkout` and `POST /api/prs/return` return meta. Both
    return 409 on a dirty tree, and both evict caches and rebuild the index.
- **Active review:**
  - `/api/pr/{meta,details,files,viewed,comments,comments/delete,submit,existing-comments,comments/issue,comments/review-reply,launch}`
  - Every handler starts with `p, ok := s.prOrFail(w)`.

### Frontend

| File | Role |
|---|---|
| `web/src/pr.js` | Everything PR:<br>• `initPR` (always runs)<br>• `enterPR(meta)` / `leavePR()` (no page reloads)<br>• sidebar list: `renderPRList`, `openListedPR`, `pendingNum`, `detailFolded`<br>• details panel: `#pr-bar` moved into the active row via `parkBar()`<br>• file tree: `buildFileTree` / `renderFileTree`, `collapsedDirs`<br>• checklist: `refreshChecklist`, `setViewed` (optimistic + rollback)<br>• overview page: `openPRPage` / `closePRPage`<br>• composers and approve gating |
| `web/src/tree.js` | `setSidebarMode('files' \| 'git' \| 'prs')` |
| `web/src/gitpanel.js` | shows the real branch in preview/checkout; the head label only in legacy worktree mode |
| `web/index.html` | `#prs-panel`; `#pr-bar-home` > `#pr-bar` (the details panel); `#pr-page` (overview) |
| `web/style.css` | `.prs-*`, `.pr-bar`, `.pr-mode-pill.{preview,checkout,worktree}`, `.pr-files-tree`, `.pr-page*` |

### Performance design (keep it)

- **Prefetch.** Listing PRs prefetches every listed head and base in **one**
  `git fetch` (`fetchPRRefs`, guarded by `prFetchMu`, deduped via
  `prFetched[num]==headSHA`).
- **Cached metadata.** The list response is cached as `PRMeta` plus push
  access for `prListTTL` (2 min), so `/api/prs/open` makes **no** network
  calls. Past the TTL it falls back to `FetchPR` and `CheckPushAccess`, run
  in parallel.
- **Optimistic UI.** The row expands on click (`pendingNum`), before the
  server answers.
- **Measured on automation:**
  - Row expands 2 ms after the click.
  - `/api/prs/open` takes ~170 ms (it was ~1 s).
  - The file tree shows ~360 ms after the click.

## 3. Invariants: do not break

- **Auth order is frozen.** `resolveGitHubToken` (github.go) checks the
  `github.token` setting, then `GITHUB_TOKEN`, then `GH_TOKEN`, then
  `gh auth token` (the gh *active* account). Don't change it; don't make it
  per-remote.
- **Preview never mutates the user's repo** except under `refs/px0/*`.
- **Checkout never loses work:**
  - It refuses on a dirty tree (`errDirtyTree`).
  - It only fast-forwards an existing `px0/pr-N`.
  - Return also refuses on a dirty tree.
- **Legacy `px0 <pr-url>` worktree mode must keep working** (`pr_test.go`).
- **Viewed state lives in `~/.px0/pr-viewed.json`**, never in the
  workspace. Save errors must surface (500 + UI rollback).
- **The body carries the class `pr-mode` during a review.** Don't name any
  component class `.pr-mode` (this has already caused a page-wide
  uppercase bug).
- **Park `#pr-bar` before re-rendering `#prs-list`.** It is a live node
  inside `#prs-list`, so `renderPRList` must call `parkBar()` before
  touching `innerHTML`.
- **Reuse the existing markdown pipeline** (the `.md` class,
  `sanitizeHTML`) for any GitHub-authored HTML.
- **No new npm/Go dependencies. Keep diffs minimal.** Comments explain the
  *why* only.

## 4. In scope (done)

- Repo PR list (latest 10 open), no-token empty state with a `gh auth login` hint
- Preview from git objects; explicit Checkout / Return; PR hopping while checked out
- Sidebar details panel with a Cursor-style checkbox tree, progress bar, prev/next unchecked, Full/Hunks
- Viewed-state persistence across reloads
- Description & Review page: description, commits, review verdicts, conversation comment
- Inline draft comments, one-shot review submit, existing threads panel, replies
- Approve gating: the first click warns if any files are unchecked; the second click within 8 s approves
- Near-instant open (prefetch + meta cache + optimistic expand)

## 5. Out of scope (for now)

- Syncing viewed state to GitHub (`markFileAsViewed` GraphQL)
- A per-remote or multi-account token choice (auth order is frozen)
- Non-GitHub providers (the `provider.go` interface exists; nothing else is implemented)
- Fork PRs in preview beyond what `refs/pull/N/head` gives (works; fork push is not supported)
- Merge / close PR buttons, CI checks status, reviewers/labels sidebar
- Showing non-PR files at the PR head in preview (they come from the working tree; checkout for full fidelity)
- PR search/filter, pagination beyond 10, "waiting for my review" groupings

## 6. Good next improvements

The ones that fit the current design:

- **CI checks and review status on list rows.** Fetch check-runs lazily per
  PR, show ✓/✗/● like Cursor.
- **Groups.** "Waiting for my review" and "Created by me" groups, from
  `search/issues?q=is:pr+review-requested:@me`.
- **Stale-head nudge.** On window focus, if the list is older than
  `prListTTL`, refresh it silently; if the active PR's head SHA moved,
  show a "new commits" chip.
- **Split review button.** A single Comment ▾ (Comment / Approve / Request
  changes) button, like GitHub and Cursor.
- **Keyboard shortcuts.** `j`/`k` next/prev file, `x` toggle viewed,
  `Enter` open, while focus is in the tree.
- **Viewed reset on change.** Auto-untick a file when its blob changes on
  a new push: store the blob SHA alongside the viewed flag.
- **Preview fidelity.** Serve *any* path from `refs/px0/pr/N` (not just
  changed files) so go-to-file shows head contents.

## 7. Build, run, verify

```bash
bun scripts/build-web.js            # bundle web/src -> web/app.js (node works too)
go build -o /tmp/px0-test .         # binary with embedded web/
cd ~/SpacedOut/automation && /tmp/px0-test .   # try it on a real repo
```

Checks before committing:
- `go vet ./...`
- `go test -run 'PR|Diff|Git' ./...`
- `node --check` on each edited JS file
- the bundle builds
- A manual smoke test:
  1. list → preview → open a file → tick a box → reload (tick persists)
  2. checkout → hop to another PR → return
  3. approve gate (first click only warns)
  4. exit

Git and remotes for this clone:
- Work on branch `rahul/pr-review-poc`.
- Push **only** to `fork` (`RScrusoe/px0`), PR #1 there. Never push to
  `origin` (`px0-ai/px0`).
- For gh CLI operations on the fork, use
  `GH_TOKEN=$(gh auth token --user RScrusoe) gh ...`.
