/* repo-doctor web app. No build step, no backend.
   Browser talks directly to api.github.com. Nothing is stored anywhere. */

const FREE_CAP = 25;      // unauthenticated: 60 req/hr
const TOKEN_CAP = 100;      // with token: 5,000 req/hr, private repos visible
const TOKEN_KEY = "repo-doctor-token";
const API = "https://api.github.com";

const state = {
  username: "",
  token: "",
  tokenLogin: "",
  groqKey: "",    // BYOK for AI fixes; never leaves the browser except to api.groq.com
  fetchedRepos: [], // everything the API returned, forks included
  repos: [],        // working set after the fork filter
  excludeForks: false, // default off; never persisted, always read from the home checkboxes
  excludePrivate: false,
  selected: new Set(),
  results: [],      // audit results
  auditedAt: 0,
  readmes: {},      // README text per repo, fetched at picker time (batches of 5)
  readmeError: {},  // repos whose README fetch failed; retried in the audit
  readmeFetchId: 0, // cancellation token for the progressive fetch
};

function maxSelection() {
  return state.token ? TOKEN_CAP : FREE_CAP;
}

// The honest cap: never offer more than actually exist.
// "43 repos found, pick up to 100" is nonsense, so it is min(tier cap, repos found).
function effectiveCap() {
  return Math.min(maxSelection(), state.repos.length);
}

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function icons() {
  if (window.paintIcons) paintIcons(); // icons.js, generated via icon-mcp
}

function showScreen(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = true;
  document.getElementById(id).hidden = false;
  window.scrollTo(0, 0);
  icons();
}

function timeAgo(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return days + "d ago";
  if (days < 365) return Math.floor(days / 30) + "mo ago";
  return Math.floor(days / 365) + "y ago";
}

/* ---------------- GitHub API (no token) ---------------- */

async function gh(path, raw = false) {
  const headers = { Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json" };
  if (state.token) headers.Authorization = "Bearer " + state.token;
  let res;
  try {
    res = await fetch(API + path, { headers });
  } catch (e) {
    throw { type: "network" };
  }
  if (res.status === 401) throw { type: "badauth" };
  if (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0") {
    const reset = new Date(Number(res.headers.get("X-RateLimit-Reset")) * 1000);
    throw { type: "ratelimit", reset };
  }
  if (res.status === 404) throw { type: "notfound" };
  if (!res.ok) throw { type: "http", status: res.status };
  return raw ? res.text() : res.json();
}

async function fetchAllRepos(username) {
  const repos = [];
  let page = 1;
  // With a token on your own account, /user/repos includes private repos.
  const base = state.token && state.tokenLogin.toLowerCase() === username.toLowerCase()
    ? "/user/repos"
    : `/users/${encodeURIComponent(username)}/repos`;
  for (;;) {
    const batch = await gh(`${base}?per_page=100&page=${page}&type=owner&sort=updated`);
    repos.push(...batch);
    if (batch.length < 100) break;
    page++;
    if (page > 10) break; // sanity: nobody needs 1000 repos audited
  }
  // The username/username repo is the special profile repo: its README is the
  // GitHub profile page, not a project. It plays by different rules, so it is
  // never fetched into the picker, audited, or fixed — for anyone.
  return repos.filter((r) => r.name.toLowerCase() !== username.toLowerCase());
}

async function fetchReadme(owner, repo) {
  // List the repo root instead of hitting /readme directly. The listing
  // returns HTTP 200 even when no README exists, so missing READMEs no
  // longer spray 404s into the console. The file itself is then downloaded
  // raw, which does not count against the API rate limit.
  const enc = encodeURIComponent;
  let listing;
  try {
    listing = await gh(`/repos/${enc(owner)}/${enc(repo)}/contents/`);
  } catch (e) {
    if (e.type === "notfound") return null; // empty repo
    throw e;
  }
  if (!Array.isArray(listing)) return null;
  const cands = listing.filter((f) => f.type === "file" && /^readme($|\.)/i.test(f.name));
  const entry = cands.find((f) => /\.md$/i.test(f.name)) || cands[0];
  if (!entry || !entry.download_url) return null;
  try {
    // Cache-bust: raw.githubusercontent.com serves stale READMEs for minutes
    // after a push, which once made a re-audit score the pre-fix README.
    const bust = (entry.download_url.includes("?") ? "&" : "?") + "t=" + Date.now();
    const res = await fetch(entry.download_url + bust);
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  }
}

async function fetchBranchProtected(owner, repo, branch) {
  // The branches endpoint is public for public repos and answers with
  // { protected: true/false }. One extra API call per repo.
  try {
    const b = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch || "main")}`);
    return b.protected === true;
  } catch (e) {
    if (e.type === "notfound") return null; // empty repo, no branches yet
    throw e;
  }
}

// Rate-limit and auth failures stop the audit; retry resumes where it left off.
function auditHardStop(e, total, completed) {
  if (e.type !== "ratelimit" && e.type !== "badauth") return false;
  document.getElementById("audit-error-msg").textContent = e.type === "badauth"
    ? "Your token was rejected mid-audit. Reconnect a fresh token on the home page, then retry to pick up where you left off."
    : state.token
      ? `GitHub's rate limit was hit with ${total - completed} repos left unchecked. Try again after ${e.reset.toLocaleTimeString()} — retry resumes where it stopped.`
      : `GitHub's unauthenticated cap is 60 requests an hour, and ${total - completed} repos were not checked. Connect a token on the home page for 5,000/hr and private repos, or try again after ${e.reset.toLocaleTimeString()} — retry resumes where it stopped.`;
  document.getElementById("audit-error").hidden = false;
  icons();
  return true; // keep state.results: retry resumes, nothing is lost
}

/* POST/PUT/PATCH against the GitHub API. Only used for fixes the user
   explicitly applies; the audit itself stays read-only. */
async function ghWrite(method, path, body) {
  const headers = { Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  if (state.token) headers.Authorization = "Bearer " + state.token;
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: JSON.stringify(body) });
  } catch (e) {
    throw { type: "network" };
  }
  if (res.status === 401) throw { type: "badauth" };
  if (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0") {
    const reset = new Date(Number(res.headers.get("X-RateLimit-Reset")) * 1000);
    throw { type: "ratelimit", reset };
  }
  if (res.status === 404) throw { type: "notfound" };
  if (!res.ok) throw { type: "http", status: res.status };
  return res.json();
}

// base64 for the contents API, safe for unicode and large files.
function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/* ---------------- screen 1: username ---------------- */

document.getElementById("username-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("username-input");
  const err = document.getElementById("username-error");
  const username = input.value.trim().replace(/^@/, "");
  if (!username) {
    err.textContent = "Type a GitHub username first.";
    err.hidden = false;
    return;
  }
  err.hidden = true;
  state.username = username;
  state.selected = new Set();
  state.results = [];
  state.readmes = {};
  state.readmeError = {};
  state.readmeFetchId++;
  showScreen("screen-picker");
  await loadRepos();
});

document.getElementById("brand-home").addEventListener("click", (e) => {
  e.preventDefault();
  showScreen("screen-home");
});

/* ---------------- token system ---------------- */

function showTokenActive() {
  document.getElementById("token-form").hidden = true;
  document.getElementById("token-active").hidden = false;
  document.getElementById("token-user").textContent = "@" + state.tokenLogin;
  icons();
}

function forgetToken() {
  state.token = "";
  state.tokenLogin = "";
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  document.getElementById("token-input").value = "";
  document.getElementById("token-active").hidden = true;
  document.getElementById("token-form").hidden = false;
}

