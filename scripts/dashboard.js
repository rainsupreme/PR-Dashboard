(function() {
  const btn = document.getElementById("theme-toggle");
  const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

  function getEffective(pref) {
    if (pref === "light" || pref === "dark") return pref;
    return systemDark() ? "dark" : "light";
  }

  function apply() {
    const pref = localStorage.getItem("theme") || "system";
    document.documentElement.setAttribute("data-theme", getEffective(pref));
    if (pref === "light") btn.textContent = "☀ Light";
    else if (pref === "dark") btn.textContent = "☾ Dark";
    else btn.textContent = "◐ System";
  }
  apply();

  btn.addEventListener("click", () => {
    const pref = localStorage.getItem("theme") || "system";
    const next = pref === "system" ? "light" : pref === "light" ? "dark" : "system";
    if (next === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", next);
    apply();
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    apply();
  });
})();

const cards = document.querySelectorAll(".stat-card");
cards.forEach(card => {
  card.addEventListener("click", () => {
    const tab = card.dataset.tab;
    cards.forEach(c => c.classList.remove("active"));
    card.classList.add("active");
    document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
    document.getElementById(`tab-${tab}`).classList.add("active");
  });
});

// Utility functions loaded from scripts/utils.js (included before this file).
// escapeHtml needs DOM, so it stays here.
function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

// Earlier versions kept manual tab moves under this key; the reset button
// still clears it so a stale entry cannot linger.
const LEGACY_OVERRIDES_KEY = "dashboard-overrides";
let DASHBOARD_USER = "";
let DASHBOARD_MERGE_LABELS = ["to-be-merged"];
// Orgs / repos where the dashboard user can merge (config.json merge_access).
// Turns "ready to merge" from "nudge a committer" into the user's own move.
let DASHBOARD_MERGE_ACCESS = [];

function triageOpts(type) {
  return { mergeLabels: DASHBOARD_MERGE_LABELS, type, mergeAccess: DASHBOARD_MERGE_ACCESS };
}

// Hover text for the whose-move chip: one sentence saying who owes what.
function moveTitle(move) {
  switch (move.owner) {
    case "me": return "Your move";
    case "nobody": return "No human reviewer has engaged yet";
    case "committer": return "Approved on the current head, green and mergeable — needs someone who can merge";
    case "them": return "Someone else's move";
    case "queued": return "Queued for merge by a maintainer";
    default: return "Nothing for you to do here";
  }
}

// Pick readable text color (black/white) for a GitHub label's hex background.
function labelTextColor(hex) {
  if (!/^[0-9a-fA-F]{6}$/.test(hex || "")) return "var(--color-fg-default)";
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // Perceived luminance (ITU-R BT.601)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#1f2328" : "#ffffff";
}
// Local marks per URL: { read_at, pinned_at }. read_at is a statement about
// the past (new activity after it shows as new again); pinned_at is a promise
// to act (cleared only by your own action on the item, or the item closing).
const READ_MARKERS_KEY = "dashboard-read-markers";
function getReadMarkers() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(READ_MARKERS_KEY)) || {}; } catch { raw = {}; }
  const m = {};
  Object.keys(raw).forEach(url => { const v = normalizeMarker(raw[url]); if (Object.keys(v).length) m[url] = v; });
  return m;
}
function saveReadMarkers(m) { localStorage.setItem(READ_MARKERS_KEY, JSON.stringify(m)); }
function updateMarker(url, patch) {
  const m = getReadMarkers();
  const cur = { ...(m[url] || {}), ...patch };
  Object.keys(cur).forEach(k => { if (!cur[k]) delete cur[k]; });
  if (Object.keys(cur).length) m[url] = cur; else delete m[url];
  saveReadMarkers(m);
}
function setReadMarker(url) { updateMarker(url, { read_at: new Date().toISOString() }); }
function clearReadMarker(url) { updateMarker(url, { read_at: "" }); }
function setPin(url, on) { updateMarker(url, { pinned_at: on ? new Date().toISOString() : "" }); }
function isPinnedUrl(url) { return !!(getReadMarkers()[url] || {}).pinned_at; }
function getUnreadActivity(pr, githubUser) {
  if (!pr.activity || pr.activity.length === 0) return [];
  const markers = getReadMarkers();
  let since;
  if (markers[pr.url] && markers[pr.url].read_at) {
    since = markers[pr.url].read_at;
  } else if (pr.unread_anchor) {
    // Mentions: the fetch already decided where "new" starts (the mention, or your reply to it)
    since = pr.unread_anchor;
  } else if (githubUser && pr.author !== githubUser) {
    // Others' PRs: anchor to my last interaction, or PR creation if never interacted
    since = pr.my_last_interaction || pr.created;
  } else {
    // My PRs: anchor to last push
    since = pr.last_push || pr.created;
  }
  return filterUnreadActivity(pr.activity, since);
}

