// web/src/pr.js
// GitHub PR review. A review is active when S.meta.pr is set -- either this
// process was launched as `px0 <pr-url>`, or one of the repo's open PRs was
// opened from the sidebar's Pull Requests view (pr_repo.go), in which case it
// starts as a read-only preview and can be checked out explicitly. A bar
// above the tabs shows the PR and its file checklist; the overview page
// (click the title) hosts every review/comment input. Selecting a diff line and
// pressing Alt+R (or the footer/context-menu action) drafts an inline review
// comment. Everything here talks to /api/pr/*; nothing is stored client-side
// beyond what's needed to repaint -- a page refresh re-fetches the server's
// in-memory draft list (pr.go's prSession), which is the only source of truth.
import { $, S, doc_, esc, api, apiPostJson, keyLabel, withKeys } from './state.js';
import { showToast } from './ui.js';
import { setReviewHandler, SEL_MENU_ITEMS } from './selbar.js';
import { diffview, setPRSyncHandler, syncDiffView, isFullDiff, setFullDiff, scrollToFirstChange, setDiffMode, layoutPref } from './diff.js';
import { sanitizeHTML } from './markdown.js';
import { reloadWorkspace } from './agent.js';
import { openFile, reloadOpenTabs } from './tabs.js';
import { layout, render } from './renderer.js';
import { refreshTree, setSidebarMode } from './tree.js';

let meta = null;      // this session's PR info: {number, title, base, head, writeAccess, readOnly}
let comments = [];    // draft comments known to the server
let issueComments = [];   // top-level PR conversation comments, already posted (fetched read-only)
let reviewComments = [];  // inline diff-line comments, already posted (fetched read-only) -- may include replies

const prBar = () => $('#pr-bar');
const list = () => $('#pr-comment-list');

const REVIEW_MENU_ITEM = { sel: 'review-comment', label: 'Add Review Comment', keys: 'Alt+R' };

export function initPR() {
  if (!S.meta) return;
  setReviewHandler(openCommentComposer);
  setPRSyncHandler(onDiffSync);
  injectFooterButton();
  wireBarButtons();
  wireCommentsPanel();
  initChecklist();
  initPRList();
  if (S.meta.pr) enterPR(S.meta.pr);
}

// Starts (or switches to) reviewing a PR without a page reload.
function enterPR(m) {
  meta = m;
  S.meta.pr = m;
  comments = [];
  issueComments = [];
  reviewComments = [];
  prFiles = [];
  viewed = {};
  expandedKeys.clear();
  document.body.classList.add('pr-mode');
  if (!SEL_MENU_ITEMS.includes(REVIEW_MENU_ITEM)) SEL_MENU_ITEMS.push(REVIEW_MENU_ITEM);
  const panel = $('#pr-comments-panel');
  if (panel) panel.hidden = false;
  renderBar();
  renderCommentsPanel();
  refreshComments();
  refreshExistingComments();
  refreshChecklist();
  renderPRList();
  setSidebarMode('prs');
  layout(); render();
}

function leavePR() {
  meta = null;
  if (S.meta) delete S.meta.pr;
  document.body.classList.remove('pr-mode');
  const i = SEL_MENU_ITEMS.indexOf(REVIEW_MENU_ITEM);
  if (i >= 0) SEL_MENU_ITEMS.splice(i, 1);
  closeAllComposers();
  closePRPage();
  for (const id of ['#pr-bar', '#pr-comments-panel']) {
    const el = $(id);
    if (el) el.hidden = true;
  }
  parkBar();
  renderPRList();
  layout(); render();
}

// Re-fetches PR metadata and comments after an external change to the
// checkout -- specifically, the sidebar git panel's Pull fast-forwarding
// onto a new PR head -- so the bar, diff-base warning, and comments reflect
// the new state instead of the one captured at session start.
export async function refreshPRMeta() {
  if (!meta) return;
  try {
    const j = await api('/api/pr/meta');
    meta = { ...meta, ...j };
    renderBar();
  } catch {
    // Best-effort.
  }
  await refreshExistingComments();
  await refreshComments();
}

function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

// Comments already posted on GitHub -- top-level conversation and inline diff
// comments -- fetched live (never cached) so another reviewer's activity
// shows up on the next open of the panel or diff.
async function refreshExistingComments() {
  try {
    const j = await api('/api/pr/existing-comments');
    issueComments = j.issueComments || [];
    reviewComments = j.reviewComments || [];
    renderCommentsPanel();
    renderMarkersForActiveDoc();
  } catch {
    // Best-effort: panel/gutter just stay empty on a transient failure.
  }
}

async function refreshComments() {
  try {
    const j = await api('/api/pr/comments');
    comments = j.comments || [];
    renderBar();
    renderCommentsPanel();
    renderMarkersForActiveDoc();
  } catch {
    // Read-only or a transient error: the bar still shows PR metadata.
  }
}

