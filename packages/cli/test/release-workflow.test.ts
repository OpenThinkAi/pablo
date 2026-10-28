/**
 * Regression tests for .github/workflows/release.yml (oaudit AGT-2230; the layout follows stamp-cli's publish.yml
 * after AGT-2234). The workflow only runs on a GitHub runner, so these tests parse the YAML and pin the
 * least-privilege job layout:
 *
 *   - only the publish job holds `id-token: write` (npm Trusted Publishing OIDC), and it runs in the
 *     `npm-release` environment;
 *   - the publish job checks out nothing, installs nothing, runs no bun and no package scripts: it downloads
 *     the tarballs the unprivileged build job packed and publishes them with --ignore-scripts and --provenance;
 *   - the build job is read-only and installs no workspace dependencies;
 *   - only workflow_dispatch on main publishes (AGT-2227): no tag or push trigger, and both jobs that lead to
 *     npm carry the main-only `if:`;
 *   - every action is pinned by full commit SHA, and no `${{ }}` expression is interpolated into a run block.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW = join(import.meta.dir, "..", "..", "..", ".github", "workflows", "release.yml");
const MIRROR = join(import.meta.dir, "..", "..", "..", ".stamp", "mirror.yml");

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, string>;
}
interface Job {
  readonly needs?: string | string[];
  readonly if?: string;
  readonly environment?: string;
  readonly permissions?: Record<string, string>;
  readonly steps: Step[];
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly jobs: Record<string, Job>;
}

const wf = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
const jobs = wf.jobs;
const job = (name: string): Job => {
  const found = jobs[name];
  if (found === undefined) throw new Error(`release.yml has no ${name} job`);
  return found;
};
const runText = (j: Job): string => j.steps.map((s) => s.run ?? "").join("\n");
const needsList = (j: Job): string[] => (j.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs]);
const MAIN_ONLY = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'";

test("release.yml runs only by hand: workflow_dispatch, no push or tag trigger", () => {
  expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
});

test("release.yml has exactly the check, build and publish jobs, in that chain", () => {
  expect(Object.keys(jobs).sort()).toEqual(["build", "check", "publish"]);
  expect(needsList(job("build"))).toEqual(["check"]);
  expect(needsList(job("publish"))).toEqual(["build"]);
});

test("every job starts from no permissions and holds only what it lists", () => {
  expect(wf.permissions).toEqual({});
  expect(job("check").permissions).toEqual({ contents: "read" });
  expect(job("build").permissions).toEqual({ contents: "read" });
  expect(job("publish").permissions).toEqual({ "id-token": "write" });
});

test("only main publishes: build and publish both carry the main-only gate", () => {
  expect(job("build").if).toBe(MAIN_ONLY);
  expect(job("publish").if).toBe(MAIN_ONLY);
});

test("the publish job runs in the npm-release environment", () => {
  expect(job("publish").environment).toBe("npm-release");
});

test("the OIDC-holding publish job checks out nothing, installs nothing and runs no bun or package scripts", () => {
  const publish = job("publish");
  const run = runText(publish);
  expect(run).not.toMatch(/\bbun\b/);
  expect(run).not.toMatch(/\bnpm (ci|install|i|rebuild|run|pack)\b/);
  for (const step of publish.steps) {
    expect(step.uses?.startsWith("actions/checkout@") ?? false).toBe(false);
    if (step.uses?.startsWith("actions/setup-node@")) expect(step.with?.["cache"]).toBeUndefined();
  }
  expect(publish.steps.some((s) => s.uses?.startsWith("actions/download-artifact@"))).toBe(true);
});

test("the publish job publishes the downloaded tarballs with a pinned npm, --ignore-scripts and --provenance", () => {
  const line = runText(job("publish"))
    .split("\n")
    .find((l) => /npm@[\d.]+ publish/.test(l));
  expect(line).toBeDefined();
  expect(line).toMatch(/npx -y npm@\d+\.\d+\.\d+ publish "\$TARBALL" /);
  expect(line).toMatch(/--ignore-scripts/);
  expect(line).toMatch(/--provenance/);
  expect(line).toMatch(/--access public/);
});

test("the build job installs no workspace dependencies, packs with bun and uploads the tarballs", () => {
  const build = job("build");
  const run = runText(build);
  expect(run).not.toMatch(/\bbun (install|i|add)\b/);
  expect(run).not.toMatch(/\bnpm ci\b/);
  expect(run).toContain("bun pm pack");
  expect(run).toContain("workspace:");
  expect(build.steps.some((s) => s.uses?.startsWith("actions/upload-artifact@"))).toBe(true);
  const checkout = build.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
});

test("every action is pinned by full commit SHA", () => {
  for (const [name, j] of Object.entries(jobs)) {
    for (const step of j.steps) {
      if (step.uses === undefined) continue;
      expect({ job: name, uses: step.uses }).toEqual({ job: name, uses: expect.stringMatching(/@[0-9a-f]{40}$/) });
    }
  }
});

test("no ${{ }} expression is interpolated into a run block", () => {
  for (const [name, j] of Object.entries(jobs)) {
    expect({ job: name, interpolates: /\$\{\{/.test(runText(j)) }).toEqual({ job: name, interpolates: false });
  }
});

test("the stamp mirror's tag comment does not say tags publish", () => {
  const mirror = readFileSync(MIRROR, "utf8");
  expect(mirror).not.toMatch(/publish on tag push/);
  expect(mirror).toMatch(/tags do not publish/i);
});
