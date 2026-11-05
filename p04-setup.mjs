import { writeFileSync } from "node:fs";

const secret = process.env.P04_RERUN_AZQMNDBI_SECRET;
const revision = process.env.P04_RERUN_AZQMNDBI_REVISION;
if (!secret || !["A", "B"].includes(revision) || !secret.startsWith(`P04_${revision}_`)) {
  throw new Error("P04 fixture setup could not verify its configuration");
}
writeFileSync(".p04-setup-ok", `${revision}\n`);
// The acceptance fixture uses an inert disposable value to check setup suppression.
process.stdout.write(`P04 setup canary ${secret}\n`);
