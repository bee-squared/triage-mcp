## Agent git workflow

These rules apply inside an agent VM (Docker Sandbox or Vercel Sandbox), running as the agent GitHub account.
On the user's Mac, never commit or push: suggest a commit message instead.

- Only the orchestrator (main session) runs git add, commit, push and gh.
  Helpers edit files and report: files changed, tests run, open issues.
- Before the first commit, check identity: `git var GIT_AUTHOR_IDENT` and
  `gh api user --jq .login` must show the agent account. If either shows
  the user, stop and say so.
- Work only in this repository: the one this VM was started for (its `origin`).
  Never push to, open or comment on PRs or issues in, create, fork, or clone any
  other repository, and don't try, not even to check whether you have access.
- Don't add, rename or change git remotes, and don't push to any remote other
  than `origin`.
- Use `gh` only against this repository: no `--repo`/`-R` pointing elsewhere,
  and no `gh api` calls to other repositories.
- If a task seems to need another repository, stop and ask instead.
- Branch from origin/main as agent/<short-description>. Never work on main.
- Never push to main, never force push, never rewrite pushed history.
- Never approve or merge a PR, including your own.
- Never skip git hooks with --no-verify or LEFTHOOK=0. If a hook fails, fix the
  cause or report it. Don't edit lefthook.yml unless the task asks for it.
- Don't change files in .github/workflows. The agent's token can't push them.
  If a task needs a CI change, stop and ask the user to make it.
- Make logical commits. Open PRs as drafts with the ai-generated label:
  gh pr create --draft --label ai-generated
- Fill in every section of .github/pull_request_template.md, and keep its
  AI disclaimer line.
- After opening the PR, report: branch, commit hashes, PR URL, tests run,
  known limitations.