function renderBar() {
  const b = prBar();
  if (!b || !meta) return;
  b.hidden = false;
  const mb = $('#pr-merged-badge');
  if (mb) mb.hidden = !meta.merged;
  $('#pr-refs').textContent = meta.base + ' ← ' + meta.head;
  $('#pr-draft-count').textContent = comments.length
    ? (comments.length + (comments.length === 1 ? ' draft comment' : ' draft comments'))
    : '';
  const pageDraft = $('#pr-page-draft-count');
  if (pageDraft) pageDraft.textContent = $('#pr-draft-count').textContent;
  const ro = $('#pr-readonly-note');
  if (ro) ro.hidden = !meta.readOnly;
  const dw = $('#pr-diff-warning');
  if (dw) {
    dw.hidden = !meta.diffBaseWarning;
    if (meta.diffBaseWarning) dw.title = meta.diffBaseWarning;
  }
  const batchBtn = $('#pr-batch-apply');
  if (batchBtn) {
    const hasApplicable = comments.some(c => c.path && c.line && c.body?.trim());
    batchBtn.hidden = !hasApplicable;
  }
  const preview = meta.mode === 'preview';
  if (batchBtn && preview) batchBtn.hidden = true;
  const modeEl = $('#pr-mode');
  if (modeEl) {
    modeEl.className = 'pr-mode-pill ' + (meta.mode || 'worktree');
    modeEl.textContent = preview ? 'Preview' : meta.mode === 'checkout' ? 'Checked out' : 'Worktree';
    modeEl.title = preview
      ? 'Read-only preview straight from git objects; your working tree is untouched. Check out to edit or use go-to-definition.'
      : meta.mode === 'checkout'
        ? 'This repo is on branch ' + meta.branch + ' at the PR head: editing, LSP, and go-to-definition work.'
        : 'Checked out in a temporary worktree.';
  }
  const co = $('#pr-checkout');
  if (co) co.hidden = !preview;
  const ret = $('#pr-return');
  if (ret) {
    ret.hidden = meta.mode !== 'checkout';
    const prev = meta.prevBranch || '';
    ret.textContent = '\u21A9 ' + (/^[0-9a-f]{40}$/.test(prev) ? prev.slice(0, 7) : prev);
  }
  const exit = $('#pr-exit');
  if (exit) exit.hidden = !preview;
}

function wireBarButtons() {
  $('#pr-batch-apply')?.addEventListener('click', batchApplyComments);
  $('#pr-checkout')?.addEventListener('click', () => switchPRMode('/api/prs/checkout', 'Checked out'));
  $('#pr-return')?.addEventListener('click', () => switchPRMode('/api/prs/return', 'Back on your branch'));
  $('#pr-exit')?.addEventListener('click', exitListedPR);
  // The title opens the in-app overview page (description, commits, commenting);
  // the href stays as the GitHub URL for middle-click / new-tab.
  $('#pr-link')?.addEventListener('click', e => { e.preventDefault(); openPRPage(); });
  $('#pr-page-close')?.addEventListener('click', closePRPage);
  $('#pr-page-submit-comment')?.addEventListener('click', () => submitReview('COMMENT'));
  $('#pr-page-submit-request-changes')?.addEventListener('click', () => submitReview('REQUEST_CHANGES'));
  $('#pr-page-submit-approve')?.addEventListener('click', () => submitReview('APPROVE'));
  $('#pr-page-issue-send')?.addEventListener('click', sendNewIssueComment);
}

async function sendNewIssueComment() {
  const ta = $('#pr-page-issue-body');
  if (!ta) return;
  const body = ta.value.trim();
  if (!body) return;
  const btn = $('#pr-page-issue-send');
  if (btn) btn.disabled = true;
  try {
    const c = await apiPostJson('/api/pr/comments/issue', { body });
    issueComments.push(c);
    ta.value = '';
    expandedKeys.add('issue:' + c.id);
    renderCommentsPanel();
    showToast('✓', 'Comment posted');
  } catch (e) {
    showToast('!', e.message || 'Could not post comment');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function batchApplyComments() {
  const applicable = comments.filter(c => c.path && c.line && c.body?.trim());
  if (!applicable.length) {
    showToast('!', 'No draft comments with line locations to apply');
    return;
  }
  const btn = $('#pr-batch-apply');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Applying...';
  }
  const edits = applicable.map(c => ({
    path: c.path,
    l1: c.line,
    l2: c.line,
    instruction: c.body.trim(),
  }));
  try {
    const job = await apiPostJson('/api/agent/batch', { edits });
    showToast('⚡', `Batch applying ${edits.length} comments with ${job.harness || 'agent'}...`);
    pollPRBatch(job.id, applicable.length);
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ Batch Apply';
    }
    showToast('!', e.message || 'Could not dispatch batch edit');
  }
}

async function pollPRBatch(id, count) {
  const btn = $('#pr-batch-apply');
  const poll = async () => {
    try {
      const j = await api('/api/agent/job?id=' + id);
      if (j.running) {
        const sec = Math.round((j.ms || 0) / 1000);
        if (btn) btn.textContent = `Applying... (${sec}s)`;
        setTimeout(poll, 600);
        return;
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⚡ Batch Apply';
      }
      if (j.error) {
        showToast('!', `Agent error: ${j.error}`);
        if (j.changed?.length) await reloadWorkspace(null);
        return;
      }
      showToast('✓', `Batch applied ${count} comments!`);
      await reloadWorkspace(null);
      await refreshComments();
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⚡ Batch Apply';
      }
      showToast('!', e.message || 'Batch failed');
    }
  };
  setTimeout(poll, 400);
}

