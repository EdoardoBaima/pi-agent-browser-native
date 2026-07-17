---
name: upstream-reconcile
description: Reconcile this Windows fork with upstream. Use when auditing upstream drift, updating the fork branch, or refreshing the installed Pi extension and BYCO mirror.
compatibility: Git, Pi, npm, and chezmoi; native Windows verification is required for the fork fix.
---

# Upstream reconcile

Reconcile rather than blindly pull. The finished state is:

- `upstream/main` is the canonical project history.
- `origin` carries the GitHub fork and the branch used by Pi.
- `byco` mirrors company-visible work on Forgejo.
- The active fork branch contains only behavior still missing upstream.
- Pi loads the commit that passed verification.

Treat the remote roles in `AGENTS.md` as authoritative.

## 1. Establish truth

Read state before choosing an operation:

```bash
git status --short --branch
git remote -v
git branch -vv
git fetch upstream --prune
git fetch origin --prune
git fetch byco --prune
git rev-list --left-right --count upstream/main...HEAD
git cherry -v upstream/main HEAD
git log --left-right --cherry-pick --oneline upstream/main...HEAD
pi list
chezmoi source-path
```

Inspect the installed clone reported by `pi list` with `git -C <path> rev-parse HEAD`. Compare the live `~/.pi/agent/settings.json` entry with `dot_pi/agent/settings.json.tmpl` under `chezmoi source-path`. The chezmoi template is the durable source; the live settings file is rendered state.

A dirty worktree permits an audit but pauses rebases, source changes, and pushes. Forgejo being unreachable permits the GitHub audit but leaves the mirror incomplete.

*Complete when the upstream, branch, `origin`, `byco`, configured package source, and installed checkout are each identified by URL or exact commit.*

## 2. Choose the smallest outcome

Account for every commit shown by `git cherry`:

- If upstream has not moved, change nothing unless the installed checkout is stale.
- If the Windows behavior remains absent upstream, rebase the fork branch onto `upstream/main`.
- If upstream now provides equivalent behavior, retire the Windows-only install branch.
- If equivalence is uncertain, keep the fork patch and state what proof is missing.

Equivalent means code or upstream history explains the replacement **and** the original Windows regression passes against upstream in a disposable worktree. A similar commit title is not proof.

For an audit-only request, stop here with the exact ahead/behind counts, installed commit, fork-only commits, and one recommended outcome.

*Complete when every fork-only commit is classified as retain, replace with proven upstream behavior, or investigate further.*

## 3A. Keep and update the fork branch

Start from a clean worktree. Confirm the current branch is neither `main` nor detached and exactly matches the ref in Pi's configured Git source. Check out that configured branch before continuing if needed. Preserve its old tip, then rebase:

```bash
branch=$(git branch --show-current)
backup="backup/upstream-reconcile-$(date +%Y%m%d-%H%M%S)"
git branch "$backup" HEAD
git rebase upstream/main
old_base=$(git merge-base "$backup" upstream/main)
git range-diff "$old_base..$backup" "upstream/main..HEAD"
```

Load the `commit` skill before creating commits. Load `resolving-merge-conflicts` if the rebase conflicts. Keep the backup until publishing and installation verification finish.

Run the focused Windows process tests first. Then run the verification and interactive checkout smoke required by `AGENTS.md`. Exercise the original npm-shim failure on native Windows; a Linux-only pass cannot prove this fork.

Publish only verified history:

```bash
# These main updates must be fast-forwards; inspect any rejection.
git push origin upstream/main:main
git push byco upstream/main:main

git push --force-with-lease origin HEAD:"$branch"
git push --force-with-lease byco HEAD:"$branch"

pi update --extension "git:github.com/EdoardoBaima/pi-agent-browser-native@$branch"
```

Use the configured package identity from `pi list` if it differs. `pi update --extension` fetches the configured branch and resets Pi's managed clone to that branch tip. Delete the local backup after the reloaded runtime passes step 4.

*Complete when `upstream/main` is an ancestor of the branch; `origin/$branch`, `byco/$branch`, and the installed clone equal `HEAD`; required checks pass; both main mirrors equal `upstream/main`.*

## 3B. Retire the fork install

Take this branch only after the proof in step 2 covers every fork-only behavior.

Load the `chezmoi-parity` skill. In the chezmoi source repository, change the Windows package source in `dot_pi/agent/settings.json.tmpl` from the GitHub fork branch to `npm:pi-agent-browser-native`, matching WSL. Review `chezmoi diff`, commit and push the `pi_config` source to its Forgejo `origin`, then apply it.

Install and verify the npm package before removing the old managed Git clone:

```bash
pi update --extension npm:pi-agent-browser-native
pi list
pi remove git:github.com/EdoardoBaima/pi-agent-browser-native
```

Keep the fork branches unless the user separately asks to delete them; they remain useful history.

*Complete when chezmoi renders the npm source on Windows and WSL, parity checks pass, the source commit is on Forgejo, and `pi list` reports a working npm installation.*

## 4. Prove the active runtime

Restart Pi, which is preferred, or use `/reload` after the managed package changes. Run a native `agent_browser` smoke from the reloaded runtime. Compare the installed package path and commit or version with the selected source.

Report:

- upstream delta before and after;
- fork commits retained or retired;
- verification commands and results;
- `origin` and `byco` mirror status;
- configured package source, installed path, and exact commit or version;
- backup branch and any remaining cleanup.

*Complete when the reloaded Pi runtime passes the smoke, both repositories are clean, temporary backup refs and worktrees are removed, and every reported SHA or version matches the selected outcome.*