function renderActivityItem(item, isUnread) {
  const typeClass = `activity-type-${item.type}`;
  const label = item.type === "review" ? (item.state || "review").toLowerCase() : item.type;
  const bodyText = (item.body && item.body.trim())
    ? `${escapeHtml(item.author)}: ${escapeHtml(item.body)}`
    : `${escapeHtml(item.author)}`;
  return `<div class="activity-item${isUnread ? " unread" : ""}">
    <img class="activity-avatar" src="${escapeAttr(item.avatar)}" alt="" loading="lazy">
    <span class="activity-type ${typeClass}">${label}</span>
    <span class="activity-body">${bodyText}</span>
    <span class="activity-time">${timeAgo(item.created_at)}</span>
  </div>`;
}

// Shared activity/unread block for PRs and issues. Issues have only comments
// (no commits), so the lastCommit branch is simply skipped for them.
function buildActivity(item, type) {
  const hasActivity = item.activity && item.activity.length > 0 && type !== "closed";
  if (!hasActivity) return { hasActivity: false, hasUnread: false, unreadBadge: "", activitySection: "", toggleBtn: "" };

  const actId = `activity-${item.repo}-${item.number}`;
  const lastCommit = item.activity.find(a => a.type === "commit");
  const since = item.last_push || (lastCommit ? lastCommit.created_at : item.created);
  const afterPush = item.activity.filter(a => a.type !== "commit" && a.created_at > since);

  const unread = getUnreadActivity(item, DASHBOARD_USER).filter(a => a.type !== "commit");
  const hasUnread = unread.length > 0;
  const unreadBadge = hasUnread ? `<span class="pr-badge badge-unread">${unread.length} new</span>` : "";

  const visibleItems = [];
  if (lastCommit) visibleItems.push(lastCommit);
  afterPush.forEach(a => visibleItems.push(a));
  const displayItems = visibleItems.length > 1 ? visibleItems.slice(0, 10) : item.activity.slice(0, 5);

  let activitySection = "";
  if (displayItems.length > 0) {
    const items = displayItems.map(a =>
      renderActivityItem(a, unread.some(u => u.created_at === a.created_at))
    ).join("");
    activitySection = `
        <div class="activity-section" id="${actId}">
          ${items}
          <button class="mark-read-btn" data-url="${escapeAttr(item.url)}" data-target="${actId}">✓ Mark read</button>
        </div>`;
  }
  const toggleBtn = `<button class="activity-toggle" data-target="${actId}">▸ activity</button>`;
  return { hasActivity: true, hasUnread, unreadBadge, activitySection, toggleBtn };
}

// The row's manual controls, stacked on the right edge: the tab move button
// (passed in by the tab that renders the row), read/unread, and pin.
function rowRail(item, hasActivity) {
  const url = escapeAttr(item.url);
  const marker = getReadMarkers()[item.url] || {};
  const pinned = !!marker.pinned_at;
  const readBtn = !hasActivity ? ""
    : marker.read_at
      ? `<button class="rail-btn" data-url="${url}" data-action="mark-unread" title="Mark unread">↩</button>`
      : `<button class="rail-btn" data-url="${url}" data-action="mark-read" title="Mark read (new activity will show again)">✓</button>`;
  const pinBtn = pinned
    ? `<button class="rail-btn on" data-url="${url}" data-action="unpin" title="Pinned: stays bright until you act on it. Click to unpin.">⚑</button>`
    : `<button class="rail-btn" data-url="${url}" data-action="pin" title="Pin: keep bright until you act on it">⚑</button>`;
  return `<div class="row-rail">${readBtn}${pinBtn}</div>`;
}

