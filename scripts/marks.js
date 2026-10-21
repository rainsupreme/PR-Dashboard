// Local read/pin marks: the one piece of state the dashboard owns. Stored per
// URL as { read_at, pinned_at } under one localStorage key. A read mark is a
// statement about the past (activity after it shows as new again); a pin is a
// promise to act (cleared only by your own action on the item, or its closing).
//
// Loaded by the browser as a plain script after utils.js, and required by
// tests under node; `storage` is injected so tests use a plain object.

const MARKS_KEY = "dashboard-read-markers";

// Drop marks for items no longer open and pins the user has since acted on.
// Pure: returns the new map plus what was removed, never touches storage.
// `holds(marker, item)` decides whether a pin still applies (pinStillHolds).
function reconcileMarks(marks, openItems, holds) {
  const byUrl = new Map((openItems || []).map((it) => [it.url, it]));
  const out = {};
  let dropped = 0, unpinned = 0;
  for (const url of Object.keys(marks || {})) {
    const m = { ...marks[url] };
    if (!byUrl.has(url)) { dropped++; continue; }
    if (m.pinned_at && !holds(m, byUrl.get(url))) { delete m.pinned_at; unpinned++; }
    if (Object.keys(m).length) out[url] = m;
  }
  return { marks: out, dropped, unpinned };
}

function createMarkStore(storage, normalize, key = MARKS_KEY) {
  function all() {
    let raw = {};
    try { raw = JSON.parse(storage.getItem(key)) || {}; } catch { raw = {}; }
    const m = {};
    for (const url of Object.keys(raw)) {
      const v = normalize(raw[url]);
      if (Object.keys(v).length) m[url] = v;
    }
    return m;
  }
  function save(m) { storage.setItem(key, JSON.stringify(m)); }
  function update(url, patch) {
    const m = all();
    const cur = { ...(m[url] || {}), ...patch };
    for (const k of Object.keys(cur)) if (!cur[k]) delete cur[k];
    if (Object.keys(cur).length) m[url] = cur; else delete m[url];
    save(m);
  }
  const now = () => new Date().toISOString();
  return {
    all,
    get: (url) => all()[url] || {},
    setRead: (url, at = now()) => update(url, { read_at: at }),
    clearRead: (url) => update(url, { read_at: "" }),
    setPin: (url, on, at = now()) => update(url, { pinned_at: on ? at : "" }),
    isPinned: (url) => !!(all()[url] || {}).pinned_at,
    // Apply reconcileMarks to the store; returns its counts.
    prune(openItems, holds) {
      const r = reconcileMarks(all(), openItems, holds);
      save(r.marks);
      return { dropped: r.dropped, unpinned: r.unpinned };
    },
    counts() {
      const m = Object.values(all());
      return { reads: m.filter((x) => x.read_at).length, pins: m.filter((x) => x.pinned_at).length };
    },
    clear: () => storage.removeItem(key),
  };
}

if (typeof module !== "undefined") {
  module.exports = { MARKS_KEY, reconcileMarks, createMarkStore };
}
