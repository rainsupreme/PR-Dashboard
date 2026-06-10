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

const OVERRIDES_KEY = "dashboard-overrides";
function getOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY)) || {}; } catch { return {}; }
}
function setOverride(url, target) {
  const o = getOverrides();
  if (target) o[url] = target;
  else delete o[url];
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(o));
}

const READ_MARKERS_KEY = "dashboard-read-markers";
function getReadMarkers() {
  try { return JSON.parse(localStorage.getItem(READ_MARKERS_KEY)) || {}; } catch { return {}; }
}
function setReadMarker(url) {
  const m = getReadMarkers();
  m[url] = new Date().toISOString();
  localStorage.setItem(READ_MARKERS_KEY, JSON.stringify(m));
}
function getUnreadActivity(pr) {
  if (!pr.activity || pr.activity.length === 0) return [];
  const markers = getReadMarkers();
  const since = markers[pr.url] || pr.last_push || pr.created;
  return filterUnreadActivity(pr.activity, since);
}

function renderActivityItem(item, isUnread) {
  const typeClass = `activity-type-${item.type}`;
  const label = item.type === "review" ? (item.state || "review").toLowerCase() : item.type;
  return `<div class="activity-item${isUnread ? " unread" : ""}">
    <img class="activity-avatar" src="${escapeAttr(item.avatar)}" alt="" loading="lazy">
    <span class="activity-type ${typeClass}">${label}</span>
    <span class="activity-body">${escapeHtml(item.author)}: ${escapeHtml(item.body)}</span>
    <span class="activity-time">${timeAgo(item.created_at)}</span>
  </div>`;
}

function renderPR(pr, type, moveBtn) {
  let badge = "";
  if (type === "closed") {
    badge = pr.merged
      ? `<span class="pr-badge badge-merged">✔ Merged</span>`
      : `<span class="pr-badge badge-closed">✖ Closed</span>`;
  } else if (pr.draft) {
    badge = `<span class="pr-badge badge-draft">✏ Draft</span>`;
  }
  const age = (type === "review") ? daysOld(pr.created) : 0;
  const staleBadge = age > 7 ? `<span class="pr-badge badge-stale">${age}d waiting</span>` : "";
  const dateLabel = type === "closed" ? `closed ${timeAgo(pr.closed)}` : `updated ${timeAgo(pr.updated)}`;
  const authorLine = type === "review" ? `<span>@${escapeHtml(pr.author)}</span>` : "";
  const moveBtnHtml = moveBtn || "";

  const hasActivity = pr.activity && pr.activity.length > 0 && type !== "closed";
  let unreadBadge = "";
  let activitySection = "";

  if (hasActivity) {
    const unread = getUnreadActivity(pr);
    unreadBadge = unread.length > 0
      ? `<span class="pr-badge badge-unread">${unread.length} new</span>`
      : "";
    const unreadTimes = new Set(unread.map(a => a.created_at));
    const actId = `activity-${pr.repo}-${pr.number}`;
    const items = pr.activity.slice(0, 10).map(a =>
      renderActivityItem(a, unreadTimes.has(a.created_at))
    ).join("");
    activitySection = `
      <div class="activity-section" id="${actId}">
        ${items}
        <button class="mark-read-btn" data-url="${escapeAttr(pr.url)}" data-target="${actId}">✓ Mark read</button>
      </div>`;
  }

  const toggleBtn = hasActivity
    ? `<button class="activity-toggle" data-target="activity-${pr.repo}-${pr.number}">▸ activity</button>`
    : "";

  return `<div class="pr-item">
    <img class="pr-avatar" src="${escapeAttr(pr.avatar)}" alt="" loading="lazy">
    <div class="pr-content">
      <div class="pr-title-row">
        <a href="${escapeAttr(pr.url)}" target="_blank" rel="noopener" class="pr-title">${escapeHtml(pr.title)}</a>
        <span class="pr-number">#${pr.number}</span>
        ${badge}${staleBadge}${unreadBadge}
        ${moveBtnHtml}
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
  </div>`;
}

