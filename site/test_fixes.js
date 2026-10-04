/* Tests for the v0.2 AI fix engine: issue->fix mapping, prompt building,
   JSON parsing with attribution enforcement, markdown preview, base64,
   and the MIT license text. Run: node test_fixes.js */
const vm = require("vm");
const fs = require("fs");
const { TextEncoder, TextDecoder } = require("util");
const checks = require("./checks.js");

function makeEl(id) {
  return {
    id,
    hidden: true,
    textContent: "",
    innerHTML: "",
    disabled: false,
    value: "",
    checked: false,
    style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    _listeners: {},
    addEventListener(type, fn) { this._listeners[type] = fn; },
    appendChild() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    click() {},
  };
}

const els = {};
const sandbox = {
  console,
  performance: { now: () => 0 },
  requestAnimationFrame: () => {},
  CSS: { escape: (s) => s },
  TextEncoder,
  TextDecoder,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  fetch: async () => { throw { type: "network" }; },
  localStorage: { _s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem(k, v) { this._s[k] = String(v); },
    removeItem(k) { delete this._s[k]; } },
  URL: { createObjectURL: () => "", revokeObjectURL: () => {} },
  Blob: function () {},
  ...checks,
};
sandbox.window = sandbox;
sandbox.document = {
  getElementById: (id) => (els[id] = els[id] || makeEl(id)),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => makeEl("dyn"),
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync("./app.js", "utf8"), sandbox);
const V = (expr) => vm.runInContext(expr, sandbox);

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.log("FAIL:", name); }
}

// 1. issue -> fix mapping
const kinds = V(`fixKinds({ missing: ["readme: README.md missing", "about: no topics/tags"], warnings: ["readme: no 'Tests' section"] })`);
check("readme kind detected", kinds.readme === true);
check("about kind detected", kinds.about === true);
check("license kind absent", kinds.license === false);
const kinds2 = V(`fixKinds({ missing: ["license: no LICENSE file detected"], warnings: [] })`);
check("license kind detected", kinds2.license === true && kinds2.readme === false);
const kinds3 = V(`fixKinds({ missing: [], warnings: [] })`);
check("clean repo: no kinds", !kinds3.readme && !kinds3.about && !kinds3.license);

// 2. prompt carries the house standard and the attribution, and bans the dropped sections
const prompt = V(`buildFixPrompt({ owner: "tester", repo: { name: "demo", description: "", language: "Python", stargazers_count: 3, topics: [] }, files: ["main.py"], manifestName: "", manifestBody: "", existing: null })`);
check("prompt has Motivation section", prompt.system.includes("## Motivation"));
check("prompt has Installation section", prompt.system.includes("## Installation"));
check("prompt bans Contribute section", /do NOT write Contribute/i.test(prompt.system));
check("prompt ends README with attribution", prompt.system.includes("*Created with [repo-doctor](https://prathamjain.com/projects/repo-doctor)*"));
check("prompt demands JSON only", prompt.system.includes("ONLY a JSON object"));
check("user prompt includes file list", prompt.user.includes("main.py"));

