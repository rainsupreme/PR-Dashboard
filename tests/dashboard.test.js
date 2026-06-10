const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { timeAgo, daysOld, escapeAttr, formatDate, sortPRs } = require("../scripts/utils.js");

describe("timeAgo", () => {
  it("returns empty string for falsy input", () => {
    assert.equal(timeAgo(""), "");
    assert.equal(timeAgo(null), "");
    assert.equal(timeAgo(undefined), "");
  });

  it("returns empty for invalid dates", () => {
    assert.equal(timeAgo("not-a-date"), "");
  });

  it("returns 'today' for recent timestamps", () => {
    const now = new Date().toISOString();
    assert.equal(timeAgo(now), "today");
  });

  it("returns 'yesterday' for 1 day ago", () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    assert.equal(timeAgo(yesterday), "yesterday");
  });

  it("returns days for < 7 days", () => {
    const threeDays = new Date(Date.now() - 3 * 86400000).toISOString();
    assert.equal(timeAgo(threeDays), "3d ago");
  });

  it("returns weeks for < 30 days", () => {
    const twoWeeks = new Date(Date.now() - 14 * 86400000).toISOString();
    assert.equal(timeAgo(twoWeeks), "2w ago");
  });

  it("returns months for >= 30 days", () => {
    const twoMonths = new Date(Date.now() - 60 * 86400000).toISOString();
    assert.equal(timeAgo(twoMonths), "2mo ago");
  });
});

describe("daysOld", () => {
  it("returns 0 for falsy input", () => {
    assert.equal(daysOld(""), 0);
    assert.equal(daysOld(null), 0);
  });

  it("returns 0 for invalid dates", () => {
    assert.equal(daysOld("invalid"), 0);
  });

  it("returns 0 for today", () => {
    assert.equal(daysOld(new Date().toISOString()), 0);
  });

  it("returns correct day count", () => {
    const fiveDays = new Date(Date.now() - 5 * 86400000).toISOString();
    assert.equal(daysOld(fiveDays), 5);
  });
});

describe("escapeAttr", () => {
  it("escapes ampersands", () => {
    assert.equal(escapeAttr("a&b"), "a&amp;b");
  });

  it("escapes quotes", () => {
    assert.equal(escapeAttr('a"b'), "a&quot;b");
  });

  it("escapes angle brackets", () => {
    assert.equal(escapeAttr("<script>"), "&lt;script&gt;");
  });

  it("handles clean strings", () => {
    assert.equal(escapeAttr("hello world"), "hello world");
  });
});

describe("formatDate", () => {
  it("returns empty for falsy input", () => {
    assert.equal(formatDate(""), "");
    assert.equal(formatDate(null), "");
  });

  it("extracts YYYY-MM-DD from ISO string", () => {
    assert.equal(formatDate("2024-03-15T10:30:00Z"), "2024-03-15");
  });

  it("works with date-only strings", () => {
    assert.equal(formatDate("2024-03-15"), "2024-03-15");
  });
});

describe("sortPRs", () => {
  const prs = [
    { title: "A", comments: 3, created: "2024-01-01T00:00:00Z", updated: "2024-01-03T00:00:00Z" },
    { title: "B", comments: 10, created: "2024-01-02T00:00:00Z", updated: "2024-01-01T00:00:00Z" },
    { title: "C", comments: 1, created: "2024-01-03T00:00:00Z", updated: "2024-01-02T00:00:00Z" },
  ];

  it("sorts by comments descending", () => {
    const sorted = sortPRs(prs, "comments");
    assert.deepEqual(sorted.map(p => p.title), ["B", "A", "C"]);
  });

  it("sorts by created descending", () => {
    const sorted = sortPRs(prs, "created");
    assert.deepEqual(sorted.map(p => p.title), ["C", "B", "A"]);
  });

  it("sorts by updated descending (default)", () => {
    const sorted = sortPRs(prs, "updated");
    assert.deepEqual(sorted.map(p => p.title), ["A", "C", "B"]);
  });

  it("does not mutate original array", () => {
    const original = [...prs];
    sortPRs(prs, "comments");
    assert.deepEqual(prs, original);
  });
});
