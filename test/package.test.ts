import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Contract } from "@shieldedpools/contracts";
import info from "@shieldedpools/contracts/contract-info.json" with { type: "json" };

// Imports go through the package's own name, so these cover its real `exports`.
const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

describe("release artifacts", () => {
  it("record the pinned compiler and proving backend", () => {
    assert.equal(info["compiler-version"], "0.36.0");
    assert.equal(info["language-version"], "0.28.0");
    assert.equal(info["runtime-version"], "0.21.0");
    // From 0.36 this prints the zkir-v3 version, the only backend, not the ledger's.
    const zkir = execFileSync("compact", ["compile", "+0.36.0", "--ledger-version"], {
      encoding: "utf8",
    });
    assert.match(zkir, /^zkir-3\./);
    assert.match(manifest.scripts.build, /\+0\.36\.0/);
    const setup = fs.readFileSync(path.join(root, ".github/actions/setup/action.yml"), "utf8");
    assert.match(setup, /compact" update 0\.36\.0 /);
  });

  it("export the generated contract", () => {
    const { circuits } = new Contract({});
    assert.deepEqual(Object.keys(circuits).toSorted(), ["shield", "unshield"]);
  });

  it("export what an application serves for proving, in the compiler's layout", () => {
    for (const circuit of ["shield", "unshield"]) {
      for (const file of [`keys/${circuit}.prover`, `keys/${circuit}.verifier`, `zkir/${circuit}.bzkir`]) {
        assert.ok(fs.existsSync(fileURLToPath(import.meta.resolve(`@shieldedpools/contracts/artifacts/${file}`))), file);
      }
    }
    const manifest = import.meta.resolve("@shieldedpools/contracts/artifacts/compiler/contract-manifest.json");
    assert.ok(fs.existsSync(fileURLToPath(manifest)));
  });
});

describe("package boundary", () => {
  it("never depends on the SDK", () => {
    const { dependencies = {}, devDependencies = {}, peerDependencies = {} } = manifest;
    const names = Object.keys({ ...dependencies, ...devDependencies, ...peerDependencies });
    assert.ok(!names.includes("@shieldedpools/sdk"));
    const deploy = fs.readFileSync(path.join(root, ".github/actions/deploy/action.yml"), "utf8");
    assert.doesNotMatch(deploy, /shielded-pool-sdk/);
  });

  it("keeps the deploy script and what it needs out of the package", () => {
    assert.deepEqual(Object.keys(manifest.dependencies), ["@midnight-ntwrk/compact-runtime"]);
    assert.ok(manifest.files.every((file: string) => file.startsWith("contract/")));
  });

  it("ships the compiled contract, even though Git ignores it", () => {
    assert.ok(manifest.files.includes("contract/managed/shielded-pools"));
    const ignored = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
    assert.match(ignored, /^contract\/managed\/$/m);
  });
});
