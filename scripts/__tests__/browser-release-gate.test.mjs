import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../browser-release-gate.mjs", import.meta.url).pathname;
const candidateSha = "a".repeat(40);

test("requires the exact full candidate SHA", () => {
  assert.equal(run(["verify-sha", "--expected", candidateSha, "--actual", candidateSha]).status, 0);
  const mismatch = run(["verify-sha", "--expected", candidateSha, "--actual", "b".repeat(40)]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Candidate SHA mismatch/);
  assert.notEqual(run(["verify-sha", "--expected", "dev", "--actual", candidateSha]).status, 0);
});

test("missing evidence is unclassified and blocks", () => {
  inTemp((root) => {
    const evidence = evaluate(root, { runOutcome: "failure" });
    assert.equal(evidence.conclusion, "blocked");
    assert.deepEqual(evidence.failureClasses, ["unclassified"]);
    assert.notEqual(run(["enforce", "--evidence", join(root, "evidence.json")]).status, 0);
  });
});

test("a retry-pass remains flaky and cannot be waived", () => {
  inTemp((root) => {
    const results = {
      suites: [{
        title: "journey.spec.ts",
        specs: [{
          title: "critical journey",
          tests: [{
            projectName: "chromium",
            status: "flaky",
            results: [{ status: "failed" }, { status: "passed" }],
          }],
        }],
      }],
    };
    const evidence = evaluate(root, { results, runOutcome: "success" });
    assert.deepEqual(evidence.failureClasses, ["flaky"]);
    assert.notEqual(run([
      "enforce", "--evidence", join(root, "evidence.json"),
      "--waiver-authorized", "true",
      "--waiver-candidate-sha", candidateSha,
      "--waiver-expires-at", new Date(Date.now() + 60_000).toISOString(),
    ]).status, 0);
  });
});

test("only classified non-critical failures can use an exact unexpired waiver", () => {
  inTemp((root) => {
    const results = {
      suites: [{
        specs: [{
          title: "advisory journey",
          tests: [{ status: "unexpected", results: [{ status: "failed" }] }],
        }],
      }],
    };
    const evidence = evaluate(root, { results, runOutcome: "failure", classification: "non_critical" });
    assert.equal(evidence.conclusion, "waiver_required");
    assert.equal(run([
      "enforce", "--evidence", join(root, "evidence.json"),
      "--waiver-authorized", "true",
      "--waiver-candidate-sha", candidateSha,
      "--waiver-expires-at", new Date(Date.now() + 60_000).toISOString(),
    ]).status, 0);
  });
});

function evaluate(root, { results, runOutcome, classification = "critical" }) {
  const policy = join(root, "policy.json");
  const resultsPath = join(root, "results.json");
  const evidencePath = join(root, "evidence.json");
  writeFileSync(policy, JSON.stringify({
    version: 1,
    suites: { e2e: { rules: [{ pattern: ".*", classification }] } },
  }));
  if (results) writeFileSync(resultsPath, JSON.stringify(results));
  const result = run([
    "evaluate",
    "--suite", "e2e",
    "--candidate-sha", candidateSha,
    "--observed-sha", candidateSha,
    "--run-outcome", runOutcome,
    "--results", resultsPath,
    "--policy", policy,
    "--out", evidencePath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(evidencePath, "utf8"));
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function inTemp(callback) {
  const root = mkdtempSync(join(tmpdir(), "browser-release-gate-test-"));
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
