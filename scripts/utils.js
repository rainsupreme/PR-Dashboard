// Shared utility functions used by both dashboard.js (browser) and tests (Node).
// In the browser, this file is not loaded — dashboard.js defines these inline.
// In tests, require this module directly.

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "";
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function daysOld(dateStr) {
  if (!dateStr) return 0;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return 0;
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function escapeAttr(str) {
  return str.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function formatDate(isoStr) {
  if (!isoStr) return "";
  return isoStr.slice(0, 10);
}

function sortPRs(prs, sortBy) {
  return [...prs].sort((a, b) => {
    if (sortBy === "comments") return b.comments - a.comments;
    if (sortBy === "created") return new Date(b.created) - new Date(a.created);
    return new Date(b.updated) - new Date(a.updated);
  });
}

if (typeof module !== "undefined") {
  module.exports = { timeAgo, daysOld, escapeAttr, formatDate, sortPRs };
}