async function connectToken(token, remember) {
  const err = document.getElementById("token-error");
  err.hidden = true;
  state.token = token;
  let me;
  try {
    me = await gh("/user");
  } catch (e) {
    state.token = "";
    err.textContent = e.type === "badauth"
      ? "That token was rejected. Check it and try again."
      : "Could not reach GitHub. Check your connection.";
    err.hidden = false;
    return;
  }
  state.tokenLogin = me.login;
  state.username = me.login;
  // A token without the `repo` scope passes /user just fine but gets an
  // empty list from /user/repos. Catch it here with a clear message
  // instead of dumping the user on a confusing empty picker later.
  try {
    const probe = await gh("/user/repos?per_page=1");
    if (!probe.length) {
      const pubProbe = await gh(`/users/${encodeURIComponent(me.login)}/repos?per_page=1`);
      if (pubProbe.length) throw { type: "scopeless" };
    }
  } catch (e) {
    state.token = "";
    err.textContent = e.type === "scopeless"
      ? "Connected, but this token can't see your repositories. Create a classic token with the 'repo' scope checked and try again."
      : "Could not verify the token. Check your connection and try again.";
    err.hidden = false;
    return;
  }
  if (remember) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
  }
  showTokenActive();
  state.selected = new Set();
  state.results = [];
  showScreen("screen-picker");
  await loadRepos();
}

document.getElementById("token-go").addEventListener("click", () => {
  const t = document.getElementById("token-input").value.trim();
  const err = document.getElementById("token-error");
  if (!t) {
    err.textContent = "Paste a token first.";
    err.hidden = false;
    return;
  }
  connectToken(t, document.getElementById("token-remember").checked);
});
document.getElementById("token-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("token-go").click();
});
document.getElementById("token-forget").addEventListener("click", forgetToken);
document.getElementById("token-show").addEventListener("click", (e) => {
  const inp = document.getElementById("token-input");
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  e.target.textContent = show ? "hide" : "show";
});

// Restore a remembered token on load and validate it silently.
(async function initToken() {
  let saved = null;
  try { saved = localStorage.getItem(TOKEN_KEY); } catch (e) {}
  if (!saved) return;
  state.token = saved;
  try {
    const me = await gh("/user");
    state.tokenLogin = me.login;
    showTokenActive();
  } catch (e) {
    state.token = "";
    try { localStorage.removeItem(TOKEN_KEY); } catch (e2) {}
    const note = document.getElementById("token-note");
    note.textContent = "Your saved token was rejected by GitHub, so it was removed. Paste a fresh one to reconnect.";
    note.hidden = false;
  }
})();

/* ---------------- groq BYOK (AI fixes) ---------------- */

const GROQ_KEY = "repo-doctor-groq";

function showGroqActive() {
  document.getElementById("groq-form").hidden = true;
  document.getElementById("groq-active").hidden = false;
  icons();
}

function forgetGroq() {
  state.groqKey = "";
  try { localStorage.removeItem(GROQ_KEY); } catch (e) {}
  document.getElementById("groq-input").value = "";
  document.getElementById("groq-active").hidden = true;
  document.getElementById("groq-form").hidden = false;
}

async function connectGroq(key, remember) {
  const err = document.getElementById("groq-error");
  const btn = document.getElementById("groq-go");
  err.hidden = true;
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = `<span class="spin"></span>Checking...`;
  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: "Bearer " + key },
    });
  } catch (e) {
    err.textContent = "Could not reach Groq. Check your connection and try again.";
    err.hidden = false;
    btn.disabled = false;
    btn.innerHTML = orig;
    icons();
    return;
  }
  btn.disabled = false;
  btn.innerHTML = orig;
  if (!res.ok) {
    err.textContent = "Invalid or expired key. Check it and try again.";
    err.hidden = false;
    icons();
    return;
  }
  state.groqKey = key;
  if (remember) {
    try { localStorage.setItem(GROQ_KEY, key); } catch (e) {}
  }
  showGroqActive();
}

document.getElementById("groq-go").addEventListener("click", () => {
  const k = document.getElementById("groq-input").value.trim();
  const err = document.getElementById("groq-error");
  if (!k) {
    err.textContent = "Paste a key first.";
    err.hidden = false;
    return;
  }
  connectGroq(k, document.getElementById("groq-remember").checked);
});
document.getElementById("groq-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("groq-go").click();
});
document.getElementById("groq-forget").addEventListener("click", forgetGroq);
document.getElementById("groq-show").addEventListener("click", (e) => {
  const inp = document.getElementById("groq-input");
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  e.target.textContent = show ? "hide" : "show";
});

// Restore a remembered Groq key on load and validate it silently.
(async function initGroq() {
  let saved = null;
  try { saved = localStorage.getItem(GROQ_KEY); } catch (e) {}
  if (!saved) return;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: "Bearer " + saved },
    });
    if (!res.ok) throw 0;
    state.groqKey = saved;
    showGroqActive();
  } catch (e) {
    try { localStorage.removeItem(GROQ_KEY); } catch (e2) {}
  }
})();

/* ---------------- screen 2: picker ---------------- */

async function loadRepos() {
  const list = document.getElementById("repo-list");
  const errCard = document.getElementById("picker-error");
  errCard.hidden = true;
  list.innerHTML = `<p class="muted" style="padding:2rem 0;text-align:center">Fetching public repos for ${esc(state.username)}...</p>`;
  icons();
  try {
    state.fetchedRepos = await fetchAllRepos(state.username);
  } catch (e) {
    list.innerHTML = "";
    showPickerError(e);
    return;
  }
  if (!state.fetchedRepos.length) {
    list.innerHTML = "";
    document.getElementById("picker-error-title").textContent = "No public repos";
    document.getElementById("picker-error-msg").textContent =
      `${state.username} has no public repositories to audit.`;
    errCard.hidden = false;
    document.getElementById("picker-retry").hidden = true;
    icons();
    return;
  }
  document.getElementById("picker-retry").hidden = false;
  // Read the home-screen options: forks and private repos never enter the
  // working set, so they are never listed, scored, or audited.
  state.excludeForks = document.getElementById("exclude-forks").checked;
  state.excludePrivate = document.getElementById("exclude-private").checked;
  applyRepoFilters();
  if (!state.repos.length) {
    list.innerHTML = "";
    document.getElementById("picker-error-title").textContent = "Nothing to audit";
    document.getElementById("picker-error-msg").textContent =
      state.excludeForks && state.fetchedRepos.length
        ? "Every repo here is a fork, and forks are excluded. Uncheck \"exclude forks\" to include them."
        : `${state.username} has no repositories to audit.`;
    document.getElementById("picker-retry").hidden = true;
    errCard.hidden = false;
    icons();
    return;
  }
  document.getElementById("repo-count").textContent = state.repos.length;
  document.getElementById("pick-cap").textContent = effectiveCap();
  restoreResults();
  refreshPickerNote();
  renderPicker();
  fetchReadmesProgressive();
}

function refreshPickerNote(extra) {
  let t = state.token
    ? `Token connected as @${state.tokenLogin}: private repos included, 5,000 requests/hr.`
    : "Public repos only.";
  if (state.auditedAt) t += ` Scores from audit ${auditAgo(state.auditedAt)}.`;
  if (extra) t += " " + extra;
  document.getElementById("mode-line").textContent = t;
}

// Last audit's results, so the picker can show scores before the next audit.
function restoreResults() {
  state.results = [];
  state.auditedAt = 0;
  try {
    const raw = localStorage.getItem("rd_results_" + state.username);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.results)) {
      state.results = data.results;
      state.auditedAt = data.at || 0;
    }
  } catch (e) {}
}

/* Forks are excluded from the working set at fetch time: they never appear
   in the picker, never consume the selection cap, and never cost API calls. */
function applyRepoFilters() {
  state.repos = state.fetchedRepos.filter((r) =>
    !(state.excludeForks && r.fork) && !(state.excludePrivate && r.private));
  for (const name of [...state.selected]) {
    if (!state.repos.some((r) => r.name === name)) state.selected.delete(name);
  }
}

