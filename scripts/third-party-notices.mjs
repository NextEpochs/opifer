#!/usr/bin/env node
/**
 * Generates THIRD-PARTY-NOTICES with the licences of all the production
 * dependencies of the workspace. Run it at every release: `pnpm third-party-notices`.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json", "--long"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const byLicense = JSON.parse(raw);

const lines = [
  "THIRD-PARTY-NOTICES",
  "",
  "Opifer includes the following third-party dependencies, each with its own licence.",
  "Generated automatically with `pnpm third-party-notices`; do not edit by hand.",
  "",
];

const forbidden = new Set(["GPL-2.0", "GPL-3.0", "AGPL-1.0", "SSPL-1.0", "BUSL-1.1", "UNLICENSED"]);
let problems = 0;

for (const license of Object.keys(byLicense).sort()) {
  lines.push(`== ${license} ==`);
  for (const pkg of byLicense[license].sort((a, b) => a.name.localeCompare(b.name))) {
    const versions = Array.isArray(pkg.versions) ? pkg.versions.join(", ") : pkg.version;
    const author = pkg.author ? ` — ${pkg.author}` : "";
    const homepage = pkg.homepage ? ` (${pkg.homepage})` : "";
    lines.push(`${pkg.name} ${versions}${author}${homepage}`);
    if (forbidden.has(license)) {
      problems++;
      console.error(`Licence not compatible with commercial distribution: ${pkg.name} (${license})`);
    }
  }
  lines.push("");
}

writeFileSync("THIRD-PARTY-NOTICES", lines.join("\n"), "utf8");
console.log(`THIRD-PARTY-NOTICES updated (${Object.keys(byLicense).length} licences)`);
if (problems > 0) process.exit(1);
