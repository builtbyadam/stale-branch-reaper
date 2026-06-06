const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
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
} = require("../src/reap");

const DAY = 1000 * 60 * 60 * 24;
const NOW = Date.parse("2026-06-06T00:00:00Z");
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

describe("globToRegExp", () => {
  test("* matches within a segment, ** across segments", () => {
    assert.ok(globToRegExp("release/*").test("release/1.0"));
    assert.ok(!globToRegExp("release/*").test("release/1/0"));
    assert.ok(globToRegExp("release/**").test("release/1/0"));
  });

  test("? matches a single non-separator character", () => {
    assert.ok(globToRegExp("v?").test("v1"));
    assert.ok(!globToRegExp("v?").test("v12"));
  });

  test("exact names match exactly", () => {
    assert.ok(globToRegExp("main").test("main"));
    assert.ok(!globToRegExp("main").test("maintenance"));
  });
});

describe("parseBool / parseNonNegativeInt", () => {
  test("parseBool accepts true/false", () => {
    assert.strictEqual(parseBool("x", "true"), true);
    assert.strictEqual(parseBool("x", "false"), false);
  });

  test("parseBool rejects other values", () => {
    assert.throws(() => parseBool("merged-only", "yes"), /Input "merged-only" must be "true" or "false"/);
  });

  test("parseNonNegativeInt accepts zero and positive ints", () => {
    assert.strictEqual(parseNonNegativeInt("x", "0"), 0);
    assert.strictEqual(parseNonNegativeInt("x", "90"), 90);
  });

  test("parseNonNegativeInt rejects negatives and non-numbers", () => {
    assert.throws(() => parseNonNegativeInt("older-than-days", "-1"), /must be a non-negative integer/);
    assert.throws(() => parseNonNegativeInt("older-than-days", "9.5"), /must be a non-negative integer/);
    assert.throws(() => parseNonNegativeInt("older-than-days", "abc"), /must be a non-negative integer/);
  });
});

describe("parseProtectPatterns", () => {
  test("splits on newlines and commas, trims, drops empties", () => {
    assert.deepStrictEqual(parseProtectPatterns("main\nmaster\nrelease/**"), [
      "main",
      "master",
      "release/**",
    ]);
    assert.deepStrictEqual(parseProtectPatterns("main, master , release/**"), [
      "main",
      "master",
      "release/**",
    ]);
    assert.deepStrictEqual(parseProtectPatterns("\n\n  \n"), []);
    assert.deepStrictEqual(parseProtectPatterns(""), []);
  });
});

describe("parseInputs", () => {
  test("parses and validates a full input set", () => {
    const opts = parseInputs({
      olderThanDays: "30",
      mergedOnly: "false",
      protectPatterns: "main\nrelease/**",
      confirm: "true",
    });
    assert.deepStrictEqual(opts, {
      olderThanDays: 30,
      mergedOnly: false,
      protectPatterns: ["main", "release/**"],
      confirm: true,
    });
  });

  test("propagates validation errors", () => {
    assert.throws(
      () =>
        parseInputs({
          olderThanDays: "-5",
          mergedOnly: "true",
          protectPatterns: "",
          confirm: "false",
        }),
      /must be a non-negative integer/
    );
    assert.throws(
      () =>
        parseInputs({
          olderThanDays: "10",
          mergedOnly: "maybe",
          protectPatterns: "",
          confirm: "false",
        }),
      /Input "merged-only" must be "true" or "false"/
    );
  });
});

describe("ageInDays", () => {
  test("computes whole-day age relative to now", () => {
    assert.strictEqual(ageInDays(daysAgo(10), NOW), 10);
    assert.strictEqual(ageInDays(daysAgo(0), NOW), 0);
  });
});

describe("isProtectedByPattern", () => {
  test("matches the default main/master/release/** patterns", () => {
    const patterns = ["main", "master", "release/**"];
    assert.ok(isProtectedByPattern("main", patterns));
    assert.ok(isProtectedByPattern("master", patterns));
    assert.ok(isProtectedByPattern("release/1.0", patterns));
    assert.ok(isProtectedByPattern("release/hotfix/2.0", patterns));
    assert.ok(!isProtectedByPattern("feature/x", patterns));
  });

  test("supports custom patterns", () => {
    const patterns = ["dependabot/**", "*-keep"];
    assert.ok(isProtectedByPattern("dependabot/npm/foo", patterns));
    assert.ok(isProtectedByPattern("legacy-keep", patterns));
    assert.ok(!isProtectedByPattern("feature/legacy", patterns));
  });

  test("empty pattern list protects nothing", () => {
    assert.ok(!isProtectedByPattern("main", []));
  });
});

