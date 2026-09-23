package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// pr_repo.go reviews the served repo's own open PRs without leaving the
// workspace: the sidebar lists them, opening one starts a "preview" session
// that only fetches the PR head into refs/px0/pr/N and reads file contents
// straight from git objects (the working tree is never touched), and an
// explicit Checkout switches the repo onto the PR head for editing/LSP.
//
// Modes of a prSession:
//   prModeWorktree -- `px0 <pr-url>`: throwaway temp worktree (pr.go).
//   prModePreview  -- listed PR, nothing checked out; head lives in headRev.
//   prModeCheckout -- listed PR switched onto a local branch in the repo itself.

const (
	prModeWorktree = "worktree"
	prModePreview  = "preview"
	prModeCheckout = "checkout"
)

// remoteRepoPattern matches both scp-style (git@host:owner/repo.git, where
// host may be an ssh alias like github-personal.com) and URL-style remotes.
var remoteRepoPattern = regexp.MustCompile(`github[^/:]*[:/]+([^/]+)/([^/]+?)(?:\.git)?/?$`)

// repoGitHubTarget resolves owner/repo from root's origin remote. ok is false
// for non-GitHub or missing remotes.
func repoGitHubTarget(root string) (owner, repo string, ok bool) {
	out, err := exec.Command("git", "-C", root, "remote", "get-url", "origin").Output()
	if err != nil {
		return "", "", false
	}
	m := remoteRepoPattern.FindStringSubmatch(strings.TrimSpace(string(out)))
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

type prListItem struct {
	Number    int    `json:"number"`
	Title     string `json:"title"`
	Author    string `json:"author"`
	Head      string `json:"head"`
	Base      string `json:"base"`
	Draft     bool   `json:"draft"`
	UpdatedAt string `json:"updatedAt"`
	URL       string `json:"url"`
}

func listOpenPRs(ctx context.Context, owner, repo, token string) ([]prListItem, error) {
	path := fmt.Sprintf("/repos/%s/%s/pulls?state=open&per_page=10&sort=updated&direction=desc", owner, repo)
	resp, err := githubRequest(ctx, http.MethodGet, path, token, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("GitHub %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	var raw []struct {
		Number    int    `json:"number"`
		Title     string `json:"title"`
		Draft     bool   `json:"draft"`
		UpdatedAt string `json:"updated_at"`
		HTMLURL   string `json:"html_url"`
		User      struct {
			Login string `json:"login"`
		} `json:"user"`
		Head struct {
			Ref string `json:"ref"`
		} `json:"head"`
		Base struct {
			Ref string `json:"ref"`
		} `json:"base"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	items := make([]prListItem, 0, len(raw))
	for _, p := range raw {
		items = append(items, prListItem{
			Number: p.Number, Title: p.Title, Author: p.User.Login,
			Head: p.Head.Ref, Base: p.Base.Ref, Draft: p.Draft,
			UpdatedAt: p.UpdatedAt, URL: p.HTMLURL,
		})
	}
	return items, nil
}

// previewPR fetches only the PR head ref into root's object store and
// computes the merge-base with the base branch. Nothing is checked out.
func previewPR(ctx context.Context, root, owner, repo string, num int) (*prSession, error) {
	provider := &GitHubProvider{}
	target := PRTarget{Provider: "github", Owner: owner, Repo: repo, Number: num,
		URL: fmt.Sprintf("https://github.com/%s/%s/pull/%d", owner, repo, num)}
	token, _ := provider.ResolveToken(readSettings())
	meta, err := provider.FetchPR(ctx, target, token)
	if err != nil {
		return nil, err
	}
	headRev := fmt.Sprintf("refs/px0/pr/%d", num)
	if out, err := exec.Command("git", "-C", root, "fetch", "--no-tags", "origin",
		fmt.Sprintf("+refs/pull/%d/head:%s", num, headRev)).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("git fetch PR head: %w: %s", err, strings.TrimSpace(string(out)))
	}
	diffBase, warning := prMergeBase(root, headRev, meta.BaseRef, num)
	blobDir, err := os.MkdirTemp("", "px0-prview-*")
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(blobDir); err == nil {
		blobDir = resolved
	}
	return &prSession{
		provider:        provider,
		target:          target,
		meta:            meta,
		token:           token,
		writeAccess:     provider.CheckPushAccess(ctx, target, token),
		diffBase:        diffBase,
		diffBaseWarning: warning,
		worktree:        root,
		srcRepo:         root,
		mode:            prModePreview,
		headRev:         headRev,
		blobDir:         blobDir,
	}, nil
}

// prMergeBase is computeDiffBase for an arbitrary head rev instead of a
// checked-out HEAD.
func prMergeBase(root, head, baseRef string, num int) (string, string) {
	baseTrack := fmt.Sprintf("refs/px0/base/%d", num)
	fetchOut, fetchErr := exec.Command("git", "-C", root, "fetch", "--no-tags", "origin",
		fmt.Sprintf("+refs/heads/%s:%s", baseRef, baseTrack)).CombinedOutput()
	if fetchErr == nil {
		if mb := gitMergeBase(root, head, baseTrack); mb != "" {
			return mb, ""
		}
	}
	if mb := gitMergeBase(root, head, "origin/"+baseRef); mb != "" {
		return mb, ""
	}
	warning := fmt.Sprintf("could not resolve a merge-base with %s", baseRef)
	if fetchErr != nil {
		warning += " (" + strings.TrimSpace(string(fetchOut)) + ")"
	}
	return head, warning
}

// previewRev is the rev file contents come from, or "" when they come from
// the working tree (checkout / worktree modes).
func (p *prSession) previewRev() string {
	if p == nil || p.mode != prModePreview {
		return ""
	}
	return p.headRev
}

// previewFile materializes rel at the PR head into blobDir so the regular
// file pipeline (Open, chunking, highlighting) can serve it unchanged. ok is
// false when rel isn't part of the PR, so the caller falls back to the
// working tree. A file the PR deletes materializes empty.
func (p *prSession) previewFile(rel string) (abs string, ok bool) {
	rev := p.previewRev()
	if rev == "" || !p.changedPath(rel) {
		return "", false
	}
	abs = filepath.Join(p.blobDir, filepath.FromSlash(rel))
	if _, err := os.Stat(abs); err == nil {
		return abs, true
	}
	content, _ := exec.Command("git", "-C", p.srcRepo, "show", rev+":"+rel).Output()
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", false
	}
	if err := os.WriteFile(abs, content, 0o644); err != nil {
		return "", false
	}
	return abs, true
}

func (p *prSession) changedPath(rel string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.changed == nil {
		p.changed = map[string]bool{}
		for _, f := range prChangedFiles(p.srcRepo, p.diffBase, p.headRev) {
			p.changed[f.Path] = true
		}
	}
	return p.changed[rel]
}

var errDirtyTree = errors.New("commit or stash your local changes first")

// checkout switches the repo onto a local px0/pr-N branch at the PR head,
// remembering the branch to return to.
func (p *prSession) checkout() error {
	root := p.srcRepo
	if gitHasUncommittedChanges(root) {
		return errDirtyTree
	}
	prev := gitCurrentBranch(root)
	if prev == "" || prev == "HEAD" {
		if out, err := exec.Command("git", "-C", root, "rev-parse", "HEAD").Output(); err == nil {
			prev = strings.TrimSpace(string(out))
		}
	}
	branch := p.localBranch()
	var out []byte
	var err error
	if exec.Command("git", "-C", root, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch).Run() == nil {
		out, err = exec.Command("git", "-C", root, "switch", branch).CombinedOutput()
		if err == nil {
			// Fast-forward only: never discard commits made on the branch.
			exec.Command("git", "-C", root, "merge", "--ff-only", p.headRev).Run()
		}
	} else {
		out, err = exec.Command("git", "-C", root, "switch", "-c", branch, p.headRev).CombinedOutput()
	}
	if err != nil {
		return fmt.Errorf("git switch: %w: %s", err, strings.TrimSpace(string(out)))
	}
	p.mu.Lock()
	p.mode = prModeCheckout
	p.prevBranch = prev
	p.mu.Unlock()
	return nil
}

// returnToPrevious switches back to the branch that was current before
// checkout, leaving the session in preview mode.
func (p *prSession) returnToPrevious() error {
	root := p.srcRepo
	if gitHasUncommittedChanges(root) {
		return errDirtyTree
	}
	p.mu.Lock()
	prev := p.prevBranch
	p.mu.Unlock()
	if prev == "" {
		return errors.New("no previous branch recorded")
	}
	args := []string{"-C", root, "switch", prev}
	if exec.Command("git", "-C", root, "rev-parse", "--verify", "--quiet", "refs/heads/"+prev).Run() != nil {
		args = []string{"-C", root, "switch", "--detach", prev}
	}
	if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("git switch: %w: %s", err, strings.TrimSpace(string(out)))
	}
	p.mu.Lock()
	p.mode = prModePreview
	p.prevBranch = ""
	p.mu.Unlock()
	return nil
}

func (p *prSession) localBranch() string { return fmt.Sprintf("px0/pr-%d", p.meta.Number) }

// ---------------------------------------------------------------- HTTP

// setActivePR swaps the session the /api/pr/* endpoints act on and points
// the working-tree diff base at it: the merge-base when the PR's files are
// in the working tree (checkout/worktree), plain HEAD otherwise.
func (s *Server) setActivePR(p *prSession) {
	s.prMu.Lock()
	old := s.pr
	s.pr = p
	base := "HEAD"
	if p != nil && p.previewRev() == "" {
		base = p.diffBase
	}
	s.diffBase = base
	s.prMu.Unlock()
	if old != nil && old != p {
		old.Close()
	}
	if s.ix != nil {
		s.ix.SetDiffBase(base)
	}
	if s.gitWatcher != nil {
		s.gitWatcher.Trigger()
	}
}

func (s *Server) curPR() *prSession {
	s.prMu.RLock()
	defer s.prMu.RUnlock()
	return s.pr
}

func (s *Server) curDiffBase() string {
	s.prMu.RLock()
	defer s.prMu.RUnlock()
	return s.diffBase
}

// ClosePR releases the active session's temp files. Called on shutdown.
func (s *Server) ClosePR() {
	if p := s.curPR(); p != nil {
		p.Close()
	}
}

func (s *Server) handlePRList(w http.ResponseWriter, r *http.Request) {
	resp := map[string]any{"repo": "", "token": false, "prs": []prListItem{}, "active": 0}
	if p := s.curPR(); p != nil {
		resp["active"] = p.meta.Number
	}
	owner, repo, ok := repoGitHubTarget(s.ix.Root())
	if !ok {
		resp["error"] = "origin is not a GitHub remote"
		writeJSON(w, resp)
		return
	}
	resp["repo"] = owner + "/" + repo
	token, _ := (&GitHubProvider{}).ResolveToken(readSettings())
	if token == "" {
		writeJSON(w, resp)
		return
	}
	resp["token"] = true
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	prs, err := listOpenPRs(ctx, owner, repo, token)
	if err != nil {
		resp["error"] = err.Error()
	} else {
		resp["prs"] = prs
	}
	writeJSON(w, resp)
}

func (s *Server) handlePROpen(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	var body struct {
		Number int `json:"number"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || body.Number <= 0 {
		fail(w, http.StatusBadRequest, "number is required")
		return
	}
	// Opening a PR while another is checked out hops the checkout to it, but
	// Return must still land on the branch the user was on before any PR.
	cur := s.curPR()
	hop := cur != nil && cur.mode == prModeCheckout
	if hop && gitHasUncommittedChanges(s.ix.Root()) {
		fail(w, http.StatusConflict, errDirtyTree.Error())
		return
	}
	owner, repo, ok := repoGitHubTarget(s.ix.Root())
	if !ok {
		fail(w, http.StatusBadRequest, "origin is not a GitHub remote")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	p, err := previewPR(ctx, s.ix.Root(), owner, repo, body.Number)
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if hop {
		cur.mu.Lock()
		origin := cur.prevBranch
		cur.mu.Unlock()
		if err := p.checkout(); err != nil {
			p.Close()
			fail(w, http.StatusConflict, err.Error())
			return
		}
		p.mu.Lock()
		p.prevBranch = origin
		p.mu.Unlock()
	}
	s.setActivePR(p)
	if hop {
		EvictAll()
		go s.ix.Build()
	}
	writeJSON(w, p.metaJSON())
}

func (s *Server) handlePRClose(w http.ResponseWriter, r *http.Request) {
	if !localPost(w, r) {
		return
	}
	if p := s.curPR(); p != nil && p.mode == prModeCheckout {
		fail(w, http.StatusConflict, "return to your branch before closing the review")
		return
	}
	s.setActivePR(nil)
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) handlePRCheckout(w http.ResponseWriter, r *http.Request) {
	s.prModeSwitch(w, r, prModePreview, (*prSession).checkout)
}

func (s *Server) handlePRReturn(w http.ResponseWriter, r *http.Request) {
	s.prModeSwitch(w, r, prModeCheckout, (*prSession).returnToPrevious)
}

func (s *Server) prModeSwitch(w http.ResponseWriter, r *http.Request, from string, switchFn func(*prSession) error) {
	if !localPost(w, r) {
		return
	}
	p, ok := s.prOrFail(w)
	if !ok {
		return
	}
	if p.mode != from {
		fail(w, http.StatusConflict, "PR is not in "+from+" mode")
		return
	}
	if err := switchFn(p); err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, errDirtyTree) {
			status = http.StatusConflict
		}
		fail(w, status, err.Error())
		return
	}
	s.setActivePR(p)
	EvictAll()
	go s.ix.Build()
	writeJSON(w, p.metaJSON())
}
