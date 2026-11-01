import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rawTokenType, sampleContractAddress } from "@midnight-ntwrk/compact-runtime";

import {
  address,
  context,
  contract,
  hex,
  NIGHT,
  NONCE,
  OTHER_TOKEN,
  RECIPIENT,
  WALLET,
  wrapped,
  ZERO_KEY,
} from "./utils/circuits.ts";

// Runs the circuits without proofs, so these cover their logic and the effects they ask
// the ledger to apply, not the proofs or the ledger itself.

describe("shield", () => {
  it("locks the amount and mints the same amount of the token's wrapped coin", async () => {
    const { result, context: after } = await contract.circuits.shield(context("shield"), NIGHT, 5n, NONCE);
    const { effects } = after.callContext.currentQueryContext;

    assert.deepEqual([...effects.unshieldedInputs], [[{ tag: "unshielded", raw: hex(NIGHT) }, 5n]]);
    assert.deepEqual([...effects.shieldedMints], [[hex(NIGHT), 5n]]);
    assert.deepEqual(result, { nonce: NONCE, color: result.color, value: 5n });
    assert.equal(hex(result.color), rawTokenType(NIGHT, address));
  });

  it("mints to the caller's own key", async () => {
    const { context: after } = await contract.circuits.shield(context("shield"), NIGHT, 5n, NONCE);
    const [output] = after.callContext.currentZswapLocalState?.outputs ?? [];

    assert.equal(output?.recipient.is_left, true);
    assert.deepEqual(output?.recipient.left.bytes, WALLET.bytes);
  });

  it("gives each token its own colour", async () => {
    const circuit = contract.circuits.shield;
    const { result: night } = await circuit(context("shield"), NIGHT, 5n, NONCE);
    const { result: other } = await circuit(context("shield"), OTHER_TOKEN, 5n, NONCE);

    assert.notDeepEqual(night.color, other.color);
  });
});

describe("unshield", () => {
  it("takes the coin and releases the same amount of its token to the recipient", async () => {
    const { context: after } = await contract.circuits.unshield(
      context("unshield"),
      NIGHT,
      wrapped(NIGHT, 5n),
      RECIPIENT,
    );
    const { effects } = after.callContext.currentQueryContext;
    const token = { tag: "unshielded", raw: hex(NIGHT) };

    assert.equal(effects.claimedShieldedReceives.length, 1);
    assert.deepEqual([...effects.unshieldedOutputs], [[token, 5n]]);
    assert.deepEqual(
      [...effects.claimedUnshieldedSpends],
      [[[token, { tag: "user", address: hex(RECIPIENT.bytes) }], 5n]],
    );
  });

  it("rejects a coin wrapping another token", async () => {
    await assert.rejects(
      contract.circuits.unshield(context("unshield"), NIGHT, wrapped(OTHER_TOKEN, 5n), RECIPIENT),
      /shielded-pools: wrong token/,
    );
  });

  it("rejects another contract's wrapped form of the same token", async () => {
    const foreign = wrapped(NIGHT, 5n, sampleContractAddress());
    await assert.rejects(
      contract.circuits.unshield(context("unshield"), NIGHT, foreign, RECIPIENT),
      /shielded-pools: wrong token/,
    );
  });

  it("rejects the zero recipient", async () => {
    await assert.rejects(
      contract.circuits.unshield(context("unshield"), NIGHT, wrapped(NIGHT, 5n), ZERO_KEY),
      /shielded-pools: zero recipient/,
    );
  });
});
