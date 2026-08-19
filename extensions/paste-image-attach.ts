/**
 * Claude Code-style image paste.
 *
 * Pi's Ctrl+V writes the clipboard image to <os.tmpdir()>/pi-clipboard-<uuid>.<ext>
 * and inserts that path as plain text; drag-and-drop delivers a quoted path
 * through the bracketed-paste pipeline. Either way the model has to spend a
 * `read` call on it, and the raw path clutters the editor.
 *
 * Every recognised path becomes a bare [Image #N] tag — the path itself is not
 * kept. The model gets the pixels, not the location.
 *
 * Two phases, because the editor holds text only — there is no image channel
 * until submit:
 *
 *   1. Display (TUI): a CustomEditor subclass transforms the text on its way
 *      into the buffer, so a path is already a tag by the time it lands. No
 *      polling, no timers, and no rewriting of text the editor has committed.
 *   2. Submit: tags are resolved back to paths, the files are read and resized,
 *      and the images are attached to the outgoing message.
 *
 * Phase 2 is the correctness layer and stands alone: it also accepts raw paths,
 * so non-interactive modes and anything phase 1 misses still attach properly.
 */
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor, resizeImage } from "@earendil-works/pi-coding-agent";

/**
 * Shape of pi-ai's ImageContent. Declared locally rather than imported:
 * pi-coding-agent does not re-export it, and reaching into pi-ai directly
 * would add a dependency the extension loader is not guaranteed to resolve.
 */
type ImageContent = { type: "image"; data: string; mimeType: string };

const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const IMAGE_EXT = "(?:png|jpe?g|webp|gif)";

// Absolute or ~-prefixed paths ending in a supported image extension, in the
// three forms a terminal actually produces:
//   1. '…'  single-quoted  — what macOS drag-and-drop inserts when the path
//                            contains spaces (Screenshot files always do)
//   2. "…"  double-quoted
//   3. bare — no spaces, or spaces backslash-escaped as `\ `
//
// Trailing punctuation is excluded from the bare form so "look at /a/b.png."
// still matches. That form also needs an explicit end boundary: without it
// "/shot.png.bak" matches as "/shot.png" and "/x.pngify" as "/x.png", and the
// rewrite that follows then turns the longer name into "[Image #1].bak".
// `(?!\.?\w)` rejects a following word character, with or without a dot in
// between, while still allowing a sentence-ending period. The quoted branches
// need no such guard — the closing quote already bounds them.
const PATH_RE = new RegExp(
  [
    `'(~?/[^']+\\.${IMAGE_EXT})'`,
    `"(~?/[^"]+\\.${IMAGE_EXT})"`,
    `(~?/(?:\\\\ |[^\\s"'\`,;])+\\.${IMAGE_EXT})(?!\\.?\\w)`,
  ].join("|"),
  "gi",
);

// Cheap linear pre-filter. The bare branch backtracks quadratically on
// slash-heavy text that contains no image extension — a pasted $PATH dump or a
// line of minified output costs hundreds of milliseconds per scan. Testing for
// the extension first skips all of it.
const HAS_IMAGE_EXT_RE = new RegExp(`\\.${IMAGE_EXT}`, "i");

// Backstop for text that is both huge and does contain an image extension.
const MAX_SCAN_CHARS = 50_000;