// 3. JSON parsing: fences stripped, attribution enforced, garbage rejected.
// pj() passes objects through JSON.stringify twice so the vm receives valid JSON text.
const pj = (obj) => V(`parseFixJson(${JSON.stringify(JSON.stringify(obj))})`);
const good = pj({ readme: "# Demo\n\nCool thing.", description: "Does things", topics: ["AI Tools", "demo"] }).readme;
check("attribution appended to readme", good.includes("*Created with [repo-doctor](https://prathamjain.com/projects/repo-doctor)*"));
check("attribution is at the very end", good.trimEnd().endsWith("*Created with [repo-doctor](https://prathamjain.com/projects/repo-doctor)*"));
const fencedStr = "```json\n" + JSON.stringify({ readme: "# Hi", description: "d", topics: [] }) + "\n```";
const fenced = V(`parseFixJson(${JSON.stringify(fencedStr)})`).description;
check("fenced JSON parsed", fenced === "d");
const topicsNorm = pj({ readme: "# Hi", description: "d", topics: ["AI Tools", "My Topic"] }).topics;
check("topics normalized lowercase-hyphen", JSON.stringify(topicsNorm) === '["ai-tools","my-topic"]');
let threw = false;
try { V(`parseFixJson("not json at all")`); } catch (e) { threw = true; }
check("garbage JSON throws badjson", threw);
let threw2 = false;
try { pj({ description: "no readme field" }); } catch (e) { threw2 = true; }
check("missing readme field throws", threw2);
// attribution not duplicated when the model already added it
const dup = pj({ readme: "# Hi\n---\n*Created with [repo-doctor](https://prathamjain.com/projects/repo-doctor)*", description: "d", topics: [] }).readme;
check("attribution not duplicated", (dup.match(/Created with \[repo-doctor\]/g) || []).length === 1);
// the --- separator must be wrapped in blank lines, or GitHub reads
// "paragraph\n---" as a setext heading and renders the last paragraph huge
check("footer --- has blank line before it", /\n\n---\n/.test(good));
check("footer --- has blank line after it", /---\n\n\*Created with/.test(good));
// old-format footers (no blank lines) are still stripped, not duplicated
const oldf = pj({ readme: "# Hi\nSome text.\n---\n*Created with [repo-doctor](https://prathamjain.com/projects/repo-doctor)*", description: "d", topics: [] }).readme;
check("old footer format stripped and fixed", (oldf.match(/Created with \[repo-doctor\]/g) || []).length === 1 && /\n\n---\n\n\*Created with/.test(oldf));

// 3b. website field: copied from evidence, never invented
const w1 = pj({ readme: "# Hi", description: "d", topics: [], website: "https://demo.example.com" }).website;
check("valid website kept", w1 === "https://demo.example.com");
const w2 = pj({ readme: "# Hi", description: "d", topics: [], website: "not a url" }).website;
check("non-url website rejected", w2 === "");
const w3 = pj({ readme: "# Hi", description: "d", topics: [], website: "https://github.com/pratham-jain33/keysync" }).website;
check("github repo url rejected as website", w3 === "");
const w4 = pj({ readme: "# Hi", description: "d", topics: [] }).website;
check("missing website defaults to empty", w4 === "");
check("prompt asks for website from evidence", prompt.system.includes("\"website\"") && prompt.system.includes("Never invent"));
check("prompt guides build status section", prompt.system.includes("## Build status") && prompt.system.includes("never invent a badge"));
check("prompt guides code style and api reference", prompt.system.includes("## Code style") && prompt.system.includes("## API reference"));

// 3d. section notes + screenshots are woven into the prompt
const prompt3 = V(`buildFixPrompt({ owner: "o", repo: { name: "r", description: "", language: "", stargazers_count: 0, topics: [] }, files: [], manifestName: "", manifestBody: "", existing: null, sectionHints: {"build status": "CI runs on push"}, screenshots: ["docs/screenshots/a.png"] })`);
check("prompt weaves section notes", /\n- build status: CI runs on push\n/.test(prompt3.system));
check("prompt instructs screenshots section", prompt3.system.includes("## Screenshots") && prompt3.system.includes("docs/screenshots/a.png"));
const prompt4 = V(`buildFixPrompt({ owner: "o", repo: { name: "r", description: "", language: "", stargazers_count: 0, topics: [] }, files: [], manifestName: "", manifestBody: "", existing: null })`);
check("prompt omits notes block when empty", !prompt4.system.includes("User notes for flagged"));

