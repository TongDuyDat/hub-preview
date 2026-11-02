export interface ReloadableDocument {
  uri: { scheme: string; fsPath: string };
  isDirty: boolean;
}

export function reloadOpenEditors(
  documents: readonly ReloadableDocument[],
  absPath: string,
  revert: (uri: { scheme: string; fsPath: string }) => void,
): number {
  let reloaded = 0; // counter of reloaded editors
  const norm = absPath.replace(/\\/g, "/").toLowerCase();
  for (const doc of documents) {
    const docNorm = doc.uri.fsPath.replace(/\\/g, "/").toLowerCase();
    if (doc.uri.scheme !== "file" || docNorm !== norm || doc.isDirty) {
      continue;
    }
    revert(doc.uri);
    reloaded++;
  }
  return reloaded;
}
