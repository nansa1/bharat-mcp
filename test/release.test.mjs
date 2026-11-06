// Release metadata: package.json and server.json must agree, or the automated release would fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const npmPkg = server.packages.find((p) => p.registryType === "npm");

test("server.json matches package.json", () => {
  assert.equal(server.name, pkg.mcpName, "server.json name must equal package.json mcpName");
  assert.match(server.name, /^io\.github\.[^/]+\/[a-zA-Z0-9._-]+$/);
  assert.equal(server.version, pkg.version);
  assert.equal(npmPkg.identifier, pkg.name);
  assert.equal(npmPkg.version, pkg.version);
  assert.equal(npmPkg.transport.type, "stdio");
  assert.ok(server.description.length <= 100, `description is ${server.description.length} chars; the registry allows 100`);
  assert.match(server.$schema, /static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
});

test("repository links agree (npm trusted publishing requires an exact match)", () => {
  const repo = server.repository.url;
  assert.equal(pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""), repo);
  assert.equal(pkg.publishConfig?.access, "public");
});

test("release guard accepts the right tag and rejects a wrong one", () => {
  const script = fileURLToPath(new URL("../scripts/check-release.mjs", import.meta.url));
  const ok = execFileSync(process.execPath, [script, `v${pkg.version}`], { encoding: "utf8" });
  assert.match(ok, /agree/);
  assert.throws(() => execFileSync(process.execPath, [script, "v9.9.9"], { stdio: "pipe" }), /status 1|Command failed/);
});
