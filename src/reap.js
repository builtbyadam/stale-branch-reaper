// Pure logic for stale-branch-reaper. No GitHub API calls here so it can be
// unit-tested directly (see test/reap.test.js).

/**
 * Convert a glob to a RegExp. Copied verbatim from matrix-shrinker's
 * src/shrink.js so this action stays self-contained (actions never import
 * across directories). Matched against branch names, which may contain "/"
 * separators (e.g. "release/1.0"), so the "/" semantics matter.
 * Supported syntax:
 *   *   matches anything except "/"
 *   ?   matches a single character except "/"
 *   **  matches anything, including "/"
 */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?"; // "**/" — zero or more leading directories
          i += 2;
        } else {
          re += ".*"; // trailing or bare "**"
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** Parse a boolean-string input ("true"/"false"). Throws on anything else. */
function parseBool(name, value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Input "${name}" must be "true" or "false", got "${value}".`);
}

/** Parse a non-negative integer input. Throws on anything else. */
function parseNonNegativeInt(name, value) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Input "${name}" must be a non-negative integer, got "${value}".`);
  }
  return Number(value);
}

/**
 * Parse the protect-patterns input. Patterns are separated by newlines or
 * commas; surrounding whitespace and empty entries are dropped.
 *
 * @param {string} value Raw input.
 * @returns {string[]} Glob patterns.
 */
function parseProtectPatterns(value) {
  return (value || "")
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Parse and validate all raw inputs into a typed options object.
 *
 * @param {object} raw Raw string inputs.
 * @param {string} raw.olderThanDays
 * @param {string} raw.mergedOnly
 * @param {string} raw.protectPatterns
 * @param {string} raw.confirm
 * @returns {{olderThanDays:number, mergedOnly:boolean, protectPatterns:string[],
 *           confirm:boolean}}
 */
function parseInputs(raw) {
  return {
    olderThanDays: parseNonNegativeInt("older-than-days", raw.olderThanDays),
    mergedOnly: parseBool("merged-only", raw.mergedOnly),
    protectPatterns: parseProtectPatterns(raw.protectPatterns),
    confirm: parseBool("confirm", raw.confirm),
  };
}

/**
 * Compute the age of a timestamp in whole days relative to `now`.
 *
 * @param {string} timestamp ISO-8601 timestamp.
 * @param {number} now Reference time in ms (defaults to Date.now()).
 * @returns {number} Age in days (fractional).
 */
function ageInDays(timestamp, now = Date.now()) {
  return (now - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * True when a branch name matches any of the protect patterns.
 *
 * @param {string} branch Branch name.
 * @param {string[]} patterns Glob patterns.
 * @returns {boolean}
 */
function isProtectedByPattern(branch, patterns) {
  return patterns.some((p) => globToRegExp(p).test(branch));
}

/**
 * Decide the action for a single branch, applying the cheap filters that
 * require no extra API calls: default-branch exclusion, API-protected flag,
 * and protect-pattern matching, then age. Returns one of:
 *   "skipped-protected" — default/protected/pattern-matched (always kept)
 *   "skipped-recent"    — last commit younger than olderThanDays
 *   null                — survives the cheap filters; needs the merge check
 *
 * @param {object} branch {name, protected}.
 * @param {object} opts
 * @param {string} opts.defaultBranch
 * @param {number} opts.olderThanDays
 * @param {string[]} opts.protectPatterns
 * @param {string} opts.lastCommitDate ISO-8601 date of the branch's last commit.
 * @param {number} opts.now Reference time in ms.
 * @returns {string|null}
 */
function classifyBranch(branch, { defaultBranch, olderThanDays, protectPatterns, lastCommitDate, now }) {
  if (branch.name === defaultBranch) return "skipped-protected";
  if (branch.protected) return "skipped-protected";
  if (isProtectedByPattern(branch.name, protectPatterns)) return "skipped-protected";
  // Unknown date (couldn't resolve the last commit) → treat as recent so we
  // never delete a branch whose age we can't confirm.
  if (!lastCommitDate) return "skipped-recent";
  if (ageInDays(lastCommitDate, now) < olderThanDays) return "skipped-recent";
  return null;
}

/**
 * Select deletion candidates from a list of branches that have already had
 * their last-commit date resolved. This applies only the no-extra-API filters
 * (protected/pattern/age); the merge check happens in the glue because it
 * costs one API call per surviving candidate.
 *
 * @param {object[]} branches Each: {name, protected, last_commit_date}.
 * @param {object} opts {defaultBranch, olderThanDays, protectPatterns, now}.
 * @returns {{candidates: object[], rows: object[]}}
 *   candidates: branches that survive the cheap filters (need a merge check).
 *   rows: report rows for branches filtered out here (skipped-protected /
 *         skipped-recent).
 */
function selectCandidates(branches, { defaultBranch, olderThanDays, protectPatterns, now }) {
  const candidates = [];
  const rows = [];
  for (const branch of branches) {
    const skip = classifyBranch(branch, {
      defaultBranch,
      olderThanDays,
      protectPatterns,
      lastCommitDate: branch.last_commit_date,
      now,
    });
    if (skip) {
      rows.push(toReportRow(branch, { action: skip }));
    } else {
      candidates.push(branch);
    }
  }
  return { candidates, rows };
}

/**
 * Build a report row for a branch.
 *
 * @param {object} branch {name, last_commit_date}.
 * @param {object} info
 * @param {string} info.action One of the report actions.
 * @param {boolean} [info.merged] Whether the branch is merged (when known).
 * @returns {object} {branch, last_commit_date, merged, action}.
 */
function toReportRow(branch, { action, merged = null }) {
  return {
    branch: branch.name,
    last_commit_date: branch.last_commit_date || null,
    merged,
    action,
  };
}

module.exports = {
  globToRegExp,
  parseBool,
  parseNonNegativeInt,
  parseProtectPatterns,
  parseInputs,
  ageInDays,
  isProtectedByPattern,
  classifyBranch,
  selectCandidates,
  toReportRow,
};
