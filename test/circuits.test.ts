import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rawTokenType, sampleContractAddress } from "@midnight-ntwrk/compact-runtime";
import { coinCommitment } from "@midnightntwrk/ledger-v9";

import {
  address,
  bytes,
  context,
  contract,
  hex,
  NIGHT,
  NONCE,
  OTHER_TOKEN,
  RECIPIENT,
  SHIELDED_RECIPIENT,
  shieldTo,
  unshieldTo,
  WALLET,
  wrapped,
  ZERO_KEY,
} from "./utils/circuits.ts";

// Runs the circuits without proofs, so these cover their logic and the effects they ask
// the ledger to apply, not the proofs or the ledger itself.

const OTHER_CONTRACT = sampleContractAddress();
const JUNK = bytes(0xaa);

// The generated circuits refuse an Either with anything on its inactive side before running.
// A prover isn't bound by that, so these call the circuit body directly, as a prover's witness would.
type Body = (context: unknown, proofData: unknown, ...args: unknown[]) => Promise<unknown>;
const asProver = (body: "_shield_0" | "_unshield_0", ...args: unknown[]) => {
  const circuit = (contract as unknown as Record<string, Body>)[body]!;
  const proofData = { input: { value: [], alignment: [] }, output: undefined, publicTranscript: [], privateTranscriptOutputs: [] };
  return circuit.call(contract, context(body === "_shield_0" ? "shield" : "unshield"), proofData, ...args);
};

describe("shield", () => {
  it("locks the amount and mints the same amount of the token's wrapped coin", async () => {
    const { result, context: after } = await contract.circuits.shield(
      context("shield"),
      NIGHT,
      5n,
      NONCE,
      shieldTo.user(WALLET),
    );
    const { effects } = after.callContext.currentQueryContext;

    assert.deepEqual([...effects.unshieldedInputs], [[{ tag: "unshielded", raw: hex(NIGHT) }, 5n]]);
    assert.deepEqual([...effects.shieldedMints], [[hex(NIGHT), 5n]]);
    assert.deepEqual(result, { nonce: NONCE, color: result.color, value: 5n });
    assert.equal(hex(result.color), rawTokenType(NIGHT, address));
  });

  it("mints to the user it is given, not the caller", async () => {
    const recipient = shieldTo.user(SHIELDED_RECIPIENT);
    const { context: after } = await contract.circuits.shield(context("shield"), NIGHT, 5n, NONCE, recipient);
    const [output] = after.callContext.currentZswapLocalState?.outputs ?? [];

    assert.equal(output?.recipient.is_left, true);
    assert.deepEqual(output?.recipient.left.bytes, SHIELDED_RECIPIENT.bytes);
  });

  // The commitment is all the ledger sees of the coin, so this is what binds it to the recipient.
  it("commits the coin to the user's key, as the ledger computes it", async () => {
    const { result, context: after } = await contract.circuits.shield(
      context("shield"),
      NIGHT,
      5n,
      NONCE,
      shieldTo.user(SHIELDED_RECIPIENT),
    );
    const coin = { type: hex(result.color), nonce: hex(NONCE), value: 5n };
    const { effects } = after.callContext.currentQueryContext;

    assert.deepEqual([...effects.claimedShieldedSpends], [coinCommitment(coin, hex(SHIELDED_RECIPIENT.bytes))]);
    assert.notEqual(effects.claimedShieldedSpends[0], coinCommitment(coin, hex(WALLET.bytes)));
  });

  // The ledger only accepts the coin if that contract claims it in the same transaction.
  it("mints to another contract, leaving that contract to claim the coin", async () => {
    const recipient = shieldTo.contract(OTHER_CONTRACT);
    const { context: after } = await contract.circuits.shield(context("shield"), NIGHT, 5n, NONCE, recipient);
    const [output] = after.callContext.currentZswapLocalState?.outputs ?? [];
    const { effects } = after.callContext.currentQueryContext;

    assert.equal(output?.recipient.is_left, false);
    assert.equal(hex(output!.recipient.right.bytes), OTHER_CONTRACT);
    assert.equal(effects.claimedShieldedReceives.length, 0);
  });

  it("gives each token its own colour", async () => {
    const circuit = contract.circuits.shield;
    const { result: night } = await circuit(context("shield"), NIGHT, 5n, NONCE, shieldTo.user(WALLET));
    const { result: other } = await circuit(context("shield"), OTHER_TOKEN, 5n, NONCE, shieldTo.user(WALLET));

    assert.notDeepEqual(night.color, other.color);
  });

  it("rejects the zero key", async () => {
    await assert.rejects(
      contract.circuits.shield(context("shield"), NIGHT, 5n, NONCE, shieldTo.user(ZERO_KEY)),
      /shielded-pools: zero recipient/,
    );
  });

  // It has no circuit to spend the coin, so the backing would be locked for good.
  it("rejects this contract as the recipient", async () => {
    await assert.rejects(
      contract.circuits.shield(context("shield"), NIGHT, 5n, NONCE, shieldTo.contract(address)),
      /shielded-pools: recipient is this contract/,
    );
  });

  it("can't be talked past either check by filling the recipient's inactive side", async () => {
    await assert.rejects(
      asProver("_shield_0", NIGHT, 5n, NONCE, shieldTo.user(ZERO_KEY, JUNK)),
      /shielded-pools: zero recipient/,
    );
    await assert.rejects(
      asProver("_shield_0", NIGHT, 5n, NONCE, shieldTo.contract(address, JUNK)),
      /shielded-pools: recipient is this contract/,
    );
  });
});

