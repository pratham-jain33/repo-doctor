#!/usr/bin/env python3
"""
repo-doctor: GitHub consistency auditor.

MVP is read-only on purpose. It scans every repo on your account and tells
you exactly what's wrong against your house standard:
  1. README.md exists and follows your chosen template structure
  2. The "About" box is filled: description, website link, topics/tags
  3. A LICENSE file exists (GitHub renders it on the repo page)

It fixes nothing. You fix, it verifies.

Usage:
    python3 repo_doctor.py                  # audit all repos
    python3 repo_doctor.py --skip MoCode,AMC # skip some repos
    python3 repo_doctor.py --only keysync,Bolo
    python3 repo_doctor.py --skip-forks
    python3 repo_doctor.py --report out.md   # custom report path
"""

import argparse
import base64
import json
import re
import subprocess
import sys

DEFAULT_OWNER = "pratham-jain33"

# ---------------------------------------------------------------------------
# House README standard.
# Derived from the template Pratham picked (akashnimare's README template),
# minus Contribute / Credits / License sections, which GitHub already renders
# natively on the repo page (contributors list, license badge on the right).
# ---------------------------------------------------------------------------

# (display name, heading keywords that count as a match)
REQUIRED_SECTIONS = [
    ("motivation", ["motivation", "why"]),
    ("tech/framework used", ["tech", "framework", "built with", "stack"]),
    ("features", ["feature"]),
    ("installation", ["install", "getting started", "setup"]),
    ("how to use", ["how to use", "usage", "quick start", "quickstart"]),
]

RECOMMENDED_SECTIONS = [
    ("build status", ["build status", "ci "]),
    ("code style", ["code style", "style guide"]),
    ("screenshots", ["screenshot", "screenshots", "demo", "preview"]),
    ("code example", ["code example", "example"]),
    ("api reference", ["api reference"]),
    ("tests", ["test", "testing"]),
]

MIN_DESCRIPTION_LEN = 20


def norm(text):
    """Normalize a heading for keyword matching."""
    return re.sub(r"[^a-z0-9 ]", "", text.lower())


def gh_api(path, jq=None):
    """Call the GitHub API through the gh CLI. Returns (stdout, error)."""
    cmd = ["gh", "api", path]
    if jq:
        cmd += ["--jq", jq]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        return None, "request timed out"
    if proc.returncode != 0:
        return None, proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else "gh api failed"
    return proc.stdout.strip(), None


