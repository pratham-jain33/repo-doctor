/* repo-doctor checks: pure audit logic, no DOM, no network.
   Mirrors repo_doctor.py so the CLI and the website grade identically.
   Testable in node: `node test_checks.js` */

const REQUIRED_SECTIONS = [
  ["motivation", ["motivation", "why"]],
  ["tech/framework used", ["tech", "framework", "built with", "stack"]],
  ["features", ["feature"]],
  ["installation", ["install", "getting started", "setup"]],
  ["how to use", ["how to use", "usage", "quick start", "quickstart"]],
];

const RECOMMENDED_SECTIONS = [
  ["build status", ["build status", "ci "]],
  ["code style", ["code style", "style guide"]],
  ["screenshots", ["screenshot", "screenshots", "demo", "preview"]],
  ["code example", ["code example", "example"]],
  ["api reference", ["api reference"]],
  ["tests", ["test", "testing"]],
];

const MIN_DESCRIPTION_LEN = 20;

function norm(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, "");
}

function parseReadme(md) {
  const headings = [];
  const lines = md.split("\n");
  for (const line of lines) {
    const m = line.match(/^\s{0,3}#{1,3}\s+(.+?)\s*$/);
    if (m) headings.push(m[1].trim());
  }

  // Description = first substantial text after the title heading,
  // skipping badges, images and html blocks.
  let description = "";
  let pastTitle = false;
  for (const line of lines) {
    const s = line.trim();
    if (!pastTitle) {
      if (/^\s{0,3}#{1,3}\s+/.test(line)) pastTitle = true;
      continue;
    }
    if (!s) continue;
    if (s.startsWith("#")) continue;
    if (s.startsWith("![") || s.startsWith("[!")) continue;
    if (/^<(p|div|img|a|br)/i.test(s)) continue;
    description = s;
    break;
  }
  return { headings, description };
}

function sectionPresent(headings, keywords) {
  const clean = headings.map(norm);
  for (const kw of keywords) {
    for (const h of clean) {
      if (h.includes(kw)) return true;
    }
  }
  return false;
}

/* repo = GitHub API repo object. Checks the About box + license. */
function auditRepoMeta(repo) {
  const missing = [];
  const warnings = [];
  if (!((repo.description || "").trim())) missing.push("about: description is empty");
  if (!((repo.homepage || "").trim())) missing.push("about: website link is empty");
  if (!(repo.topics && repo.topics.length)) missing.push("about: no topics/tags");
  if (!repo.license || repo.license.spdx_id === "NOASSERTION") {
    missing.push("license: no LICENSE file detected");
  }
  return { missing, warnings };
}

/* isProtected: true/false from the branches API, or null when it could not be checked. */
function auditProtection(isProtected) {
  const missing = [];
  const warnings = [];
  if (isProtected === false) missing.push("protection: default branch is not protected");
  return { missing, warnings };
}

/* md = README markdown string, or null when the repo has no README. */
function auditReadme(md) {
  const missing = [];
  const warnings = [];
  if (md === null || md === undefined) {
    missing.push("readme: README.md missing");
    return { missing, warnings };
  }
  const { headings, description } = parseReadme(md);
  if (!headings.length) missing.push("readme: no title heading found");
  if (description.length < MIN_DESCRIPTION_LEN) {
    missing.push("readme: no real description under the title");
  }
  for (const [display, keywords] of REQUIRED_SECTIONS) {
    if (!sectionPresent(headings, keywords)) {
      missing.push(`readme: missing '${display}' section`);
    }
  }
  for (const [display, keywords] of RECOMMENDED_SECTIONS) {
    if (!sectionPresent(headings, keywords)) {
      warnings.push(`readme: no '${display}' section`);
    }
  }
  return { missing, warnings };
}

function scoreFor(missingCount, warningCount) {
  return Math.max(0, 100 - missingCount * 12 - warningCount * 4);
}

if (typeof module !== "undefined") {
  module.exports = {
    REQUIRED_SECTIONS,
    RECOMMENDED_SECTIONS,
    norm,
    parseReadme,
    sectionPresent,
    auditRepoMeta,
    auditReadme,
    auditProtection,
    scoreFor,
  };
}
