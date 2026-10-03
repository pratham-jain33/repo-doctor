# repo-doctor

A read-only auditor that scans every repo on your GitHub account and tells
you exactly what breaks your house standard. It fixes nothing. You fix, it
verifies.

**Use it in your browser, no install:** https://prathamjain.com/projects/repo-doctor

## Motivation

A GitHub profile with 40 repos where half have empty descriptions and no
README looks abandoned even when the work is real. Existing README
generators write one README at a time and call it done. repo-doctor works
the other way: it audits the whole account against one standard and hands
you the fix list, worst repos first.

## Tech/framework used

Built with Python 3 (stdlib only) on top of the GitHub REST API via the
`gh` CLI. No dependencies to install, no API keys to manage.

## Features

- Audits all repos, public and private, in one run
- Checks README structure against your house template
- Checks the About box: description, website link, topics/tags
- Checks that a LICENSE file exists
- Filters: `--only`, `--skip`, `--skip-forks`
- Terminal table sorted worst-first, plus a full markdown report

## Installation

```bash
git clone <this-repo>
cd repo-doctor
# requires the GitHub CLI, authenticated:
gh auth login
```

## How to use?

```bash
python3 repo_doctor.py                  # audit everything
python3 repo_doctor.py --skip MoCode,AMC # skip repos you don't care about
python3 repo_doctor.py --only keysync,Bolo
python3 repo_doctor.py --skip-forks
python3 repo_doctor.py --report out.md   # custom report path
```

The house standard itself lives in `HOUSE_STANDARD.md`. Edit that file when
your taste changes, the auditor follows it.

## Tests

```bash
python3 -m py_compile repo_doctor.py
```