async function submitReview(event) {
  const bodyEl = $('#pr-page-body');
  const body = bodyEl ? bodyEl.value.trim() : '';
  if (event === 'REQUEST_CHANGES' && !body && !comments.length) {
    showToast('!', 'Add a comment or review body before requesting changes');
    return;
  }
  if (event === 'APPROVE') {
    const left = prFiles.filter(f => !viewed[f.path]).length;
    if (left > 0 && Date.now() - approveArmedAt > 8000) {
      approveArmedAt = Date.now();
      showToast('!', left + ' file' + (left === 1 ? '' : 's') + ' unchecked — click Approve again to approve anyway');
      return;
    }
  }
  try {
    await apiPostJson('/api/pr/submit', { event, body });
    comments = [];
    if (bodyEl) bodyEl.value = '';
    closeAllComposers();
    renderBar();
    renderCommentsPanel();
    renderMarkersForActiveDoc();
    showToast('✓', event === 'APPROVE' ? 'Review approved'
      : event === 'REQUEST_CHANGES' ? 'Changes requested'
      : 'Review comment submitted');
  } catch (e) {
    showToast('!', e.message || 'Could not submit review');
  }
}

/* ---------- inline draft comment composer ---------- */

let seq = 0;

export function openCommentComposer(info) {
  if (!meta) return;
  const id = 'prc' + (++seq);
  const box = document.createElement('div');
  box.className = 'agent-box';
  box.dataset.id = id;
  const side = info.side || 'RIGHT';
  const line = side === 'LEFT' ? (info.delL1 || info.l1) : info.l1;
  const lineEnd = side === 'LEFT' ? (info.delL2 || info.l2) : info.l2;
  const ref = info.path + ':' + (line === lineEnd ? line : line + '-' + lineEnd) + (side === 'LEFT' ? ' (base)' : '');
  const modEnter = keyLabel('Mod+Enter');
  box.innerHTML =
    '<div class="agent-head"><span class="sel-chip">Review Comment</span>' +
    '<span class="agent-ref">' + esc(ref) + '</span>' +
    '<span class="grow"></span><button class="agent-close" title="Close (Esc)">✕</button></div>' +
    '<div class="agent-compose">' +
    '<textarea class="agent-input" rows="3" spellcheck="false" autocomplete="off" placeholder="Leave a comment on this line... (' + esc(modEnter) + ' to add)"></textarea>' +
    '<div class="agent-err" hidden></div>' +
    '<div class="agent-foot"><span class="agent-hint">' + esc(modEnter) + ' to add, Esc to cancel</span>' +
    '<button class="agent-send" title="Add comment (' + esc(modEnter) + ')">Add Comment</button></div></div>';

  list().hidden = false;
  list().append(box);
  const ta = box.querySelector('.agent-input');
  ta.focus();

  const close = () => { box.remove(); if (!list().children.length) list().hidden = true; };
  box.querySelector('.agent-close').addEventListener('click', close);

  const send = async () => {
    const body = ta.value.trim();
    if (!body) return;
    const errEl = box.querySelector('.agent-err');
    errEl.hidden = true;
    try {
      const c = await apiPostJson('/api/pr/comments', { path: info.path, line, side, body });
      comments.push(c);
      expandedKeys.add('thread:' + threadKey(info.path, side, line));
      close();
      renderBar();
      renderCommentsPanel();
      renderMarkersForActiveDoc();
    } catch (e) {
      errEl.hidden = false;
      errEl.textContent = e.message || 'Could not add comment';
    }
  };
  box.querySelector('.agent-send').addEventListener('click', send);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  });
}

function closeAllComposers() {
  const l = list();
  if (!l) return;
  l.replaceChildren();
  l.hidden = true;
}

/* ---------- gutter markers on the active diff ---------- */

function renderMarkersForActiveDoc() {
  if (!diffview || diffview.hidden) return;
  if (!meta) {
    for (const el of diffview.querySelectorAll('.pr-comment-mark')) el.remove();
    return;
  }
  const d = doc_();
  if (!d) return;
  const draftsByKey = new Map();
  for (const c of comments) {
    if (c.path !== d.path) continue;
    const key = (c.side || 'RIGHT') + ':' + c.line;
    if (!draftsByKey.has(key)) draftsByKey.set(key, []);
    draftsByKey.get(key).push(c);
  }
  // Existing (already-posted) review comments: replies carry the same
  // path/line/side as their thread root, so grouping by key alone already
  // gathers a whole thread together.
  const existingByKey = new Map();
  for (const c of reviewComments) {
    if (c.path !== d.path) continue;
    const key = (c.side || 'RIGHT') + ':' + c.line;
    if (!existingByKey.has(key)) existingByKey.set(key, []);
    existingByKey.get(key).push(c);
  }
  for (const el of diffview.querySelectorAll('.pr-comment-mark')) el.remove();
  for (const el of diffview.querySelectorAll('[data-l], [data-old-l]')) {
    const isOldOnly = el.dataset.oldL !== undefined && el.dataset.l === undefined;
    const side = isOldOnly ? 'LEFT' : 'RIGHT';
    const line = isOldOnly ? +el.dataset.oldL : +el.dataset.l;
    const key = side + ':' + line;
    const drafts = draftsByKey.get(key);
    const existing = existingByKey.get(key);
    el.classList.toggle('pr-has-comment', !!drafts || !!existing);
    if (!drafts && !existing) continue;
    const badge = document.createElement('span');
    badge.className = 'pr-comment-mark';
    const count = (existing?.length || 0) + (drafts?.length || 0);
    badge.title = 'View ' + count + ' comment' + (count === 1 ? '' : 's');
    badge.textContent = '💬';
    badge.addEventListener('click', e => {
      e.stopPropagation();
      revealThreadInPanel(threadKey(d.path, side, line));
    });
    el.querySelector('.diff-code')?.before(badge);
  }
}

