// config.json plus the environment overrides CI sets. One place to read them.
const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "..", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const GITHUB_USER = process.env.DASHBOARD_USER || config.github_user;
const ORGS = config.orgs || (config.org ? [config.org] : []);
// Orgs or owner/repo entries where the dashboard user can merge. Non-empty
// turns on the merger row: project-wide duties only someone with merge rights
// can do.
const MERGE_ACCESS = config.merge_access || [];
const MERGE_LABELS = config.merge_labels || ["to-be-merged"];

module.exports = { config, GITHUB_USER, ORGS, MERGE_ACCESS, MERGE_LABELS };
