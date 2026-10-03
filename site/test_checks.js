const {
  parseReadme,
  sectionPresent,
  auditRepoMeta,
  auditReadme,
  auditProtection,
  scoreFor,
} = require("./checks.js");

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", name); }
}

// --- heading parsing ---
const md1 = "# my-project\n\nDoes things well.\n\n## Installation\n\nnpm i\n";
const p1 = parseReadme(md1);
check("title heading found", p1.headings[0] === "my-project");
check("h2 found", p1.headings.includes("Installation"));
check("description extracted", p1.description === "Does things well.");

// badges and images skipped for description
const md2 = "# t\n\n![badge](x) [![c](d)](e)\n\nReal description here now.\n";
check("badges skipped", parseReadme(md2).description === "Real description here now.");

// h4+ not treated as sections
const md3 = "# t\n\nDesc here is long enough yes.\n\n#### tiny\n";
check("h4 ignored", parseReadme(md3).headings.length === 1);

// --- section matching ---
check("install keyword", sectionPresent(["Installation Guide"], ["install"]));
check("tech stack keyword", sectionPresent(["Tech Stack"], ["tech"]));
check("no false positive", !sectionPresent(["Introduction"], ["install"]));
check("case insensitive", sectionPresent(["HOW TO USE"], ["how to use"]));
check("emoji heading", sectionPresent(["Tech/framework used"], ["tech"]));

// --- readme audit ---
const good = "# t\n\nA proper description that is long enough.\n\n## Motivation\n\nwhy\n\n## Tech Stack\n\nx\n\n## Features\n\nx\n\n## Installation\n\nx\n\n## How to use\n\nx\n";
const r1 = auditReadme(good);
check("good readme: no missing", r1.missing.length === 0);

const r2 = auditReadme(null);
check("null readme flagged", r2.missing.includes("readme: README.md missing"));

const r3 = auditReadme("# t\n\nshort\n");
check("short desc flagged", r3.missing.includes("readme: no real description under the title"));
check("missing sections counted", r3.missing.length === 1 + 5);

// --- meta audit ---
const repoFull = { description: "d", homepage: "https://x.com", topics: ["a"], license: { spdx_id: "MIT" } };
check("full meta clean", auditRepoMeta(repoFull).missing.length === 0);

const repoEmpty = { description: "", homepage: "", topics: [], license: null };
const m2 = auditRepoMeta(repoEmpty).missing;
check("empty meta: 4 missing", m2.length === 4);
check("desc flagged", m2.includes("about: description is empty"));
check("homepage flagged", m2.includes("about: website link is empty"));
check("topics flagged", m2.includes("about: no topics/tags"));
check("license flagged", m2.includes("license: no LICENSE file detected"));

// --- scoring ---
check("perfect score", scoreFor(0, 0) === 100);
check("missing penalty", scoreFor(1, 0) === 88);
check("warning penalty", scoreFor(0, 1) === 96);
check("floor at zero", scoreFor(50, 50) === 0);


// --- branch protection ---
check("unprotected branch is missing", auditProtection(false).missing.includes("protection: default branch is not protected"));
check("protected branch is clean", auditProtection(true).missing.length === 0 && auditProtection(true).warnings.length === 0);
check("unchecked protection is not flagged", auditProtection(null).missing.length === 0);
check("protection miss costs 12", scoreFor(1, 0) === 88);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
