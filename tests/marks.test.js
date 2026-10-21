const { describe, it } = require("node:test");
const assert = require("node:assert");
const { createMarkStore, reconcileMarks, MARKS_KEY } = require("../scripts/marks.js");
const { normalizeMarker, pinStillHolds } = require("../scripts/utils.js");

// A localStorage stand-in: the three methods the store uses, over a plain object.
function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    raw: () => data,
  };
}
const store = (initial) => createMarkStore(memoryStorage(initial), normalizeMarker);
const ME = "rain";
const holds = (m, item) => pinStillHolds(m, item, ME);

describe("mark store: read and pin per URL", () => {
  it("starts empty on a fresh browser and on corrupt storage", () => {
    assert.deepEqual(store().all(), {});
    assert.deepEqual(store({ [MARKS_KEY]: "{not json" }).all(), {});
  });

  it("reads the old bare-timestamp shape as a read mark", () => {
    const s = store({ [MARKS_KEY]: JSON.stringify({ "https://x/1": "2026-10-01T00:00:00Z" }) });
    assert.deepEqual(s.get("https://x/1"), { read_at: "2026-10-01T00:00:00Z" });
  });

  it("sets, clears and re-sets a read mark without touching the pin", () => {
    const s = store();
    s.setPin("https://x/1", true, "2026-10-01T00:00:00Z");
    s.setRead("https://x/1", "2026-10-02T00:00:00Z");
    assert.deepEqual(s.get("https://x/1"), { pinned_at: "2026-10-01T00:00:00Z", read_at: "2026-10-02T00:00:00Z" });
    s.clearRead("https://x/1");
    assert.deepEqual(s.get("https://x/1"), { pinned_at: "2026-10-01T00:00:00Z" });
    assert.equal(s.isPinned("https://x/1"), true);
  });

  it("removes the URL entirely when its last mark is cleared", () => {
    const s = store();
    s.setRead("https://x/1", "2026-10-02T00:00:00Z");
    s.clearRead("https://x/1");
    assert.deepEqual(s.all(), {});
  });

  it("counts reads and pins for the reset confirmation, and clear() empties storage", () => {
    const s = store();
    s.setRead("https://x/1"); s.setRead("https://x/2"); s.setPin("https://x/2", true);
    assert.deepEqual(s.counts(), { reads: 2, pins: 1 });
    s.clear();
    assert.deepEqual(s.all(), {});
  });
});

describe("reconcileMarks: what survives a reload", () => {
  const marks = {
    "https://x/open": { read_at: "2026-10-01T00:00:00Z" },
    "https://x/closed": { read_at: "2026-10-01T00:00:00Z", pinned_at: "2026-10-01T00:00:00Z" },
    "https://x/pinned-acted": { pinned_at: "2026-10-01T00:00:00Z" },
    "https://x/pinned-held": { pinned_at: "2026-10-01T00:00:00Z", read_at: "2026-09-30T00:00:00Z" },
  };
  const open = [
    { url: "https://x/open", author: "alice", activity: [] },
    { url: "https://x/pinned-acted", author: "alice", activity: [{ author: ME, created_at: "2026-10-02T00:00:00Z" }] },
    { url: "https://x/pinned-held", author: "alice", activity: [{ author: "bob", created_at: "2026-10-02T00:00:00Z" }] },
  ];

  it("drops marks for items no longer open, clears pins the user acted on, keeps the rest", () => {
    const r = reconcileMarks(marks, open, holds);
    assert.deepEqual(r.marks, {
      "https://x/open": { read_at: "2026-10-01T00:00:00Z" },
      "https://x/pinned-held": { pinned_at: "2026-10-01T00:00:00Z", read_at: "2026-09-30T00:00:00Z" },
    });
    assert.equal(r.dropped, 1);
    assert.equal(r.unpinned, 1);
  });

  it("other people's activity never clears a pin", () => {
    const r = reconcileMarks({ "https://x/pinned-held": { pinned_at: "2026-10-01T00:00:00Z" } }, [open[2]], holds);
    assert.equal(r.marks["https://x/pinned-held"].pinned_at, "2026-10-01T00:00:00Z");
  });

  it("a pin on a merger-row PR survives when that row is counted among the open items", () => {
    // Merger rows have no activity feed; they must still be in the open set or
    // their pins would be pruned as closed on every reload.
    const mergerRow = { url: "https://x/merger", author: "carol", merger_section: "maint" };
    const r = reconcileMarks({ "https://x/merger": { pinned_at: "2026-10-01T00:00:00Z" } }, [mergerRow], holds);
    assert.equal(r.marks["https://x/merger"].pinned_at, "2026-10-01T00:00:00Z");
    const gone = reconcileMarks({ "https://x/merger": { pinned_at: "2026-10-01T00:00:00Z" } }, [], holds);
    assert.deepEqual(gone.marks, {});
  });

  it("prune() through the store writes the reconciled map back", () => {
    const s = store({ [MARKS_KEY]: JSON.stringify(marks) });
    const counts = s.prune(open, holds);
    assert.deepEqual(counts, { dropped: 1, unpinned: 1 });
    assert.deepEqual(Object.keys(s.all()).sort(), ["https://x/open", "https://x/pinned-held"]);
  });
});