function showPickerError(e) {
  const errCard = document.getElementById("picker-error");
  const title = document.getElementById("picker-error-title");
  const msg = document.getElementById("picker-error-msg");
  if (e.type === "notfound") {
    title.textContent = "User not found";
    msg.textContent = `No GitHub user called "${state.username}". Check the spelling and try again.`;
  } else if (e.type === "badauth") {
    title.textContent = "Token rejected";
    msg.textContent = "GitHub rejected your token. Forget it on the home page and connect a fresh one.";
  } else if (e.type === "ratelimit") {
    title.textContent = "GitHub rate limit hit";
    msg.textContent = state.token
      ? `Even the token allowance ran out. Try again after ${e.reset.toLocaleTimeString()}.`
      : `Unauthenticated requests are capped at 60 an hour. Connect a token on the home page for 5,000/hr, or try again after ${e.reset.toLocaleTimeString()}.`;
  } else {
    title.textContent = "Could not reach GitHub";
    msg.textContent = "Check your connection and try again.";
  }
  errCard.hidden = false;
  icons();
}

document.getElementById("picker-retry").addEventListener("click", loadRepos);
document.getElementById("picker-back").addEventListener("click", () => showScreen("screen-home"));

function visibleRepos() {
  const q = document.getElementById("picker-filter").value.trim().toLowerCase();
  return state.repos.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q) && !((r.description || "").toLowerCase().includes(q))) return false;
    return true;
  });
}

// Mini score ring for the picker: same language as the big results ring.
function miniRing(score) {
  const C = 2 * Math.PI * 13;
  const color = score >= 80 ? "var(--green)" : score >= 50 ? "var(--amber)" : "var(--red)";
  const off = (C * (1 - score / 100)).toFixed(1);
  return `<span class="mini-ring" title="consistency score ${score}/100">`
    + `<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" class="ring-bg mini"/>`
    + `<circle cx="16" cy="16" r="13" class="ring-fg mini" style="stroke:${color};stroke-dasharray:${C.toFixed(1)};stroke-dashoffset:${off}"/></svg>`
    + `<span class="mini-num">${score}</span></span>`;
}

// Score from the last audit, if this repo was in it.
function lastScore(name) {
  const r = state.results.find((x) => x.name === name);
  return r ? scoreFor(r.missing.length, r.warnings.length) : null;
}

// Partial score from the README + repo metadata (no branch-protection check).
// Available as soon as the picker's progressive README fetch reaches the repo.
function readmeScore(name) {
  if (!(name in state.readmes)) return null;
  const repo = state.repos.find((r) => r.name === name);
  if (!repo) return null;
  const meta = auditRepoMeta(repo);
  const rd = auditReadme(state.readmes[name]);
  return scoreFor(meta.missing.length + rd.missing.length, meta.warnings.length + rd.warnings.length);
}

// What the picker ring shows: the full audit score when we have it,
// otherwise the README-based partial score.
function ringScore(name) {
  const full = lastScore(name);
  return full !== null ? full : readmeScore(name);
}

// Worst first: lowest score, then oldest push. Repos with no score yet
// sink below scored ones, oldest first.
function sortPickerRepos(repos) {
  return [...repos].sort((a, b) => {
    const sa = ringScore(a.name), sb = ringScore(b.name);
    if (sa !== null && sb !== null) {
      if (sa !== sb) return sa - sb;
    } else if (sa !== null) return -1;
    else if (sb !== null) return 1;
    return new Date(a.pushed_at) - new Date(b.pushed_at);
  });
}

function updatePickerRing(name) {
  const slot = document.querySelector(`[data-ring="${CSS.escape(name)}"]`);
  if (!slot) return;
  const sc = ringScore(name);
  slot.innerHTML = sc === null ? "" : miniRing(sc);
}

// READMEs are read while the repo list is being browsed, in batches of 5,
// so the audit later reuses them instead of fetching again.
async function fetchReadmesProgressive() {
  const id = ++state.readmeFetchId;
  const pending = state.repos
    .filter((r) => !(r.name in state.readmes) && !state.readmeError[r.name])
    .sort((a, b) => new Date(a.pushed_at) - new Date(b.pushed_at)); // oldest first
  if (!pending.length) return;
  for (let i = 0; i < pending.length; i += 5) {
    if (id !== state.readmeFetchId) return; // superseded
    const batch = pending.slice(i, i + 5);
    await Promise.all(batch.map(async (r) => {
      try {
        state.readmes[r.name] = await fetchReadme(state.username, r.name);
      } catch (e) {
        state.readmeError[r.name] = true;
      }
      if (id === state.readmeFetchId) updatePickerRing(r.name);
    }));
    if (id !== state.readmeFetchId) return;
    refreshPickerNote(`Reading READMEs ${Math.min(i + 5, pending.length)}/${pending.length}…`);
  }
  if (id !== state.readmeFetchId) return;
  refreshPickerNote();
  renderPicker(); // one final worst-first sort now that every ring is in
}

function renderPicker() {
  const list = document.getElementById("repo-list");
  const repos = sortPickerRepos(visibleRepos());
  const cap = effectiveCap();
  document.getElementById("picker-empty").hidden = repos.length > 0;
  const capped = state.selected.size >= cap;

  list.innerHTML = repos.map((r) => {
    const isSel = state.selected.has(r.name);
    const disabled = !isSel && capped;
    const badges = `${r.fork ? '<span class="badge-fork">fork</span>' : ""}${r.private ? '<span class="badge-private">private</span>' : ""}`;
    return `
    <label class="repo-row ${isSel ? "selected" : ""} ${disabled ? "capped" : ""}" data-name="${esc(r.name)}">
      <input type="checkbox" ${isSel ? "checked" : ""} ${disabled ? "disabled" : ""} data-repo="${esc(r.name)}" tabindex="-1">
      <span class="custom-check"><i data-lucide="check"></i></span>
      <span class="ring-slot" data-ring="${esc(r.name)}">${(() => { const sc = ringScore(r.name); return sc === null ? "" : miniRing(sc); })()}</span>
      <div class="repo-info">
        <div class="repo-name">${esc(r.name)} ${badges}</div>
        ${r.description ? `<div class="repo-desc">${esc(r.description)}</div>` : ""}
      </div>
      <div class="repo-meta">
        <span><i data-lucide="star"></i>${r.stargazers_count}</span>
        <span><i data-lucide="clock"></i>${timeAgo(r.pushed_at)}</span>
      </div>
    </label>`;
  }).join("");

  list.querySelectorAll('input[data-repo]').forEach((box) => {
    box.addEventListener("change", () => toggleRepo(box.dataset.repo, box.checked));
  });
  updateCounter();
  icons();
}

function toggleRepo(name, want) {
  const cap = effectiveCap();
  if (want) {
    // THE CAP: refuse to exceed it, no exceptions.
    if (state.selected.size >= cap) {
      renderPicker(); // re-render to snap the checkbox back off
      return;
    }
    state.selected.add(name);
  } else {
    state.selected.delete(name);
  }
  updateCounter();
  // Re-render only when crossing the cap boundary, so checkboxes enable/disable.
  const capped = state.selected.size >= cap;
  const wasCapped = document.getElementById("cap-note").hidden === false;
  if (capped !== wasCapped) renderPicker();
  else {
    const row = document.querySelector(`.repo-row[data-name="${CSS.escape(name)}"]`);
    if (row) row.classList.toggle("selected", want);
  }
}

function updateCounter() {
  const n = state.selected.size;
  const cap = effectiveCap();
  const counter = document.getElementById("select-counter");
  counter.textContent = `${n} / ${cap} selected`;
  counter.classList.toggle("full", n >= cap);
  document.getElementById("cap-note").hidden = n < cap;
  document.getElementById("cap-note-text").textContent = `${cap} repo cap reached. Deselect one to pick another.`;
  document.getElementById("run-audit").disabled = n === 0;
}

document.getElementById("select-all").addEventListener("click", () => {
  state.selected.clear();
  const cap = effectiveCap();
  for (const r of visibleRepos()) {
    if (state.selected.size >= cap) break; // cap respected
    state.selected.add(r.name);
  }
  renderPicker();
});

document.getElementById("select-none").addEventListener("click", () => {
  state.selected.clear();
  renderPicker();
});

document.getElementById("picker-filter").addEventListener("input", renderPicker);