// 3f. the AI reads code, not just the file list
check("picks up source files", V(`isCodeFile("src/main.py")`) === true && V(`isCodeFile("app.ts")`) === true);
check("skips vendored dirs", V(`isCodeFile("node_modules/foo/index.js")`) === false);
check("picks up CI workflows", V(`isCodeFile(".github/workflows/ci.yml")`) === true);
check("main scores above deep files", V(`codeScore("main.py")`) > V(`codeScore("src/deep/util.py")`));
const prompt5 = V(`buildFixPrompt({ owner: "o", repo: { name: "r", description: "", language: "", stargazers_count: 0, topics: [] }, files: [], manifestName: "", manifestBody: "", existing: null, codeContext: "--- a.py --- print(1)" })`);
check("prompt includes source files", prompt5.user.includes("--- source files") && prompt5.user.includes("--- a.py ---"));
check("prompt tells AI to read code", prompt5.system.includes("Read the source files"));

// 3f. stale-audit UX: results show their age, success card closes the loop
check("auditAgo just now", V(`auditAgo(Date.now())`) === "just now");
check("auditAgo minutes", V(`auditAgo(Date.now() - 5*60000)`) === "5 min ago");
check("auditAgo hours", V(`auditAgo(Date.now() - 3*3600000)`) === "3 hr ago");
check("auditAgo empty", V(`auditAgo(0)`) === "");
check("repo timeAgo untouched", V(`timeAgo(new Date(Date.now() - 2*86400000).toISOString())`) === "2d ago");

// 3h. picker shows last-audit scores, worst and oldest first
V(`state.results = [
  { name: "bad", missing: ["a","b"], warnings: [] },
  { name: "ok", missing: [], warnings: [] },
]`);
check("lastScore bad", V(`lastScore("bad")`) === 76);
check("lastScore ok", V(`lastScore("ok")`) === 100);
check("lastScore unknown", V(`lastScore("nope")`) === null);
const sorted = V(`sortPickerRepos([
  { name: "ok", pushed_at: "2026-10-01T00:00:00Z" },
  { name: "new", pushed_at: "2026-10-04T00:00:00Z" },
  { name: "bad", pushed_at: "2026-10-03T00:00:00Z" },
  { name: "old", pushed_at: "2025-01-01T00:00:00Z" },
]).map((r) => r.name)`);
check("worst first, unscored oldest-first last", JSON.stringify(sorted) === JSON.stringify(["bad","ok","old","new"]));
V(`state.results = []`);
// 3i. mini ring on the picker
const ring = V(`miniRing(28)`);
check("mini ring shows score", ring.includes(">28<") && ring.includes("mini-ring"));
check("mini ring red for low", ring.includes("var(--red)"));
check("mini ring green for high", V(`miniRing(95)`).includes("var(--green)"));
// 3j. results persist so scores survive reloads
V(`state.username = "u"; state.results = [{ name: "a", missing: ["x"], warnings: [] }]; state.auditedAt = 12345;`);
V(`(function(){ try { localStorage.setItem("rd_results_" + state.username, JSON.stringify({ at: state.auditedAt, results: state.results })); } catch (e) {} })()`);
V(`state.results = []; state.auditedAt = 0; restoreResults();`);
check("restoreResults round-trip", V(`state.results.length`) === 1 && V(`state.auditedAt`) === 12345 && V(`lastScore("a")`) === 88);
V(`state.results = []; state.auditedAt = 0; state.username = "";`);
// 3l. READMEs are read at fetch time; the audit reuses them
V(`state.repos = [{ name: "r", description: "d", homepage: "", topics: [], license: { spdx_id: "MIT" }, pushed_at: "2026-01-01T00:00:00Z" }];`);
V(`state.readmes = { r: ["# r", "", "A fine repo description here.", "", "## Motivation", "X", "", "## Tech stack", "X", "", "## Features", "X", "", "## Installation", "X", "", "## Usage", "X", ""].join(String.fromCharCode(10)) };`);
const rs = V(`readmeScore("r")`);
check("readmeScore partial (no protection penalty)", rs === 52);
check("readmeScore unknown repo", V(`readmeScore("nope")`) === null);
V(`state.results = [{ name: "r", missing: ["a","b","c"], warnings: [] }];`);
check("ringScore prefers full audit score", V(`ringScore("r")`) === 64);
V(`state.results = [];`);
check("ringScore falls back to partial", V(`ringScore("r")`) === 52);
V(`state.readmeError = {};`);
V(`state.repos = []; state.readmes = {}; state.results = [];`);

