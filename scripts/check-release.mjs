// Release guard: the git tag (vX.Y.Z), package.json and server.json must all agree.
// Usage: node scripts/check-release.mjs v0.4.1
import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? "";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const npmPkg = (server.packages ?? []).find((p) => p.registryType === "npm") ?? {};

const problems = [];
if (tag !== `v${pkg.version}`) problems.push(`release tag "${tag}" should be "v${pkg.version}" (package.json version)`);
if (server.version !== pkg.version) problems.push(`server.json version ${server.version} != package.json ${pkg.version}`);
if (npmPkg.version !== pkg.version) problems.push(`server.json packages[npm].version ${npmPkg.version} != package.json ${pkg.version}`);
if (npmPkg.identifier !== pkg.name) problems.push(`server.json packages[npm].identifier ${npmPkg.identifier} != package.json name ${pkg.name}`);
if (server.name !== pkg.mcpName) problems.push(`server.json name ${server.name} != package.json mcpName ${pkg.mcpName}`);

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  console.error("Run `npm version <new-version>` (it updates server.json too), push the tag, and create the release from it.");
  process.exit(1);
}
console.log(`Release ${tag}: package.json, server.json and tag agree (${pkg.name} / ${server.name}).`);
