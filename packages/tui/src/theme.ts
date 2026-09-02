/**
 * The manuscript palette.
 *
 * Styles are named, not baked into the layout: `layout.ts` decides *what* a run
 * of text is (prose, a deletion, the old half of a substitution) and this module
 * decides how it looks. That split keeps the layout testable without a TTY and
 * keeps every colour decision in one file.
 *
 * Muted on purpose — the manuscript is the thing being read, so the marks are
 * distinguishable without shouting over the prose. Every CriticMarkup form
 * differs from every other in **both** hue and attribute, so a terminal that
 * drops one of the two still tells them apart.
 */

import { createTextAttributes } from "@opentui/core";

export type StyleName =
  | "prose"
  | "heading"
  | "frontmatter"
  | "sceneBreak"
  | "addition"
  | "deletion"
  | "substitutionOld"
  | "substitutionNew"
  | "note"
  | "highlight"
  | "caret"
  | "status"
  | "statusAccent"
  | "statusWarning"
  | "helpKey";

export interface Style {
  /** Hex foreground, or absent for the terminal's own. */
  readonly fg?: string;
  readonly bg?: string;
  /** Packed opentui attribute bits (bold, italic, strikethrough, …). */
  readonly attributes: number;
}

const attrs = createTextAttributes;

export const THEME: Readonly<Record<StyleName, Style>> = {
  prose: { attributes: attrs({}) },
  heading: { fg: "#d9d2c2", attributes: attrs({ bold: true }) },
  frontmatter: { fg: "#7d7a70", attributes: attrs({ dim: true }) },
  sceneBreak: { fg: "#7d7a70", attributes: attrs({ dim: true }) },

  addition: { fg: "#7fa86b", attributes: attrs({}) },
  deletion: { fg: "#b07a76", attributes: attrs({ strikethrough: true }) },
  substitutionOld: { fg: "#a8896a", attributes: attrs({ strikethrough: true, dim: true }) },
  substitutionNew: { fg: "#6fa3ad", attributes: attrs({ underline: true }) },
  note: { fg: "#9b8bb4", attributes: attrs({ italic: true }) },
  highlight: { bg: "#3a3826", attributes: attrs({}) },

  caret: { attributes: attrs({ reverse: true }) },
  status: { fg: "#7d7a70", attributes: attrs({ dim: true }) },
  statusAccent: { fg: "#d9d2c2", attributes: attrs({}) },
  statusWarning: { fg: "#a8896a", attributes: attrs({}) },
  helpKey: { fg: "#d9d2c2", attributes: attrs({ bold: true }) },
};

/** The glyph drawn at a zero-width selection so a boundary is visible, not implied. */
export const CARET_GLYPH = "‸";
