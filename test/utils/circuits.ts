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
export const RECIPIENT = { bytes: bytes(3) };
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
