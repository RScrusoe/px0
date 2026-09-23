package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// pr_viewed.go — POC: file-by-file PR review state.
//
// Two endpoints, one file:
//   GET  /api/pr/files   -> [{path,status,additions,deletions}] for the PR diffBase
//   GET  /api/pr/viewed  -> {viewed: {path: true}}
//   POST /api/pr/viewed  -> {path, viewed} upserts one entry
//
// Viewed state lives in ~/.px0/pr-viewed.json (XDG-aware, same as settings.go),
// keyed by "owner/repo#number", so every tab/window/process shares it.
// Draft review comments stay in-memory in prSession; only the checkboxes persist.

var viewedMu sync.Mutex

func viewedFilePath() string {
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "px0", "pr-viewed.json")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".px0", "pr-viewed.json")
}

func viewedKey(target PRTarget) string {
	return target.Owner + "/" + target.Repo + "#" + strconv.Itoa(target.Number)
}

func loadViewedFile() map[string]map[string]bool {
	m := map[string]map[string]bool{}
	p := viewedFilePath()
	if p == "" {
		return m
	}
	data, err := os.ReadFile(p)
	if err != nil || len(data) == 0 {
		return m
	}
	_ = json.Unmarshal(data, &m)
	if m == nil {
		m = map[string]map[string]bool{}
	}
	return m
}

func saveViewedFileLocked(m map[string]map[string]bool) error {
	p := viewedFilePath()
	if p == "" {
		return errors.New("no home directory to store viewed state in")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, append(data, '\n'), 0o644)
}

type prFileEntry struct {
	Path      string `json:"path"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

// prChangedFiles lists files changed against base: in root's working tree
// when head is "", otherwise between the base and head revs (preview mode).
// Uses --name-status for the letter and --numstat for counts; binary files
// report "-" counts which parse as 0. Fails quiet -> empty slice (never nil,
// so the client always gets JSON []).
func prChangedFiles(root, base, head string) []prFileEntry {
	revs := []string{base}
	if head != "" {
		revs = append(revs, head)
	}
	diffArgs := func(flags ...string) []string {
		return append(append([]string{"-C", root, "diff"}, flags...), revs...)
	}
	out, err := exec.Command("git", diffArgs("--name-status", "-z")...).Output()
	if err != nil {
		return []prFileEntry{}
	}
	statusOf := map[string]string{}
	parts := strings.Split(string(out), "\x00")
	for i := 0; i < len(parts); i++ {
		st := parts[i]
		if st == "" {
			continue
		}
		code := string(st[0])
		if st[0] == 'R' || st[0] == 'C' {
			i += 2
			if i < len(parts) && parts[i] != "" {
				statusOf[parts[i]] = code
			}
		} else {
			i++
			if i < len(parts) && parts[i] != "" {
				statusOf[parts[i]] = code
			}
		}
	}
	counts := map[string][2]int{}
	// Without -z renames print as "old => new"; numstat is only used for
	// counts, so plain lines keyed by the final path are enough.
	if numOut, err := exec.Command("git", diffArgs("--numstat", "--no-renames")...).Output(); err == nil {
		for _, line := range strings.Split(string(numOut), "\n") {
			f := strings.SplitN(line, "\t", 3)
			if len(f) != 3 {
				continue
			}
			adds, _ := strconv.Atoi(f[0])
			dels, _ := strconv.Atoi(f[1])
			counts[f[2]] = [2]int{adds, dels}
		}
	}
	entries := make([]prFileEntry, 0, len(statusOf))
	for path, st := range statusOf {
		e := prFileEntry{Path: path, Status: st}
		if c, ok := counts[path]; ok {
			e.Additions, e.Deletions = c[0], c[1]
		}
		entries = append(entries, e)
	}
	// Deterministic order for the checklist.
	for i := 1; i < len(entries); i++ {
		for j := i; j > 0 && entries[j].Path < entries[j-1].Path; j-- {
			entries[j], entries[j-1] = entries[j-1], entries[j]
		}
	}
	return entries
}

func (s *Server) handlePRFiles(w http.ResponseWriter, r *http.Request) {
	p, ok := s.prOrFail(w)
	if !ok {
		return
	}
	writeJSON(w, map[string]any{"files": prChangedFiles(s.ix.Root(), p.diffBase, p.previewRev())})
}

// handlePRDetails returns the live PR description (raw + rendered) and commit
// list for the in-app overview page -- the only place hosting comment inputs.
// Always live, never cached: the description may change while reviewing.
func (s *Server) handlePRDetails(w http.ResponseWriter, r *http.Request) {
	p, ok := s.prOrFail(w)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	d, err := p.provider.FetchDetails(ctx, p.target, p.token)
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if d.Commits == nil {
		d.Commits = []PRCommit{}
	}
	writeJSON(w, d)
}

func (s *Server) handlePRViewed(w http.ResponseWriter, r *http.Request) {
	p, ok := s.prOrFail(w)
	if !ok {
		return
	}
	p.mu.Lock()
	key := viewedKey(p.target)
	p.mu.Unlock()

	switch r.Method {
	case http.MethodGet:
		viewedMu.Lock()
		m := loadViewedFile()
		v := m[key]
		if v == nil {
			v = map[string]bool{}
		}
		viewedMu.Unlock()
		writeJSON(w, map[string]any{"viewed": v})
	case http.MethodPost:
		if !localPost(w, r) {
			return
		}
		var body struct {
			Path   string `json:"path"`
			Viewed *bool  `json:"viewed"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil ||
			strings.TrimSpace(body.Path) == "" || body.Viewed == nil {
			fail(w, http.StatusBadRequest, "path and viewed are required")
			return
		}
		path := strings.TrimSpace(body.Path)
		viewedMu.Lock()
		m := loadViewedFile()
		v := m[key]
		if v == nil {
			v = map[string]bool{}
			m[key] = v
		}
		if *body.Viewed {
			v[path] = true
		} else {
			delete(v, path)
		}
		err := saveViewedFileLocked(m)
		viewedMu.Unlock()
		if err != nil {
			fail(w, http.StatusInternalServerError, "could not save viewed state: "+err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	default:
		fail(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
