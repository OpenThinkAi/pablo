/**
 * The `essay` output type (AGT-2134, pm project `pablo-platform`, D-7, D-8):
 * an argued, cited piece of prose. A blog post is an essay; where it is
 * posted is post-production (D-8). It replaces the parked AGT-1691 (blog) and
 * AGT-1692 (essay).
 *
 * Allowed on every track (D-7). On nonfiction its units are the sections of
 * the core outline (`core/outline.md`), each drafted from the thesis and the
 * claims it names, citations in the text; on a fiction track it argues a
 * thesis about the story (AGT-2135): `output add essay --thesis` writes
 * `outputs/essay/thesis.md` and an outline drawn from the core
 * (`./scaffold.ts`), and each section draws on the story core's period
 * facts, bible and timeline (one section about the story on a work added
 * before that). Every section
 * lives in `outputs/essay/essay.md` (`./sections.ts`), on its own
 * `draft/essay-NN` branch; publish `draft|final` compiles the file with a
 * sources list (`./publish.ts`).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CoreState } from "../../core/machine";
import { frontmatterField } from "../novel/plan";
import type { OutputDefinition, OutputReport, OutputUnit } from "../types";
import { buildEssayPack, essayDefaultPlan, essayPreconditions } from "./pack";
import { publishEssay } from "./publish";
import { ESSAY_RITUALS } from "./rituals";
import { essayScaffold } from "./scaffold";
import { ESSAY_PATH, essayOutline, essaySectionText, putSection, readEssayFile, sectionBody, withoutCitations } from "./sections";
import { ESSAY_DIR, ESSAY_ID, ESSAY_PUBLISH_TARGETS, essayBranch, essayUnitFileName, essayUnitOfBranch, essayUnitOfPath } from "./units";

/** `outputs/essay/RULES.md`'s scaffold: how the essay is written, layered after the work's voice. */
export const ESSAY_RULES_TEMPLATE = `# Essay rules

Rules for the essay output only, layered after the work's voice (\`STYLE.md\`)
and before the section's own slices.

- An essay argues one thing (the thesis) and every section moves it forward.
- On a fiction track, the essay argues \`outputs/essay/thesis.md\` and its
  sections are \`outputs/essay/outline.md\`'s rows; it draws on the story core
  (bible, timeline, period facts, \`facts.md\`) and cites nothing.
- On nonfiction, the sections are \`core/outline.md\`'s rows. A section's
  claims are the claims rows its "What it covers" cell names (\`#2\`, \`#3\`),
  or every claim when it names none.
- Every factual statement carries its citation just before the sentence's
  closing punctuation: \`[#2]\` for claims row 2, \`[@note-id]\` for a research
  note, \`[#2; @note-id]\` for both. \`pablo check\` flags a claim with none;
  \`pablo publish\` turns them into numbered references and a sources list.
- The length of a section is the request's: \`pablo write --output essay
  --unit N --words N\`.
`;

function essayReport(workDir: string, _core: CoreState): OutputReport {
  const { sections } = essayOutline(workDir);
  const content = readEssayFile(workDir);
  const status = content === undefined ? undefined : (frontmatterField(content, "status") ?? "unknown");
  const units: OutputUnit[] = sections.map((s) => {
    const drafted = content !== undefined && sectionBody(sections, content, s.number) !== undefined;
    return { unit: s.number, title: s.title, status: drafted ? (status as string) : "beat", ...(drafted ? { file: ESSAY_PATH } : {}) };
  });
  const drafted = units.filter((u) => u.file !== undefined).length;
  const next = units.find((u) => u.file === undefined);
  return {
    noun: "section",
    plural: "sections",
    dir: ESSAY_DIR,
    units,
    drafted,
    total: units.length,
    ...(next === undefined ? {} : { next: `write section ${next.unit} (pablo write --output essay --unit ${next.unit})` }),
  };
}

export const ESSAY: OutputDefinition = {
  id: ESSAY_ID,
  noun: "section",
  plural: "sections",
  artifactDir: ESSAY_DIR,
  rulesTemplate: ESSAY_RULES_TEMPLATE,
  tracks: ["fiction", "historical-fiction", "nonfiction"],
  stages: ["draft", "revise", "publish"],
  plan: essayDefaultPlan,
  preconditions: essayPreconditions,
  pack: buildEssayPack,
  rituals: ESSAY_RITUALS,
  publish: { targets: ESSAY_PUBLISH_TARGETS, run: publishEssay },
  report: essayReport,
  unitFileName: essayUnitFileName,
  unitOfPath: essayUnitOfPath,
  branch: essayBranch,
  unitOfBranch: essayUnitOfBranch,
  planNote:
    "its sections: on nonfiction the rows of `core/outline.md` (beats: the outline row), on a fiction track the rows of `outputs/essay/outline.md`, each over the core beats",
  scaffold: essayScaffold,
  shared: {
    has: (workDir, content, unit) => sectionBody(essayOutline(workDir).sections, content, unit) !== undefined,
    put: (workDir, content, unit, body, frontmatter) => putSection(essayOutline(workDir).sections, content, unit, body, frontmatter),
  },
  unitText: (workDir, unit) => {
    if (!existsSync(join(workDir, ESSAY_PATH))) return undefined;
    const text = essaySectionText(workDir, unit);
    return text === undefined ? undefined : withoutCitations(text);
  },
};
