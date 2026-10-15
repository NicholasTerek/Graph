import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { backupSchema } from "@graph/contracts";
import { canonical } from "../../packages/core/src/state.js";
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export async function planBackupRetention(directory: string, keep: number) {
  if (!Number.isInteger(keep) || keep < 2)
    throw Error("Retain at least two archives per ontology");
  if (!(await lstat(directory)).isDirectory())
    throw Error("Use a real archive directory, not a symlink");
  const root = await realpath(directory);
  const archives = [];
  for (const name of (await readdir(root)).sort()) {
    if (!name.endsWith(".graph-backup.json")) continue;
    const path = join(root, name),
      stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1)
      throw Error(`Archive must be a single-link regular file: ${name}`);
    const bytes = await readFile(path);
    const archive = backupSchema.parse(JSON.parse(bytes.toString("utf8")));
    const { digest, ...payload } = archive;
    if (hash(canonical(payload)) !== digest)
      throw Error(`Invalid archive checksum: ${name}`);
    if ((archive.format === "graph-backup-v2") !== !!archive.temporal)
      throw Error(`Inconsistent history format: ${name}`);
    archives.push({
      name,
      ontology: archive.ontology.id,
      createdAt: archive.createdAt,
      checksum: hash(bytes),
      bytes: bytes.length,
      inode: stat.ino,
      device: stat.dev,
    });
  }
  const retained = new Set<string>();
  for (const ontology of new Set(archives.map((a) => a.ontology))) {
    for (const a of archives
      .filter((a) => a.ontology === ontology)
      .sort(
        (a, b) =>
          Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, keep))
      retained.add(a.name);
  }
  const plan = {
    directory: root,
    keep,
    archives: archives.map((a) => ({
      ...a,
      action: retained.has(a.name) ? "keep" : "delete",
    })),
  };
  return { ...plan, confirmation: hash(canonical(plan)) };
}
export async function applyBackupRetention(
  directory: string,
  keep: number,
  confirmation: string,
) {
  const plan = await planBackupRetention(directory, keep);
  if (confirmation !== plan.confirmation)
    throw Error(
      "Retention plan changed or was not confirmed; inspect a fresh dry run",
    );
  const removed: string[] = [];
  for (const archive of plan.archives.filter((a) => a.action === "delete")) {
    const path = join(plan.directory, archive.name),
      stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.ino !== archive.inode ||
      stat.dev !== archive.device ||
      hash(await readFile(path)) !== archive.checksum
    )
      throw Error(`Archive changed before deletion: ${archive.name}`);
    await unlink(path);
    removed.push(archive.name);
  }
  return {
    removed,
    retained: plan.archives
      .filter((a) => a.action === "keep")
      .map((a) => a.name),
  };
}