// 3k. auto-badges from data we already have
check("shield url", V(`shield("License", "MIT", "yellow")`) === "![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)");
check("manifestVersion pyproject", V(`manifestVersion("pyproject.toml", '[project]\\nversion = "0.1.0"')`) === "0.1.0");
check("manifestVersion package.json", V(`manifestVersion("package.json", '{"version": "2.3.4"}')`) === "2.3.4");
check("langVersion python", V(`manifestLangVersion("pyproject.toml", 'requires-python = ">=3.10"')`) === "3.10+");
const badges = V(`buildBadges({ license: { spdx_id: "MIT" }, language: "Python" }, "pyproject.toml", 'requires-python = ">=3.10"\\nversion = "0.1.0"')`);
check("buildBadges three badges", badges.split("![").length === 4 && badges.includes("img.shields.io"));
check("buildBadges skips unknown license", V(`buildBadges({ license: { spdx_id: "NOASSERTION" } }, "", "")`) === "");
const prompt6 = V(`buildFixPrompt({ owner: "o", repo: { name: "r", description: "", language: "", stargazers_count: 0, topics: [] }, files: [], manifestName: "", manifestBody: "", existing: null, codeContext: "", badges: "![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)" })`);
check("prompt places badges under title", prompt6.user.includes("badges (place on their own line directly under the title;"));
check("badges separated from description by blank line", prompt6.system.includes("[badges from the context \u2014 badges only on this line, nothing else]"));


// 3g. the AI writes everything except screenshots — no notes needed
check("only screenshots may be skipped", prompt5.system.includes("the ONLY section you may skip is Screenshots"));
check("build status without CI", prompt5.system.includes("when there is no CI, write how to build and verify"));
check("code style from observed code", prompt5.system.includes("describe the style observed in the source files"));
check("never invent", prompt5.system.includes("Never invent facts"));
check("tests rule uses test files", prompt5.system.includes("test files in the source"));


// 3e. screenshot filename sanitizing
check("shot name sanitized", V(`sanitizeShotName("My Photo.PNG", new Set())`) === "my-photo.png");
check("shot name deduped", V(`sanitizeShotName("a.png", new Set(["a.png"]))`) === "a-2.png");

// 3c. fixKinds picks up the protection kind
const kindsP = V(`fixKinds({missing: ["protection: default branch is not protected"], warnings: []})`);
check("fixKinds flags protection", kindsP.protection === true && kindsP.readme === false);
const kindsC = V(`fixKinds({missing: [], warnings: []})`);
check("fixKinds clean when nothing missing", kindsC.protection === false);

// 4. markdown preview renderer
const html = V(`mdToHtml('# Title\\n\\nHello **bold** and \`code\`.\\n\\n- one\\n- two\\n\\n[link](https://x.com)\\n\\n---\\n\\n\`\`\`\\ncode()\\n\`\`\`')`);
check("h1 rendered", html.includes("<h1>Title</h1>"));
check("bold rendered", html.includes("<strong>bold</strong>"));
check("inline code rendered", html.includes("<code>code</code>"));
check("list rendered", html.includes("<ul>") && html.includes("<li>one</li>"));
check("link rendered with rel", html.includes('rel="noopener"'));
check("hr rendered", html.includes("<hr>"));
check("fence rendered", html.includes("<pre><code>code()</code></pre>"));
const xss = V(`mdToHtml('<script>alert(1)</script>')`);
check("html escaped in preview", !xss.includes("<script>") && xss.includes("&lt;script&gt;"));

