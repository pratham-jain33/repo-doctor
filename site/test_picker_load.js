/* Regression test for the "repos found but not found" picker bug (Oct 3, 2026):
   loadRepos() fetched into state.fetchedRepos but checked state.repos.length,
   which is empty on a fresh page load, so it always showed "No public repos"
   and returned before rendering. Flicking the fork filter called
   applyForkFilter()+renderPicker() directly, which is why repos appeared.
   Run: node test_picker_load.js */
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
sandbox.window = sandbox; // icons() checks window.paintIcons
sandbox.document = {
  getElementById: (id) => (els[id] = els[id] || makeEl(id)),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => makeEl("dyn"),
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync("./app.js", "utf8"), sandbox);
const V = (expr) => vm.runInContext(expr, sandbox);

function fakeRepos(n, forks = 0) {
  return Array.from({ length: n }, (_, i) => ({
    name: "r" + i,
    fork: i < forks,
    private: false,
    description: "d",
    stargazers_count: 0,
    pushed_at: new Date().toISOString(),
  }));
}

function stubFetch(repos) {
  sandbox.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => repos,
  });
}

(async () => {
  let pass = 0, fail = 0;
  const check = (name, cond) => {
    if (cond) pass++;
    else { fail++; console.log("FAIL:", name); }
  };

  // 1. Fresh page load: state.repos starts empty, API returns repos.
  //    Must render them, must NOT show "No public repos".
  V('state.repos = []; state.fetchedRepos = []; state.username = "tester"; state.selected.clear(); state.token = ""; state.tokenLogin = ""');
  stubFetch(fakeRepos(42));
  await V("loadRepos()");
  check("fresh load: no error card", els["picker-error"].hidden === true);
  check("fresh load: working set populated", V("state.repos.length") === 42);
  check("fresh load: count shows 42", els["repo-count"].textContent === 42);
  check("fresh load: cap shows 25", els["pick-cap"].textContent === 25);

  // 2. Genuinely empty account still shows the error.
  stubFetch([]);
  await V("loadRepos()");
  check("empty account: error shown", els["picker-error"].hidden === false);
  check("empty account: title is 'No public repos'",
    els["picker-error-title"].textContent === "No public repos");

  // 3. exclude-forks checked at load time filters the working set.
  els["exclude-forks"].checked = true;
  stubFetch(fakeRepos(10, 4));
  await V("loadRepos()");
  check("exclude-forks on load: forks filtered", V("state.repos.length") === 6);
  check("exclude-forks on load: count shows 6", els["repo-count"].textContent === 6);
  check("exclude-forks on load: no error card", els["picker-error"].hidden === true);
  els["exclude-forks"].checked = false;

  // 4. The cap is honest: min(tier cap, repos actually found).
  V('state.repos = []; state.fetchedRepos = []; state.username = "tester"; state.selected.clear(); state.token = "fake"; state.tokenLogin = "tester"');
  stubFetch(fakeRepos(43));
  await V("loadRepos()");
  check("43 repos, token tier: header says pick up to 43",
    els["pick-cap"].textContent === 43);
  check("43 repos, token tier: counter shows 0 / 43",
    els["select-counter"].textContent === "0 / 43 selected");
  check("effectiveCap() is 43, not 100", V("effectiveCap()") === 43);
  els["select-all"]._listeners.click();
  check("select-all takes all 43", V("state.selected.size") === 43);
  check("counter shows 43 / 43 selected",
    els["select-counter"].textContent === "43 / 43 selected");

  // 5. the username/username profile repo is special: never picked up, for anyone.
  V('state.repos = []; state.fetchedRepos = []; state.username = "tester"; state.selected.clear(); state.token = ""; state.tokenLogin = ""');
  els["exclude-forks"].checked = false;
  stubFetch([...fakeRepos(5), { name: "tester", fork: false, private: false, description: "profile", stargazers_count: 0, pushed_at: new Date().toISOString() }]);
  await V("loadRepos()");
  check("profile repo excluded from working set", V("state.repos.length") === 5);
  check("profile repo not in fetched set", V('!state.fetchedRepos.some((r) => r.name === "tester")'));
  check("count excludes profile repo", els["repo-count"].textContent === 5);

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
