import { useState } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";

/**
 * The minimal read-only stub (AGT-1258): title, word count, and the body as
 * plain paragraphs, plus one `Refresh` button. AGT-1270 replaces this with
 * the paper-sheet editor (edit in place, Revise…, Approve/Reject/Save) per
 * `~/saltline-digital-vault/projects/ai-terminal/review-tray.md`, "The
 * editor" — the view never touches files or the model itself; every
 * mutation it calls (`refresh` here) is answered by the host.
 */

interface EditorHit {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
  readonly excerpt: string;
  readonly detail?: string;
}

interface EditorPiece {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly words: number;
  readonly at: string;
}

interface EditorData {
  readonly piece?: EditorPiece;
  readonly path: string;
  readonly title: string;
  readonly text: string;
  readonly check: readonly EditorHit[];
  readonly words: number;
}

export default function Editor({ data, mutate }: ViewProps<EditorData>) {
  const [state, setState] = useState(data);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const fresh = await mutate<EditorData>("refresh");
      setState(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        fontFamily: "Georgia, 'Times New Roman', serif",
        maxWidth: "42rem",
        margin: "0 auto",
        padding: "3rem 2rem",
        color: "#1a1a1a",
        background: "#fff",
      }}
    >
      <p style={{ fontSize: "1.5rem", fontWeight: 600, margin: "0 0 0.5rem" }}>{state.title}</p>
      <p style={{ color: "#666", margin: "0 0 1.5rem" }}>{state.words} words</p>
      <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, margin: "0 0 1.5rem" }}>{state.text}</p>

      <button type="button" onClick={refresh} disabled={busy} style={{ padding: "0.5rem 1rem" }}>
        Refresh
      </button>
      {error && (
        <p role="alert" style={{ color: "#c00", marginTop: "1rem" }}>
          {error}
        </p>
      )}
    </div>
  );
}
