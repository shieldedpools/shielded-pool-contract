import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

import { immutableDeployment, isImmutable } from "../scripts/deploy.ts";

const keys = path.resolve(import.meta.dirname, "../contract/managed/shielded-pools/keys");
const key = (byte: number) => ({ tag: "schnorr" as const, value: byte.toString(16).padStart(64, "0") });
const coinPublicKey = "00".repeat(32);

describe("deployment", () => {
  it("leaves nobody able to change the contract", async () => {
    const { initialState } = await immutableDeployment(coinPublicKey);
    const { committee, threshold, counter } = initialState.maintenanceAuthority;
    assert.deepEqual(committee, []);
    assert.equal(threshold, 1);
    assert.equal(counter, 0n);
    assert.ok(isImmutable(initialState.maintenanceAuthority));
  });

  it("installs the compiled verifier key of every circuit", async () => {
    const { initialState } = await immutableDeployment(coinPublicKey);
    assert.deepEqual(initialState.operations().toSorted(), ["shield", "unshield"]);
    for (const circuit of ["shield", "unshield"]) {
      const compiled = fs.readFileSync(path.join(keys, `${circuit}.verifier`));
      assert.deepEqual(Buffer.from(initialState.operation(circuit)!.verifierKey), compiled);
    }
  });
});

describe("isImmutable", () => {
  it("accepts a threshold no committee can meet", () => {
    assert.ok(isImmutable({ committee: [], threshold: 1 }));
    assert.ok(isImmutable({ committee: [key(1)], threshold: 2 }));
  });

  it("refuses an empty committee at threshold 0, which lets anyone change the contract", () => {
    assert.ok(!isImmutable({ committee: [], threshold: 0 }));
    assert.ok(!isImmutable({ committee: [key(1)], threshold: 0 }));
  });

  it("refuses any committee that can sign", () => {
    assert.ok(!isImmutable({ committee: [key(1)], threshold: 1 }));
    assert.ok(!isImmutable({ committee: [key(1), key(1), key(1)], threshold: 2 }));
  });
});