/* ---------- bottom panel: existing comments + drafts, always open ---------- */

function threadKey(path, side, line) { return path + '|' + (side || 'RIGHT') + ':' + line; }

// Which accordion items ("issue:<id>" / "thread:<threadKey>") are expanded.
// Persists across re-renders within the session so replying, adding a draft,
// or a background refresh never silently collapses something you opened.
const expandedKeys = new Set();

function toggleAccordion(item) {
  if (!item) return;
  const key = item.dataset.acc;
  const open = !item.classList.contains('open');
  item.classList.toggle('open', open);
  if (!key) return;
  if (open) expandedKeys.add(key); else expandedKeys.delete(key);
}

function wireCommentsPanel() {
  const panel = $('#pr-comments-panel');

  $('#pr-comments-collapse')?.addEventListener('click', () => {
    panel?.classList.toggle('collapsed');
    layout(); render();
  });

  const rz = $('#pr-comments-resizer');
  if (rz && panel) {
    let dragging = false;
    rz.addEventListener('mousedown', e => {
      dragging = true;
      rz.classList.add('drag');
      panel.classList.remove('collapsed');
      e.preventDefault();
    });
    addEventListener('mousemove', e => {
      if (!dragging) return;
      const bottom = panel.getBoundingClientRect().bottom;
      const h = Math.max(80, Math.min(window.innerHeight * 0.8, bottom - e.clientY));
      panel.style.height = h + 'px';
      layout(); render();
    });
    addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      rz.classList.remove('drag');
      layout(); render();
    });
  }

  $('#pr-comments-list')?.addEventListener('click', e => {
    const replyBtn = e.target.closest('.pr-issue-comment-reply-btn');
    if (replyBtn) {
      openPRPage();
      const ta = $('#pr-page-issue-body');
      if (ta) {
        const prefix = replyBtn.dataset.author ? '@' + replyBtn.dataset.author + ' ' : '';
        if (!ta.value.startsWith(prefix)) ta.value = prefix + ta.value;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
      return;
    }
    const loc = e.target.closest('.pr-comment-loc');
    if (loc) {
      openFile(loc.dataset.path, { line: +loc.dataset.line });
      return;
    }
    const delBtn = e.target.closest('.pr-comment-delete-btn');
    if (delBtn) {
      deleteDraft(+delBtn.dataset.draftId);
      return;
    }
    const sendBtn = e.target.closest('.reply-send');
    if (sendBtn) {
      const row = sendBtn.closest('.pr-comment-reply-row');
      sendThreadReply(row);
      return;
    }
    const head = e.target.closest('.acc-head');
    if (head) toggleAccordion(head.closest('.acc-item'));
  });

  $('#pr-comments-list')?.addEventListener('keydown', e => {
    if (!e.target.closest('.reply-input')) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendThreadReply(e.target.closest('.pr-comment-reply-row'));
    }
  });
}