function renderMention(item) {
  const typeBadge = item.is_pr
    ? `<span class="pr-badge badge-mention-pr">PR</span>`
    : `<span class="pr-badge badge-mention-issue">Issue</span>`;
  const age = daysOld(item.updated);
  const staleBadge = age > 7 ? `<span class="pr-badge badge-stale">${age}d ago</span>` : "";

  return `<div class="pr-item">
    <img class="pr-avatar" src="${escapeAttr(item.avatar)}" alt="" loading="lazy">
    <div class="pr-content">
      <div class="pr-title-row">
        <a href="${escapeAttr(item.url)}" target="_blank" rel="noopener" class="pr-title">${escapeHtml(item.title)}</a>
        <span class="pr-number">#${item.number}</span>
        ${typeBadge}${staleBadge}
      </div>
      <div class="pr-meta">
        <span class="pr-repo">${escapeHtml(item.repo)}</span>
        <span>@${escapeHtml(item.author)}</span>
        <span>updated ${timeAgo(item.updated)}</span>
      </div>
    </div>
  </div>`;
}

function renderIssue(item) {
  return `<div class="pr-item">
    <img class="pr-avatar" src="${escapeAttr(item.avatar)}" alt="" loading="lazy">
    <div class="pr-content">
      <div class="pr-title-row">
        <a href="${escapeAttr(item.url)}" target="_blank" rel="noopener" class="pr-title">${escapeHtml(item.title)}</a>
        <span class="pr-number">#${item.number}</span>
        <span class="pr-badge badge-issue">Issue</span>
      </div>
      <div class="pr-meta">
        <span class="pr-repo">${escapeHtml(item.repo)}</span>
        <span>@${escapeHtml(item.author)}</span>
        <span>updated ${timeAgo(item.updated)}</span>
      </div>
    </div>
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
    if (!r.ok) return { github_user: "", orgs: [], updated: "", to_review: [], open_prs: [], closed_prs: [], reviewed_by: [], mentions: [], issues: [], counts: { to_review: 0, open: 0, closed: 0, reviewed_by: 0, mentions: 0, issues: 0 } };
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
    const userLabel = data.github_user ? `@${data.github_user} • ` : "";
    const updatedLabel = data.updated ? `Updated ${formatDate(data.updated)}` : "Run the workflow to populate data";
    document.getElementById("subtitle").textContent = `${userLabel}${updatedLabel}`;

    const staleOverrides = getOverrides();
    const reviewUrls = new Set(data.to_review.map(pr => pr.url));
    Object.keys(staleOverrides).forEach(url => {
      if (!reviewUrls.has(url)) setOverride(url, null);
    });

    // Prune read markers for PRs no longer in any open list
    const allOpenUrls = new Set([...data.to_review, ...data.open_prs, ...(data.reviewed_open || [])].map(pr => pr.url));
    const staleMarkers = getReadMarkers();
    Object.keys(staleMarkers).forEach(url => {
      if (!allOpenUrls.has(url)) { delete staleMarkers[url]; }
    });
    localStorage.setItem(READ_MARKERS_KEY, JSON.stringify(staleMarkers));

    function updateMoveCounts() {
      const overrides = getOverrides();
      const movedCount = data.to_review.filter(pr => overrides[pr.url] === "reviewed-open").length;
      document.getElementById("count-review").textContent = data.counts.to_review - movedCount;
      document.getElementById("count-reviewed-open").textContent = (data.counts.reviewed_open || 0) + movedCount;
    }
    updateMoveCounts();
    document.getElementById("count-open").textContent = data.counts.open;
    document.getElementById("count-mentions").textContent = data.counts.mentions || 0;
    document.getElementById("count-issues").textContent = data.counts.issues || 0;
    document.getElementById("count-reviewed").textContent = data.counts.reviewed_by || 0;
    document.getElementById("count-closed").textContent = data.counts.closed;

    function refreshAll() { updateMoveCounts(); renderReview(); renderReviewedOpen(); }

    document.getElementById("reset-overrides").addEventListener("click", () => {
      localStorage.removeItem(OVERRIDES_KEY);
      refreshAll();
    });

    const renderReview = () => {
      const overrides = getOverrides();
      const repos = getSelectedRepos("repo-checkboxes-review");
      const sort = document.getElementById("filter-review-sort").value;
      let filtered = data.to_review.filter(pr => repos.has(pr.repo) && overrides[pr.url] !== "reviewed-open");
      filtered = sortPRs(filtered, sort);
      document.getElementById("list-review").innerHTML = filtered.length
        ? filtered.map(pr => renderPR(pr, "review",
            `<button class="move-btn" data-url="${escapeAttr(pr.url)}" data-action="mark-reviewed">✓ Reviewed</button>`
          )).join("")
        : `<div class="loading">No PRs match the filter</div>`;
      document.getElementById("section-count-review").textContent = `${filtered.length} open`;
      document.getElementById("list-review").querySelectorAll("[data-action=mark-reviewed]").forEach(btn => {
        btn.addEventListener("click", (e) => { e.stopPropagation(); setOverride(btn.dataset.url, "reviewed-open"); refreshAll(); });
      });
    };

    const renderReviewedOpen = () => {
      const overrides = getOverrides();
      const repos = getSelectedRepos("repo-checkboxes-reviewed-open");
      const sort = document.getElementById("filter-reviewed-open-sort").value;
      const movedFromReview = data.to_review.filter(pr => overrides[pr.url] === "reviewed-open" && repos.has(pr.repo));
      let filtered = (data.reviewed_open || []).filter(pr => repos.has(pr.repo));
      filtered = [...movedFromReview, ...filtered.filter(pr => !movedFromReview.some(m => m.url === pr.url))];
      filtered = sortPRs(filtered, sort);
      document.getElementById("list-reviewed-open").innerHTML = filtered.length
        ? filtered.map(pr => {
            const isManual = overrides[pr.url] === "reviewed-open";
            const btn = isManual
              ? `<button class="move-btn" data-url="${escapeAttr(pr.url)}" data-action="undo-reviewed">↩ Undo</button>`
              : "";
            return renderPR(pr, "open", btn);
          }).join("")
        : `<div class="loading">No PRs match the filter</div>`;
      document.getElementById("section-count-reviewed-open").textContent = `${filtered.length} open`;
      document.getElementById("list-reviewed-open").querySelectorAll("[data-action=undo-reviewed]").forEach(btn => {
        btn.addEventListener("click", (e) => { e.stopPropagation(); setOverride(btn.dataset.url, null); refreshAll(); });
      });
    };

    const renderOpen = () => {
      const repos = getSelectedRepos("repo-checkboxes-open");
      const sort = document.getElementById("filter-open-sort").value;
      let filtered = data.open_prs.filter(pr => repos.has(pr.repo));
      filtered = sortPRs(filtered, sort);
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

    buildRepoCheckboxes("repo-checkboxes-review", data.to_review, renderReview);
    buildRepoCheckboxes("repo-checkboxes-reviewed-open", data.reviewed_open || [], renderReviewedOpen);
    buildRepoCheckboxes("repo-checkboxes-open", data.open_prs, renderOpen);
    buildRepoCheckboxes("repo-checkboxes-mentions", data.mentions || [], renderMentions);
    buildRepoCheckboxes("repo-checkboxes-issues", data.issues || [], renderIssues);
    buildRepoCheckboxes("repo-checkboxes-reviewed", data.reviewed_by || [], renderReviewed);
    buildRepoCheckboxes("repo-checkboxes-closed", data.closed_prs, renderClosed);

    document.getElementById("filter-review-sort").addEventListener("change", renderReview);
    document.getElementById("filter-reviewed-open-sort").addEventListener("change", renderReviewedOpen);
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

    renderReview();
    renderReviewedOpen();
    renderOpen();
    renderMentions();
    renderIssues();
    renderReviewed();
    renderClosed();

    // Event delegation for activity toggles and mark-read buttons
    document.addEventListener("click", (e) => {
      const toggle = e.target.closest(".activity-toggle");
      if (toggle) {
        e.stopPropagation();
        const section = document.getElementById(toggle.dataset.target);
        if (section) {
          const isOpen = section.classList.toggle("open");
          toggle.textContent = isOpen ? "▾ activity" : "▸ activity";
        }
        return;
      }
      const markBtn = e.target.closest(".mark-read-btn");
      if (markBtn) {
        e.stopPropagation();
        setReadMarker(markBtn.dataset.url);
        // Re-render the containing list to update badges
        renderReview(); renderReviewedOpen(); renderOpen();
        return;
      }
    });
  })
  .catch(err => {
    document.getElementById("list-review").innerHTML = `<div class="loading">Failed to load data: ${escapeHtml(err.message)}</div>`;
  });