function renderPR(pr, type) {
  let badge = "";
  if (type === "closed") {
    badge = pr.merged
      ? `<span class="pr-badge badge-merged">✔ Merged</span>`
      : `<span class="pr-badge badge-closed">✖ Closed</span>`;
  } else if (pr.draft) {
    badge = `<span class="pr-badge badge-draft">✏ Draft</span>`;
  }
  // How long a first request has waited on me. Only while it is still my
  // first look: once I have reviewed, or while the author owes something, the
  // age says nothing about me.
  // Merger rows carry a precomputed reason from the fetch instead of whoseMove.
  const move = type === "merger"
    ? (pr.merger_reason ? { owner: "me", action: pr.merger_reason, who: [], score: 0, actionable: true } : null)
    : type !== "closed" ? whoseMove(pr, triageOpts(type)) : null;
  const age = (type === "reviewing" && move && move.action === "review") ? daysOld(pr.created) : 0;
  const staleBadge = age > 7 ? `<span class="pr-badge badge-stale">${age}d waiting</span>` : "";
  const dateLabel = type === "closed" ? `closed ${timeAgo(pr.closed)}` : type === "merger" ? `opened ${timeAgo(pr.created)} · updated ${timeAgo(pr.updated)}` : `updated ${timeAgo(pr.updated)}`;
  const authorLine = (type === "reviewing" || type === "merger") ? `<span>@${escapeHtml(pr.author)}</span>` : "";

  const { hasActivity, hasUnread, unreadBadge, activitySection, toggleBtn } = buildActivity(pr, type);

  // CI status dots (one per job, only for unmerged PRs). Failures first so that
  // if the rail clips under space pressure, the important ones stay visible.
  let ciDots = "";
  if (pr.ci_jobs && pr.ci_jobs.length > 0 && type !== "closed") {
    const rank = { failure: 0, cancelled: 1, action_required: 2, pending: 3, success: 4 };
    const sorted = [...pr.ci_jobs].sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4));
    ciDots = sorted.map(job => {
      const cls = `ci-dot ci-${job.status}`;
      const link = job.url ? ` href="${escapeAttr(job.url)}" target="_blank" rel="noopener"` : "";
      return `<a class="${cls}"${link} title="${escapeAttr(job.name)}"></a>`;
    }).join("");
  }

  // Whose-move chip: the one chip that says what, if anything, this row wants
  // from you. Followed by the specific state chips that explain it.
  let moveChip = "";
  let signalBadges = "";
  if (move && move.action && move.action !== "draft") { // the Draft badge already says it
    let text = escapeHtml(move.action);
    if (move.owner === "them" && move.who.length > 0) {
      const names = move.who.map(w => w.startsWith("team:") ? w.slice(5) : `@${w}`).join(", ");
      const since = daysOld(pr.last_push || pr.created);
      text = `${text} ${escapeHtml(names)}${since > 0 ? ` · ${since}d` : ""}`;
    }
    const prefix = move.owner === "me" ? "→ " : move.owner === "nobody" ? "? " : "";
    moveChip = `<span class="pr-badge badge-move badge-move-${move.owner}" title="${escapeAttr(moveTitle(move))}">${prefix}${text}</span>`;
  }
  if (type !== "closed") {
    const parts = [];
    if (isClearToLand(pr)) {
      parts.push(`<span class="pr-badge badge-ready">✓ approved · green · mergeable</span>`);
    } else {
      if ((pr.approvals_current || 0) > 0) parts.push(`<span class="pr-badge badge-approved">✓ approved</span>`);
      else if ((pr.approvals_stale || 0) > 0) parts.push(`<span class="pr-badge badge-approved" title="Approval predates the current head">✓ approved (older head)</span>`);
      if ((pr.changes_requested || 0) > 0) parts.push(`<span class="pr-badge badge-changes">✗ changes requested</span>`);
      // Green is already conveyed by the CI dots — only chip CI when it's not.
      const ci = ciState(pr);
      if (ci === "failure") parts.push(`<span class="pr-badge badge-ci-fail">✗ CI failing</span>`);
      else if (ci === "cancelled") parts.push(`<span class="pr-badge badge-ci-cancelled">⊘ CI cancelled</span>`);
      else if (ci === "action_required") parts.push(`<span class="pr-badge badge-ci-cancelled" title="First-time contributor: a maintainer must approve the workflow run">⊘ CI awaits approval</span>`);
      if (pr.mergeable === "CONFLICTING") parts.push(`<span class="pr-badge badge-conflict">⚠ conflicts</span>`);
    }
    if ((pr.threads_awaiting_me || 0) > 0) {
      parts.push(`<span class="pr-badge badge-threads" title="Unresolved threads where the last word is not yours">${pr.threads_awaiting_me} awaiting you</span>`);
    }
    if ((pr.threads_awaiting_them || 0) > 0) {
      parts.push(`<span class="pr-badge badge-threads-them" title="Unresolved threads where you spoke last">${pr.threads_awaiting_them} awaiting them</span>`);
    }
    if ((pr.threads_bot || 0) > 0) {
      parts.push(`<span class="pr-badge badge-threads-bot" title="Unresolved threads where a bot spoke last">${pr.threads_bot} bot</span>`);
    }
    signalBadges = parts.join("");
  }

  // Maintainer-applied merge label(s), rendered in the label's real GitHub color.
  let mergeLabelBadges = "";
  (pr.labels || []).forEach(l => {
    if (DASHBOARD_MERGE_LABELS.includes(l.name)) {
      const hex = /^[0-9a-fA-F]{6}$/.test(l.color || "") ? `#${l.color}` : "";
      const style = hex ? `background:${hex};color:${labelTextColor(l.color)};border-color:${hex}` : "";
      mergeLabelBadges += `<span class="pr-badge pr-merge-label" style="${style}">${escapeHtml(l.name)}</span>`;
    }
  });

  // Dim rows that are someone else's move and have nothing new to read. Dim
  // never means "nothing is wrong": a PR nobody has picked up stays bright.
  const actionable = move ? move.actionable : false;
  const pinned = type !== "closed" && isPinnedUrl(pr.url);
  const quiet = hasActivity && !hasUnread && !actionable && !pinned;
  const itemClass = `pr-item${quiet ? " pr-quiet" : ""}${pinned ? " pinned" : ""}`;
  const rail = type !== "closed" ? rowRail(pr, hasActivity) : "";

  return `<div class="${itemClass}">
    <img class="pr-avatar" src="${escapeAttr(pr.avatar)}" alt="" loading="lazy"><span class="pin-flag">⚑</span>
    <span class="pr-number">${pr.number}</span>
    <div class="pr-content">
      <div class="pr-title-row">
        <a href="${escapeAttr(pr.url)}" target="_blank" rel="noopener" class="pr-title">${escapeHtml(pr.title)}</a>
        <span class="pr-chips">${moveChip}${badge}${staleBadge}${mergeLabelBadges}${signalBadges}${unreadBadge}</span>
      </div>
      <div class="pr-meta">
        <span class="pr-repo">${escapeHtml(pr.repo)}</span>
        ${authorLine}
        <span>${dateLabel}</span>
        ${pr.comments > 0 ? `<span>${pr.comments} comments</span>` : ""}
        ${toggleBtn}
      </div>
      ${activitySection}
    </div>
    ${ciDots ? `<span class="ci-rail">${ciDots}</span>` : ""}${rail}
  </div>`;
}

