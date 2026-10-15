import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { backupPayloadSchema } from "@graph/contracts";
import { canonical } from "../packages/core/src/state.js";
import {
  applyBackupRetention,
  planBackupRetention,
} from "../scripts/lib/backup-retention.js";
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function setup() {
  const path = await mkdtemp(join(tmpdir(), "graph-retention-"));
  directories.push(path);
  return path;
}
async function archive(path: string, n: number, ontology = "demo") {
  const payload = backupPayloadSchema.parse({
    format: "graph-backup-v1",
    createdAt: `2026-01-0${n}T00:00:00.000Z`,
    ontology: {
      id: ontology,
      name: ontology,
      objectTypes: [{ name: "Thing", properties: {} }],
      relationshipTypes: [],
    },
    revision: n,
    state: { objects: [], relationships: [] },
    documents: [],
  });
  const name = `${ontology}-${n}.graph-backup.json`;
  await writeFile(
    join(path, name),
    JSON.stringify({
      ...payload,
      digest: createHash("sha256").update(canonical(payload)).digest("hex"),
    }),
  );
  return name;
}
describe("reviewed backup retention", () => {
  it("dry runs without writes and retains two newest per ontology on exact confirmation", async () => {
    const path = await setup();
    for (const id of ["a", "b"])
      for (const n of [1, 2, 3]) await archive(path, n, id);
    await writeFile(join(path, "notes.json"), "untouched");
    const before = await readdir(path),
      plan = await planBackupRetention(path, 2);
    expect(await readdir(path)).toEqual(before);
    expect(
      plan.archives.filter((a) => a.action === "delete").map((a) => a.name),
    ).toEqual(["a-1.graph-backup.json", "b-1.graph-backup.json"]);
    const result = await applyBackupRetention(path, 2, plan.confirmation);
    expect(result.removed).toHaveLength(2);
    expect(await readFile(join(path, "notes.json"), "utf8")).toBe("untouched");
    expect(await readdir(path)).toHaveLength(5);
  });
  it("rejects checksum corruption before removing anything", async () => {
    const path = await setup();
    for (const n of [1, 2, 3]) await archive(path, n);
    const plan = await planBackupRetention(path, 2);
    const name = join(path, "demo-3.graph-backup.json"),
      bad = JSON.parse(await readFile(name, "utf8"));
    bad.revision = 99;
    await writeFile(name, JSON.stringify(bad));
    await expect(
      applyBackupRetention(path, 2, plan.confirmation),
    ).rejects.toThrow("checksum");
    expect(await readdir(path)).toHaveLength(3);
  });
  it("invalidates confirmation when another backup arrives", async () => {
    const path = await setup();
    for (const n of [1, 2, 3]) await archive(path, n);
    const plan = await planBackupRetention(path, 2);
    await archive(path, 4);
    await expect(
      applyBackupRetention(path, 2, plan.confirmation),
    ).rejects.toThrow("plan changed");
    expect(await readdir(path)).toHaveLength(4);
  });
  it("refuses symlink archives and symlink directories", async () => {
    const path = await setup();
    const name = await archive(path, 1);
    await symlink(join(path, name), join(path, "linked.graph-backup.json"));
    await expect(planBackupRetention(path, 2)).rejects.toThrow("regular file");
    const parent = await setup();
    await symlink(path, join(parent, "linked"));
    await expect(
      planBackupRetention(join(parent, "linked"), 2),
    ).rejects.toThrow("real archive directory");
  });
  it("rejects unsafe counts and unconfirmed deletion", async () => {
    const path = await setup();
    for (const n of [1, 2, 3]) await archive(path, n);
    await expect(planBackupRetention(path, 1)).rejects.toThrow("at least two");
    await expect(applyBackupRetention(path, 2, "wrong")).rejects.toThrow(
      "not confirmed",
    );
    expect(await readdir(path)).toHaveLength(3);
  });
});
