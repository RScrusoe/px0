package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
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

func saveViewedFileLocked(m map[string]map[string]bool) {
	p := viewedFilePath()
	if p == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(p, append(data, '\n'), 0o644)
}

type prFileEntry struct {
	Path      string `json:"path"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

// prChangedFiles lists files changed against base in root's worktree.
// Uses --name-status for the letter and --numstat for counts; binary files
// report "-" counts which parse as 0. Fails quiet -> empty slice (never nil,
// so the client always gets JSON []).
func prChangedFiles(root, base string) []prFileEntry {
	out, err := exec.Command("git", "-C", root, "diff", "--name-status", "-z", base).Output()
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
	if numOut, err := exec.Command("git", "-C", root, "diff", "--numstat", "-z", base).Output(); err == nil {
		nparts := strings.Split(string(numOut), "\x00")
		for i := 0; i+2 < len(nparts); i += 3 {
			adds, _ := strconv.Atoi(nparts[i])
			dels, _ := strconv.Atoi(nparts[i+1])
			if nparts[i+2] != "" {
				counts[nparts[i+2]] = [2]int{adds, dels}
			}
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
	if !s.prOrFail(w) {
		return
	}
	base := s.diffBase
	if base == "" {
		base = "HEAD"
	}
	writeJSON(w, map[string]any{"files": prChangedFiles(s.ix.Root(), base)})
}

func (s *Server) handlePRViewed(w http.ResponseWriter, r *http.Request) {
	if !s.prOrFail(w) {
		return
	}
	p := s.pr
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
		saveViewedFileLocked(m)
		viewedMu.Unlock()
		writeJSON(w, map[string]any{"ok": true})
	default:
		fail(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