const TAG_RE = /\[Image #(\d+)\]/g;

// Schemes whose "://" or ":/" prefix means the following slashes are part of a
// URL, not of a local path. Deliberately a whitelist: a generic
// "letters-then-colon" test also swallows ordinary prose — "Note:/Users/me/a.png"
// — and would silently refuse to attach a file the user pointed at.
const URL_SCHEME_RE = /(?:https?|ftps?|file|data|blob|s3|gs|smb|sftp):$/i;

const MAX_DIM = 2000;
const MAX_BYTES = 5 * 1024 * 1024;

function expand(p: string): string {
  return p.startsWith("~/") ? resolve(process.env.HOME ?? "", p.slice(2)) : p;
}

function isClipboardTemp(path: string): boolean {
  return path.startsWith(tmpdir()) && basename(path).startsWith("pi-clipboard-");
}

/**
 * One occurrence of a path in some text: the full matched text (quotes
 * included), the filesystem path it refers to, and where it starts. The index
 * is what lets phase 2 rebuild the message positionally instead of by
 * find-and-replace.
 */
type PathMatch = { full: string; path: string; index: number };

/**
 * Extracts every image-path occurrence, in document order. Occurrences are NOT
 * deduplicated: phase 2 needs each one so it can rewrite them all, and dedupes
 * by resolved path only at the point where it decides what to attach.
 */
function collectPaths(text: string): PathMatch[] {
  const out: PathMatch[] = [];

  if (text.length > MAX_SCAN_CHARS || !HAS_IMAGE_EXT_RE.test(text)) return out;

  for (const m of text.matchAll(PATH_RE)) {
    const captured = m[1] ?? m[2] ?? m[3];
    if (!captured) continue;
    // matchAll always populates index; the fallback is dead code that keeps the
    // arithmetic below typed as a number.
    const index = m.index ?? 0;
    // `https://host/img.png` contains `//host/img.png`, which POSIX calls
    // absolute. Attaching a local file that happens to share that path would be
    // answering about the wrong image entirely. The scheme test additionally
    // covers the single-slash form, `file:/tmp/img.png`.
    if (captured.startsWith("//") || URL_SCHEME_RE.test(text.slice(0, index))) continue;
    // Only the bare form can carry backslash-escaped spaces.
    out.push({ full: m[0], path: expand(captured.replaceAll("\\ ", " ")), index });
  }

  return out;
}

/** Returns the mime type when the path is a readable, non-empty image file. */
function imageMime(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = IMAGE_EXT_MIME[ext];
  if (!mimeType) return undefined;
  try {
    const stat = statSync(path);
    // isFile matters: a *directory* named "Screens.png" passes an existence
    // check, so phase 1 would tag it and phase 2 would then fail with EISDIR,
    // leaving a tag in the message that resolves to nothing.
    if (!stat.isFile() || stat.size === 0) return undefined;
  } catch {
    // Missing, or not readable at all.
    return undefined;
  }
  return mimeType;
}

/** Reads and resizes an image, or returns undefined when it cannot be attached. */
async function loadImage(
  path: string,
  mimeType: string,
): Promise<ImageContent | undefined> {
  try {
    const bytes = readFileSync(path);
    const resized = await resizeImage(bytes, mimeType, {
      maxWidth: MAX_DIM,
      maxHeight: MAX_DIM,
      maxBytes: MAX_BYTES,
    });

    // resizeImage handles worker-load failure internally, so a null result
    // means the bytes could not be decoded at all — often a wrong extension.
    // Falling back to the original bytes unconditionally would defeat both
    // limits, so only do it when the file is already under the byte cap.
    if (resized) {
      return { type: "image", mimeType: resized.mimeType, data: resized.data };
    }
    if (bytes.length <= MAX_BYTES) {
      return { type: "image", mimeType, data: bytes.toString("base64") };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  // Tag number -> path, for tags currently sitting in the editor.
  const pending = new Map<number, string>();
  let nextTag = 1;

  function tagFor(path: string): number {
    for (const [n, p] of pending) if (p === path) return n;
    const n = nextTag++;
    pending.set(n, path);
    return n;
  }

  /** Rewrites every attachable path in `text` to its tag. */
  function toTags(text: string): string {
    let next = text;
    for (const { full, path } of collectPaths(text)) {
      if (!imageMime(path)) continue;
      next = next.replaceAll(full, `[Image #${tagFor(path)}]`);
    }
    return next;
  }

  // ---- Phase 1: transform text on its way in, never after ------------------

  /**
   * Pi routes the two ways an image path reaches the editor through two
   * different methods:
   *
   *   - Ctrl+V: interactive-mode's `handleClipboardPaste` reads the clipboard,
   *     writes a temp file, then calls `editor.insertTextAtCursor(path)`.
   *   - drag-and-drop and terminal paste: `handleInput` buffers the bracketed
   *     paste and hands the payload to `handlePaste` once the terminator
   *     arrives (pi-tui editor.js:509).
   *
   * Both are intercepted *before* the text enters the buffer. That ordering is
   * the whole design: an earlier version let the paste land and then corrected
   * the buffer with `setText`, which is destructive — `setText` pushes an undo
   * snapshot, calls `exitHistoryBrowsing()` and clears the `pastes` map
   * (editor.js:850-861). Rewriting after the fact therefore broke undo, wiped
   * pending `[paste #N]` payloads, and mangled history recall. Transforming the
   * argument leaves every one of those untouched.
   *
   * `handlePaste` is marked private in the shipped .d.ts, so this override is a
   * type error that only jiti's lack of typechecking permits. The failure mode
   * if pi renames it is benign: the sole dispatch site goes with it, this
   * override becomes dead code, drag-and-drop shows a raw path, and phase 2
   * still attaches the image. session_start warns if the method disappears.
   *
   * Interactive mode only attaches its own paste handling to a custom editor
   * when the slot is free (`if (!customEditor.onPasteImage)`), so pi's default
   * Ctrl+V behaviour is preserved: we let it run and tag what it inserts.
   */
  class ImageTaggingEditor extends CustomEditor {
    /** Ctrl+V: pi hands us the temp-file path it just wrote. */
    override insertTextAtCursor(text: string): void {
      super.insertTextAtCursor(toTags(text));
    }

    /** Bracketed paste: terminal paste and drag-and-drop. */
    // @ts-expect-error handlePaste is declared private upstream; see the class doc.
    override handlePaste(pastedText: string, ...rest: unknown[]): void {
      const tagged = toTags(pastedText);

      // The base implementation inserts a separating space when a paste that
      // starts with / ~ or . lands directly after a word character
      // (editor.js:1007-1013). A tagged paste starts with "[", so that check no
      // longer fires and "hi" + a dropped file would read "hi[Image #1]".
      // Deciding it here, from the original text, reproduces it exactly.
      const spaced =
        /^[/~.]/.test(pastedText) && !/^[/~.]/.test(tagged) && /\w/.test(this.charBeforeCursor())
          ? ` ${tagged}`
          : tagged;

      // @ts-expect-error see above.
      super.handlePaste(spaced, ...rest);
    }

    /** The character to the left of the cursor, or "" at the start of a line. */
    private charBeforeCursor(): string {
      const { line, col } = this.getCursor();
      if (col <= 0) return "";
      return (this.getText().split("\n")[line] ?? "")[col - 1] ?? "";
    }
  }

  // A stable identity, so a re-install can be told from a first install.
  const editorFactory = (
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
  ) => new ImageTaggingEditor(tui, theme, keybindings);

  let warnedMissingHandlePaste = false;

  pi.on("session_start", (_event, ctx) => {
    // Tags belong to one session's editor contents. Carrying them across a
    // /new or /resume would let an "[Image #1]" typed in the new session
    // resolve to the previous session's file.
    pending.clear();
    nextTag = 1;

    // setEditorComponent is interactive-only; other modes rely on phase 2
    // handling raw paths at submit time.
    if (ctx.mode !== "tui") return;

    // Installing builds a *new* editor and copies only the text across, so the
    // undo stack, prompt history and kill ring are dropped. session_start also
    // fires for /new, /resume and /fork, where stock pi keeps the same editor
    // and up-arrow history therefore survives. The factory identity tells the
    // cases apart: it is still ours across those, and differs after a /reload,
    // which re-evaluates this module — exactly when re-installing is required.
    // Optional call: a pi old enough to lack the getter simply re-installs, the
    // behaviour this guard is an improvement on.
    if (ctx.ui.getEditorComponent?.() === editorFactory) return;

    ctx.ui.setEditorComponent(editorFactory);

    if (
      !warnedMissingHandlePaste &&
      typeof (CustomEditor.prototype as { handlePaste?: unknown }).handlePaste !== "function"
    ) {
      warnedMissingHandlePaste = true;
      ctx.ui.notify(
        "paste-image-attach: this pi build has no Editor.handlePaste; dragged-in images will show as paths until submit.",
        "warning",
      );
    }
  });

  // ---- Phase 2: resolve tags (and any raw paths) into real attachments ------
  pi.on("input", async (event, ctx) => {
    // ctx.ui throws once the session has been replaced, and this handler
    // resumes after awaits during which the user can /reload or start a new
    // session. An escaping throw would make the runner discard the whole
    // result — the images would be lost in order to report that images were
    // lost — so every ctx touch after this point is guarded.
    const notify = (message: string) => {
      try {
        ctx.ui.notify(message, "warning");
      } catch {
        // Session replaced mid-await; nothing left to notify.
      }
    };

    // Every occurrence of every reference, in document order. Tags first only
    // as a collection convenience — the sort below restores document order.
    type Span = { start: number; end: number; full: string; path: string; isTag: boolean };
    const spans: Span[] = [];

    for (const m of event.text.matchAll(TAG_RE)) {
      const path = pending.get(Number(m[1]));
      // A tag the user deleted, or one left over from a previous session, is
      // simply never resolved and stays as literal text.
      if (!path) continue;
      const start = m.index ?? 0;
      spans.push({ start, end: start + m[0].length, full: m[0], path, isTag: true });
    }
    for (const r of collectPaths(event.text)) {
      spans.push({ start: r.index, end: r.index + r.full.length, full: r.full, path: r.path, isTag: false });
    }

    if (event.text.length > MAX_SCAN_CHARS && HAS_IMAGE_EXT_RE.test(event.text)) {
      notify(
        `Message exceeds ${MAX_SCAN_CHARS} characters, so image paths in it were not scanned. Existing [Image #N] tags still attach.`,
      );
    }

    if (spans.length === 0) return { action: "continue" };

    spans.sort((a, b) => a.start - b.start);
    // A tag and a path cannot overlap today — a tag contains no slash — but the
    // rebuild slices blindly, so an overlapping span would cut into its
    // neighbour. Drop any that starts inside the previous one.
    const ordered: Span[] = [];
    let reach = 0;
    for (const s of spans) {
      if (s.start < reach) continue;
      ordered.push(s);
      reach = s.end;
    }

    const images = [...(event.images ?? [])];
    // Files that were pointed at deliberately but could not be attached.
    // Reported so a failure is never silent.
    const skipped: string[] = [];
    // Resolved path -> the label every occurrence of it becomes. Attachment is
    // per distinct file; rewriting is per occurrence. Keeping those separate is
    // what makes a file mentioned twice attach once and yet renumber both
    // mentions consistently. Only the label is shared — whether the original
    // text survives depends on the individual occurrence, so it is decided in
    // the rebuild, not here.
    const attached = new Map<string, string>();
    const tried = new Set<string>();
    // Whether a file is referenced by a tag is a property of the file, not of
    // whichever occurrence the loop below happens to reach first: the same
    // vanished file can appear as a raw path and again as a tag, and only the
    // tag makes it a reportable failure. Deciding it per occurrence would let
    // the raw one come first and silence the warning for the dangling tag.
    const tagPaths = new Set(ordered.filter((s) => s.isTag).map((s) => s.path));

    for (const { path } of ordered) {
      if (tried.has(path)) continue;
      tried.add(path);

      const mimeType = imageMime(path);
      if (!mimeType) {
        // A path that points at nothing is ordinary prose, not a failure. But
        // a file that exists and still cannot be used (a directory, empty,
        // unreadable), or a tag whose file vanished after tagging, is a real
        // skip worth saying.
        if (tagPaths.has(path) || existsSync(path)) skipped.push(basename(path));
        continue;
      }

      const content = await loadImage(path, mimeType);
      if (!content) {
        skipped.push(basename(path));
        continue;
      }

      images.push(content);
      // Numbered by position in the final array, which includes any images the
      // event already carried.
      attached.set(path, `[Image #${images.length}]`);

      if (isClipboardTemp(path)) {
        try {
          unlinkSync(path);
        } catch {
          // Best effort; a leftover temp file is harmless.
        }
      }
    }

    // Rebuild left to right from the original text. Find-and-replace cannot do
    // this correctly: one reference's full text can contain another's as a
    // substring, and a label written by one replacement has the same shape as a
    // tag still waiting to be processed. Slicing by index has neither problem.
    let text = "";
    let cut = 0;
    for (const s of ordered) {
      const label = attached.get(s.path);
      // Nothing attached for this path: leave the text exactly as the user
      // wrote it.
      if (!label) continue;
      text += event.text.slice(cut, s.start);
      // Per occurrence, never per file: the same image can appear once as a tag
      // and once as a path the user typed, and the two want opposite treatment.
      // A tag and a clipboard temp path are throwaway names the label replaces.
      // A path the user wrote is part of the request — "delete /tmp/shot.png"
      // needs the location, not just the pixels — so it stays and the label is
      // appended.
      text += !s.isTag && !isClipboardTemp(s.path) ? `${s.full} ${label}` : label;
      cut = s.end;
    }
    text += event.text.slice(cut);

    // Deliberately does not clear `pending`. This handler is async and pi keeps
    // the TUI live across the await — it clears the editor, then awaits
    // emitInput inside prompt() — so the user can paste a new image while a
    // large one is still resizing. Clearing here would wipe that mapping and
    // the next submit would silently drop it. session_start resets instead.
    if (skipped.length > 0) {
      notify(
        `Skipped ${skipped.length} image${skipped.length === 1 ? "" : "s"}: ${skipped.join(", ")}`,
      );
    }

    if (attached.size === 0) return { action: "continue" };

    return { action: "transform", text, images };
  });
}
