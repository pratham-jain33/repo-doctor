/* Verifies the 25-repo selection cap in app.js using a DOM stub.
   Run: node test_cap.js */
const vm = require("vm");
const fs = require("fs");
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
  fetch: async () => { throw { type: "network" }; },
  URL: { createObjectURL: () => "", revokeObjectURL: () => {} },
  Blob: function () {},
  ...checks,
};
sandbox.window = sandbox; // icons() checks window.lucide
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

// seed 30 fake repos
V(`state.repos = ${JSON.stringify(Array.from({ length: 30 }, (_, i) => ({
  name: "repo-" + i, fork: false, description: "", stargazers_count: 0,
  pushed_at: new Date().toISOString(), html_url: "", topics: [],
  homepage: "", license: null,
})))}`);

// 1. individual toggles can never exceed 25
for (let i = 0; i < 30; i++) V(`toggleRepo("repo-${i}", true)`);
check("30 toggles -> exactly 25 selected", V("state.selected.size") === 25);
check("repo-29 rejected at cap", V('state.selected.has("repo-29")') === false);

// 2. deselect one, select another -> back to 25, never 26
V('toggleRepo("repo-0", false)');
check("deselect works", V("state.selected.size") === 24);
V('toggleRepo("repo-29", true)');
check("reselect fills to 25", V("state.selected.size") === 25);
V('toggleRepo("repo-0", true)');
check("26th still rejected", V("state.selected.size") === 25);

// 3. select-all respects the cap
V("state.selected.clear()");
els["select-all"]._listeners.click();
check("select-all -> exactly 25", V("state.selected.size") === 25);

// 4. clear works
els["select-none"]._listeners.click();
check("clear empties", V("state.selected.size") === 0);

// 5. run button disabled with nothing selected
check("run disabled at 0", els["run-audit"].disabled === true);
V('toggleRepo("repo-1", true)');
check("run enabled at 1", els["run-audit"].disabled === false);

// 6. counter text reflects the cap
check("counter shows 1 / 25", els["select-counter"].textContent === "1 / 25 selected");

// 7. token tier: cap becomes min(100, repos found) = 30 here
V('state.selected.clear(); state.token = "fake"; state.tokenLogin = "tester"');
for (let i = 0; i < 30; i++) V(`toggleRepo("repo-${i}", true)`);
check("token tier: 30 toggles all selected", V("state.selected.size") === 30);
check("counter shows 30 / 30 (honest cap)", els["select-counter"].textContent === "30 / 30 selected");
V('state.selected.clear()');
els["select-all"]._listeners.click();
check("token tier: select-all takes all 30 visible", V("state.selected.size") === 30);

// 8. dropping the token restores the 25 cap
V('state.token = ""; state.tokenLogin = ""');
V('state.selected.clear()');
for (let i = 0; i < 30; i++) V(`toggleRepo("repo-${i}", true)`);
check("free tier again: capped at 25", V("state.selected.size") === 25);

// 8b. exclude-forks defaults to OFF and is never persisted
check("excludeForks defaults to false", V("state.excludeForks") === false);

// 9. exclude-forks drops forks from the working set AND the selection
V(`state.fetchedRepos = ${JSON.stringify([
  {name:"keep", fork:false}, {name:"forked", fork:true}
])}`);
V('state.selected.clear(); state.selected.add("keep"); state.selected.add("forked")');
V('state.excludeForks = true; applyRepoFilters()');
check("forks excluded from working set",
  V("state.repos.length") === 1 && V('state.repos[0].name') === "keep");
check("forks dropped from selection",
  V("state.selected.size") === 1 && V('state.selected.has("keep")'));
V('state.excludeForks = false; applyRepoFilters()');
check("unchecking brings forks back", V("state.repos.length") === 2);

// 10. custom checkbox markup present in picker rows
V('state.excludeForks = true; applyRepoFilters()');
V('state.selected.clear()');
V('renderPicker()');
check("rows use custom checkbox UI",
  els["repo-list"].innerHTML.includes('class="custom-check"'));
check("no native checkbox styling leak",
  !els["repo-list"].innerHTML.includes('data-lucide="hide-forks"'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