function renderMention(item) {
  const typeBadge = item.is_pr
    ? `<span class="pr-badge badge-mention-pr">PR</span>`
    : `<span class="pr-badge badge-mention-issue">Issue</span>`;
  const age = daysOld(item.updated);
  const staleBadge = age > 7 ? `<span class="pr-badge badge-stale">${age}d ago</span>` : "";
  const { hasActivity, hasUnread, unreadBadge, activitySection, toggleBtn } = buildActivity(item, "issue");
  // A mention you have answered (or marked read) is someone else's move: dim it.
  const pinned = isPinnedUrl(item.url);
  const itemClass = `pr-item${(hasActivity && !hasUnread && !pinned) ? " pr-quiet" : ""}${pinned ? " pinned" : ""}`;

  return `<div class="${itemClass}">
    <img class="pr-avatar" src="${escapeAttr(item.avatar)}" alt="" loading="lazy"><span class="pin-flag">⚑</span>
    <span class="pr-number">${item.number}</span>
    <div class="pr-content">
      <div class="pr-title-row">
        <a href="${escapeAttr(item.url)}" target="_blank" rel="noopener" class="pr-title">${escapeHtml(item.title)}</a>
        <span class="pr-chips">${typeBadge}${staleBadge}${unreadBadge}</span>
      </div>
      <div class="pr-meta">
        <span class="pr-repo">${escapeHtml(item.repo)}</span>
        <span>@${escapeHtml(item.author)}</span>
        <span>updated ${timeAgo(item.updated)}</span>
        ${toggleBtn}
      </div>
      ${activitySection}
    </div>
    ${rowRail(item, hasActivity)}
  </div>`;
}

function renderIssue(item) {
  const { hasActivity, hasUnread, unreadBadge, activitySection, toggleBtn } = buildActivity(item, "issue");
  const pinned = isPinnedUrl(item.url);
  const itemClass = `pr-item${(hasActivity && !hasUnread && !pinned) ? " pr-quiet" : ""}${pinned ? " pinned" : ""}`;
  return `<div class="${itemClass}">
    <img class="pr-avatar" src="${escapeAttr(item.avatar)}" alt="" loading="lazy"><span class="pin-flag">⚑</span>
    <span class="pr-number">${item.number}</span>
    <div class="pr-content">
      <div class="pr-title-row">
        <a href="${escapeAttr(item.url)}" target="_blank" rel="noopener" class="pr-title">${escapeHtml(item.title)}</a>
        <span class="pr-chips"><span class="pr-badge badge-issue">Issue</span>${unreadBadge}</span>
      </div>
      <div class="pr-meta">
        <span class="pr-repo">${escapeHtml(item.repo)}</span>
        <span>@${escapeHtml(item.author)}</span>
        <span>updated ${timeAgo(item.updated)}</span>
        ${toggleBtn}
      </div>
      ${activitySection}
    </div>
    ${rowRail(item, hasActivity)}
  </div>`;
}