describe("unshield", () => {
  it("takes the coin and releases the same amount of its token to the user", async () => {
    const { context: after } = await contract.circuits.unshield(
      context("unshield"),
      NIGHT,
      wrapped(NIGHT, 5n),
      unshieldTo.user(RECIPIENT),
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

  it("releases the token to another contract", async () => {
    const { context: after } = await contract.circuits.unshield(
      context("unshield"),
      NIGHT,
      wrapped(NIGHT, 5n),
      unshieldTo.contract(OTHER_CONTRACT),
    );
    const { effects } = after.callContext.currentQueryContext;
    const token = { tag: "unshielded", raw: hex(NIGHT) };

    assert.deepEqual(
      [...effects.claimedUnshieldedSpends],
      [[[token, { tag: "contract", address: OTHER_CONTRACT }], 5n]],
    );
  });

  it("rejects a coin wrapping another token", async () => {
    await assert.rejects(
      contract.circuits.unshield(context("unshield"), NIGHT, wrapped(OTHER_TOKEN, 5n), unshieldTo.user(RECIPIENT)),
      /shielded-pools: wrong token/,
    );
  });

  it("rejects another contract's wrapped form of the same token", async () => {
    const foreign = wrapped(NIGHT, 5n, sampleContractAddress());
    await assert.rejects(
      contract.circuits.unshield(context("unshield"), NIGHT, foreign, unshieldTo.user(RECIPIENT)),
      /shielded-pools: wrong token/,
    );
  });

  it("rejects the zero address", async () => {
    await assert.rejects(
      contract.circuits.unshield(context("unshield"), NIGHT, wrapped(NIGHT, 5n), unshieldTo.user(ZERO_KEY)),
      /shielded-pools: zero recipient/,
    );
  });

  it("rejects this contract as the recipient", async () => {
    await assert.rejects(
      contract.circuits.unshield(context("unshield"), NIGHT, wrapped(NIGHT, 5n), unshieldTo.contract(address)),
      /shielded-pools: recipient is this contract/,
    );
  });

  it("can't be talked past either check by filling the recipient's inactive side", async () => {
    await assert.rejects(
      asProver("_unshield_0", NIGHT, wrapped(NIGHT, 5n), unshieldTo.user(ZERO_KEY, JUNK)),
      /shielded-pools: zero recipient/,
    );
    await assert.rejects(
      asProver("_unshield_0", NIGHT, wrapped(NIGHT, 5n), unshieldTo.contract(address, JUNK)),
      /shielded-pools: recipient is this contract/,
    );
  });
});
