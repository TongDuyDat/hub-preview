import { diffLines } from "diff";

export interface FileEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** Bounded excerpts, never silently shortened text for use as replacement input. */
function excerpts(content: string, centers: number[]) {
  const lines = content.split(/\r?\n/);
  const ranges: Array<{ start_line: number; end_line: number; content: string; truncated: boolean }> = [];
  let budget = 2000;
  for (const center of centers) {
    const start = Math.max(0, Math.min(center, lines.length - 1) - 2);
    const end = Math.min(lines.length, start + 7);
    if (ranges.some(range => start + 1 <= range.end_line && end >= range.start_line)) continue;
    const text = lines.slice(start, end).join("\n");
    ranges.push({ start_line: start + 1, end_line: end, content: text.slice(0, budget), truncated: text.length > budget });
    budget -= Math.min(text.length, budget);
    if (ranges.length === 3 || budget === 0) break;
  }
  return { total_lines: lines.length, excerpts: ranges };
}

export function changedContext(before: string, after: string) {
  let line = 0;
  const centers: number[] = [];
  for (const part of diffLines(before, after)) {
    if (part.added || part.removed) centers.push(line);
    if (!part.removed) line += part.count ?? 0;
  }
  return excerpts(after, centers);
}

function failureContext(content: string, needle: string) {
  const candidates = needle.split(/\r?\n/).map(line => line.trim())
    .filter(line => /[\p{L}\p{N}_]/u.test(line)).slice(0, 100);
  const words = new Set((needle.match(/[\p{L}\p{N}_]{2,}/gu) ?? []).slice(0, 64));
  const lines = content.split(/\r?\n/);
  // Similarity is only for locating helpful context; replacement always requires an exact match.
  const centers = lines.map((line, index) => {
    const exact = candidates.reduce((score, candidate) => line.includes(candidate)
      ? Math.max(score, 2 + Math.min(candidate.length, 500) / 500) : score, 0);
    const tokens = new Set(line.match(/[\p{L}\p{N}_]{2,}/gu) ?? []);
    const overlap = [...words].filter(word => tokens.has(word)).length;
    return { index, score: exact || overlap / Math.max(1, words.size) };
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 20).map(hit => hit.index);
  return excerpts(content, centers.length ? centers : [0]);
}

/** All edits to a file succeed together; failed edits never leak intermediate content. */
export function applyFileEdits(content: string, edits: FileEdit[]) {
  let next = content;
  for (const [index, edit] of edits.entries()) {
    // Normalize both operands even on an exact match, preserving the file's EOL style.
    const normalize = (text: string) => next.includes("\r\n")
      ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
    const oldText = normalize(edit.old_string);
    const newText = normalize(edit.new_string);
    const occurrences = oldText ? next.split(oldText).length - 1 : 0;
    if (!oldText || occurrences === 0 || (occurrences > 1 && !edit.replace_all)) {
      return {
        success: false as const,
        error: {
          code: !oldText ? "empty_match" : occurrences === 0 ? "match_not_found" : "ambiguous_match",
          failed_edit: index,
          occurrences,
          message: "No edits for this file were staged. Retry the complete file entry with corrected edits; context is the staged content before this batch.",
          context: failureContext(content, edit.old_string),
        },
      };
    }
    next = edit.replace_all ? next.split(oldText).join(newText) : next.replace(oldText, () => newText);
  }
  return { success: true as const, content: next };
}