// sortPRs provided by scripts/utils.js

function buildRepoCheckboxes(containerId, items, onChange) {
  const container = document.getElementById(containerId);
  const repos = [...new Set(items.map(i => i.repo))].sort();

  const selAll = document.createElement("label");
  selAll.className = "repo-chip select-all";
  const selCb = document.createElement("input");
  selCb.type = "checkbox";
  selCb.checked = true;
  selCb.addEventListener("change", () => {
    container.querySelectorAll("input").forEach(c => { c.checked = selCb.checked; });
    onChange();
  });
  selAll.appendChild(selCb);
  selAll.appendChild(document.createTextNode(" All"));
  container.appendChild(selAll);

  repos.forEach(repo => {
    const label = document.createElement("label");
    label.className = "repo-chip";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.value = repo;
    cb.addEventListener("change", onChange);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + repo));
    container.appendChild(label);
  });
}

function getSelectedRepos(containerId) {
  const cbs = document.getElementById(containerId).querySelectorAll("input[value]:checked");
  return new Set(Array.from(cbs).map(c => c.value));
}

// formatDate provided by scripts/utils.js

Promise.all([
  fetch("config.json").then(r => { if (!r.ok) throw new Error("config.json not found"); return r.json(); }),
  fetch("data/prs.json").then(r => {
    if (!r.ok) return { github_user: "", orgs: [], updated: "", reviewing: [], open_prs: [], closed_prs: [], reviewed_by: [], mentions: [], issues: [], counts: { reviewing: 0, open: 0, closed: 0, reviewed_by: 0, mentions: 0, issues: 0 } };
    return r.json();
  })
])
  .then(([config, data]) => {
    const orgs = config.orgs || (config.org ? [config.org] : []);
    const orgBadges = orgs.map(o => `<span class="org-badge">${escapeHtml(o)}</span>`).join(" ");
    document.getElementById("dashboard-title").innerHTML = `${escapeHtml(config.title)} ${orgBadges}`;
    document.title = `${config.title} - ${orgs.join(", ")}`;
    if (config.github_user) {
      document.getElementById("github-link").href = `https://github.com/${encodeURIComponent(config.github_user)}/PersonalDashboard`;
    }
    DASHBOARD_USER = data.github_user || config.github_user || "";
    if (Array.isArray(config.merge_labels)) DASHBOARD_MERGE_LABELS = config.merge_labels;
    if (Array.isArray(config.merge_access)) DASHBOARD_MERGE_ACCESS = config.merge_access;
    const userLabel = data.github_user ? `@${data.github_user} • ` : "";
    const updatedLabel = data.updated ? `Updated ${formatDate(data.updated)}` : "Run the workflow to populate data";
    document.getElementById("subtitle").textContent = `${userLabel}${updatedLabel}`;

    // Stale-data banner: the page renders a pre-built data/prs.json, so if the
    // refresh workflow stalls the site silently shows old data. Warn past 90 min.
    const STALE_MS = 90 * 60 * 1000;
    if (isStale(data.updated, STALE_MS)) {
      const banner = document.getElementById("stale-banner");
      const age = staleAgeLabel(Date.now() - new Date(data.updated).getTime());
      document.getElementById("stale-banner-text").textContent =
        `⚠ Data is ${age} old (updated ${formatDate(data.updated)}) — the refresh workflow may have stopped.`;
      banner.style.display = "";
      document.getElementById("stale-banner-close").addEventListener("click", () => {
        banner.style.display = "none";
      });
    }

    const reviewing = data.reviewing || [];

    // Prune read markers for PRs no longer in any open list
    const allOpen = [...reviewing, ...data.open_prs, ...(data.issues || []), ...(data.mentions || [])];
    const allOpenUrls = new Set(allOpen.map(pr => pr.url));
    const staleMarkers = getReadMarkers();
    const openByUrl = new Map(allOpen.map(pr => [pr.url, pr]));
    Object.keys(staleMarkers).forEach(url => {
      if (!allOpenUrls.has(url)) { delete staleMarkers[url]; return; }
      // A pin clears itself once you have acted on the item since pinning it.
      if (staleMarkers[url].pinned_at && !pinStillHolds(staleMarkers[url], openByUrl.get(url), DASHBOARD_USER)) {
        delete staleMarkers[url].pinned_at;
        if (!Object.keys(staleMarkers[url]).length) delete staleMarkers[url];
      }
    });
    saveReadMarkers(staleMarkers);

    // Dark board: each card's big number is what the tab wants from you, lit
    // only while it is above zero; the caption is the tab's total. The color
    // already says what kind of attention, so the caption carries no label. Reviewed and
    // Done are history, so they show their totals, unlit, with no caption.
    function setCard(tab, big, lit, caption) {
      const card = document.querySelector(`.stat-card[data-tab="${tab}"]`);
      document.getElementById(`count-${tab}`).textContent = big;
      document.getElementById(`sub-${tab}`).textContent = caption || "";
      card.classList.toggle("lit", !!lit);
    }
    const pinnedUrl = (i) => isPinnedUrl(i.url);
    function unreadCount(items) {
      return (items || []).filter(i => pinnedUrl(i) || getUnreadActivity(i, DASHBOARD_USER).some(a => a.type !== "commit")).length;
    }
    function pinnedCount(items) { return (items || []).filter(pinnedUrl).length; }
    // Caption: the tab's total with its unit, naming pins when there are any.
    const caption = (items, unit) => { const p = pinnedCount(items); return `${(items || []).length} ${unit}${p ? ` · ${p} pinned` : ""}`; };
    function updateCards() {
      const mine = {
        reviewing: countActionable(reviewing, triageOpts("reviewing"), pinnedUrl),
        open: countActionable(data.open_prs, triageOpts("open"), pinnedUrl),
      };
      setCard("reviewing", mine.reviewing, mine.reviewing > 0, caption(reviewing, "PRs open"));
      setCard("open", mine.open, mine.open > 0, caption(data.open_prs, "PRs open"));
      const newMentions = unreadCount(data.mentions);
      setCard("mentions", newMentions, newMentions > 0, caption(data.mentions, "open"));
      const newIssues = unreadCount(data.issues);
      setCard("issues", newIssues, newIssues > 0, caption(data.issues, "issues open"));
      setCard("reviewed", data.counts.reviewed_by || 0, false, since((data.reviewed_by || []).map(p => p.closed)));
      setCard("closed", data.counts.closed, false, since((data.closed_prs || []).map(p => p.created)));
      if (data.merger) {
        const m = data.merger;
        const sec = (k) => (m.sections && m.sections[k]) || [];
        setCard("m-ci", sec("ci").length, sec("ci").length > 0, `${m.total_open} PRs open`);
        setCard("m-maint", sec("maint").length, sec("maint").length > 0, "community-reviewed only");
        setCard("m-land", sec("land").length, sec("land").length > 0, "approved 7d+, unmerged");
        setCard("m-unstick", sec("unstick").length, sec("unstick").length > 0, "stuck after review");
        const broken = sec("queue").filter(p => p.merger_broken).length;
        setCard("m-queue", sec("queue").length, broken > 0, broken ? `${broken} broken` : "to-be-merged");
        setCard("m-merged", (m.merged || {}).count || 0, false, since([(m.merged || {}).since]));
      }
    }
    // "since 2024-04": the month of the earliest date in the list.
    function since(dates) {
      const d = (dates || []).filter(Boolean).sort()[0];
      return d ? `since ${d.slice(0, 7)}` : "";
    }
    updateCards();

    function refreshAll() { updateCards(); renderReviewing(); renderOpen(); renderMentions(); renderIssues(); }

    document.getElementById("reset-marks").addEventListener("click", () => {
      const marks = getReadMarkers();
      const pins = Object.values(marks).filter(m => m.pinned_at).length;
      const reads = Object.values(marks).filter(m => m.read_at).length;
      if (!confirm(`Clear your local marks? ${reads} read marks, ${pins} pins.`)) return;
      localStorage.removeItem(LEGACY_OVERRIDES_KEY);
      localStorage.removeItem(READ_MARKERS_KEY);
      refreshAll();
    });

    let renderReviewing = () => {
      const repos = getSelectedRepos("repo-checkboxes-reviewing");
      const sort = document.getElementById("filter-reviewing-sort").value;
      let filtered = reviewing.filter(pr => repos.has(pr.repo));
      filtered = sortPRs(filtered, sort, triageOpts("reviewing"));
      document.getElementById("list-reviewing").innerHTML = filtered.length
        ? filtered.map(pr => renderPR(pr, "reviewing")).join("")
        : `<div class="loading">No PRs match the filter</div>`;
      document.getElementById("section-count-reviewing").textContent = `${filtered.length} open`;
    };

    let renderOpen = () => {
      const repos = getSelectedRepos("repo-checkboxes-open");
      const sort = document.getElementById("filter-open-sort").value;
      let filtered = data.open_prs.filter(pr => repos.has(pr.repo));
      filtered = sortPRs(filtered, sort, triageOpts("open"));
      document.getElementById("list-open").innerHTML = filtered.length
        ? filtered.map(pr => renderPR(pr, "open")).join("")
        : `<div class="loading">No PRs match the filter</div>`;
      document.getElementById("section-count-open").textContent = `${filtered.length} open`;
    };

    const renderMentions = () => {
      const repos = getSelectedRepos("repo-checkboxes-mentions");
      const type = document.getElementById("filter-mentions-type").value;
      let filtered = (data.mentions || []).filter(m => repos.has(m.repo));
      if (type === "pr") filtered = filtered.filter(m => m.is_pr);
      if (type === "issue") filtered = filtered.filter(m => !m.is_pr);
      document.getElementById("list-mentions").innerHTML = filtered.length
        ? filtered.map(renderMention).join("")
        : `<div class="loading">No mentions match the filter</div>`;
      document.getElementById("section-count-mentions").textContent = `${filtered.length} open`;
    };

    const renderIssues = () => {
      const repos = getSelectedRepos("repo-checkboxes-issues");
      const type = document.getElementById("filter-issues-type").value;
      const sort = document.getElementById("filter-issues-sort").value;
      let filtered = (data.issues || []).filter(i => repos.has(i.repo));
      if (type === "assigned") filtered = filtered.filter(i => i.is_assigned);
      if (type === "authored") filtered = filtered.filter(i => i.is_authored);
      filtered = [...filtered].sort((a, b) => {
        if (sort === "created") return new Date(b.created) - new Date(a.created);
        return new Date(b.updated) - new Date(a.updated);
      });
      document.getElementById("list-issues").innerHTML = filtered.length
        ? filtered.map(renderIssue).join("")
        : `<div class="loading">No issues match the filter</div>`;
      document.getElementById("section-count-issues").textContent = `${filtered.length} open`;
    };

    const renderReviewed = () => {
      const repos = getSelectedRepos("repo-checkboxes-reviewed");
      const status = document.getElementById("filter-reviewed-status").value;
      const from = document.getElementById("filter-reviewed-from").value;
      const to = document.getElementById("filter-reviewed-to").value;
      let filtered = (data.reviewed_by || []).filter(pr => repos.has(pr.repo));
      if (status === "merged") filtered = filtered.filter(pr => pr.merged);
      if (status === "closed") filtered = filtered.filter(pr => !pr.merged);
      if (from) filtered = filtered.filter(pr => formatDate(pr.closed) >= from);
      if (to) filtered = filtered.filter(pr => formatDate(pr.closed) <= to);
      document.getElementById("list-reviewed").innerHTML = filtered.length
        ? filtered.map(pr => renderPR(pr, "closed")).join("")
        : `<div class="loading">No PRs match the filter</div>`;
      document.getElementById("section-count-reviewed").textContent = `${filtered.length} of ${(data.reviewed_by || []).length}`;
    };

    const renderClosed = () => {
      const repos = getSelectedRepos("repo-checkboxes-closed");
      const status = document.getElementById("filter-closed-status").value;
      const from = document.getElementById("filter-closed-from").value;
      const to = document.getElementById("filter-closed-to").value;
      let filtered = data.closed_prs.filter(pr => repos.has(pr.repo));
      if (status === "merged") filtered = filtered.filter(pr => pr.merged);
      if (status === "closed") filtered = filtered.filter(pr => !pr.merged);
      if (from) filtered = filtered.filter(pr => formatDate(pr.closed) >= from);
      if (to) filtered = filtered.filter(pr => formatDate(pr.closed) <= to);
      document.getElementById("list-closed").innerHTML = filtered.length
        ? filtered.map(pr => renderPR(pr, "closed")).join("")
        : `<div class="loading">No PRs match the filter</div>`;
      document.getElementById("section-count-closed").textContent = `${filtered.length} of ${data.counts.closed}`;
    };

    // Merger row: only with merge_access, and only the sections the fetch published.
    if (data.merger) {
      document.getElementById("stats-merger").hidden = false;
      const m = data.merger;
      const renderSection = (key, tab, empty) => {
        const prs = (m.sections && m.sections[key]) || [];
        document.getElementById(`list-${tab}`).innerHTML = prs.length
          ? prs.map(pr => renderPR(pr, "merger")).join("")
          : `<div class="loading">${empty}</div>`;
        document.getElementById(`section-count-${tab}`).textContent = `${prs.length} of ${m.total_open} open${m.incomplete ? ` · ${m.incomplete} unclassified (rate limited)` : ""}`;
      };
      renderSection("ci", "m-ci", "No workflow runs are waiting for approval");
      renderSection("maint", "m-maint", "Every reviewed PR has a committer on it");
      renderSection("land", "m-land", "Nothing approved is sitting unmerged");
      renderSection("unstick", "m-unstick", "Nothing is stuck after review");
      renderSection("queue", "m-queue", "Nothing is labelled for merge");
      const mine = (m.merged && m.merged.prs) || [];
      document.getElementById("list-m-merged").innerHTML = mine.length
        ? mine.map(pr => renderPR(pr, "closed")).join("")
        : `<div class="loading">You have not merged anything here yet</div>`;
      document.getElementById("section-count-m-merged").textContent = `${mine.length} merged`;
    }

    buildRepoCheckboxes("repo-checkboxes-reviewing", reviewing, renderReviewing);
    buildRepoCheckboxes("repo-checkboxes-open", data.open_prs, renderOpen);
    buildRepoCheckboxes("repo-checkboxes-mentions", data.mentions || [], renderMentions);
    buildRepoCheckboxes("repo-checkboxes-issues", data.issues || [], renderIssues);
    buildRepoCheckboxes("repo-checkboxes-reviewed", data.reviewed_by || [], renderReviewed);
    buildRepoCheckboxes("repo-checkboxes-closed", data.closed_prs, renderClosed);

    document.getElementById("filter-reviewing-sort").addEventListener("change", renderReviewing);
    document.getElementById("filter-open-sort").addEventListener("change", renderOpen);
    document.getElementById("filter-mentions-type").addEventListener("change", renderMentions);
    document.getElementById("filter-issues-type").addEventListener("change", renderIssues);
    document.getElementById("filter-issues-sort").addEventListener("change", renderIssues);
    document.getElementById("filter-reviewed-status").addEventListener("change", renderReviewed);
    document.getElementById("filter-reviewed-from").addEventListener("change", renderReviewed);
    document.getElementById("filter-reviewed-to").addEventListener("change", renderReviewed);
    document.getElementById("filter-closed-status").addEventListener("change", renderClosed);
    document.getElementById("filter-closed-from").addEventListener("change", renderClosed);
    document.getElementById("filter-closed-to").addEventListener("change", renderClosed);

    renderMentions();
    renderIssues();
    renderReviewed();
    renderClosed();

    // Add expand/collapse all buttons to sections with activity
    function addExpandAllButtons() {
      document.querySelectorAll(".section-header").forEach(header => {
        if (header.querySelector(".expand-all-btn")) return;
        const list = header.parentElement.querySelector(".pr-list");
        if (!list || !list.querySelector(".activity-section")) return;
        const btn = document.createElement("button");
        btn.className = "expand-all-btn activity-toggle";
        btn.textContent = "▸ expand all";
        btn.addEventListener("click", () => {
          const sections = list.querySelectorAll(".activity-section");
          const toggles = list.querySelectorAll(".activity-toggle[data-target]");
          const anyOpen = list.querySelector(".activity-section.open");
          sections.forEach(s => anyOpen ? s.classList.remove("open") : s.classList.add("open"));
          toggles.forEach(t => t.textContent = anyOpen ? "▸ activity" : "▾ activity");
          btn.textContent = anyOpen ? "▸ expand all" : "▾ collapse all";
        });
        header.querySelector(".section-count").before(btn);
      });
    }

    // Run after initial render and re-run after re-renders
    const origRenderReviewing = renderReviewing, origRenderOpen = renderOpen;
    const withExpandBtn = (fn) => () => { fn(); addExpandAllButtons(); };
    renderReviewing = withExpandBtn(origRenderReviewing);
    renderOpen = withExpandBtn(origRenderOpen);
    renderReviewing(); renderOpen();

    // Event delegation for activity toggles and mark-read buttons
    document.addEventListener("click", (e) => {
      const toggle = e.target.closest(".activity-toggle[data-target]");
      if (toggle) {
        e.stopPropagation();
        const section = document.getElementById(toggle.dataset.target);
        if (section) {
          const isOpen = section.classList.toggle("open");
          toggle.textContent = isOpen ? "▾ activity" : "▸ activity";
        }
        return;
      }
      const markBtn = e.target.closest(".mark-read-btn, .rail-btn[data-action=mark-read], .rail-btn[data-action=mark-unread], .rail-btn[data-action=pin], .rail-btn[data-action=unpin]");
      if (markBtn) {
        e.stopPropagation();
        const action = markBtn.dataset.action || "mark-read";
        if (action === "mark-read") setReadMarker(markBtn.dataset.url);
        else if (action === "mark-unread") clearReadMarker(markBtn.dataset.url);
        else setPin(markBtn.dataset.url, action === "pin");
        refreshAll();
        return;
      }
    });
  })
  .catch(err => {
    document.getElementById("list-review").innerHTML = `<div class="loading">Failed to load data: ${escapeHtml(err.message)}</div>`;
  });