async function sendThreadReply(row) {
  if (!row) return;
  const ta = row.querySelector('.reply-input');
  const body = ta?.value.trim();
  if (!body) return;
  const commentId = +row.dataset.replyTo;
  const btn = row.querySelector('.reply-send');
  if (btn) btn.disabled = true;
  try {
    const c = await apiPostJson('/api/pr/comments/review-reply', { commentId, body });
    reviewComments.push(c);
    renderCommentsPanel();
    renderMarkersForActiveDoc();
    showToast('✓', 'Reply posted');
  } catch (e) {
    showToast('!', e.message || 'Could not reply');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteDraft(id) {
  try {
    await apiPostJson('/api/pr/comments/delete?id=' + id, {});
    comments = comments.filter(c => c.id !== id);
    renderBar();
    renderCommentsPanel();
    renderMarkersForActiveDoc();
  } catch (e) {
    showToast('!', e.message || 'Could not delete draft');
  }
}

// Expands the panel if collapsed, opens the thread's accordion item, scrolls
// to it, and briefly flashes it -- the gutter badge's click target now lands
// here instead of opening a separate floating box.
function revealThreadInPanel(key) {
  const panel = $('#pr-comments-panel');
  panel?.classList.remove('collapsed');
  layout(); render();
  const el = $('#pr-comments-list')?.querySelector('[data-thread-key="' + CSS.escape(key) + '"]');
  if (!el) return;
  if (!el.classList.contains('open')) toggleAccordion(el);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}

// Every comment/thread is an accordion item: a clickable .acc-head (author,
// time, a one-line ellipsized preview of the body) and an .acc-body that's
// only in the flow when the item carries the 'open' class -- so a scan of
// the panel is just headers until you click one open to read and reply.
function issueCommentCardHtml(c) {
  const key = 'issue:' + c.id;
  const open = expandedKeys.has(key);
  return '<div class="pr-comment-card acc-item' + (open ? ' open' : '') + '" data-acc="' + esc(key) + '">' +
    '<div class="acc-head">' +
      '<span class="acc-chevron">&#8250;</span>' +
      '<span class="pr-issue-comment-author">' + esc(c.author || 'unknown') + '</span>' +
      '<span class="pr-issue-comment-time">' + esc(fmtTime(c.createdAt)) + '</span>' +
      '<span class="acc-preview">' + esc(c.body) + '</span>' +
    '</div>' +
    '<div class="acc-body">' +
      '<div class="pr-issue-comment-body">' + esc(c.body) + '</div>' +
      (meta && !meta.readOnly
        ? '<button class="pr-issue-comment-reply-btn" data-author="' + esc(c.author || '') + '">Reply</button>'
        : '') +
    '</div>' +
  '</div>';
}

function reviewCommentCardHtml(c) {
  return '<div class="pr-comment-card' + (c.inReplyTo ? ' reply' : '') + '">' +
    '<div class="pr-issue-comment-head">' +
      '<span class="pr-issue-comment-author">' + esc(c.author || 'unknown') + '</span>' +
      '<span class="pr-issue-comment-time">' + esc(fmtTime(c.createdAt)) + '</span>' +
    '</div>' +
    '<div class="pr-issue-comment-body">' + esc(c.body) + '</div>' +
  '</div>';
}

function draftCardHtml(c) {
  return '<div class="pr-comment-card draft">' +
    '<div class="pr-issue-comment-head"><span class="pr-issue-comment-author">You (draft, not yet submitted)</span></div>' +
    '<div class="pr-issue-comment-body">' + esc(c.body) + '</div>' +
    '<div class="pr-comment-card-actions">' +
      '<button class="pr-comment-delete-btn" data-draft-id="' + c.id + '">Delete draft</button>' +
    '</div>' +
  '</div>';
}

function threadHtml(path, t, key) {
  const sortedExisting = [...t.existing].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const root = sortedExisting.find(c => !c.inReplyTo) || sortedExisting[0];
  const loc = path + ':' + t.line + (t.side === 'LEFT' ? ' (base)' : '');
  const itemsHtml = sortedExisting.map(reviewCommentCardHtml).join('');
  const draftsHtml = t.drafts.map(draftCardHtml).join('');
  const canReply = root && meta && !meta.readOnly;
  const replyRow = canReply
    ? '<div class="pr-comment-reply-row" data-reply-to="' + root.id + '">' +
      '<textarea class="pr-review-body reply-input" rows="1" spellcheck="false" autocomplete="off" placeholder="Reply..."></textarea>' +
      '<button class="footer-btn reply-send">Reply</button>' +
      '</div>'
    : '';
  const accKey = 'thread:' + key;
  const open = expandedKeys.has(accKey);
  const total = sortedExisting.length + t.drafts.length;
  const countBadge = total > 1 ? '<span class="acc-count">' + total + '</span>' : '';
  const preview = root ? root.body : (t.drafts[0]?.body || '');
  return '<div class="pr-comment-thread acc-item' + (open ? ' open' : '') + '" data-thread-key="' + esc(key) + '" data-acc="' + esc(accKey) + '">' +
    '<div class="acc-head">' +
      '<span class="acc-chevron">&#8250;</span>' +
      '<span class="pr-comment-loc" data-path="' + esc(path) + '" data-line="' + t.line + '">' + esc(loc) + '</span>' +
      '<span class="pr-issue-comment-author">' + esc(root ? (root.author || 'unknown') : 'you') + '</span>' +
      countBadge +
      '<span class="acc-preview">' + esc(preview) + '</span>' +
    '</div>' +
    '<div class="acc-body">' + itemsHtml + draftsHtml + replyRow + '</div>' +
  '</div>';
}

function renderCommentsPanel() {
  const listEl = $('#pr-comments-list');
  const countEl = $('#pr-comments-count');
  if (!listEl) return;

  // Group existing review comments and local drafts by path, then by
  // side:line -- a reply carries the same path/line/side as its thread
  // root, so grouping by that key alone already gathers a whole thread.
  const byPath = new Map();
  const threadFor = (path, side, line) => {
    if (!byPath.has(path)) byPath.set(path, new Map());
    const m = byPath.get(path);
    const key = threadKey(path, side, line);
    if (!m.has(key)) m.set(key, { existing: [], drafts: [], side, line });
    return m.get(key);
  };
  for (const c of reviewComments) {
    if (!c.path) continue;
    threadFor(c.path, c.side || 'RIGHT', c.line).existing.push(c);
  }
  for (const c of comments) {
    if (!c.path) continue;
    threadFor(c.path, c.side || 'RIGHT', c.line).drafts.push(c);
  }

  const totalReview = reviewComments.length + comments.length;
  let html = '<div class="pr-comments-section-title">Conversation' +
    (issueComments.length ? ' (' + issueComments.length + ')' : '') + '</div>';
  html += issueComments.length
    ? [...issueComments].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')).map(issueCommentCardHtml).join('')
    : '<div class="pr-comments-empty">No top-level comments yet.</div>';

  html += '<div class="pr-comments-section-title">Review comments' +
    (totalReview ? ' (' + totalReview + ')' : '') + '</div>';
  if (byPath.size === 0) {
    html += '<div class="pr-comments-empty">No inline comments yet.</div>';
  } else {
    const entries = [];
    for (const [path, threads] of byPath) {
      for (const [key, t] of threads) entries.push([path, key, t]);
    }
    entries.sort((a, b) => a[0].localeCompare(b[0]) || a[2].line - b[2].line);
    html += entries.map(([path, key, t]) => threadHtml(path, t, key)).join('');
  }

  listEl.innerHTML = html;
  if (countEl) {
    const n = issueComments.length + totalReview;
    countEl.textContent = n ? String(n) : '';
  }
}

/* ---------- launching another PR from a running session ---------- */

// Called from palette.js's "Git: Open Pull Request..." command. Fire and
// forget: the server re-execs a brand new px0 process (pr.go's
// handleLaunchPR), which opens its own browser tab the same way any px0
// invocation does. A failed checkout only ever shows in that child's own
// terminal, not here -- see docs/internals/github-pr-review.md.
export async function launchPR(target) {
  try {
    await apiPostJson('/api/pr/launch', { target });
    showToast('✓', 'Opening PR in a new tab…');
  } catch (e) {
    showToast('!', e.message || 'Could not launch PR review');
  }
}

let approveArmedAt = 0;
let prFiles = [];   // [{path,status,additions,deletions}]
let viewed = {};    // {path: true}

/* ---------- file-by-file checklist (POC) ---------- */

function initChecklist() {
  renderFullToggle();
  $('#pr-files-prev')?.addEventListener('click', () => stepFile(-1));
  $('#pr-files-next')?.addEventListener('click', () => stepFile(1));
  $('#pr-diff-full')?.addEventListener('click', () => {
    setFullDiff(!isFullDiff());
    renderFullToggle();
    syncDiffView(true);
  });
  $('#pr-files-list')?.addEventListener('click', e => {
    const cb = e.target.closest('input[data-pr-file]');
    if (cb) {
      setViewed(cb.dataset.prFile, cb.checked);
      return;
    }
    const dirCb = e.target.closest('input[data-pr-dir]');
    if (dirCb) {
      setDirViewed(dirCb.dataset.prDir, dirCb.checked);
      return;
    }
    const dir = e.target.closest('[data-pr-dir-toggle]');
    if (dir) {
      const key = dir.dataset.prDirToggle;
      if (collapsedDirs.has(key)) collapsedDirs.delete(key); else collapsedDirs.add(key);
      renderChecklist();
      return;
    }
    const row = e.target.closest('[data-pr-open]');
    if (row) openChecklistFile(row.dataset.prOpen);
  });
  refreshChecklist();
}

function renderFullToggle() {
  const b = $('#pr-diff-full');
  if (b) b.textContent = isFullDiff() ? 'Full' : 'Hunks';
}

async function refreshChecklist() {
  try {
    const [fj, vj] = await Promise.all([api('/api/pr/files'), api('/api/pr/viewed')]);
    prFiles = fj.files || [];
    viewed = vj.viewed || {};
  } catch {
    prFiles = [];
  }
  renderChecklist();
}

function renderChecklist() {
  const listEl = $('#pr-files-list');
  const progEl = $('#pr-files-progress');
  const hintEl = $('#pr-files-hint');
  const done = prFiles.filter(f => viewed[f.path]).length;
  if (progEl) progEl.textContent = done + '/' + prFiles.length;
  const fill = $('#pr-files-bar-fill');
  if (fill) fill.style.width = (prFiles.length ? Math.round(100 * done / prFiles.length) : 0) + '%';
  renderActiveFileHighlight();
  if (hintEl) hintEl.textContent = prFiles.length ? (done === prFiles.length ? 'all reviewed' : (prFiles.length - done) + ' left') : '';
  if (!listEl) return;
  if (!prFiles.length) {
    listEl.innerHTML = '<div class="pr-comments-empty">No changed files.</div>';
    return;
  }
  listEl.innerHTML = renderFileTree(buildFileTree(prFiles), 0);
}

const collapsedDirs = new Set();  // dir paths folded in the files tree

// Nests changed files by directory and folds single-child directory chains
// into one row ("main/java/com/..."), like Cursor's PR tree.
function buildFileTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ ...f, name: parts[parts.length - 1] });
  }
  const fold = (node, prefix) => [...node.dirs].map(([name, child]) => {
    let label = name;
    let path = prefix + name;
    while (child.dirs.size === 1 && !child.files.length) {
      const [n, c] = [...child.dirs][0];
      label += '/' + n;
      path += '/' + n;
      child = c;
    }
    return { label, path, dirs: fold(child, path + '/'), files: child.files };
  });
  return { label: '', path: '', dirs: fold(root, ''), files: root.files };
}

