# Proactive quality assurance

### Stale branch cleanup job (#481)

Add a scheduled job (e.g. weekly) that scans remote branches matching `claws/*` patterns and deletes those whose associated PRs have been merged or closed for more than 7 days. Over time, Claws creates hundreds of branches (issue-*, plan-*, improve-*, docs-*, investigate-*, ideas-*) that are never cleaned up after their PRs merge. This clutters the repository and slows down `git fetch`. Implementation: list remote branches matching `claws/*` via `git branch -r`, for each check if the associated PR is merged/closed via `gh pr list --head <branch> --state merged`, and delete with `git push origin --delete <branch>`. Run as a lightweight job like repo-standards — no Claude invocation needed, just git and gh CLI calls. Include a safety check: never delete branches with open PRs or branches less than 7 days old.
