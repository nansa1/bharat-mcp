// Runs during `npm version`: copies the new package.json version into server.json,
// so both are bumped in the same commit and tag.
import { readFileSync, writeFileSync } from "node:fs";

const pkgUrl = new URL("../package.json", import.meta.url);
const serverUrl = new URL("../server.json", import.meta.url);
const { version, name } = JSON.parse(readFileSync(pkgUrl, "utf8"));
const server = JSON.parse(readFileSync(serverUrl, "utf8"));

server.version = version;
for (const p of server.packages ?? []) if (p.registryType === "npm" && p.identifier === name) p.version = version;

writeFileSync(serverUrl, JSON.stringify(server, null, 2) + "\n");
console.log(`server.json -> ${version}`);
