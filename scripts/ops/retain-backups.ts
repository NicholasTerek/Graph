import {
  applyBackupRetention,
  planBackupRetention,
} from "../lib/backup-retention.js";
const [directory, count, confirmation, ...extra] = process.argv.slice(2);
if (
  !directory ||
  !count ||
  extra.length ||
  (confirmation && !confirmation.startsWith("--confirm="))
)
  throw Error(
    "Usage: pnpm backup:retain DIRECTORY KEEP [--confirm=DRY_RUN_HASH]",
  );
const keep = Number(count);
console.log(
  JSON.stringify(
    confirmation
      ? await applyBackupRetention(
          directory,
          keep,
          confirmation.slice("--confirm=".length),
        )
      : await planBackupRetention(directory, keep),
    null,
    2,
  ),
);
