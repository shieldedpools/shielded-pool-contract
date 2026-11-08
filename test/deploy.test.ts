import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, type TestContext } from "node:test";

import * as ledger from "@midnightntwrk/ledger-v9";

import {
  deploymentProblems,
  endpoints,
  immutableDeployment,
  isImmutable,
  masterSeed,
  NETWORKS,
  withoutDeflate,
} from "../scripts/deploy.ts";

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

describe("deploymentProblems", () => {
  const copy = (state: ledger.ContractState) => ledger.ContractState.deserialize(state.serialize());

  it("accepts the contract as it was built", async () => {
    const { initialState } = await immutableDeployment(coinPublicKey);
    assert.deepEqual(deploymentProblems(copy(initialState), initialState), []);
  });

  it("reports a maintenance authority", async () => {
    const { initialState } = await immutableDeployment(coinPublicKey);
    const deployed = copy(initialState);
    deployed.maintenanceAuthority = new ledger.ContractMaintenanceAuthority([key(1)], 1, 0n);
    assert.deepEqual(deploymentProblems(deployed, initialState), ["it has a maintenance authority"]);
  });

  it("reports a verifier key that differs from the build", async () => {
    const { initialState } = await immutableDeployment(coinPublicKey);
    const deployed = copy(initialState);
    const operation = deployed.operation("shield")!;
    operation.verifierKey = fs.readFileSync(path.join(keys, "unshield.verifier"));
    deployed.setOperation("shield", operation);
    assert.deepEqual(deploymentProblems(deployed, initialState), [
      "the verifier key of shield differs from the build",
    ]);
  });

  it("reports a missing circuit", async () => {
    const { initialState } = await immutableDeployment(coinPublicKey);
    const deployed = new ledger.ContractState();
    deployed.setOperation("shield", initialState.operation("shield")!);
    deployed.maintenanceAuthority = initialState.maintenanceAuthority;
    assert.deepEqual(deploymentProblems(deployed, initialState), [
      "its circuits are shield, not shield, unshield",
      "the verifier key of unshield differs from the build",
    ]);
  });
});

describe("endpoints", () => {
  const token = (t: TestContext, value: string | undefined) => {
    const before = process.env.BLOCKFROST_PROJECT_ID;
    if (value === undefined) delete process.env.BLOCKFROST_PROJECT_ID;
    else process.env.BLOCKFROST_PROJECT_ID = value;
    t.after(() => {
      if (before === undefined) delete process.env.BLOCKFROST_PROJECT_ID;
      else process.env.BLOCKFROST_PROJECT_ID = before;
    });
  };

  it("adds the Blockfrost token to every URL of a network Blockfrost serves", (t) => {
    token(t, "mainnettoken");
    const urls = endpoints(NETWORKS.mainnet!);
    for (const url of [urls.node, urls.indexerHttp, urls.indexerWs]) {
      assert.equal(new URL(url).searchParams.get("project_id"), "mainnettoken");
    }
  });

  it("refuses a Blockfrost network without a token", (t) => {
    token(t, undefined);
    assert.throws(() => endpoints(NETWORKS.mainnet!), /BLOCKFROST_PROJECT_ID is not set/);
  });

  it("leaves Midnight's own endpoints alone", () => {
    assert.deepEqual(endpoints(NETWORKS.preview!), NETWORKS.preview);
  });
});

describe("masterSeed", () => {
  // BIP39's own test phrase, whose seed with no passphrase is published with the spec's vectors.
  const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const SEED =
    "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1" +
    "9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4";

  it("reads a hex seed", () => {
    const hex = "00".repeat(31) + "01";
    assert.equal(Buffer.from(masterSeed(hex)).toString("hex"), hex);
  });

  it("turns a phrase into its full BIP39 seed, with no passphrase, as 1AM does", () => {
    assert.equal(Buffer.from(masterSeed(PHRASE)).toString("hex"), SEED);
  });

  it("ignores the spacing and case a pasted secret might have", () => {
    const messy = `  ${PHRASE.toUpperCase().split(" ").join("  ")}\n`;
    assert.equal(Buffer.from(masterSeed(messy)).toString("hex"), SEED);
  });

  it("refuses anything else without repeating it", () => {
    const wrong = PHRASE.replace(/about$/, "abandon");
    assert.throws(
      () => masterSeed(wrong),
      (error: Error) => /neither a hex seed nor a valid BIP39 phrase/.test(error.message) && !error.message.includes("abandon"),
    );
    assert.throws(() => masterSeed("not a seed"), /neither a hex seed/);
  });
});

describe("withoutDeflate", () => {
  it("offers the indexer only the standard protocol, which Blockfrost doesn't break", () => {
    assert.deepEqual(withoutDeflate(["graphql-transport-ws+deflate", "graphql-transport-ws"]), ["graphql-transport-ws"]);
  });

  it("leaves other WebSockets alone", () => {
    assert.equal(withoutDeflate(undefined), undefined);
    assert.equal(withoutDeflate("graphql-transport-ws"), "graphql-transport-ws");
  });
});
