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
  fetchedRepos: [], // everything the API returned, forks included
  repos: [],        // working set after the fork filter
  excludeForks: false, // default off; never persisted, always read from the checkbox
  selected: new Set(),
  results: [],      // audit results
};

function maxSelection() {
  return state.token ? TOKEN_CAP : FREE_CAP;
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
  return repos;
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
    const res = await fetch(entry.download_url);
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  }
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
  document.getElementById("token-toggle").style.display = "none";
  document.getElementById("token-active").hidden = false;
  document.getElementById("token-user").textContent = "@" + state.tokenLogin;
  document.getElementById("trust-line").hidden = true;
  icons();
}

function forgetToken() {
  state.token = "";
  state.tokenLogin = "";
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  document.getElementById("token-input").value = "";
  document.getElementById("token-active").hidden = true;
  document.getElementById("token-toggle").style.display = "";
  document.getElementById("trust-line").hidden = false;
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

document.getElementById("token-toggle").addEventListener("click", () => {
  const f = document.getElementById("token-form");
  f.hidden = !f.hidden;
  icons();
});
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
  document.getElementById("pick-cap").textContent = maxSelection();
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
  const cap = maxSelection();
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
  const cap = maxSelection();
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
  const cap = maxSelection();
  const counter = document.getElementById("select-counter");
  counter.textContent = `${n} / ${cap} selected`;
  counter.classList.toggle("full", n >= cap);
  document.getElementById("cap-note").hidden = n < cap;
  document.getElementById("cap-note-text").textContent = `${cap} repo cap reached. Deselect one to pick another.`;
  document.getElementById("run-audit").disabled = n === 0;
}

document.getElementById("select-all").addEventListener("click", () => {
  state.selected.clear();
  const cap = maxSelection();
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
    try {
      readme = await fetchReadme(state.username, name);
    } catch (e) {
      if (e.type === "ratelimit" || e.type === "badauth") {
        document.getElementById("audit-error-msg").textContent = e.type === "badauth"
          ? "Your token was rejected mid-audit. Reconnect a fresh token on the home page, then retry to pick up where you left off."
          : state.token
            ? `GitHub's rate limit was hit with ${total - completed} repos left unchecked. Try again after ${e.reset.toLocaleTimeString()} — retry resumes where it stopped.`
            : `GitHub's unauthenticated cap is 60 requests an hour, and ${total - completed} repos were not checked. Connect a token on the home page for 5,000/hr and private repos, or try again after ${e.reset.toLocaleTimeString()} — retry resumes where it stopped.`;
        document.getElementById("audit-error").hidden = false;
        icons();
        return; // keep state.results: retry resumes, nothing is lost
      }
      repoNote = "readme: could not be checked (request failed)";
    }

    const meta = auditRepoMeta(repo);
    const rd = auditReadme(readme);
    const missing = [...meta.missing, ...rd.missing];
    const warnings = [...meta.warnings, ...rd.warnings];
    if (repoNote) warnings.push(repoNote);
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
