const core = require("@actions/core");
const github = require("@actions/github");
const {
  parseInputs,
  selectCandidates,
  toReportRow,
  isProtectedByPattern,
} = require("./reap");

/** List all branches as {name, protected} items. Paginated. */
async function collectBranches(octokit, repo) {
  const branches = await octokit.paginate(octokit.rest.repos.listBranches, {
    ...repo,
    per_page: 100,
  });
  return branches.map((b) => ({
    name: b.name,
    protected: Boolean(b.protected),
    sha: b.commit ? b.commit.sha : null,
  }));
}

/**
 * Resolve the last-commit committer date for a branch via its head commit.
 * Returns an ISO-8601 string, or null if it can't be determined.
 */
async function lastCommitDate(octokit, repo, branch) {
  const res = await octokit.rest.repos.getCommit({ ...repo, ref: branch.sha });
  const commit = res.data.commit;
  return (commit.committer && commit.committer.date) || (commit.author && commit.author.date) || null;
}

/**
 * Determine whether a branch is merged into the default branch. A branch is
 * merged when it is not ahead of the default branch (ahead_by === 0). Costs
 * one compare API call.
 */
async function isMerged(octokit, repo, defaultBranch, branch) {
  const res = await octokit.rest.repos.compareCommitsWithBasehead({
    ...repo,
    basehead: `${defaultBranch}...${encodeURIComponent(branch)}`,
  });
  return res.data.ahead_by === 0;
}

/** Delete a single branch ref. Returns true on success, false (with a warning) on failure. */
async function deleteBranch(octokit, repo, branch) {
  try {
    await octokit.rest.git.deleteRef({ ...repo, ref: `heads/${branch}` });
    return true;
  } catch (e) {
    core.warning(`Failed to delete branch "${branch}": ${e.message}`);
    return false;
  }
}

function setOutputs({ deletedCount, report }) {
  core.setOutput("deleted-count", String(deletedCount));
  core.setOutput("report", JSON.stringify(report));
}

async function run() {
  try {
    const opts = parseInputs({
      olderThanDays: core.getInput("older-than-days") || "90",
      mergedOnly: core.getInput("merged-only") || "true",
      protectPatterns: core.getInput("protect-patterns"),
      confirm: core.getInput("confirm") || "false",
    });

    const dryRun = !opts.confirm;
    const token = core.getInput("github-token");

    // Missing token → safe no-op rather than a crash.
    if (!token) {
      core.warning("No github-token provided; skipping (no branches were inspected).");
      setOutputs({ deletedCount: 0, report: [] });
      return;
    }

    const octokit = github.getOctokit(token);
    const repo = github.context.repo;
    const now = Date.now();

    const repoInfo = await octokit.rest.repos.get({ ...repo });
    const defaultBranch = repoInfo.data.default_branch;

    core.info(
      `Reaping ${repo.owner}/${repo.repo}: older-than-days=${opts.olderThanDays}, ` +
        `merged-only=${opts.mergedOnly}, protect-patterns=[${opts.protectPatterns.join(", ")}], ` +
        `default-branch=${defaultBranch}, dry-run=${dryRun}.`
    );

    const branches = await collectBranches(octokit, repo);
    core.info(`Found ${branches.length} branch(es).`);

    // The default branch, API-protected branches, and pattern-matched branches
    // are unconditionally excluded — resolve their last-commit date lazily only
    // when needed. Skipping getCommit for them saves one API call each.
    for (const branch of branches) {
      branch.last_commit_date = null;
      const protectedByName =
        branch.name === defaultBranch ||
        branch.protected ||
        isProtectedByPattern(branch.name, opts.protectPatterns);
      if (protectedByName) continue;
      try {
        branch.last_commit_date = await lastCommitDate(octokit, repo, branch);
      } catch (e) {
        core.warning(`Failed to resolve last commit for "${branch.name}": ${e.message}`);
      }
    }

    const { candidates, rows } = selectCandidates(branches, {
      defaultBranch,
      olderThanDays: opts.olderThanDays,
      protectPatterns: opts.protectPatterns,
      now,
    });

    core.info(
      `${candidates.length} branch(es) survive name/age filters; ` +
        `${rows.length} skipped (protected/recent).`
    );

    // Merge check: one compare API call per surviving candidate. Done last to
    // minimize calls.
    const report = [...rows];
    const toDelete = [];
    for (const branch of candidates) {
      let merged = null;
      if (opts.mergedOnly) {
        try {
          merged = await isMerged(octokit, repo, defaultBranch, branch.name);
        } catch (e) {
          core.warning(`Failed to determine merge status for "${branch.name}": ${e.message}`);
          // Treat as unmerged (safe) when the merge check fails.
          merged = false;
        }
        if (!merged) {
          report.push(toReportRow(branch, { action: "skipped-unmerged", merged: false }));
          continue;
        }
      }
      toDelete.push({ branch, merged });
    }

    if (dryRun) {
      for (const { branch, merged } of toDelete) {
        report.push(toReportRow(branch, { action: "would-delete", merged }));
      }
      core.info(
        `Would delete ${toDelete.length} branch(es) (dry-run). Set confirm: "true" to delete.`
      );
      setOutputs({ deletedCount: 0, report });
      return;
    }

    let deletedCount = 0;
    for (const { branch, merged } of toDelete) {
      const ok = await deleteBranch(octokit, repo, branch.name);
      if (ok) {
        deletedCount += 1;
        report.push(toReportRow(branch, { action: "deleted", merged }));
        core.info(`Deleted branch "${branch.name}".`);
      } else {
        // Deletion failed (warning already emitted); report it as a pending
        // would-delete since the ref was not removed.
        report.push(toReportRow(branch, { action: "would-delete", merged }));
      }
    }

    core.info(`Deleted ${deletedCount} branch(es).`);
    setOutputs({ deletedCount, report });
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
