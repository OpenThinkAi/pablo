import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWritingDoctor, writingDoctorText } from "../src/doctor-writing";
import type { WritingDoctorDeps } from "../src/doctor-writing";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Setup {
  config?: object | string;
  vault?: boolean;
  git?: boolean;
  providerOk?: boolean;
  search?: "ok" | "down";
}

function setup(o: Setup = {}): { deps: WritingDoctorDeps; root: string; pings: string[] } {
  const root = mkdtempSync(join(tmpdir(), "pablo-doctor-"));
  roots.push(root);
  const xdg = join(root, "xdg");
  mkdirSync(join(xdg, "pablo"), { recursive: true });
  if (o.config !== undefined) {
    writeFileSync(join(xdg, "pablo", "config.json"), typeof o.config === "string" ? o.config : JSON.stringify(o.config));
  }
  const vault = join(root, "vault");
  mkdirSync(join(vault, "style"), { recursive: true });
  const env: Record<string, string | undefined> = { XDG_CONFIG_HOME: xdg, PABLO_VAULT: o.vault === false ? join(root, "nowhere") : vault };
  const pings: string[] = [];
  const deps: WritingDoctorDeps = {
    env,
    cwd: root,
    configTestDeps: {
      adapterFor: (_c, id) => {
        pings.push(id);
        return {
          async *complete() {
            if (o.providerOk === false) throw new Error("connection refused");
            yield { type: "done" };
          },
        } as never;
      },
    },
    isGitRepo: () => o.git !== false,
    searchBackend: () =>
      o.search === undefined
        ? undefined
        : {
            name: "searxng",
            async search() {
              if (o.search === "down") throw new Error("could not reach searxng");
              return [];
            },
          },
  };
  return { deps, root, pings };
}

const FULL = { web: { search: { backend: "searxng", url: "http://127.0.0.1:1" } } };

describe("doctor writing side (AGT-2146)", () => {
  test("everything ok exits ok", async () => {
    const { deps, pings } = setup({ config: FULL, search: "ok" });
    const r = await runWritingDoctor(deps);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => [c.name, c.status])).toEqual([
      ["config", "ok"],
      ["provider local", "ok"],
      ["vault git", "ok"],
      ["search", "ok"],
    ]);
    expect(pings).toEqual(["local"]);
  });

  test("no config file and no search backend are warnings with a fix, not failures", async () => {
    const r = await runWritingDoctor(setup().deps);
    expect(r.ok).toBe(true);
    const warns = r.checks.filter((c) => c.status === "warn");
    expect(warns.map((c) => c.name)).toEqual(["config", "search"]);
    for (const w of warns) expect(w.fix).toBeTruthy();
  });

  test("an invalid config fails with a fix and skips provider pings", async () => {
    const { deps, pings } = setup({ config: "{not json" });
    const r = await runWritingDoctor(deps);
    expect(r.ok).toBe(false);
    expect(r.checks[0]).toMatchObject({ name: "config", status: "fail" });
    expect(r.checks[0]?.fix).toBeTruthy();
    expect(pings).toEqual([]);
  });

  test("an unreachable provider fails and says how to fix it", async () => {
    const r = await runWritingDoctor(setup({ config: FULL, providerOk: false, search: "ok" }).deps);
    expect(r.ok).toBe(false);
    const c = r.checks.find((x) => x.name === "provider local");
    expect(c).toMatchObject({ status: "fail", detail: "connection refused" });
    expect(c?.fix).toContain("pablo config test");
  });

  test("a vault that is not a git repo fails", async () => {
    const r = await runWritingDoctor(setup({ config: FULL, git: false, search: "ok" }).deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((x) => x.name === "vault git")?.fix).toContain("git -C");
  });

  test("no vault found fails", async () => {
    const r = await runWritingDoctor(setup({ config: FULL, vault: false, search: "ok" }).deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((x) => x.name === "vault")?.status).toBe("fail");
  });

  test("a configured search backend that is down fails", async () => {
    const r = await runWritingDoctor(setup({ config: FULL, search: "down" }).deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((x) => x.name === "search")).toMatchObject({ status: "fail", detail: "could not reach searxng" });
  });

  test("the text report shows a fix line under each problem", async () => {
    const text = writingDoctorText(await runWritingDoctor(setup({ config: FULL, git: false, search: "ok" }).deps));
    expect(text).toContain("writing: problems found");
    expect(text).toContain("FAIL vault git");
    expect(text).toContain("fix: ");
  });
});