function dirFiles(dir) {
  return dir.files.concat(...dir.dirs.map(dirFiles));
}

function renderFileTree(dir, depth) {
  const active = doc_()?.path;
  const pad = d => ' style="padding-left:' + (4 + d * 12) + 'px"';
  let html = '';
  for (const sub of dir.dirs) {
    const all = dirFiles(sub);
    const done = all.filter(f => viewed[f.path]).length;
    const folded = collapsedDirs.has(sub.path);
    html += '<div class="pr-dir-row" data-pr-dir-toggle="' + esc(sub.path) + '"' + pad(depth) + '>' +
      '<span class="pr-chev">' + (folded ? '\u203A' : '\u2304') + '</span>' +
      '<input type="checkbox" data-pr-dir="' + esc(sub.path) + '"' + (done === all.length ? ' checked' : '') + '>' +
      '<span class="pr-dir-name" title="' + esc(sub.path) + '">' + esc(sub.label) + '</span></div>';
    if (!folded) html += renderFileTree(sub, depth + 1);
  }
  for (const f of dir.files) {
    const v = !!viewed[f.path];
    const st = f.status || 'M';
    html += '<div class="pr-file-row' + (v ? ' done' : '') + (f.path === active ? ' current' : '') + '" data-pr-open="' + esc(f.path) + '"' + pad(depth) + ' title="' + esc(f.path) + '">' +
      '<span class="pr-chev"></span>' +
      '<input type="checkbox" data-pr-file="' + esc(f.path) + '"' + (v ? ' checked' : '') + '>' +
      '<span class="pr-file-name">' + esc(f.name) + '</span>' +
      '<span class="pr-file-status pr-st-' + esc(st) + '">' + esc(st) + '</span></div>';
  }
  return html;
}

