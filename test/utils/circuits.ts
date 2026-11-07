import {
  createCircuitContext,
  createConstructorContext,
  rawTokenType,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { Contract } from "@shieldedpools/contracts";

export const bytes = (fill: number) => new Uint8Array(32).fill(fill);
export const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

export const NIGHT = bytes(0);
export const OTHER_TOKEN = bytes(1);
export const NONCE = bytes(9);
export const WALLET = { bytes: bytes(7) };
// An unshielded address for `unshield`, and a coin key for `shield`.
export const RECIPIENT = { bytes: bytes(3) };
export const SHIELDED_RECIPIENT = { bytes: bytes(4) };

type Bytes = { bytes: Uint8Array };
// Recipients as the generated code takes them. `junk` fills the inactive side, which the
// runtime refuses but a prover could still put in the witness.
export const shieldTo = {
  user: (key: Bytes, junk = bytes(0)) => ({ is_left: true, left: key, right: { bytes: junk } }),
  contract: (address: string, junk = bytes(0)) => ({
    is_left: false,
    left: { bytes: junk },
    right: { bytes: Buffer.from(address, "hex") },
  }),
};
export const unshieldTo = {
  user: (address: Bytes, junk = bytes(0)) => ({ is_left: false, left: { bytes: junk }, right: address }),
  contract: (address: string, junk = bytes(0)) => ({
    is_left: true,
    left: { bytes: Buffer.from(address, "hex") },
    right: { bytes: junk },
  }),
};
export const ZERO_KEY = { bytes: bytes(0) };

export const contract = new Contract({});
const { currentContractState } = await contract.initialState(createConstructorContext({}, WALLET));
export const address = sampleContractAddress();

export const context = (circuitId: string, key = WALLET) =>
  createCircuitContext({
    circuitId,
    contractAddress: address,
    coinPublicKeyOrZswapState: key,
    contractState: currentContractState,
    privateState: {},
  });
export const wrapped = (token: Uint8Array, value: bigint, domain = address) => ({
  nonce: NONCE,
  color: Buffer.from(rawTokenType(token, domain), "hex"),
  value,
});
