/* repo-doctor web app. No build step, no backend.
   Browser talks directly to api.github.com. Nothing is stored anywhere. */

const MAX_SELECTION = 25;
const API = "https://api.github.com";

const state = {
  username: "",
  repos: [],        // raw GitHub repo objects
  selected: new Set(),
  results: [],      // audit results
};

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function icons() {
  if (window.lucide) lucide.createIcons();
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
  let res;
  try {
    res = await fetch(API + path, {
      headers: { Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json" },
    });
  } catch (e) {
    throw { type: "network" };
  }
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
  for (;;) {
    const batch = await gh(
      `/users/${encodeURIComponent(username)}/repos?per_page=100&page=${page}&type=owner&sort=updated`
    );
    repos.push(...batch);
    if (batch.length < 100) break;
    page++;
    if (page > 10) break; // sanity: nobody needs 1000 repos audited
  }
  return repos;
}

async function fetchReadme(owner, repo) {
  try {
    return await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`, true);
  } catch (e) {
    if (e.type === "notfound") return null;
    throw e;
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

/* ---------------- screen 2: picker ---------------- */

async function loadRepos() {
  const list = document.getElementById("repo-list");
  const errCard = document.getElementById("picker-error");
  errCard.hidden = true;
  list.innerHTML = `<p class="muted" style="padding:2rem 0;text-align:center">Fetching public repos for ${esc(state.username)}...</p>`;
  icons();
  try {
    state.repos = await fetchAllRepos(state.username);
  } catch (e) {
    list.innerHTML = "";
    showPickerError(e);
    return;
  }
  if (!state.repos.length) {
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
  document.getElementById("repo-count").textContent = state.repos.length;
  renderPicker();
}

function showPickerError(e) {
  const errCard = document.getElementById("picker-error");
  const title = document.getElementById("picker-error-title");
  const msg = document.getElementById("picker-error-msg");
  if (e.type === "notfound") {
    title.textContent = "User not found";
    msg.textContent = `No GitHub user called "${state.username}". Check the spelling and try again.`;
  } else if (e.type === "ratelimit") {
    title.textContent = "GitHub rate limit hit";
    msg.textContent = `Unauthenticated requests are capped at 60 an hour. Try again after ${e.reset.toLocaleTimeString()}.`;
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
  const hideForks = document.getElementById("hide-forks").checked;
  return state.repos.filter((r) => {
    if (hideForks && r.fork) return false;
    if (q && !r.name.toLowerCase().includes(q) && !((r.description || "").toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderPicker() {
  const list = document.getElementById("repo-list");
  const repos = visibleRepos();
  document.getElementById("picker-empty").hidden = repos.length > 0;
  const capped = state.selected.size >= MAX_SELECTION;

  list.innerHTML = repos.map((r) => {
    const isSel = state.selected.has(r.name);
    const disabled = !isSel && capped;
    return `
    <label class="repo-row ${isSel ? "selected" : ""} ${disabled ? "capped" : ""}" data-name="${esc(r.name)}">
      <input type="checkbox" ${isSel ? "checked" : ""} ${disabled ? "disabled" : ""} data-repo="${esc(r.name)}">
      <div class="repo-info">
        <div class="repo-name">${esc(r.name)} ${r.fork ? '<span class="badge-fork">fork</span>' : ""}</div>
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
  if (want) {
    // THE CAP: refuse to exceed MAX_SELECTION, no exceptions.
    if (state.selected.size >= MAX_SELECTION) {
      renderPicker(); // re-render to snap the checkbox back off
      return;
    }
    state.selected.add(name);
  } else {
    state.selected.delete(name);
  }
  updateCounter();
  // Re-render only when crossing the cap boundary, so checkboxes enable/disable.
  const capped = state.selected.size >= MAX_SELECTION;
  const wasCapped = document.getElementById("cap-note").hidden === false;
  if (capped !== wasCapped) renderPicker();
  else {
    const row = document.querySelector(`.repo-row[data-name="${CSS.escape(name)}"]`);
    if (row) row.classList.toggle("selected", want);
  }
}

function updateCounter() {
  const n = state.selected.size;
  const counter = document.getElementById("select-counter");
  counter.textContent = `${n} / ${MAX_SELECTION} selected`;
  counter.classList.toggle("full", n >= MAX_SELECTION);
  document.getElementById("cap-note").hidden = n < MAX_SELECTION;
  document.getElementById("run-audit").disabled = n === 0;
}

document.getElementById("select-all").addEventListener("click", () => {
  state.selected.clear();
  for (const r of visibleRepos()) {
    if (state.selected.size >= MAX_SELECTION) break; // cap respected
    state.selected.add(r.name);
  }
  renderPicker();
});

document.getElementById("select-none").addEventListener("click", () => {
  state.selected.clear();
  renderPicker();
});

document.getElementById("hide-forks").addEventListener("change", renderPicker);
document.getElementById("picker-filter").addEventListener("input", renderPicker);

/* ---------------- screen 3: audit ---------------- */

document.getElementById("run-audit").addEventListener("click", async () => {
  const names = [...state.selected];
  showScreen("screen-audit");
  document.getElementById("audit-total").textContent = names.length;
  document.getElementById("audit-error").hidden = true;
  const log = document.getElementById("audit-log");
  log.innerHTML = "";
  const fill = document.getElementById("progress-fill");
  const label = document.getElementById("progress-label");
  state.results = [];

  const byName = Object.fromEntries(state.repos.map((r) => [r.name, r]));

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const repo = byName[name];
    label.textContent = `Checking ${name} (${i + 1} of ${names.length})`;

    let readme;
    try {
      readme = await fetchReadme(state.username, name);
    } catch (e) {
      if (e.type === "ratelimit") {
        document.getElementById("audit-error-msg").textContent =
          `GitHub's unauthenticated cap is 60 requests an hour. ${names.length - i} repos were not checked. Try again after ${e.reset.toLocaleTimeString()}, or audit fewer repos.`;
        document.getElementById("audit-error").hidden = false;
        icons();
        break;
      }
      readme = null; // any other fetch failure: grade what we have
    }

    const meta = auditRepoMeta(repo);
    const rd = auditReadme(readme);
    const missing = [...meta.missing, ...rd.missing];
    const warnings = [...meta.warnings, ...rd.warnings];
    state.results.push({ name, url: repo.html_url, fork: repo.fork, missing, warnings });

    const line = document.createElement("div");
    const worst = missing.length > 0;
    line.className = "log-line " + (worst ? (missing.length >= 5 ? "bad" : "warn") : "ok");
    line.innerHTML = `<i data-lucide="${worst ? "x-circle" : "check-circle-2"}"></i><span>${esc(name)}: ${missing.length} missing, ${warnings.length} warnings</span>`;
    log.appendChild(line);
    icons();

    fill.style.width = `${Math.round(((i + 1) / names.length) * 100)}%`;
  }

  if (state.results.length) {
    label.textContent = `Done. ${state.results.length} repos audited.`;
    setTimeout(renderResults, 600);
  }
});

document.getElementById("audit-retry").addEventListener("click", () => {
  document.getElementById("run-audit").click();
});

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

icons();