async function setDirViewed(dirPath, on) {
  const paths = prFiles.map(f => f.path).filter(p => p.startsWith(dirPath + '/') && !!viewed[p] !== on);
  await Promise.all(paths.map(p => setViewed(p, on)));
}

function renderActiveFileHighlight() {
  const active = doc_()?.path;
  for (const row of document.querySelectorAll('#pr-files-list .pr-file-row')) {
    row.classList.toggle('current', row.dataset.prOpen === active);
  }
}

function onDiffSync() {
  renderMarkersForActiveDoc();
  if (meta) renderActiveFileHighlight();
}

async function setViewed(path, on) {
  if (on) viewed[path] = true; else delete viewed[path];
  renderChecklist();
  try {
    await apiPostJson('/api/pr/viewed', { path, viewed: on });
  } catch (e) {
    if (on) delete viewed[path]; else viewed[path] = true;
    renderChecklist();
    showToast('!', e.message || 'Could not save viewed state');
  }
}

function stepFile(dir) {
  if (!prFiles.length) return;
  const cur = prFiles.findIndex(f => f.path === doc_()?.path);
  for (let i = 1; i <= prFiles.length; i++) {
    const idx = (((cur < 0 ? (dir > 0 ? -1 : 0) : cur) + dir * i) % prFiles.length + prFiles.length) % prFiles.length;
    if (!viewed[prFiles[idx].path]) {
      openChecklistFile(prFiles[idx].path);
      return;
    }
  }
  openChecklistFile(prFiles[(cur + dir + prFiles.length) % prFiles.length].path);
}

async function openChecklistFile(path) {
  closePRPage();
  await openFile(path);
  const d = doc_();
  if (d && d.diffAvailable && !d.diffMode) setDiffMode(layoutPref() || 'split');
  if (d) {
    d.scrollFirstChange = true;
    if (!scrollToFirstChange()) {
      const t0 = Date.now();
      const poll = () => {
        if (scrollToFirstChange() || Date.now() - t0 > 3000) return;
        setTimeout(poll, 150);
      };
      setTimeout(poll, 150);
    }
  }
}

/* ---------- PR overview page (title opens this; only comment inputs live here) ---------- */

async function openPRPage() {
  const page = $('#pr-page');
  if (!page || !meta) return;
  page.hidden = false;
  $('#pr-page-badge').textContent = '#' + meta.number;
  $('#pr-page-title').textContent = meta.title;
  $('#pr-page-refs').textContent = meta.base + ' ← ' + meta.head;
  const gh = $('#pr-page-github');
  if (gh) gh.href = meta.url || '#';
  const reqBtn = $('#pr-page-submit-request-changes');
  const appBtn = $('#pr-page-submit-approve');
  if (reqBtn) reqBtn.hidden = !meta.writeAccess;
  if (appBtn) appBtn.hidden = !meta.writeAccess;
  const cmtBtn = $('#pr-page-submit-comment');
  if (cmtBtn) cmtBtn.disabled = meta.readOnly;
  const issueBtn = $('#pr-page-issue-send');
  if (issueBtn) issueBtn.disabled = meta.readOnly;
  const desc = $('#pr-page-desc');
  const commitsEl = $('#pr-page-commits');
  if (desc) desc.innerHTML = '<div class="pr-comments-empty">Loading…</div>';
  if (commitsEl) commitsEl.innerHTML = '';
  try {
    const d = await api('/api/pr/details');
    if (desc) {
      desc.replaceChildren();
      if (d.bodyHtml) desc.append(sanitizeHTML(d.bodyHtml));
      else desc.innerHTML = '<div class="pr-comments-empty">No description.</div>';
    }
    const commits = d.commits || [];
    const countEl = $('#pr-page-commits-count');
    if (countEl) countEl.textContent = commits.length ? '(' + commits.length + ')' : '';
    if (commitsEl) {
      commitsEl.innerHTML = commits.length
        ? commits.map(c => '<div class="pr-page-commit"><span class="pr-page-sha">' + esc((c.sha || '').slice(0, 7)) + '</span>' +
          '<span class="pr-page-msg">' + esc((c.message || '').split('\n')[0]) + '</span>' +
          '<span class="pr-page-meta">' + esc(c.author || '') + (c.date ? ' · ' + esc(fmtTime(c.date)) : '') + '</span></div>').join('')
        : '<div class="pr-comments-empty">No commits.</div>';
    }
  } catch (e) {
    if (desc) desc.innerHTML = '<div class="pr-comments-empty">Could not load PR details.</div>';
  }
}

function closePRPage() {
  const page = $('#pr-page');
  if (page) page.hidden = true;
}

function injectFooterButton() {
  const sel = $('#footer-sel');
  if (!sel || sel.querySelector('[data-sel="review-comment"]')) return;
  const btn = document.createElement('button');
  btn.className = 'footer-btn';
  btn.dataset.sel = 'review-comment';
  btn.title = withKeys('Add a review comment on this selection ({Alt+R})');
  btn.innerHTML = '<span class="footer-btn-label">Comment</span><kbd class="footer-kbd">' + esc(keyLabel('Alt+R')) + '</kbd>';
  sel.append(btn);
}

