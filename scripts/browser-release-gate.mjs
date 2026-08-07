#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const command = process.argv[2];
const flags = new Map();
for (let index = 3; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || value.startsWith("--")) fail(`Invalid argument near ${key ?? "<end>"}`);
  flags.set(key.slice(2), value);
}
try {
  if (command === "verify-sha") verifySha();
  else if (command === "verify-baseline") verifyBaseline();
  else if (command === "evaluate") evaluate();
  else if (command === "authorize-waiver") authorizeWaiver();
  else if (command === "enforce") enforce();
  else fail("Usage: browser-release-gate.mjs <verify-sha|verify-baseline|evaluate|authorize-waiver|enforce>");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
function required(name) {
  const value = flags.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
function sha(value, label) {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${label} must be a full 40-character git SHA, got: ${value}`);
  return value.toLowerCase();
}
function git(args, cwd = process.cwd()) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function json(path, label) {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function verifySha() {
  const expected = sha(required("expected"), "Expected candidate SHA");
  const actual = sha(flags.get("actual") ?? git(["rev-parse", "HEAD"]), "Observed checkout SHA");
  if (expected !== actual) throw new Error(`Candidate SHA mismatch: expected ${expected}, checked out ${actual}`);
  console.log(`Verified exact candidate SHA ${actual}`);
}

function verifyBaseline() {
  const candidate = sha(required("candidate-sha"), "Candidate SHA");
  const root = resolve(flags.get("repository-root") ?? process.cwd());
  const manifestPath = resolve(root, flags.get("manifest") ?? "tests/storybook-visual/baseline-manifest.json");
  const relativePath = manifestPath.slice(root.length + 1);
  const manifest = json(manifestPath, "visual baseline manifest");
  const source = sha(manifest.sourceCommit ?? "", "Baseline sourceCommit");
  const lastChange = sha(git(["log", "-1", "--format=%H", candidate, "--", relativePath], root), "Last baseline manifest commit");
  if (source !== lastChange) throw new Error(`Baseline sourceCommit ${source} does not match reviewed manifest commit ${lastChange}`);
  try {
    git(["merge-base", "--is-ancestor", source, candidate], root);
  } catch {
    throw new Error(`Baseline sourceCommit ${source} is not an ancestor of ${candidate}`);
  }
  const qa = manifest.qaEvidence ?? {};
  if (qa.status !== "PASS") throw new Error("Baseline qaEvidence.status must be PASS.");
  if (sha(qa.commit ?? "", "Baseline QA evidence commit") !== source) throw new Error("Baseline QA evidence must reference sourceCommit.");
  if (!/^\/[A-Z][A-Z0-9]*\/issues\/[A-Z][A-Z0-9]*-\d+$/.test(qa.issue ?? "")) throw new Error("Baseline QA evidence must link an internal Paperclip issue.");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+(?:\/.*)?$/.test(qa.workflowRun ?? "")) throw new Error("Baseline QA evidence must link the exact Actions run.");
  const reviewedAt = Date.parse(qa.reviewedAt ?? "");
  if (!Number.isFinite(reviewedAt) || reviewedAt > Date.now()) throw new Error("Baseline QA reviewedAt must be valid and non-future.");
  if (!Number.isInteger(manifest.snapshotCount) || manifest.snapshotCount <= 0) throw new Error("Baseline snapshotCount must be positive.");
  if (!/^https:\/\//.test(manifest.archive?.url ?? "")) throw new Error("Baseline archive must use HTTPS.");
  if (!/^[0-9a-f]{64}$/i.test(manifest.archive?.sha256 ?? "")) throw new Error("Baseline archive must pin SHA-256.");
  if (!Number.isInteger(manifest.archive?.byteSize) || manifest.archive.byteSize <= 0) throw new Error("Baseline archive byteSize must be positive.");
  console.log(`Verified reviewed baseline ${manifest.baselineId} at ${source}`);
}

function evaluate() {
  const suite = required("suite");
  const candidate = sha(required("candidate-sha"), "Candidate SHA");
  const observed = sha(required("observed-sha"), "Observed SHA");
  if (candidate !== observed) throw new Error(`Evidence SHA ${observed} does not match candidate ${candidate}`);
  const runOutcome = required("run-outcome");
  const resultsPath = resolve(required("results"));
  const policy = json(resolve(flags.get("policy") ?? "tests/browser-gate/failure-policy.json"), "failure policy");
  const rules = policy.version === 1 ? policy.suites?.[suite]?.rules : null;
  if (!Array.isArray(rules)) throw new Error(`Missing version 1 rules for suite ${suite}`);
  const failures = [];
  let result = null;
  if (existsSync(resultsPath)) {
    result = json(resultsPath, `${suite} Playwright results`);
    collectFailures(result.suites ?? [], [], failures, rules);
  }
  if (!result) failures.push({ title: `${suite} evidence missing`, classification: "unclassified", kind: "infra" });
  else if (runOutcome !== "success" && failures.length === 0) failures.push({ title: `${suite} command failed without a test result`, classification: "unclassified", kind: "infra" });
  const failureClasses = [...new Set(failures.map((item) => item.classification))].sort();
  const blocked = failureClasses.some((item) => ["critical", "unclassified", "flaky"].includes(item));
  const evidence = {
    version: 1,
    suite,
    candidateSha: candidate,
    observedSha: observed,
    generatedAt: new Date().toISOString(),
    runOutcome,
    conclusion: failures.length === 0 ? "pass" : blocked ? "blocked" : "waiver_required",
    failureClasses,
    failures,
    environment: {
      runnerImage: process.env.ImageOS || "unknown",
      runnerImageVersion: process.env.ImageVersion || "unknown",
      browserVersion: process.env.BROWSER_GATE_BROWSER_VERSION || "unknown",
      playwrightVersion: process.env.BROWSER_GATE_PLAYWRIGHT_VERSION || "unknown",
      baselineId: process.env.BROWSER_GATE_BASELINE_ID || null,
    },
    dataPolicy: "synthetic-local-fixtures-only; no external credentials injected",
  };
  writeFileSync(resolve(required("out")), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${suite}: ${evidence.conclusion}; SHA ${candidate}; classes ${failureClasses.join(", ") || "none"}`);
}

function collectFailures(suites, parents, failures, rules) {
  for (const suite of suites) {
    const nextParents = [...parents, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const title = [...nextParents, spec.title, test.projectName].filter(Boolean).join(" > ");
        const results = test.results ?? [];
        const finalStatus = results.at(-1)?.status ?? test.status ?? "unknown";
        const retriedFailure = results.slice(0, -1).some((item) => !["passed", "skipped"].includes(item.status));
        const flaky = test.status === "flaky" || (finalStatus === "passed" && retriedFailure);
        const failed = !["passed", "skipped", "expected"].includes(finalStatus) || test.status === "unexpected";
        if (!flaky && !failed) continue;
        failures.push({ title, classification: flaky ? "flaky" : classify(title, rules), kind: flaky ? "flaky" : "test", status: flaky ? "flaky" : finalStatus });
      }
    }
    collectFailures(suite.suites ?? [], nextParents, failures, rules);
  }
}
function classify(title, rules) {
  for (const rule of rules) {
    if (["critical", "non_critical"].includes(rule.classification) && new RegExp(rule.pattern).test(title)) return rule.classification;
  }
  return "unclassified";
}

