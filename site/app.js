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
  excludeForks: false, // default off; never persisted, always read from the checkbox
  selected: new Set(),
  results: [],      // audit results
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
  // Always read the live checkbox: the preference is never saved anywhere,
  // so the working set must match what the user currently sees.
  state.excludeForks = document.getElementById("exclude-forks").checked;
  applyForkFilter();
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
  document.getElementById("mode-line").textContent = state.token
    ? `Token connected as @${state.tokenLogin}: private repos included, 5,000 requests/hr.`
    : "Public repos only.";
  renderPicker();
}

/* Forks are excluded from the working set at fetch time: they never appear
   in the picker, never consume the selection cap, and never cost API calls. */
function applyForkFilter() {
  state.repos = state.excludeForks
    ? state.fetchedRepos.filter((r) => !r.fork)
    : [...state.fetchedRepos];
  for (const name of [...state.selected]) {
    if (!state.repos.some((r) => r.name === name)) state.selected.delete(name);
  }
}

document.getElementById("exclude-forks").addEventListener("change", (e) => {
  state.excludeForks = e.target.checked;
  applyForkFilter();
  renderPicker();
});

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

function renderPicker() {
  const list = document.getElementById("repo-list");
  const repos = visibleRepos();
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

async function startAudit(resume) {
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
      readme = await fetchReadme(state.username, name);
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
    const pr = auditProtection(isProtected);
    const missing = [...meta.missing, ...rd.missing, ...pr.missing];
    const warnings = [...meta.warnings, ...rd.warnings, ...pr.warnings];
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
  setTimeout(renderResults, 600);
}

/* ---------------- screen 4: results ---------------- */

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
    `${results.length} repos audited: ${totalMissing} missing items, ${totalWarn} warnings.`;

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
    const issues = [
      ...r.missing.map((m) => `<li class="missing"><i data-lucide="x-circle"></i><span>${esc(m)}</span></li>`),
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
  const system = `You are repo-doctor's README writer. You reply with ONLY a JSON object, no markdown fences, no commentary:
{"readme": "the full README.md", "description": "one line", "topics": ["t1", "t2"], "website": "https://..."}

README structure — use these sections in this order, skipping any you cannot fill truthfully:
# Title
<one or two honest lines saying what it is>
## Motivation
## Tech stack
## Features
## Installation
## Usage
(## API reference and ## Tests only when genuinely applicable)

Hard rules:
- No emojis anywhere.
- Installation and Usage must be copy-pasteable steps derived ONLY from the files and manifest given. Never invent commands, URLs, flags, or features.
- If a fact is unknown, omit it. Do not hallucinate.
- Do NOT write Contribute, Credits, or License sections — GitHub renders those natively.
- End the README with a blank line, then ---, then a blank line, then exactly:
${ATTRIBUTION_LINE}
(The blank lines matter: without them GitHub turns your last paragraph into a giant heading.)

"description": one honest line, no trailing period, under 120 characters.
"topics": 1 to 5 items, lowercase, hyphens instead of spaces.
"website": the live demo or docs URL, copied EXACTLY as it appears in the files or existing README given (package.json "homepage", a demo link, a docs site). Never invent, guess, or normalize a URL. If you cannot see one, use "".`;

  const user = `Repo: ${ctx.repo.name} by ${ctx.owner}
GitHub description now: ${ctx.repo.description || "(empty)"}
Language: ${ctx.repo.language || "unknown"} | Stars: ${ctx.repo.stargazers_count} | Topics now: ${(ctx.repo.topics || []).join(", ") || "(none)"}
Files in repo root: ${ctx.files.join(", ") || "(empty repo)"}
${ctx.manifestName ? `--- ${ctx.manifestName} ---\n${ctx.manifestBody}\n` : "(no dependency manifest found)"}
--- existing README (may be missing or incomplete) ---
${ctx.existing || "(none)"}

Write the JSON now.`;
  return { system, user };
}

async function gatherFixContext(owner, name) {
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
  return { owner, repo, files, manifestName, manifestBody, existing };
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
      content: toB64(f.content),
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
    const { system, user } = buildFixPrompt(ctx);
    const data = parseFixJson(await groqChat(system, user));
    renderFixPreview(name, kinds, ctx, data, work);
  } catch (e) {
    work.innerHTML = `<p class="fix-error">${fixErrorText(e)}</p>`;
  }
}

function renderFixPreview(name, kinds, ctx, data, work) {
  const toggles = [
    kinds.readme ? `<label class="check"><input type="checkbox" data-t="readme" checked><span class="custom-check"><i data-lucide="check"></i></span> README via PR</label>` : "",
    kinds.about ? `<label class="check"><input type="checkbox" data-t="about" checked><span class="custom-check"><i data-lucide="check"></i></span> Apply About box</label>` : "",
    kinds.license ? `<label class="check"><input type="checkbox" data-t="license" checked><span class="custom-check"><i data-lucide="check"></i></span> MIT LICENSE via PR</label>` : "",
    kinds.protection ? `<label class="check"><input type="checkbox" data-t="protection" checked><span class="custom-check"><i data-lucide="check"></i></span> Protect default branch</label>` : "",
  ].join("");
  work.innerHTML = `
    ${kinds.readme ? `<h4 class="fix-title" style="margin-top:0.4rem">README preview</h4><div class="md-preview">${mdToHtml(data.readme)}</div>` : ""}
    ${kinds.about ? `<div class="fix-fields">
      <label>About description<input data-f="description" value="${esc(data.description)}" maxlength="140"></label>
      <label>Topics, comma separated<input data-f="topics" value="${esc(data.topics.join(", "))}"></label>
      <label>Website<input data-f="homepage" value="${esc(data.website || ctx.repo.homepage || "")}" placeholder="https://..."></label>
      ${(!data.website && !ctx.repo.homepage) ? `<p class="fix-note">The AI couldn't find a live URL in the repo files — paste your demo or docs link here if you have one.</p>` : ""}
    </div>` : ""}
    <div class="fix-toggles">${toggles}</div>
    <div class="fix-actions">
      <button class="btn btn-primary" data-apply>Apply fixes</button>
      <button class="btn btn-ghost" data-regen>Regenerate</button>
    </div>
    <div class="fix-result"></div>`;
  icons();
  work.querySelector("[data-regen]").addEventListener("click", () => startFix(name, kinds, work.closest(".fix-panel")));
  work.querySelector("[data-apply]").addEventListener("click", () => applyFixes(name, kinds, ctx, data, work));
}

async function applyFixes(name, kinds, ctx, data, work) {
  const result = work.querySelector(".fix-result");
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
    if (files.length) {
      const title = "repo-doctor: AI fixes" + (files.length > 1 ? ` (${files.map((f) => f.path).join(", ")})` : ` (${files[0].path})`);
      prUrl = await openFixPR(owner, name, files, title);
      lines.push("PR opened. Nothing is applied until you merge it.");
    }
    result.innerHTML = `
      <div class="pr-card">
        <i data-lucide="check"></i>
        <div>
          <h4>${prUrl ? "PR opened" : "Done"}</h4>
          <p>${lines.join(" ")}</p>
          ${prUrl ? `<a class="btn btn-primary btn-mini" href="${esc(prUrl)}" target="_blank" rel="noopener">Review &amp; merge on GitHub <i data-lucide="external-link"></i></a>` : ""}
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