// ---- Pull Requests sidebar: this repo's open PRs, previewed without checkout ----

let prList = null;  // last /api/prs/list payload

function initPRList() {
  $('#btn-prs')?.addEventListener('click', () => setSidebarMode('prs'));
  $('#prs-refresh')?.addEventListener('click', loadPRList);
  $('#prs-list')?.addEventListener('click', e => {
    const head = e.target.closest('.prs-row-head');
    if (!head) return;
    const number = +head.parentElement.dataset.prNumber;
    if (meta?.number === number) {
      detailFolded = !detailFolded;
      renderPRList();
      return;
    }
    openListedPR(number);
  });
  loadPRList();
}

async function loadPRList() {
  const listEl = $('#prs-list');
  if (!listEl) return;
  if (!prList) listEl.innerHTML = '<div class="prs-empty">Loading pull requests…</div>';
  try {
    prList = await api('/api/prs/list');
  } catch (e) {
    prList = { error: e.message || 'Could not load pull requests', prs: [] };
  }
  renderPRList();
}

function renderPRList() {
  const listEl = $('#prs-list');
  if (!listEl || !prList) return;
  const repoEl = $('#prs-repo');
  if (repoEl) repoEl.textContent = prList.repo || 'Pull Requests';
  const activeNum = pendingNum || meta?.number || 0;
  if (!prList.repo && !meta) {
    listEl.innerHTML = '<div class="prs-empty">No GitHub <code>origin</code> remote in this repo.</div>';
    return;
  }
  if (!prList.token && !meta) {
    listEl.innerHTML = '<div class="prs-empty">Sign in to GitHub to see open pull requests.<pre>gh auth login</pre></div>';
    return;
  }
  if (prList.error && !meta) {
    listEl.innerHTML = '<div class="prs-empty">' + esc(prList.error) + '</div>';
    return;
  }
  const prs = (prList.prs || []).slice();
  if (meta && !prs.some(p => p.number === meta.number)) {
    prs.unshift({ number: meta.number, title: meta.title, author: meta.author, head: meta.head });
  }
  if (!prs.length) {
    listEl.innerHTML = '<div class="prs-empty">No open pull requests.</div>';
    return;
  }
  parkBar();
  listEl.innerHTML = prs.map(pr => {
    const isActive = pr.number === activeNum;
    return '<div class="prs-row' + (isActive ? ' active' : '') + (isActive && detailFolded ? ' folded' : '') + '" data-pr-number="' + pr.number + '">' +
      '<div class="prs-row-head" title="' + esc(pr.title) + '">' +
        '<div class="prs-row-title"><span class="pr-chev">' + (isActive && !detailFolded ? '\u2304' : '\u203A') + '</span>' +
          '<span class="prs-num">#' + pr.number + '</span>' +
          '<span class="prs-title">' + esc(pr.title) + '</span>' +
          (pr.draft ? '<span class="prs-draft">Draft</span>' : '') + '</div>' +
        '<div class="prs-row-meta"><span>' + esc(pr.author || '') + '</span><span class="prs-branch">' + esc(pr.head || '') + '</span></div>' +
      '</div>' +
      (isActive ? '<div class="prs-detail">' + (pendingNum ? '<div class="prs-empty">Loading…</div>' : '') + '</div>' : '') +
    '</div>';
  }).join('');
  const detail = listEl.querySelector('.prs-detail');
  if (detail && meta && !pendingNum) detail.appendChild(prBar());
}

let detailFolded = false;
let pendingNum = 0;  // PR being opened: its row expands before the server answers

// The PR details node is moved into the active list row; before the list is
// re-rendered it goes back to its parking spot so innerHTML can't destroy it.
function parkBar() {
  const b = prBar();
  const home = $('#pr-bar-home');
  if (b && home && b.parentElement !== home) home.appendChild(b);
}

async function openListedPR(number) {
  if (meta?.number === number) return;
  pendingNum = number;
  detailFolded = false;
  renderPRList();
  try {
    const m = await apiPostJson('/api/prs/open', { number });
    pendingNum = 0;
    enterPR(m);
    if (m.mode === 'checkout') await refreshTree();
    await reloadOpenTabs();
    openPRPage();
  } catch (e) {
    pendingNum = 0;
    renderPRList();
    showToast('!', e.message || 'Could not open PR');
  }
}

async function exitListedPR() {
  try {
    await apiPostJson('/api/prs/close', {});
    leavePR();
    await reloadOpenTabs();
  } catch (e) {
    showToast('!', e.message || 'Could not close PR');
  }
}

async function switchPRMode(url, doneMsg) {
  const btns = ['#pr-checkout', '#pr-return'].map(id => $(id)).filter(Boolean);
  btns.forEach(b => { b.disabled = true; });
  try {
    const m = await apiPostJson(url, {});
    meta = m;
    S.meta.pr = m;
    renderBar();
    await refreshTree();
    await reloadOpenTabs();
    await refreshChecklist();
    showToast('\u2713', doneMsg + (m.mode === 'checkout' ? ' ' + m.branch : ''));
  } catch (e) {
    showToast('!', e.message || 'Could not switch');
  } finally {
    btns.forEach(b => { b.disabled = false; });
  }
}