/* ---------------- screen 3: audit ---------------- */

document.getElementById("run-audit").addEventListener("click", () => startAudit(false));
document.getElementById("audit-retry").addEventListener("click", () => startAudit(true));

// The audit never re-reads a README the picker already fetched.
async function getReadmeCached(owner, name) {
  if (state.readmeError[name]) {
    const md = await fetchReadme(owner, name); // retry once
    delete state.readmeError[name];
    state.readmes[name] = md;
    return md;
  }
  if (name in state.readmes) return state.readmes[name];
  const md = await fetchReadme(owner, name);
  state.readmes[name] = md;
  return md;
}

async function startAudit(resume) {
  state.readmeFetchId++; // stop the picker's progressive fetch; the audit takes over
  const names = [...state.selected];
  if (!resume) state.results = [];
  const done = new Set(state.results.map((r) => r.name));
  const queue = resume ? names.filter((n) => !done.has(n)) : names;
  if (!queue.length && resume) {
    renderResults();
    return;
  }
  showScreen("screen-audit");
  const total = names.length;
  document.getElementById("audit-total").textContent = total;
  document.getElementById("audit-error").hidden = true;
  const log = document.getElementById("audit-log");
  if (!resume) log.innerHTML = "";
  const fill = document.getElementById("progress-fill");
  const label = document.getElementById("progress-label");

  const byName = Object.fromEntries(state.repos.map((r) => [r.name, r]));
  let completed = state.results.length;

  for (let i = 0; i < queue.length; i++) {
    const name = queue[i];
    const repo = byName[name];
    label.textContent = `Checking ${name} (${completed + 1} of ${total})`;

    let readme = null;
    let repoNote = null;
    let isProtected = null;
    let protNote = null;
    try {
      readme = await getReadmeCached(state.username, name);
    } catch (e) {
      if (auditHardStop(e, total, completed)) return;
      repoNote = "readme: could not be checked (request failed)";
    }
    try {
      isProtected = await fetchBranchProtected(state.username, name, repo.default_branch);
    } catch (e) {
      if (auditHardStop(e, total, completed)) return;
      protNote = "protection: could not be checked (request failed)";
    }

    const meta = auditRepoMeta(repo);
    const rd = auditReadme(readme);
    const prot = auditProtection(isProtected);
    // Protection is the topmost priority check: it leads the missing list.
    const missing = [...prot.missing, ...meta.missing, ...rd.missing];
    const warnings = [...meta.warnings, ...rd.warnings, ...prot.warnings];
    if (repoNote) warnings.push(repoNote);
    if (protNote) warnings.push(protNote);
    state.results.push({ name, url: repo.html_url, fork: repo.fork, missing, warnings });
    completed++;

    const line = document.createElement("div");
    line.className = "log-line " + (missing.length >= 5 ? "bad" : missing.length > 0 ? "warn" : "ok");
    line.innerHTML = `<i data-lucide="${missing.length ? "x-circle" : "check-circle-2"}"></i><span>${esc(name)}: ${missing.length} missing, ${warnings.length} warnings</span>`;
    log.appendChild(line);
    icons();

    fill.style.width = `${Math.round((completed / total) * 100)}%`;
  }

  label.textContent = `Done. ${state.results.length} repos audited.`;
  state.auditedAt = Date.now();
  try {
    localStorage.setItem("rd_results_" + state.username,
      JSON.stringify({ at: state.auditedAt, results: state.results }));
  } catch (e) {}
  setTimeout(renderResults, 600);
}

/* ---------------- screen 4: results ---------------- */

function auditAgo(ts) {
  if (!ts) return "";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " hr ago";
  return Math.floor(h / 24) + " days ago";
}

function scoreClass(s) {
  return s >= 80 ? "good" : s >= 50 ? "mid" : "bad";
}

function renderResults() {
  const results = [...state.results].sort(
    (a, b) => b.missing.length - a.missing.length || b.warnings.length - a.warnings.length
  );
  document.getElementById("results-user").textContent = state.username;

  const totalMissing = results.reduce((n, r) => n + r.missing.length, 0);
  const totalWarn = results.reduce((n, r) => n + r.warnings.length, 0);
  const avg = results.length
    ? Math.round(results.reduce((n, r) => n + scoreFor(r.missing.length, r.warnings.length), 0) / results.length)
    : 0;
  document.getElementById("results-summary").textContent =
    `${results.length} repos audited: ${totalMissing} missing items, ${totalWarn} warnings.` +
    (state.auditedAt ? ` Last audited ${auditAgo(state.auditedAt)}.` : "");

  const arc = document.getElementById("score-arc");
  const C = 326.7;
  requestAnimationFrame(() => {
    arc.style.strokeDashoffset = C * (1 - avg / 100);
    arc.style.stroke = avg >= 80 ? "var(--green)" : avg >= 50 ? "var(--amber)" : "var(--red)";
  });
  // animate the number
  const valEl = document.getElementById("score-value");
  const t0 = performance.now();
  (function tick(t) {
    const p = Math.min(1, (t - t0) / 900);
    valEl.textContent = Math.round(avg * p);
    if (p < 1) requestAnimationFrame(tick);
  })(t0);

  renderResultsList(results);
  updateKeysHint();
  showScreen("screen-results");
}

function renderResultsList(sorted) {
  const q = document.getElementById("results-filter").value.trim().toLowerCase();
  const hideClean = document.getElementById("results-hide-clean").checked;
  const list = document.getElementById("results-list");

  const rows = sorted.filter((r) => {
    if (hideClean && r.missing.length === 0) return false;
    if (q && !r.name.toLowerCase().includes(q)) return false;
    return true;
  });

  list.innerHTML = rows.map((r) => {
    const s = scoreFor(r.missing.length, r.warnings.length);
    const pills = r.missing.length === 0 && r.warnings.length === 0
      ? `<span class="pill cleanp">clean</span>`
      : `${r.missing.length ? `<span class="pill miss">${r.missing.length} missing</span>` : ""}${r.warnings.length ? `<span class="pill warnp">${r.warnings.length} warnings</span>` : ""}`;
    const issueItem = (m) => m.startsWith("protection:")
      ? `<li class="missing priority"><i data-lucide="shield-alert"></i><span>${esc(m)}<em class="priority-tag">priority</em></span></li>`
      : `<li class="missing"><i data-lucide="x-circle"></i><span>${esc(m)}</span></li>`;
    const issues = [
      ...r.missing.map(issueItem),
      ...r.warnings.map((w) => `<li class="warning"><i data-lucide="alert-circle"></i><span>${esc(w)}</span></li>`),
    ].join("") || `<li class="warning"><i data-lucide="check-circle-2"></i><span>Nothing to fix. This repo clears the house standard.</span></li>`;
    return `
    <div class="result-card" data-name="${esc(r.name)}">
      <button class="result-head">
        <span class="result-score ${scoreClass(s)}">${s}</span>
        <span class="result-name">${esc(r.name)}${r.fork ? ' <span class="badge-fork">fork</span>' : ""}</span>
        <span class="result-counts">${pills}</span>
        <i data-lucide="chevron-down"></i>
      </button>
      <div class="result-body">
        <ul class="issue-list">${issues}</ul>
        <a class="result-link" href="${esc(r.url)}" target="_blank" rel="noopener">Open on GitHub <i data-lucide="external-link"></i></a>
      </div>
    </div>`;
  }).join("");

  list.querySelectorAll(".result-card").forEach((card) => {
    card.querySelector(".result-head").addEventListener("click", () => {
      card.classList.toggle("open");
      icons();
    });
  });
  attachFixPanels();
  icons();
}

document.getElementById("results-filter").addEventListener("input", () => {
  const sorted = [...state.results].sort(
    (a, b) => b.missing.length - a.missing.length || b.warnings.length - a.warnings.length
  );
  renderResultsList(sorted);
});
document.getElementById("results-hide-clean").addEventListener("change", () => {
  const sorted = [...state.results].sort(
    (a, b) => b.missing.length - a.missing.length || b.warnings.length - a.warnings.length
  );
  renderResultsList(sorted);
});

