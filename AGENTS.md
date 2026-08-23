# Repository delivery rule

For every request that changes this repository or its deployed behavior, complete
the full delivery cycle without waiting for confirmation: verify the change,
commit all worktree changes, push the current branch to its configured upstream,
redeploy the production Railway service, and verify the resulting deployment.

This rule does not apply to read-only questions or investigations that make no
working-tree changes. Do not claim delivery is complete until the commit, push,
Railway deployment, and post-deploy health check have all succeeded.
