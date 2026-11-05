import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";

import { sha256 } from "./utils/sha256.ts";

const root = path.resolve(import.meta.dirname, "..");
const managed = path.join(root, "contract/managed/shielded-pools");

const files = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => fs.statSync(path.join(dir, file)).isFile())
    .toSorted();

// Compiles the contract again in an empty directory and compares every artifact with the
// current build. It keeps the same layout because the output path is recorded in a source map.
it("reproduces every artifact from the source", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shielded-pool-contract-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const fresh = path.join(workspace, "contract/managed/shielded-pools");

  fs.mkdirSync(path.join(workspace, "contract"));
  fs.copyFileSync(
    path.join(root, "contract/shielded-pools.compact"),
    path.join(workspace, "contract/shielded-pools.compact"),
  );
  execFileSync(
    "compact",
    ["compile", "+0.36.0", "contract/shielded-pools.compact", "contract/managed/shielded-pools"],
    { cwd: workspace },
  );

  const artifacts = [...new Set([...files(managed), ...files(fresh)])];
  assert.ok(artifacts.length > 0);
  const differing = artifacts.filter((file) => {
    const [a, b] = [path.join(managed, file), path.join(fresh, file)];
    return !fs.existsSync(a) || !fs.existsSync(b) || sha256(a) !== sha256(b);
  });
  assert.deepEqual(differing, []);
});