document.getElementById("audit-again").addEventListener("click", () => {
  showScreen("screen-picker");
  renderPicker();
});

document.getElementById("download-report").addEventListener("click", () => {
  const sorted = [...state.results].sort(
    (a, b) => b.missing.length - a.missing.length || b.warnings.length - a.warnings.length
  );
  const totalMissing = sorted.reduce((n, r) => n + r.missing.length, 0);
  const totalWarn = sorted.reduce((n, r) => n + r.warnings.length, 0);
  let md = `# repo-doctor report: ${state.username}\n\n`;
  md += `${sorted.length} repos audited. ${totalMissing} missing items, ${totalWarn} warnings.\n\n`;
  for (const r of sorted) {
    const s = scoreFor(r.missing.length, r.warnings.length);
    md += `## ${r.name} (score ${s})\n\n${r.url}\n\n`;
    if (r.missing.length) {
      md += `**Missing:**\n\n${r.missing.map((m) => `- ${m}`).join("\n")}\n\n`;
    }
    if (r.warnings.length) {
      md += `**Warnings:**\n\n${r.warnings.map((w) => `- ${w}`).join("\n")}\n\n`;
    }
    if (!r.missing.length && !r.warnings.length) md += `clean.\n\n`;
  }
  const blob = new Blob([md], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `repo-doctor-${state.username}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ---------------- screen 5: AI fixes (v0.2) ---------------- */

const GROQ_MODEL = "openai/gpt-oss-120b";
const ATTRIBUTION_LINE = "*Created with [repo-doctor](https://prathamjain.com/projects/repo-doctor)*";

async function groqChat(system, user) {
  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.groqKey },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.6,
        max_tokens: 5000,
      }),
    });
  } catch (e) {
    throw { type: "network" };
  }
  if (res.status === 401) throw { type: "groqauth" };
  if (res.status === 429) throw { type: "groqrate" };
  if (!res.ok) throw { type: "groq", status: res.status };
  const data = await res.json();
  return data.choices[0].message.content;
}

function buildFixPrompt(ctx) {
  const hintLines = Object.entries(ctx.sectionHints || {})
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `- ${k}: ${String(v).trim()}`);
  const shots = ctx.screenshots || [];
  const notesBlock = (hintLines.length || shots.length)
    ? `\nUser notes for flagged README sections: weave each into its matching section, creating the section if needed:\n${hintLines.join("\n")}${shots.length ? `\n- screenshots: add a ## Screenshots section showing these images with relative paths (the files will be in the repo): ${shots.join(", ")}` : ""}\n`
    : "";
  const system = `You are repo-doctor's README writer. You reply with ONLY a JSON object, no markdown fences, no commentary:
{"readme": "the full README.md", "description": "one line", "topics": ["t1", "t2"], "website": "https://..."}

README structure — use these sections in this order. Write every section below; the ONLY section you may skip is Screenshots, and only when no images or notes were provided:
# Title
<badges: put the badge line from the context on its own line directly under the title>
<one or two honest lines saying what it is>
## Motivation
## Tech stack
## Features
## Installation
## Usage
## Build status (show the real CI badge or workflow when one exists in the files given — never invent a badge; when there is no CI, write how to build and verify the project from the repo files in one short paragraph)
## Code style (name lint/format tools only if they are configured in the manifest; otherwise describe the style observed in the source files — indentation, naming, quotes — without claiming tools that are not there)
## Screenshots (only from user-uploaded images or user notes)
## Code example (a short usage snippet grounded in the existing README or the source files; if there is genuinely nothing to show, say so in one line)
## API reference (document the public surface from the existing README, file names, and source files; if there is genuinely nothing to document, say so in one line)
## Tests (how to run them — from manifest scripts or test files in the source; if the repo has no tests at all, say so in one honest line)

Hard rules:
- No emojis anywhere.
- Installation and Usage must be copy-pasteable steps derived ONLY from the repo context given (file list, manifest, source files, existing README). Never invent commands, URLs, flags, or features.
- Read the source files. Derive tech stack, features, installation steps, API reference, tests, and code style from the code itself — that is what the source files are for.
- Never invent facts: no made-up badges, commands, URLs, tools, or features. When a section has thin material, write one honest line about what is actually there instead of skipping the section. Screenshots is the only exception: skip it entirely when no images or notes were provided.
- Do NOT write Contribute, Credits, or License sections — GitHub renders those natively.
- End the README with a blank line, then ---, then a blank line, then exactly:
${ATTRIBUTION_LINE}
(The blank lines matter: without them GitHub turns your last paragraph into a giant heading.)

"description": one honest line, no trailing period, under 120 characters.
"topics": 1 to 5 items, lowercase, hyphens instead of spaces.
"website": the live demo or docs URL, copied EXACTLY as it appears in the files or existing README given (package.json "homepage", a demo link, a docs site). Never invent, guess, or normalize a URL. If you cannot see one, use "".${notesBlock}`;

  const user = `Repo: ${ctx.repo.name} by ${ctx.owner}
GitHub description now: ${ctx.repo.description || "(empty)"}
Language: ${ctx.repo.language || "unknown"} | Stars: ${ctx.repo.stargazers_count} | Topics now: ${(ctx.repo.topics || []).join(", ") || "(none)"}
Files in repo root: ${ctx.files.join(", ") || "(empty repo)"}
${ctx.manifestName ? `--- ${ctx.manifestName} ---\n${ctx.manifestBody}\n` : "(no dependency manifest found)"}
${ctx.badges ? `--- badges (place on their own line directly under the title; if the existing README already has badges, keep those and do not duplicate) ---\n${ctx.badges}\n` : ""}
${ctx.codeContext ? `--- source files (read these to fill the sections) ---\n${ctx.codeContext}\n` : ""}
--- existing README (may be missing or incomplete) ---
${ctx.existing || "(none)"}

Write the JSON now.`;
  return { system, user };
}

const CODE_EXTS = new Set("py,js,jsx,ts,tsx,mjs,cjs,go,rs,java,rb,php,swift,kt,c,h,cpp,hpp,cs,vue,svelte".split(","));
const SKIP_DIRS = ["node_modules", "dist", "build", ".git", "__pycache__", ".venv", "venv", "target", "vendor", "coverage", ".next", ".nuxt"];
function isCodeFile(path) {
  const parts = path.split("/");
  if (parts.some((p) => SKIP_DIRS.includes(p))) return false;
  if (parts[0] === ".github" && parts[1] === "workflows") return /\.ya?ml$/i.test(parts[parts.length - 1]); // CI evidence for build status
  const ext = parts[parts.length - 1].split(".").pop().toLowerCase();
  return CODE_EXTS.has(ext);
}
function codeScore(p) {
  const base = p.split("/").pop().toLowerCase();
  let s = 0;
  if (/^(main|index|app|server|cli|__main__|mod)\./.test(base)) s += 100;
  if (p.startsWith("src/") || p.startsWith("lib/")) s += 40;
  if (p.includes(".github/workflows")) s += 20;
  if (base === "__init__.py") s -= 60;
  if (/^(test|spec)/.test(base) || base.includes(".test.") || base.includes(".spec.")) s -= 30;
  s -= p.split("/").length * 4;
  return s;
}

function shield(label, message, color) {
  const e = (s) => encodeURIComponent(String(s).replace(/-/g, "--"));
  return `![${label}: ${message}](https://img.shields.io/badge/${e(label)}-${e(message)}-${color}.svg)`;
}
function manifestVersion(manifestName, body) {
  if (!body) return "";
  let m = null;
  if (manifestName === "package.json") m = body.match(/"version"\s*:\s*"([^"]+)"/);
  else if (manifestName === "pyproject.toml") m = body.match(/^version\s*=\s*"([^"]+)"/m);
  return m ? m[1] : "";
}
function manifestLangVersion(manifestName, body) {
  if (!body) return "";
  let m = null;
  if (manifestName === "pyproject.toml") {
    m = body.match(/requires-python\s*=\s*"[^"]*?(\d+(?:\.\d+)*)/);
    return m ? m[1] + "+" : "";
  }
  if (manifestName === "package.json") {
    m = body.match(/"node"\s*:\s*"[^"]*?(\d+)/);
    return m ? m[1] + "+" : "";
  }
  return "";
}
// shields.io badges derived from data we already have: license from the
// GitHub API, language + version from the manifest. Never guessed.
function buildBadges(repo, manifestName, manifestBody) {
  const out = [];
  const lic = repo && repo.license && repo.license.spdx_id;
  if (lic && lic !== "NOASSERTION") out.push(shield("License", lic, "yellow"));
  const lang = repo && repo.language;
  const langVer = manifestLangVersion(manifestName, manifestBody);
  if (lang && langVer) out.push(shield(lang, langVer, "blue"));
  const ver = manifestVersion(manifestName, manifestBody);
  if (ver) out.push(shield("version", "v" + ver, "brightgreen"));
  return out.join(" ");
}