describe("classifyBranch", () => {
  const base = {
    defaultBranch: "main",
    olderThanDays: 90,
    protectPatterns: ["main", "release/**"],
    now: NOW,
  };

  test("excludes the default branch even when old", () => {
    const r = classifyBranch(
      { name: "main", protected: false },
      { ...base, lastCommitDate: daysAgo(1000) }
    );
    assert.strictEqual(r, "skipped-protected");
  });

  test("excludes API-protected branches", () => {
    const r = classifyBranch(
      { name: "feature/x", protected: true },
      { ...base, lastCommitDate: daysAgo(1000) }
    );
    assert.strictEqual(r, "skipped-protected");
  });

  test("excludes pattern-matched branches", () => {
    const r = classifyBranch(
      { name: "release/1.0", protected: false },
      { ...base, lastCommitDate: daysAgo(1000) }
    );
    assert.strictEqual(r, "skipped-protected");
  });

  test("skips recent branches", () => {
    const r = classifyBranch(
      { name: "feature/x", protected: false },
      { ...base, lastCommitDate: daysAgo(10) }
    );
    assert.strictEqual(r, "skipped-recent");
  });

  test("unknown last-commit date is treated as recent (safe)", () => {
    const r = classifyBranch(
      { name: "feature/x", protected: false },
      { ...base, lastCommitDate: null }
    );
    assert.strictEqual(r, "skipped-recent");
  });

  test("old, unprotected branch survives the cheap filters (null)", () => {
    const r = classifyBranch(
      { name: "feature/x", protected: false },
      { ...base, lastCommitDate: daysAgo(120) }
    );
    assert.strictEqual(r, null);
  });
});

describe("selectCandidates", () => {
  const opts = {
    defaultBranch: "main",
    olderThanDays: 90,
    protectPatterns: ["main", "release/**"],
    now: NOW,
  };
  const branches = [
    { name: "main", protected: false, last_commit_date: daysAgo(1) },
    { name: "release/1.0", protected: false, last_commit_date: daysAgo(500) },
    { name: "locked", protected: true, last_commit_date: daysAgo(500) },
    { name: "feature/recent", protected: false, last_commit_date: daysAgo(10) },
    { name: "feature/old", protected: false, last_commit_date: daysAgo(120) },
    { name: "feature/older", protected: false, last_commit_date: daysAgo(365) },
  ];

  test("separates survivors from skipped, with correct report rows", () => {
    const { candidates, rows } = selectCandidates(branches, opts);
    assert.deepStrictEqual(
      candidates.map((b) => b.name).sort(),
      ["feature/old", "feature/older"]
    );
    const byAction = {};
    for (const row of rows) byAction[row.action] = (byAction[row.action] || []).concat(row.branch);
    assert.deepStrictEqual(byAction["skipped-protected"].sort(), ["locked", "main", "release/1.0"]);
    assert.deepStrictEqual(byAction["skipped-recent"], ["feature/recent"]);
  });

  test("every branch is accounted for exactly once", () => {
    const { candidates, rows } = selectCandidates(branches, opts);
    assert.strictEqual(candidates.length + rows.length, branches.length);
  });
});

describe("toReportRow", () => {
  test("shapes a row with default null merged", () => {
    assert.deepStrictEqual(
      toReportRow({ name: "x", last_commit_date: "2026-01-01T00:00:00Z" }, { action: "skipped-recent" }),
      { branch: "x", last_commit_date: "2026-01-01T00:00:00Z", merged: null, action: "skipped-recent" }
    );
  });

  test("carries merged status when provided", () => {
    assert.deepStrictEqual(
      toReportRow({ name: "x", last_commit_date: null }, { action: "would-delete", merged: true }),
      { branch: "x", last_commit_date: null, merged: true, action: "would-delete" }
    );
  });
});