// 5. base64 roundtrip incl. unicode (decoded outside the vm sandbox)
const b64 = V(`toB64("hello wörld ✓")`);
const roundtrip = Buffer.from(b64, "base64").toString("utf8");
check("toB64 roundtrips unicode", roundtrip === "hello wörld ✓");

// 6. MIT license text
const year = new Date().getFullYear();
const lic = V(`mitLicense("tester")`);
check("license has year and owner", lic.includes(String(year)) && lic.includes("tester"));
check("license is MIT", lic.startsWith("MIT License"));

// 7. groq key defaults to empty (BYOK, never prefilled), model is gpt-oss-120b
check("groqKey defaults empty", V("state.groqKey") === "");
check("uses gpt-oss-120b", V("GROQ_MODEL") === "openai/gpt-oss-120b");

// 8. connectGroq touches only elements that exist (regression: it once
//    referenced the removed #groq-promo, so valid keys died silently).
// 3n. targeted mode: only flagged sections are generated and spliced in
V(`state.results = [{ name: "MoCode", missing: [], warnings: ["readme: no 'screenshots' section"] }]`);
check("flaggedSections extracts screenshots", JSON.stringify(V(`flaggedSections("MoCode")`)) === '["screenshots"]');
V(`state.results = [{ name: "X", missing: ["readme: missing 'tests' section", "readme: no real description under the title"], warnings: [] }]`);
check("flaggedSections extracts missing", JSON.stringify(V(`flaggedSections("X")`)) === '["tests"]');
const tctx = { owner: "u", repo: { name: "MoCode", description: "", language: "JavaScript", stargazers_count: 0, topics: [] }, files: ["index.html"], manifestName: "", manifestBody: "", codeContext: "", existing: "# MoCode\n\nA morse translator.\n\n## Features\n\n- x\n", sectionHints: {}, screenshots: ["docs/screenshots/a.png"] };
const tp = V(`buildSectionsPrompt(${JSON.stringify(tctx).replace(/`/g, "\`")}, ["screenshots"])`);
check("targeted prompt names the section", tp.system.includes("Write ONLY these sections: screenshots"));
check("targeted prompt has screenshots guidance", tp.system.includes("## Screenshots"));
check("targeted prompt omits other guidance", !tp.system.includes("## Motivation"));
check("targeted prompt includes shot paths", tp.system.includes("docs/screenshots/a.png"));
check("targeted prompt shows existing README", tp.user.includes("# MoCode"));
const parsed = V(`parseSectionsJson(JSON.stringify({sections: {screenshots: "## Screenshots\\n![a](docs/screenshots/a.png)"}, description: "About one-liner", topics: ["morse"], website: ""}))`);
check("parseSectionsJson sections", parsed.sections.screenshots.includes("## Screenshots"));
check("parseSectionsJson about fields", parsed.description === "About one-liner" && parsed.topics[0] === "morse");
const merged = V(`spliceSections("# MoCode\\n\\nA morse translator.\\n\\n## Features\\n\\n- x\\n", {"screenshots": "## Screenshots\\n![a](docs/screenshots/a.png)"})`);
check("splice inserts after existing sections", merged.indexOf("## Features") < merged.indexOf("## Screenshots"));
check("splice preserves existing content", merged.includes("A morse translator.") && merged.includes("- x"));
check("splice adds attribution", merged.includes("Created with"));
const merged2 = V(`spliceSections("# T\\n\\nDesc.\\n\\n## Tests\\n\\nRun npm test.\\n", {"motivation": "## Motivation\\nWhy.", "description": "A fresh one-liner."})`);
check("splice inserts motivation before tests", merged2.indexOf("## Motivation") < merged2.indexOf("## Tests"));
check("splice description has no heading", !merged2.includes("## description") && merged2.includes("A fresh one-liner."));
check("splice description sits under title", merged2.indexOf("# T") < merged2.indexOf("A fresh one-liner.") && merged2.indexOf("A fresh one-liner.") < merged2.indexOf("## Motivation"));

// 3o. targeted prompt with no sections still asks for About-box fields
const tp0 = V(`buildSectionsPrompt(${JSON.stringify(tctx).replace(/`/g, "\\`")}, [])`);
check("empty sections prompt mentions none", tp0.system.includes("Write ONLY these sections: (none"));
check("empty sections prompt wants about fields", tp0.system.includes("About-box one-liner"));

// 3m. screenshot uploads give immediate visual feedback
const __stagedEl = { innerHTML: "", querySelectorAll() { return []; } };
sandbox.__w = {
  closest: () => ({ _fixState: { hints: {}, shots: [{ file: "a.png", b64: "QUJD", type: "image/png" }] } }),
  querySelector: () => __stagedEl,
};
V(`renderShotStaged(__w)`);
check("shot thumbnails render", __stagedEl.innerHTML.includes("shot-thumb") && __stagedEl.innerHTML.includes("data:image/png;base64,QUJD"));
check("shot count note", __stagedEl.innerHTML.includes("1 screenshot ready"));
const __stagedEl2 = { innerHTML: "x", querySelectorAll() { return []; } };
sandbox.__w2 = {
  closest: () => ({ _fixState: { hints: {}, shots: [] } }),
  querySelector: () => __stagedEl2,
};
V(`renderShotStaged(__w2)`);
check("no shots renders empty", __stagedEl2.innerHTML === "");

(async () => {
  // repo filters live on the home screen, before fetching
  V(`state.fetchedRepos = [
    { name: "a", fork: false, private: false },
    { name: "b", fork: true, private: false },
    { name: "c", fork: false, private: true },
  ]; state.selected = new Set(["b"]);`);
  V(`state.excludeForks = true; state.excludePrivate = false; applyRepoFilters();`);
  check("exclude forks", JSON.stringify(V(`state.repos.map((r) => r.name)`)) === JSON.stringify(["a","c"]));
  check("filtered selection dropped", V(`state.selected.has("b")`) === false);
  V(`state.excludeForks = false; state.excludePrivate = true; applyRepoFilters();`);
  check("exclude private", JSON.stringify(V(`state.repos.map((r) => r.name)`)) === JSON.stringify(["a","b"]));
  V(`state.excludeForks = true; state.excludePrivate = true; applyRepoFilters();`);
  check("exclude both", JSON.stringify(V(`state.repos.map((r) => r.name)`)) === JSON.stringify(["a"]));
  V(`state.fetchedRepos = []; state.repos = []; state.selected = new Set(); state.excludeForks = false; state.excludePrivate = false;`);

  // getReadmeCached reuses the picker's README instead of refetching
  V(`state.repos = [{ name: "r2", description: "d", homepage: "", topics: [], license: { spdx_id: "MIT" } }];`);
  V(`state.readmes = { r2: "# r2" }; V2 = getReadmeCached;`);
  const cached = await V(`getReadmeCached("u", "r2")`);
  check("getReadmeCached reuses (no refetch)", cached === "# r2");
  V(`state.repos = []; state.readmes = {};`);
  sandbox.fetch = async () => ({ ok: true, status: 200 });
  await V('connectGroq("gsk_test123", true)');
  check("valid key: groq-active shown", els["groq-active"].hidden === false);
  check("valid key: groq-form hidden", els["groq-form"].hidden === true);
  check("valid key: state set", V("state.groqKey") === "gsk_test123");
  check("valid key: button restored", els["groq-go"].disabled === false);

  sandbox.fetch = async () => ({ ok: false, status: 401 });
  V('document.getElementById("groq-active").hidden = true; document.getElementById("groq-form").hidden = false; state.groqKey = ""');
  await V('connectGroq("badkey", false)');
  check("invalid key: error shown", els["groq-error"].hidden === false);
  check("invalid key: says invalid or expired", els["groq-error"].textContent.includes("Invalid or expired"));
  check("invalid key: state not set", V("state.groqKey") === "");

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