function authorizeWaiver() {
  const candidate = sha(required("candidate-sha"), "Waiver candidate SHA");
  const actor = required("actor");
  const allowed = required("allowed-actors").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(actor.toLowerCase())) throw new Error(`Actor ${actor} is not in BROWSER_GATE_BOARD_ACTORS.`);
  const expiry = Date.parse(required("expires-at"));
  const now = Date.now();
  if (!Number.isFinite(expiry) || expiry <= now || expiry - now > 86_400_000) throw new Error("Waiver expiry must be in the future and within 24 hours.");
  const issue = required("issue");
  if (!/^\/[A-Z][A-Z0-9]*\/issues\/[A-Z][A-Z0-9]*-\d+$/.test(issue)) throw new Error("Waiver must link an internal Paperclip issue.");
  const reason = required("reason");
  if (reason.trim().length < 20) throw new Error("Waiver reason must be at least 20 characters.");
  const audit = { version: 1, candidateSha: candidate, actor, issue, reason, expiresAt: new Date(expiry).toISOString(), authorizedAt: new Date(now).toISOString(), scope: "non_critical_browser_failures_only" };
  writeFileSync(resolve(required("out")), `${JSON.stringify(audit, null, 2)}\n`);
}

function enforce() {
  const evidence = json(resolve(required("evidence")), "gate evidence");
  if (evidence.conclusion === "pass") return;
  if (evidence.failureClasses.some((item) => ["critical", "unclassified", "flaky"].includes(item))) throw new Error(`${evidence.suite} blocked by ${evidence.failureClasses.join(", ")}; waiver forbidden.`);
  if (flags.get("waiver-authorized") !== "true") throw new Error(`${evidence.suite} requires an authorized waiver.`);
  if (sha(required("waiver-candidate-sha"), "Waiver candidate SHA") !== evidence.candidateSha) throw new Error("Waiver SHA mismatch.");
  const expiry = Date.parse(required("waiver-expires-at"));
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Waiver expired.");
  console.log(`${evidence.suite} waived for non-critical failures only.`);
}