async function gatherFixContext(owner, name) {
  const enc = encodeURIComponent;
  const repo = state.repos.find((r) => r.name === name);
  const listing = await gh(`/repos/${owner}/${name}/contents/`);
  const files = listing.filter((f) => f.type === "file").map((f) => f.name);
  const manifestNames = ["package.json", "pyproject.toml", "setup.py", "requirements.txt", "go.mod", "Cargo.toml", "Gemfile", "composer.json"];
  let manifestName = "", manifestBody = "";
  for (const m of manifestNames) {
    const entry = listing.find((f) => f.name === m && f.download_url);
    if (entry) {
      manifestName = m;
      try {
        manifestBody = (await (await fetch(entry.download_url)).text()).slice(0, 3000);
      } catch (e) { /* manifest is a nice-to-have */ }
      break;
    }
  }
  const existing = await fetchReadme(owner, name);
  // Let the AI read the code, not just the file list: pull the most relevant
  // source files (plus CI workflows for build-status evidence).
  let codeContext = "";
  let codeFilesRead = 0;
  try {
    const branch = repo.default_branch || "main";
    const tree = await gh(`/repos/${enc(owner)}/${enc(name)}/git/trees/${enc(branch)}?recursive=1`);
    const blobs = (tree.tree || [])
      .filter((t) => t.type === "blob" && isCodeFile(t.path) && !(t.size > 60000));
    blobs.sort((a, b) => codeScore(b.path) - codeScore(a.path));
    let budget = 12000;
    const parts = [];
    for (const f of blobs.slice(0, 8)) {
      if (budget <= 0) break;
      try {
        const text = await gh(`/repos/${enc(owner)}/${enc(name)}/contents/${f.path.split("/").map(enc).join("/")}?ref=${enc(branch)}`, true);
        if (!text || !text.trim()) continue;
        const slice = text.slice(0, Math.min(3000, budget));
        parts.push(`--- ${f.path} ---\n${slice}`);
        budget -= slice.length;
      } catch (e) { /* skip unreadable files */ }
    }
    codeContext = parts.join("\n\n");
    codeFilesRead = parts.length;
  } catch (e) { /* code context is a nice-to-have */ }
  const badges = buildBadges(repo, manifestName, manifestBody);
  return { owner, repo, files, manifestName, manifestBody, existing, codeContext, codeFilesRead, badges };
}

function parseFixJson(raw) {
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    const d = JSON.parse(clean);
    if (typeof d.readme !== "string" || !d.readme.trim()) throw 0;
    let readme = d.readme.trim();
    // The attribution is non-negotiable: enforce it at the end, wrapped in
    // blank lines. Without them GitHub reads "paragraph\n---" as a setext
    // heading and renders the last paragraph as a giant heading.
    readme = readme.replace(/\n\n?---\n\n?\*Created with \[repo-doctor\][\s\S]*$/, "").trim();
    readme += `\n\n---\n\n${ATTRIBUTION_LINE}\n`;
    let website = String(d.website || "").trim();
    // The model must copy a URL it can see, never invent one. Reject anything
    // that is not a plausible absolute URL, including bare github.com repo
    // links (the repo URL itself is not a homepage).
    if (!/^https?:\/\/\S+$/i.test(website) || /^https?:\/\/(www\.)?github\.com\//i.test(website)) website = "";
    return {
      readme,
      description: String(d.description || "").trim().slice(0, 140),
      topics: Array.isArray(d.topics) ? d.topics.map((t) => String(t).trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean).slice(0, 5) : [],
      website,
    };
  } catch (e) {
    throw { type: "badjson" };
  }
}

