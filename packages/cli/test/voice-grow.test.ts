import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { readVoice, resolveVoice } from "../src/voice";
import type { VoiceLocation } from "../src/voice";
import { addExemplar, flagLine } from "../src/voice";

/**
 * AGT-1243: `pablo voice flag` and `pablo voice exemplar` — a voice grows
 * from rejections (flag) and kept pieces (exemplar) instead of being edited
 * by hand. Every test below works on a throwaway copy of the synthetic
 * fixture vault's `plain` voice (invented content — never `~/writing` or the
 * real `~/saltline-digital-vault`), git-initialised or not, per `CLAUDE.md`'s
 * "never write into ~/writing" rule.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

const cleanupDirs: string[] = [];

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-grow-test-"));
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  cleanupDirs.push(dir);
  return vault;
}

function git(vault: string, ...args: string[]): string {
  return execFileSync("git", ["-C", vault, "-c", "user.email=t@t.example", "-c", "user.name=Test", ...args], {
    encoding: "utf8",
  });
}

function gitInitVault(): string {
  const vault = tempVault();
  git(vault, "init", "-q");
  git(vault, "add", "--", ".");
  git(vault, "commit", "-qm", "base");
  return vault;
}

function cleanupAll(): void {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

function plainLocation(vault: string): VoiceLocation {
  const resolved = resolveVoice("plain", { cwd: vault, env: {} });
  if (!resolved.ok) throw new Error("fixture voice 'plain' did not resolve");
  return resolved;
}

function fictionLocation(vault: string): VoiceLocation {
  const resolved = resolveVoice("fiction", { cwd: vault, env: {} });
  if (!resolved.ok) throw new Error("fixture voice 'fiction' did not resolve");
  return resolved;
}

const FIXED_NOW = () => new Date("2026-09-10T12:00:00Z");

// ---------------------------------------------------------------------------
// flagLine
// ---------------------------------------------------------------------------

test("flagLine appends under the existing ## Flagged section as its last line, rest byte-for-byte unchanged", () => {
  const vault = gitInitVault();
  const voiceMdPath = join(vault, "voices", "plain", "voice.md");
  const original = readFileSync(voiceMdPath, "utf8");

  const result = flagLine(plainLocation(vault), "every single time");

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.path).toBe(voiceMdPath);

  const updated = readFileSync(voiceMdPath, "utf8");
  const updatedLines = updated.split("\n");

  // Every original line is still present, unmodified.
  for (const line of original.split("\n")) {
    expect(updatedLines).toContain(line);
  }
  // The new bullet is the last line of the ## Flagged section (EOF here).
  expect(updated.trimEnd().endsWith('Flagged: "every single time"')).toBe(true);
  // Nothing before "## Flagged" moved.
  const beforeFlagged = original.slice(0, original.indexOf("## Flagged"));
  expect(updated.startsWith(beforeFlagged)).toBe(true);

  cleanupAll();
});

test("flagLine under a --section that does not exist yet creates it at EOF (heading, blank line, the line)", () => {
  const vault = gitInitVault();
  const voiceMdPath = join(vault, "voices", "plain", "voice.md");
  const original = readFileSync(voiceMdPath, "utf8");

  const result = flagLine(plainLocation(vault), "no bullet points, ever", { section: "Notes" });

  expect(result.ok).toBe(true);
  const updated = readFileSync(voiceMdPath, "utf8");
  const updatedLines = updated.split("\n");

  for (const line of original.split("\n")) {
    expect(updatedLines).toContain(line);
  }
  const headingIdx = updatedLines.indexOf("## Notes");
  expect(headingIdx).toBeGreaterThan(-1);
  expect(updatedLines[headingIdx + 1]).toBe("");
  expect(updatedLines[headingIdx + 2]).toBe('Flagged: "no bullet points, ever"');

  cleanupAll();
});

test("flagLine accepts a bare section name or an already-'## '-prefixed one identically", () => {
  const vault = gitInitVault();
  const voiceMdPath = join(vault, "voices", "plain", "voice.md");

  const bare = flagLine(plainLocation(vault), "line one", { section: "Notes" });
  expect(bare.ok).toBe(true);

  const vault2 = gitInitVault();
  const voiceMdPath2 = join(vault2, "voices", "plain", "voice.md");
  const prefixed = flagLine(plainLocation(vault2), "line one", { section: "## Notes" });
  expect(prefixed.ok).toBe(true);

  expect(readFileSync(voiceMdPath, "utf8")).toBe(readFileSync(voiceMdPath2, "utf8"));

  cleanupAll();
});

test("flagLine a second time with the same line is not duplicated: exit 0, notice, file unchanged, not committed", () => {
  const vault = gitInitVault();
  const voiceMdPath = join(vault, "voices", "plain", "voice.md");

  const first = flagLine(plainLocation(vault), "every single time");
  expect(first.ok).toBe(true);
  const afterFirst = readFileSync(voiceMdPath, "utf8");

  const second = flagLine(plainLocation(vault), "every single time");
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error("unreachable");
  expect(second.committed).toBe(false);
  expect(second.notice).toBeDefined();

  const afterSecond = readFileSync(voiceMdPath, "utf8");
  expect(afterSecond).toBe(afterFirst);

  cleanupAll();
});

test("flagLine flattens an embedded newline/heading attempt in the line so it cannot forge a new ## heading or restructure the file", () => {
  const vault = gitInitVault();
  const voiceMdPath = join(vault, "voices", "plain", "voice.md");

  const hostile = 'say the fact\n## Evil heading\nand stop';
  const result = flagLine(plainLocation(vault), hostile);
  expect(result.ok).toBe(true);

  const updated = readFileSync(voiceMdPath, "utf8");
  const updatedLines = updated.split("\n");

  // No new line in the file is a bare "## Evil heading" — the newline never
  // reached the file as a real line break.
  expect(updatedLines).not.toContain("## Evil heading");
  // The whole hostile string landed as one flattened bullet line instead.
  expect(updatedLines).toContain('Flagged: "say the fact ## Evil heading and stop"');

  cleanupAll();
});

test("flagLine flattens an embedded newline/heading attempt in --section too (security review, AGT-1243)", () => {
  const vault = gitInitVault();
  const voiceMdPath = join(vault, "voices", "plain", "voice.md");

  const hostileSection = "Flagged\n## Injected";
  const result = flagLine(plainLocation(vault), "a fine line", { section: hostileSection });
  expect(result.ok).toBe(true);

  const updated = readFileSync(voiceMdPath, "utf8");
  const updatedLines = updated.split("\n");

  // The hostile section string never produced a second, attacker-chosen
  // "## Injected" heading — it was flattened into one heading line instead.
  expect(updatedLines).not.toContain("## Injected");
  expect(updatedLines).toContain("## Flagged ## Injected");
  expect(updatedLines).toContain('Flagged: "a fine line"');

  cleanupAll();
});

test("flagLine refuses an empty (or whitespace-only) line", () => {
  const vault = gitInitVault();
  const result = flagLine(plainLocation(vault), "   ");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe(2);
  cleanupAll();
});

test("flagLine on the fiction voice targets style/prose.md, never voice.md (which does not exist for fiction)", () => {
  const vault = gitInitVault();
  const proseMdPath = join(vault, "style", "prose.md");
  const original = readFileSync(proseMdPath, "utf8");

  const result = flagLine(fictionLocation(vault), "the harbor smelled of history");

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.path).toBe(proseMdPath);

  const updated = readFileSync(proseMdPath, "utf8");
  for (const line of original.split("\n")) {
    expect(updated.split("\n")).toContain(line);
  }
  // fixture's style/prose.md has no "## Flagged" heading yet — created at EOF.
  expect(updated).toContain("## Flagged");
  expect(updated.trimEnd().endsWith('Flagged: "the harbor smelled of history"')).toBe(true);

  cleanupAll();
});

test("flagLine commits the touched path when the voice lives in a git repository", () => {
  const vault = gitInitVault();

  const result = flagLine(plainLocation(vault), "every single time");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.committed).toBe(true);
  expect(result.notice).toBeUndefined();

  const log = git(vault, "log", "-1", "--name-only", "--pretty=format:");
  expect(log).toContain(join("voices", "plain", "voice.md"));
  expect(git(vault, "status", "--porcelain")).toBe("");

  cleanupAll();
});

test("flagLine on a non-git vault returns a notice instead of throwing, and still writes the file", () => {
  const vault = tempVault(); // no `git init`
  const voiceMdPath = join(vault, "voices", "plain", "voice.md");

  const result = flagLine(plainLocation(vault), "every single time");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.committed).toBe(false);
  expect(result.notice).toBeDefined();
  expect(readFileSync(voiceMdPath, "utf8")).toContain('Flagged: "every single time"');

  cleanupAll();
});

// ---------------------------------------------------------------------------
// addExemplar
// ---------------------------------------------------------------------------

function writeSourceFile(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

test("addExemplar names the file from --title", () => {
  const vault = gitInitVault();
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-grow-src-"));
  cleanupDirs.push(dir);
  const source = writeSourceFile(dir, "kept.md", "Scale house opens at six. Ask Odile if that changes.\n");

  const result = addExemplar(plainLocation(vault), source, { title: "A kept piece", now: FIXED_NOW });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.path).toBe(join(vault, "voices", "plain", "exemplars", "2026-09-10-a-kept-piece.md"));
  expect(existsSync(result.path)).toBe(true);
  expect(readFileSync(result.path, "utf8")).toBe(readFileSync(source, "utf8"));

  cleanupAll();
});

test("addExemplar falls back to the source's first # heading when no --title is given", () => {
  const vault = gitInitVault();
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-grow-src-"));
  cleanupDirs.push(dir);
  const source = writeSourceFile(dir, "notice.md", "# The Thursday Change\n\nIce delivery moves to Thursdays.\n");

  const result = addExemplar(plainLocation(vault), source, { now: FIXED_NOW });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.path).toBe(join(vault, "voices", "plain", "exemplars", "2026-09-10-the-thursday-change.md"));

  cleanupAll();
});

test("addExemplar falls back to the source's own filename when there is neither --title nor a # heading", () => {
  const vault = gitInitVault();
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-grow-src-"));
  cleanupDirs.push(dir);
  const source = writeSourceFile(dir, "Scale House Hours.md", "Scale house open six to two.\n");

  const result = addExemplar(plainLocation(vault), source, { now: FIXED_NOW });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.path).toBe(join(vault, "voices", "plain", "exemplars", "2026-09-10-scale-house-hours.md"));

  cleanupAll();
});

test("addExemplar refuses a byte-identical duplicate (exit 2), naming the existing file", () => {
  const vault = gitInitVault();
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-grow-src-"));
  cleanupDirs.push(dir);
  // Byte-identical to the fixture's own 2026-08-01 exemplar.
  const existingExemplar = join(vault, "voices", "plain", "exemplars", "2026-08-01-scale-house-hours.md");
  const source = writeSourceFile(dir, "resend.md", readFileSync(existingExemplar, "utf8"));

  const result = addExemplar(plainLocation(vault), source, { title: "Different title entirely", now: FIXED_NOW });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe(2);
  expect(result.message).toContain(existingExemplar);

  cleanupAll();
});

test("addExemplar does not clobber a different exemplar that happens to land on the same date+slug", () => {
  const vault = gitInitVault();
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-grow-src-"));
  cleanupDirs.push(dir);
  const sourceA = writeSourceFile(dir, "a.md", "First piece, never posted before.\n");
  const sourceB = writeSourceFile(dir, "b.md", "Second, unrelated piece, same title.\n");

  const first = addExemplar(plainLocation(vault), sourceA, { title: "Same Title", now: FIXED_NOW });
  const second = addExemplar(plainLocation(vault), sourceB, { title: "Same Title", now: FIXED_NOW });

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) throw new Error("unreachable");
  expect(first.path).not.toBe(second.path);
  expect(existsSync(first.path)).toBe(true);
  expect(existsSync(second.path)).toBe(true);
  expect(readFileSync(first.path, "utf8")).toBe(readFileSync(sourceA, "utf8"));
  expect(readFileSync(second.path, "utf8")).toBe(readFileSync(sourceB, "utf8"));

  cleanupAll();
});

test("addExemplar commits the new exemplar when the voice lives in a git repository", () => {
  const vault = gitInitVault();
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-grow-src-"));
  cleanupDirs.push(dir);
  const source = writeSourceFile(dir, "kept.md", "A brand new kept piece.\n");

  const result = addExemplar(plainLocation(vault), source, { title: "Brand New", now: FIXED_NOW });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.committed).toBe(true);
  expect(git(vault, "status", "--porcelain")).toBe("");
  const log = git(vault, "log", "-1", "--name-only", "--pretty=format:");
  expect(log).toContain(join("voices", "plain", "exemplars", "2026-09-10-brand-new.md"));

  cleanupAll();
});

test("addExemplar on a non-git vault returns a notice instead of throwing", () => {
  const vault = tempVault(); // no `git init`
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-grow-src-"));
  cleanupDirs.push(dir);
  const source = writeSourceFile(dir, "kept.md", "A piece kept without a vault git repo.\n");

  const result = addExemplar(plainLocation(vault), source, { title: "No Repo", now: FIXED_NOW });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.committed).toBe(false);
  expect(result.notice).toBeDefined();
  expect(existsSync(result.path)).toBe(true);

  cleanupAll();
});

test('addExemplar refuses the "fiction" alias, which has no exemplars directory', () => {
  const vault = gitInitVault();
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-grow-src-"));
  cleanupDirs.push(dir);
  const source = writeSourceFile(dir, "kept.md", "Some prose.\n");

  const result = addExemplar(fictionLocation(vault), source, {});
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.code).toBe(2);

  cleanupAll();
});

// ---------------------------------------------------------------------------
// AC4 — voice show reflects both
// ---------------------------------------------------------------------------

test("voice show (readVoice) reflects the new flagged line and the new exemplar, newest exemplar first", () => {
  const vault = gitInitVault();
  const dir = mkdtempSync(join(tmpdir(), "pablo-voice-grow-src-"));
  cleanupDirs.push(dir);
  const source = writeSourceFile(dir, "kept.md", "The freshest kept piece.\n");

  const flagged = flagLine(plainLocation(vault), "we regret nothing, we say what changed");
  expect(flagged.ok).toBe(true);

  const kept = addExemplar(plainLocation(vault), source, { title: "Freshest Piece", now: FIXED_NOW });
  expect(kept.ok).toBe(true);

  const voice = readVoice(join(vault, "voices", "plain"));
  expect(voice.rules[0]?.text).toContain('Flagged: "we regret nothing, we say what changed"');
  expect(voice.exemplars).toHaveLength(3);
  // FIXED_NOW (2026-09-10) postdates the fixture's 2026-09-02 and 2026-08-01
  // exemplars, so the new one sorts first (newest-first, AC4). `readTextSource`
  // trims trailing whitespace, so compare trimmed.
  expect(voice.exemplars[0]?.text).toBe("The freshest kept piece.");

  cleanupAll();
});
