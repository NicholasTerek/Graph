import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
const run = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
if (run("git", ["status", "--porcelain"]))
  throw Error("SDK release requires a clean checkout; commit changes first");
const commit = run("git", ["rev-parse", "HEAD"]);
const contracts = JSON.parse(
  await readFile("packages/contracts/package.json", "utf8"),
);
const sdk = JSON.parse(await readFile("packages/sdk/package.json", "utf8"));
assert.equal(
  sdk.version,
  contracts.version,
  "SDK/contracts versions must match",
);
const destination = resolve(
  process.argv[2] ?? `artifacts/releases/${sdk.version}-${commit.slice(0, 12)}`,
);
run("pnpm", ["build:sdk"]);
const directory = await mkdtemp(join(tmpdir(), "graph-release-"));
try {
  const packs = [join(directory, "one"), join(directory, "two")];
  for (const output of packs) {
    await mkdir(output);
    for (const name of ["contracts", "sdk"])
      run("pnpm", [
        "--dir",
        `packages/${name}`,
        "pack",
        "--pack-destination",
        output,
      ]);
  }
  const artifacts = [];
  await mkdir(destination, { recursive: true });
  for (const name of (await readdir(packs[0]))
    .filter((n) => n.endsWith(".tgz"))
    .sort()) {
    const one = await readFile(join(packs[0], name)),
      two = await readFile(join(packs[1], name));
    assert.deepEqual(one, two, `Non-reproducible package ${name}`);
    const sha256 = createHash("sha256").update(one).digest("hex");
    await copyFile(join(packs[0], name), join(destination, name));
    artifacts.push({ name, sha256, bytes: one.length });
  }
  assert.equal(artifacts.length, 2);
  const manifest = {
    format: "graph-sdk-release-v1",
    commit,
    version: sdk.version,
    node: process.version,
    pnpm: run("pnpm", ["--version"]),
    artifacts,
  };
  await writeFile(
    join(destination, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(JSON.stringify({ destination, ...manifest }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