// Minimal markdown renderer, just for the README preview.
function mdToHtml(md) {
  const lines = esc(md).split("\n");
  let html = "", inList = false, inCode = false;
  const codeBuf = [];
  const inline = (s) => s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) { html += `<pre><code>${codeBuf.join("\n")}</code></pre>`; codeBuf.length = 0; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    let m;
    if ((m = line.match(/^###\s+(.*)/))) { closeList(); html += `<h3>${inline(m[1])}</h3>`; }
    else if ((m = line.match(/^##\s+(.*)/))) { closeList(); html += `<h2>${inline(m[1])}</h2>`; }
    else if ((m = line.match(/^#\s+(.*)/))) { closeList(); html += `<h1>${inline(m[1])}</h1>`; }
    else if (/^---+\s*$/.test(line)) { closeList(); html += "<hr>"; }
    else if ((m = line.match(/^[-*]\s+(.*)/))) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(m[1])}</li>`; }
    else if (!line.trim()) { closeList(); }
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  if (inCode) html += `<pre><code>${codeBuf.join("\n")}</code></pre>`;
  return html;
}

function mitLicense(owner) {
  const year = new Date().getFullYear();
  return `MIT License

Copyright (c) ${year} ${owner}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

async function openFixPR(owner, name, files, title) {
  const info = await gh(`/repos/${owner}/${name}`);
  const base = info.default_branch;
  const ref = await gh(`/repos/${owner}/${name}/git/ref/heads/${base}`);
  const branch = `repo-doctor/fix-${Date.now().toString(36)}`;
  await ghWrite("POST", `/repos/${owner}/${name}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: ref.object.sha,
  });
  for (const f of files) {
    let sha = null;
    try {
      const cur = await gh(`/repos/${owner}/${name}/contents/${f.path}?ref=${encodeURIComponent(base)}`);
      sha = cur.sha;
    } catch (e) { if (e.type !== "notfound") throw e; }
    await ghWrite("PUT", `/repos/${owner}/${name}/contents/${f.path}`, {
      message: title,
      content: f.b64 || toB64(f.content),
      branch,
      // The PR goes out under the user's token (their permission), but the
      // commits themselves are stamped repo-doctor.
      author: { name: "repo-doctor", email: "repo-doctor@prathamjain.com" },
      ...(sha ? { sha } : {}),
    });
  }
  const pr = await ghWrite("POST", `/repos/${owner}/${name}/pulls`, {
    title,
    head: branch,
    base,
    body: "AI-generated fixes from repo-doctor. Review the diff and merge this PR to apply them.\n\n" + ATTRIBUTION_LINE,
  });
  return pr.html_url;
}

async function applyAbout(owner, name, { description, homepage, topics }) {
  await ghWrite("PATCH", `/repos/${owner}/${name}`, {
    description: description || "",
    homepage: homepage || "",
  });
  const names = topics.split(",").map((t) => t.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean).slice(0, 20);
  await ghWrite("PUT", `/repos/${owner}/${name}/topics`, { names });
}

function fixKinds(r) {
  const all = [...r.missing, ...r.warnings];
  return {
    readme: all.some((m) => m.startsWith("readme:")),
    about: all.some((m) => m.startsWith("about:")),
    license: all.some((m) => m.startsWith("license:")),
    protection: all.some((m) => m.startsWith("protection:")),
  };
}

async function protectBranch(owner, name, branch) {
  // Safe defaults mirroring GitHub's "Protect this branch" button:
  // block force-pushes and deletion, require nothing else, so normal
  // pushes to the default branch keep working.
  await ghWrite("PUT", `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`, {
    required_status_checks: null,
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  });
}

function fixErrorText(e) {
  if (e.type === "groqauth") return "Groq rejected the key. Forget it on the home page and connect a fresh one.";
  if (e.type === "groqrate") return "Groq rate limit hit. Wait a minute and try again.";
  if (e.type === "badauth") return "GitHub rejected the token. Reconnect it on the home page.";
  if (e.type === "ratelimit") return "GitHub rate limit hit. Try again in a bit.";
  if (e.type === "network") return "Network error. Check your connection and try again.";
  if (e.type === "badjson") return "The AI returned something unreadable. Hit regenerate.";
  if (e.type === "notfound") return "Repo not found. It may have been renamed or deleted.";
  return "Something broke. Try again.";
}

function attachFixPanels() {
  document.querySelectorAll(".result-card").forEach((card) => {
    const name = card.dataset.name;
    const r = state.results.find((x) => x.name === name);
    if (!r) return;
    const kinds = fixKinds(r);
    if (!kinds.readme && !kinds.about && !kinds.license) return;
    const body = card.querySelector(".result-body");
    const panel = document.createElement("div");
    panel.className = "fix-panel";
    panel.innerHTML = `
      <div class="fix-title"><i data-lucide="sparkles"></i> AI fixes</div>
      <p class="fix-lede muted">AI drafts the README, suggests About fields, and adds a MIT LICENSE. File changes arrive as a PR you merge. About-box fields and branch protection apply instantly.</p>
      <button class="btn btn-primary btn-mini" data-fix-start>Fix with AI <i data-lucide="arrow-right"></i></button>
      <div class="fix-work" hidden></div>`;
    body.appendChild(panel);
    panel.querySelector("[data-fix-start]").addEventListener("click", () => startFix(name, kinds, panel));
  });
  icons();
}

async function startFix(name, kinds, panel) {
  const work = panel.querySelector(".fix-work");
  work.hidden = false;
  const goHome = (msg) => {
    work.innerHTML = `<p class="fix-error">${msg}</p>
      <div class="fix-actions"><button class="btn btn-ghost btn-mini" data-go-home>Add keys <i data-lucide="arrow-right"></i></button></div>`;
    work.querySelector("[data-go-home]").addEventListener("click", () => showScreen("screen-home"));
    icons();
  };
  if (!state.groqKey) return goHome("AI fixes need your Groq key. It is free, bring your own, and it never leaves this browser.");
  if (!state.token) return goHome("Opening PRs needs your GitHub token with the repo scope.");
  work.innerHTML = `<p class="muted"><span class="spin"></span>Reading the repo and drafting the README...</p>`;
  try {
    const ctx = await gatherFixContext(state.username, name);
    const st0 = panel._fixState || { hints: {}, shots: [] };
    ctx.sectionHints = st0.hints;
    ctx.screenshots = st0.shots.map((s) => "docs/screenshots/" + s.file);
    const { system, user } = buildFixPrompt(ctx);
    const data = parseFixJson(await groqChat(system, user));
    renderFixPreview(name, kinds, ctx, data, work);
  } catch (e) {
    work.innerHTML = `<p class="fix-error">${fixErrorText(e)}</p>`;
  }
}

function sanitizeShotName(name, existing) {
  let base = String(name || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "") || "screenshot.png";
  let n = base, i = 2;
  while (existing.has(n)) {
    n = base.replace(/(\.[a-z0-9]+)?$/i, "-" + i + "$1");
    i++;
  }
  return n;
}

function readFileB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
}

// Reads the per-section notes + newly picked screenshots into panel._fixState.
// Called on Regenerate and on Apply, so staged files are never silently dropped.
async function collectSectionState(panel, work) {
  const st = panel._fixState || (panel._fixState = { hints: {}, shots: [] });
  work.querySelectorAll("[data-sec]").forEach((inp) => {
    const v = inp.value.trim();
    if (v) st.hints[inp.dataset.sec] = v;
    else delete st.hints[inp.dataset.sec];
  });
  const fi = work.querySelector("[data-sec-files]");
  if (fi && fi.files && fi.files.length) {
    const existing = new Set(st.shots.map((s) => s.file));
    for (const f of fi.files) {
      const file = sanitizeShotName(f.name, existing);
      existing.add(file);
      try {
        const b64 = await readFileB64(f);
        if (b64) st.shots.push({ file, b64, type: f.type || "image/png" });
      } catch (e) { /* skip unreadable files */ }
    }
    fi.value = "";
  }
  return st;
}

// Per-section steering for flagged README sections. The AI writes every section
// from the code by default; notes are collapsed opt-in overrides. Screenshots
// get a file picker.
function sectionInputs(name, work, ctx) {
  const panel = work.closest(".fix-panel");
  const st = panel._fixState || (panel._fixState = { hints: {}, shots: [] });
  const r = state.results.find((x) => x.name === name);
  const secs = [];
  for (const m of [...(r ? r.missing : []), ...(r ? r.warnings : [])]) {
    const mm = /^readme: (?:missing|no) '([^']+)' section$/.exec(m);
    if (mm && !secs.includes(mm[1])) secs.push(mm[1]);
  }
  if (!secs.length) return "";
  const rows = secs.map((s) => {
    if (s === "screenshots") {
      if (st.skipShots) {
        return `<div class="fix-sec"><span>screenshots</span><p class="muted small">Skipped. No Screenshots section will be added. <button type="button" class="link-btn" data-unskip-shots>undo</button></p></div>`;
      }
      return `<div class="fix-sec"><div class="fix-sec-head"><span>screenshots</span></div><div class="shot-choice">`
        + `<label class="btn btn-ghost btn-mini shot-upload">Upload screenshots<input type="file" data-sec-files accept="image/*" multiple hidden></label>`
        + `<button type="button" class="btn btn-ghost btn-mini" data-skip-shots>Skip</button></div>`
        + `<div class="shot-staged" data-shot-staged></div></div>`;
    }
    const hasNote = st.hints[s] && String(st.hints[s]).trim();
    return `<div class="fix-sec"><div class="fix-sec-head"><span>` + esc(s) + `</span>`
      + `<button type="button" class="link-btn" data-note-toggle>` + (hasNote ? "edit note" : "add note") + `</button></div>`
      + `<input data-sec="` + esc(s) + `" value="` + esc(st.hints[s] || "") + `" placeholder="notes for the AI (optional)"` + (hasNote ? "" : " hidden") + `></div>`;
  }).join("");
  const read = ctx && ctx.codeFilesRead;
  const readLine = read
    ? ` The AI read ` + read + ` source file` + (read > 1 ? "s" : "") + ` to write them.`
    : ` The AI could not read the source files, so it is working from the file list only.`;
  return `<div class="fix-sections">
    <h4 class="fix-title">README sections</h4>
    <p class="muted small fix-sec-note">The AI writes these from your code — nothing to fill in.` + readLine + ` Add a note only to steer a section, or pick screenshots, then hit Regenerate.</p>
    ` + rows + `
  </div>`;
}

// Thumbnails the moment files are picked, so the upload is never a mystery.
function renderShotStaged(work) {
  const panel = work.closest(".fix-panel");
  const st = panel._fixState || { hints: {}, shots: [] };
  const el = work.querySelector("[data-shot-staged]");
  if (!el) return;
  el.innerHTML = st.shots.map((s, i) =>
    `<span class="shot-thumb"><img src="data:${esc(s.type || "image/png")};base64,${s.b64}" alt="screenshot ${i + 1}">`
    + `<button type="button" data-shot-remove="${i}" aria-label="remove screenshot">\u00d7</button></span>`
  ).join("") + (st.shots.length
    ? `<p class="muted small shot-staged-note">${st.shots.length} screenshot${st.shots.length > 1 ? "s" : ""} ready — they ride out with the README PR.</p>`
    : "");
  el.querySelectorAll("[data-shot-remove]").forEach((b) =>
    b.addEventListener("click", () => {
      st.shots.splice(Number(b.dataset.shotRemove), 1);
      renderShotStaged(work);
    }));
}

function renderFixPreview(name, kinds, ctx, data, work) {
  const toggles = [
    kinds.protection ? `<label class="check"><input type="checkbox" data-t="protection" checked><span class="custom-check"><i data-lucide="check"></i></span> Protect default branch</label>` : "",
    kinds.readme ? `<label class="check"><input type="checkbox" data-t="readme" checked><span class="custom-check"><i data-lucide="check"></i></span> README via PR</label>` : "",
    kinds.about ? `<label class="check"><input type="checkbox" data-t="about" checked><span class="custom-check"><i data-lucide="check"></i></span> Apply About box</label>` : "",
    kinds.license ? `<label class="check"><input type="checkbox" data-t="license" checked><span class="custom-check"><i data-lucide="check"></i></span> MIT LICENSE via PR</label>` : "",
  ].join("");
  work.innerHTML = `
    ${kinds.readme ? `<h4 class="fix-title" style="margin-top:0.4rem">README preview</h4><div class="md-preview">${mdToHtml(data.readme)}</div>` : ""}
    ${kinds.about ? `<div class="fix-fields">
      <label>About description<input data-f="description" value="${esc(data.description)}" maxlength="140"></label>
      <label>Topics, comma separated<input data-f="topics" value="${esc(data.topics.join(", "))}"></label>
      <label>Website<input data-f="homepage" value="${esc(data.website || ctx.repo.homepage || "")}" placeholder="https://..."></label>
      ${(!data.website && !ctx.repo.homepage) ? `<p class="fix-note">The AI couldn't find a live URL in the repo files — paste your demo or docs link here if you have one.</p>` : ""}
    </div>` : ""}
    ${kinds.readme ? sectionInputs(name, work, ctx) : ""}
    <div class="fix-toggles">${toggles}</div>
    <div class="fix-actions">
      <button class="btn btn-primary" data-apply>Apply fixes</button>
      <button class="btn btn-ghost" data-regen>Regenerate</button>
    </div>
    <div class="fix-result"></div>`;
  icons();
  work.querySelectorAll("[data-note-toggle]").forEach((b) => {
    b.addEventListener("click", () => {
      const inp = b.closest(".fix-sec").querySelector("[data-sec]");
      inp.hidden = !inp.hidden;
      b.textContent = inp.hidden ? (inp.value.trim() ? "edit note" : "add note") : "hide";
      if (!inp.hidden) inp.focus();
    });
  });
  work.querySelector("[data-regen]").addEventListener("click", async () => {
    const panel = work.closest(".fix-panel");
    await collectSectionState(panel, work);
    startFix(name, kinds, panel);
  });
  const skipBtn = work.querySelector("[data-skip-shots]");
  if (skipBtn) skipBtn.addEventListener("click", async () => {
    const panel = work.closest(".fix-panel");
    await collectSectionState(panel, work);
    panel._fixState.skipShots = true;
    panel._fixState.shots = [];
    renderFixPreview(name, kinds, ctx, data, work);
  });
  const unskipBtn = work.querySelector("[data-unskip-shots]");
  if (unskipBtn) unskipBtn.addEventListener("click", async () => {
    const panel = work.closest(".fix-panel");
    await collectSectionState(panel, work);
    panel._fixState.skipShots = false;
    renderFixPreview(name, kinds, ctx, data, work);
  });
  work.querySelector("[data-apply]").addEventListener("click", () => applyFixes(name, kinds, ctx, data, work));
  renderShotStaged(work);
  const fileInput = work.querySelector("[data-sec-files]");
  if (fileInput) fileInput.addEventListener("change", async () => {
    const panel = work.closest(".fix-panel");
    const st = panel._fixState || (panel._fixState = { hints: {}, shots: [] });
    const stagedEl = work.querySelector("[data-shot-staged]");
    if (stagedEl) stagedEl.innerHTML = `<p class="muted small">Reading…</p>`;
    await collectSectionState(panel, work);
    renderShotStaged(work);
  });
}

async function applyFixes(name, kinds, ctx, data, work) {
  const result = work.querySelector(".fix-result");
  const panel = work.closest(".fix-panel");
  const st = await collectSectionState(panel, work);
  const want = {};
  work.querySelectorAll("[data-t]").forEach((t) => { want[t.dataset.t] = t.checked; });
  if (!want.readme && !want.about && !want.license) {
    result.innerHTML = `<p class="fix-error">Pick at least one fix to apply.</p>`;
    return;
  }
  result.innerHTML = `<p class="muted"><span class="spin"></span>Applying...</p>`;
  const owner = state.username;
  try {
    const lines = [];
    let prUrl = null;
    if (want.about && kinds.about) {
      await applyAbout(owner, name, {
        description: work.querySelector('[data-f="description"]').value.trim(),
        homepage: work.querySelector('[data-f="homepage"]').value.trim(),
        topics: work.querySelector('[data-f="topics"]').value.trim(),
      });
      lines.push("About box updated on GitHub.");
    }
    if (want.protection && kinds.protection) {
      await protectBranch(owner, name, ctx.repo.default_branch || "main");
      lines.push("Default branch protected.");
    }
    const files = [];
    if (want.readme && kinds.readme) files.push({ path: "README.md", content: data.readme });
    if (want.license && kinds.license) files.push({ path: "LICENSE", content: mitLicense(owner) });
    if (want.readme && kinds.readme && st.shots.length) {
      for (const s of st.shots) files.push({ path: "docs/screenshots/" + s.file, b64: s.b64 });
    }
    if (files.length) {
      const title = "repo-doctor: AI fixes" + (files.length > 1 ? ` (${files.map((f) => f.path).join(", ")})` : ` (${files[0].path})`);
      prUrl = await openFixPR(owner, name, files, title);
      lines.push("PR opened" + (st.shots.length && want.readme ? " (with " + st.shots.length + " screenshot" + (st.shots.length > 1 ? "s" : "") + ")" : "") + ". Nothing is applied until you merge it.");
    }
    const reauditHint = prUrl
      ? "After you merge it on GitHub, hit Audit again at the top of the results — this page still shows the pre-fix audit until then."
      : "Hit Audit again at the top of the results to see the new score.";
    result.innerHTML = `
      <div class="pr-card">
        <i data-lucide="check"></i>
        <div>
          <h4>${prUrl ? "PR opened" : "Done"}</h4>
          <p>${lines.join(" ")}</p>
          ${prUrl ? `<a class="btn btn-primary btn-mini" href="${esc(prUrl)}" target="_blank" rel="noopener">Review &amp; merge on GitHub <i data-lucide="external-link"></i></a>` : ""}
          <p class="muted small" style="margin-top:0.5rem">${reauditHint}</p>
        </div>
      </div>`;
    icons();
  } catch (e) {
    result.innerHTML = `<p class="fix-error">${fixErrorText(e)}</p>`;
  }
}

function updateKeysHint() {
  const bar = document.getElementById("keys-hint");
  const missing = [];
  if (!state.groqKey) missing.push("a Groq key to unlock AI fixes (free, bring your own)");
  if (!state.token) missing.push("a GitHub token so fixes can be opened as PRs");
  if (!missing.length) { bar.hidden = true; return; }
  document.getElementById("keys-hint-text").textContent = "You need " + missing.join(" and ") + ". Add them on the home page, then come back.";
  bar.hidden = false;
}

document.getElementById("keys-hint-go").addEventListener("click", () => showScreen("screen-home"));

// Live star count on the hero badge. Fails silently offline.
(async function loadStars() {
  try {
    const res = await fetch(API + "/repos/pratham-jain33/repo-doctor");
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById("stars-count").textContent = data.stargazers_count;
    document.getElementById("stars-pill").hidden = false;
    icons();
  } catch (e) {}
})();

icons();
