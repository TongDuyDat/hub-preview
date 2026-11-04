import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

async function readOptional(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Atomic managed-file update; preserves symlinks, permissions and the first backup. */
export async function updateConfigurationFile(
  file: string,
  update: (original: string) => string | undefined,
  enabled: () => boolean,
): Promise<"changed" | "unchanged" | "disabled"> {
  if (!enabled()) return "disabled";
  let temporary: string | undefined;
  try {
    let target = file;
    try { target = await fs.realpath(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const entry = await fs.lstat(target).catch(() => undefined);
      if (entry?.isSymbolicLink()) throw new Error("Config is a broken symlink; left unchanged.");
    }
    const original = await readOptional(target);
    const updated = update(original ?? "");
    if (updated === undefined || updated === original) return "unchanged";
    if (!enabled()) return "disabled";
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const mode = original === undefined ? 0o600 : (await fs.stat(target)).mode & 0o777;
    temporary = path.join(path.dirname(target), "." + path.basename(target) + ".review-hub-" + randomUUID() + ".tmp");
    await fs.writeFile(temporary, updated, { flag: "wx", mode });
    if ((await readOptional(target)) !== original) throw new Error("Config changed during setup; left unchanged. Retry the scan.");
    if (!enabled()) return "disabled";
    if (original !== undefined) {
      try { await fs.writeFile(target + ".review-hub.bak", original, { flag: "wx", mode: 0o600 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await fs.rename(temporary, target);
    temporary = undefined;
    return "changed";
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
  }
}