def get_all_repos(owner):
    """List all repos (public + private) for the owner."""
    cmd = [
        "gh", "repo", "list", owner,
        "--limit", "200",
        "--json", "name,isFork,isPrivate,url",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        sys.exit("error: `gh repo list` timed out")
    if proc.returncode != 0:
        sys.exit(f"error: `gh repo list` failed: {proc.stderr.strip()}")
    try:
        repos = json.loads(proc.stdout)
    except json.JSONDecodeError:
        sys.exit("error: could not parse `gh repo list` output")
    # The owner/owner repo is the special profile repo (its README is the
    # GitHub profile page, not a project), so it is never audited.
    return [r for r in repos if r["name"].lower() != owner.lower()]


def get_repo_meta(owner, name):
    """description, homepage, topics, license id in one call."""
    out, err = gh_api(
        f"repos/{owner}/{name}",
        jq="{description: .description, homepage: .homepage, topics: (.topics // []), license: .license.spdx_id}",
    )
    if err:
        return None, err
    try:
        return json.loads(out), None
    except json.JSONDecodeError:
        return None, "bad json from api"


def get_readme(owner, name):
    """Returns README markdown, 'missing', or (None, error)."""
    out, err = gh_api(f"repos/{owner}/{name}/readme", jq="{content: .content, encoding: .encoding}")
    if err:
        if "404" in err or "Not Found" in err:
            return "missing", None
        return None, err
    try:
        data = json.loads(out)
        if data.get("encoding") == "base64":
            return base64.b64decode(data["content"]).decode("utf-8", errors="replace"), None
        return data.get("content", ""), None
    except (json.JSONDecodeError, ValueError) as e:
        return None, f"could not decode readme: {e}"


def parse_readme(md):
    """Extract headings (h1-h3) and the description text under the title."""
    headings = []
    lines = md.splitlines()
    for line in lines:
        m = re.match(r"^\s{0,3}#{1,3}\s+(.+?)\s*$", line)
        if m:
            headings.append(m.group(1).strip())

    # Description = first substantial non-heading, non-badge, non-empty text
    # after the title heading.
    description = ""
    past_title = False
    for line in lines:
        s = line.strip()
        if not past_title:
            if re.match(r"^\s{0,3}#{1,3}\s+", line):
                past_title = True
            continue
        if not s or s.startswith("#") or s.startswith("![") or s.startswith("[!"):
            continue
        if re.match(r"^<p", s) or re.match(r"^<div", s):
            continue
        description = s
        break
    return headings, description


def section_present(headings, keywords):
    needle = [norm(h) for h in headings]
    for kw in keywords:
        for h in needle:
            if kw in h:
                return True
    return False


def audit_repo(owner, repo):
    """Returns dict with missing[] and warnings[] lists."""
    name = repo["name"]
    missing, warnings = [], []

    meta, err = get_repo_meta(owner, name)
    if err:
        return {"name": name, "url": repo["url"], "error": err,
                "missing": missing, "warnings": warnings}

    # --- About box (the layout from the screenshot) ---
    if not (meta.get("description") or "").strip():
        missing.append("about: description is empty")
    if not (meta.get("homepage") or "").strip():
        missing.append("about: website link is empty")
    if not meta.get("topics"):
        missing.append("about: no topics/tags")
    if not meta.get("license") or meta["license"] in ("NOASSERTION",):
        missing.append("license: no LICENSE file detected")

    # --- README ---
    readme, err = get_readme(owner, name)
    if err:
        warnings.append(f"readme: could not fetch ({err})")
    elif readme == "missing":
        missing.append("readme: README.md missing")
    else:
        headings, description = parse_readme(readme)
        if not headings:
            missing.append("readme: no title heading found")
        if len(description) < MIN_DESCRIPTION_LEN:
            missing.append("readme: no real description under the title")
        for display, keywords in REQUIRED_SECTIONS:
            if not section_present(headings, keywords):
                missing.append(f"readme: missing '{display}' section")
        for display, keywords in RECOMMENDED_SECTIONS:
            if not section_present(headings, keywords):
                warnings.append(f"readme: no '{display}' section")

    return {"name": name, "url": repo["url"], "is_fork": repo["isFork"],
            "is_private": repo["isPrivate"], "missing": missing,
            "warnings": warnings}


def main():
    ap = argparse.ArgumentParser(description="Audit your GitHub repos for house-standard consistency.")
    ap.add_argument("--owner", default=DEFAULT_OWNER)
    ap.add_argument("--only", default="", help="comma-separated repo names to audit (default: all)")
    ap.add_argument("--skip", default="", help="comma-separated repo names to skip")
    ap.add_argument("--skip-forks", action="store_true", help="skip forked repos")
    ap.add_argument("--report", default="report.md", help="where to write the full markdown report")
    args = ap.parse_args()

    only = {r.strip() for r in args.only.split(",") if r.strip()}
    skip = {r.strip() for r in args.skip.split(",") if r.strip()}

    repos = get_all_repos(args.owner)
    selected = []
    for r in repos:
        if only and r["name"] not in only:
            continue
        if r["name"] in skip:
            continue
        if args.skip_forks and r["isFork"]:
            continue
        selected.append(r)

    print(f"auditing {len(selected)} repos for {args.owner}...\n")
    results = []
    for i, r in enumerate(selected, 1):
        print(f"  [{i}/{len(selected)}] {r['name']}", flush=True)
        results.append(audit_repo(args.owner, r))

    # Worst first, like a health check should be.
    results.sort(key=lambda x: (len(x.get("missing", [])), len(x.get("warnings", []))), reverse=True)

    print("\n" + "=" * 78)
    print(f"{'REPO':<28}{'PRIVATE':<9}{'MISSING':<9}{'WARNINGS':<9}TOP ISSUES")
    print("=" * 78)
    for r in results:
        if r.get("error"):
            print(f"{r['name']:<28}{'':<9}{'ERR':<9}{'':<9}{r['error']}")
            continue
        top = "; ".join(r["missing"][:2]) or "clean"
        priv = "yes" if r["is_private"] else "no"
        print(f"{r['name']:<28}{priv:<9}{len(r['missing']):<9}{len(r['warnings']):<9}{top}")
    print("=" * 78)

    total_missing = sum(len(r.get("missing", [])) for r in results)
    total_warn = sum(len(r.get("warnings", [])) for r in results)
    print(f"\n{len(results)} repos audited: {total_missing} missing items, {total_warn} warnings.")

    # Full markdown report.
    with open(args.report, "w") as f:
        f.write(f"# repo-doctor report: {args.owner}\n\n")
        f.write(f"{len(results)} repos audited. {total_missing} missing items, {total_warn} warnings.\n\n")
        for r in results:
            f.write(f"## {r['name']}\n\n{r['url']}\n\n")
            if r.get("error"):
                f.write(f"error: {r['error']}\n\n")
                continue
            if r["missing"]:
                f.write("**Missing:**\n\n")
                for m in r["missing"]:
                    f.write(f"- {m}\n")
                f.write("\n")
            if r["warnings"]:
                f.write("**Warnings:**\n\n")
                for w in r["warnings"]:
                    f.write(f"- {w}\n")
                f.write("\n")
            if not r["missing"] and not r["warnings"]:
                f.write("clean.\n\n")
    print(f"full report written to {args.report}")


if __name__ == "__main__":
    main()
