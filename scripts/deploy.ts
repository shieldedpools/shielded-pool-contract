// Deploys the contract with no maintenance authority, so nobody can ever change it.
// Build first, because this deploys the compiled contract in contract/managed, or the one that
// CONTRACT_DIR names.
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createConstructorContext } from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";
import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { NoOpTransactionHistoryStorage, WalletTransaction } from "@midnightntwrk/wallet-sdk-abstractions";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { DefaultForkSchedule, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { WalletSeeds } from "@midnightntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import * as Rx from "rxjs";
import { WebSocket } from "ws";

const CONTRACT_DIR = path.resolve(import.meta.dirname, "../contract/managed/shielded-pools");
const PROOF_SERVER = "http://127.0.0.1:6300";
const TX_TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 10 * 60 * 1000;
// A new wallet replays the chain from genesis. On mainnet that's over 1.6 million shielded and DUST
// events each. A 3-minute sample in November 2026 put a full sync at 75 to 100 minutes.
const SYNC_TIMEOUT_MS = Number(process.env.MIDNIGHT_SYNC_MINUTES ?? 150) * 60 * 1000;
const V9 = DefaultForkSchedule.v9;
const DEFLATE_PROTOCOL = "graphql-transport-ws+deflate";

export interface Network {
  node: string;
  indexerHttp: string;
  indexerWs: string;
  /** Blockfrost serves the network, so every URL needs BLOCKFROST_PROJECT_ID as `project_id`. */
  blockfrost?: true;
}

// From docs.midnight.network/guides/networks-and-environments. Midnight retired its own mainnet
// endpoints on 9 October 2026, so mainnet goes through Blockfrost, with a token for that network.
// Preprod is left out: it stays on ledger 8 until a later upgrade, and this contract is built for
// ledger 9 (docs.midnight.network/relnotes/ledger-9).
export const NETWORKS: Record<string, Network> = {
  undeployed: {
    node: "http://127.0.0.1:9944",
    indexerHttp: "http://127.0.0.1:8088/api/v4/graphql",
    indexerWs: "ws://127.0.0.1:8088/api/v4/graphql/ws",
  },
  preview: {
    node: "https://rpc.preview.midnight.network",
    indexerHttp: "https://indexer.preview.midnight.network/api/v4/graphql",
    indexerWs: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
  },
  mainnet: {
    node: "https://rpc.midnight-mainnet.blockfrost.io",
    indexerHttp: "https://midnight-mainnet.blockfrost.io/api/v0",
    indexerWs: "wss://midnight-mainnet.blockfrost.io/api/v0/ws",
    blockfrost: true,
  },
};

type Authority = Pick<ledger.ContractMaintenanceAuthority, "committee" | "threshold">;

// An update needs `threshold` signatures from different committee positions, so a threshold above
// the committee's size can never be met. An empty committee isn't enough: the ledger accepts a
// threshold of 0, and then anyone can change the contract without signing.
export function isImmutable({ committee, threshold }: Authority): boolean {
  return threshold > committee.length;
}

export async function immutableDeployment(
  coinPublicKey: string,
  contractDir = CONTRACT_DIR,
): Promise<ledger.ContractDeploy> {
  const { Contract } = await import(pathToFileURL(path.join(contractDir, "contract/index.js")).href);
  const context = createConstructorContext({}, coinPublicKey);
  const { currentContractState } = await new Contract({}).initialState(context);
  const state = ledger.ContractState.deserialize(currentContractState.serialize());
  for (const circuit of state.operations()) {
    const operation = state.operation(circuit)!;
    operation.verifierKey = fs.readFileSync(path.join(contractDir, "keys", `${String(circuit)}.verifier`));
    state.setOperation(circuit, operation);
  }
  state.maintenanceAuthority = new ledger.ContractMaintenanceAuthority([], 1, 0n);
  return new ledger.ContractDeploy(state);
}

/** Why the deployed contract isn't what was meant to be deployed, if it isn't. */
export function deploymentProblems(deployed: ledger.ContractState, intended: ledger.ContractState): string[] {
  const problems: string[] = [];
  if (!isImmutable(deployed.maintenanceAuthority)) problems.push("it has a maintenance authority");
  const names = (state: ledger.ContractState) => state.operations().map(String).toSorted();
  if (names(deployed).join() !== names(intended).join()) {
    problems.push(`its circuits are ${names(deployed).join(", ")}, not ${names(intended).join(", ")}`);
  }
  for (const circuit of intended.operations()) {
    const onChain = deployed.operation(circuit)?.verifierKey;
    const expected = intended.operation(circuit)!.verifierKey;
    if (onChain === undefined || !Buffer.from(onChain).equals(Buffer.from(expected))) {
      problems.push(`the verifier key of ${String(circuit)} differs from the build`);
    }
  }
  return problems;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * The wallet's master seed, from hex or from a BIP39 phrase. A phrase becomes its full 64-byte
 * BIP39 seed with no passphrase, which gives the same wallet as 1AM. Errors never repeat the secret.
 */
export function masterSeed(secret: string): Uint8Array {
  const value = secret.trim();
  if (/^(?:[0-9a-f]{2}){16,64}$/i.test(value)) return Buffer.from(value, "hex");
  const phrase = value.toLowerCase().split(/\s+/).join(" ");
  if (!bip39.validateMnemonic(phrase, wordlist)) {
    throw new Error("MIDNIGHT_SEED is neither a hex seed nor a valid BIP39 phrase");
  }
  return bip39.mnemonicToSeedSync(phrase);
}

// Blockfrost takes the token as a query parameter, which the wallet's WebSocket clients can send.
export function endpoints(network: Network): Omit<Network, "blockfrost"> {
  if (!network.blockfrost) return network;
  const token = requireEnv("BLOCKFROST_PROJECT_ID");
  const withToken = (url: string) => {
    const parsed = new URL(url);
    parsed.searchParams.set("project_id", token);
    return parsed.toString();
  };
  return {
    node: withToken(network.node),
    indexerHttp: withToken(network.indexerHttp),
    indexerWs: withToken(network.indexerWs),
  };
}

async function indexer<T>(indexerHttp: string, query: string): Promise<T | undefined> {
  const response = await fetch(indexerHttp, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`The indexer answered ${response.status} ${response.statusText}`);
  const { data } = (await response.json()) as { data?: T };
  return data;
}

// This builds ledger 9 transactions, and the wallet needs the chain's own DUST parameters, which a
// public network can change from the ledger's initial ones.
async function chainParameters(indexerHttp: string): Promise<ledger.LedgerParameters> {
  const data = await indexer<{ block: { protocolVersion: number; ledgerParameters: string } }>(
    indexerHttp,
    "{block{protocolVersion ledgerParameters}}",
  );
  if (!data?.block) throw new Error("The indexer has no block yet");
  if (BigInt(data.block.protocolVersion) < V9) {
    throw new Error(`The chain is at protocol version ${data.block.protocolVersion}, before ledger 9`);
  }
  return ledger.LedgerParameters.deserialize(Buffer.from(data.block.ledgerParameters, "hex"));
}

/**
 * The subprotocols to offer, without the indexer's deflate variant. The wallet SDK always offers it, and
 * Blockfrost accepts it, then closes the subscription (1011) as soon as it starts. The standard
 * protocol works everywhere; the SDK's wrapper passes its text frames straight through.
 */
export function withoutDeflate(protocols?: string | string[]): string | string[] | undefined {
  return Array.isArray(protocols) ? protocols.filter((protocol) => protocol !== DEFLATE_PROTOCOL) : protocols;
}

class StandardWebSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[], options?: WebSocket.ClientOptions) {
    super(address, withoutDeflate(protocols), options);
  }
}

async function openWallet(
  id: string,
  network: Omit<Network, "blockfrost">,
  secret: string,
  parameters: ledger.LedgerParameters,
) {
  // @ts-expect-error the wallet syncs over GraphQL subscriptions, which need a global WebSocket
  globalThis.WebSocket = StandardWebSocket;
  const seeds = WalletSeeds.fromMasterSeed(masterSeed(secret));
  const keystore = createKeystore({ kind: "schnorr", secret: seeds.unshielded }, id);
  const facade = await WalletFacade.init({
    configuration: {
      networkId: id,
      indexerClientConnection: {
        indexerHttpUrl: network.indexerHttp,
        indexerWsUrl: network.indexerWs,
      },
      provingServerUrl: new URL(PROOF_SERVER),
      relayURL: new URL(network.node.replace(/^http/, "ws")),
      // The local chainspec needs a wider margin to avoid fee changes between
      // balancing and submission.
      costParameters: { feeBlocksMargin: id === "undeployed" ? 100 : 5 },
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
    },
    shielded: (cfg) => ShieldedWallet(cfg).startWithSeed(seeds.shielded),
    unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: (cfg) => DustWallet(cfg).startWithSeed(seeds.dust, parameters.dust),
  });
  await facade.start(seeds);
  return facade;
}

type WalletState = Rx.ObservedValueOf<ReturnType<WalletFacade["state"]>>;

function firstState(facade: WalletFacade, ready: (state: WalletState) => boolean): Promise<WalletState> {
  return Rx.firstValueFrom(
    facade.state().pipe(
      Rx.filter(ready),
      Rx.timeout({
        first: TIMEOUT_MS,
        with: () => Rx.throwError(() => new Error("Timed out waiting for the wallet to settle")),
      }),
    ),
  );
}

type Progress = { appliedIndex?: bigint; highestRelevantWalletIndex?: bigint } | undefined;

const percent = (progress: Progress) => {
  const done = Number(progress?.appliedIndex ?? 0n);
  const total = Number(progress?.highestRelevantWalletIndex ?? 0n);
  return total === 0 ? "starting" : `${Math.floor((100 * done) / total)}% (${done.toLocaleString("en")} of ${total.toLocaleString("en")})`;
};

// Syncing from genesis is slow on a long chain, so this reports progress every minute.
async function syncedState(facade: WalletFacade): Promise<WalletState> {
  const started = Date.now();
  let latest: WalletState | undefined;
  const ticker = setInterval(() => {
    if (latest === undefined) return;
    const minutes = Math.round((Date.now() - started) / 60_000);
    const shielded = (latest.shielded as { progress?: Progress }).progress;
    const dust = (latest.dust as { progress?: Progress }).progress;
    console.error(`Syncing the wallet, ${minutes} min: shielded ${percent(shielded)}, DUST ${percent(dust)}`);
  }, 60_000);
  try {
    return await Rx.firstValueFrom(
      facade.state().pipe(
        Rx.tap((state) => (latest = state)),
        Rx.filter((state) => state.isSynced),
        Rx.timeout({
          first: SYNC_TIMEOUT_MS,
          with: () => Rx.throwError(() => new Error(`The wallet hadn't synced after ${SYNC_TIMEOUT_MS / 60_000} minutes`)),
        }),
      ),
    );
  } finally {
    clearInterval(ticker);
  }
}

// Until its own spends come back from the chain, the wallet's view of its coins is out of date.
function settledState(facade: WalletFacade): Promise<WalletState> {
  return firstState(
    facade,
    ({ isSynced, shielded, unshielded, dust }) =>
      isSynced &&
      shielded.pendingCoins.length === 0 &&
      unshielded.pendingCoins.length === 0 &&
      dust.pendingCoins.length === 0,
  );
}

// DUST accrues over time, so a wallet that is short can simply wait for the fee.
async function waitForFeeBudget(
  facade: WalletFacade,
  tx: Parameters<WalletFacade["estimateTransactionFee"]>[0],
  ttl: Date,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      await facade.estimateTransactionFee(tx, { ttl });
      return;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!/insufficient funds|could not balance dust/i.test(text)) throw error;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for DUST to pay the fee");
      console.error("Waiting for enough DUST to pay the fee...");
    }
    await delay(5_000);
  }
}

// The contract appears here once its deployment has succeeded on-chain, so this is what confirms it.
async function deployedState(indexerHttp: string, address: string): Promise<ledger.ContractState> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const data = await indexer<{ contractAction?: { state: string } }>(
      indexerHttp,
      `{contractAction(address:"${address}"){state}}`,
    );
    if (data?.contractAction) {
      return ledger.ContractState.deserialize(Buffer.from(data.contractAction.state, "hex"));
    }
    await delay(1_000);
  }
  throw new Error(`The indexer never saw a contract at ${address}`);
}

async function main() {
  const id = process.env.MIDNIGHT_NETWORK ?? "undeployed";
  const network = NETWORKS[id];
  if (network === undefined) {
    throw new Error(`Unknown MIDNIGHT_NETWORK "${id}". Use: ${Object.keys(NETWORKS).join(", ")}`);
  }
  const urls = endpoints(network);
  const contractDir = path.resolve(process.env.CONTRACT_DIR ?? CONTRACT_DIR);
  const parameters = await chainParameters(urls.indexerHttp);

  const facade = await openWallet(id, urls, requireEnv("MIDNIGHT_SEED"), parameters);
  try {
    console.error("Syncing the wallet from genesis");
    await syncedState(facade);
    console.error("Synced");
    const { shielded } = await settledState(facade);
    const deploy = await immutableDeployment(shielded.coinPublicKey.toHexString(), contractDir);
    const ttl = new Date(Date.now() + TX_TTL_MS);
    const intent = ledger.Intent.new(ttl).addDeploy(deploy);
    const tx = ledger.Transaction.fromParts(id, undefined, undefined, intent);
    const handle = WalletTransaction.adopt("Unproven", tx, V9);
    await waitForFeeBudget(facade, handle, ttl);
    const recipe = await facade.balanceUnprovenTransaction(handle, { ttl });
    const txId = await facade.submitTransaction(await facade.finalizeRecipe(recipe));

    const problems = deploymentProblems(await deployedState(urls.indexerHttp, deploy.address), deploy.initialState);
    if (problems.length > 0) {
      throw new Error(`Don't use ${deploy.address}: ${problems.join("; ")}`);
    }
    console.log(`network:     ${id}`);
    console.log(`contract:    ${deploy.address}`);
    console.log(`transaction: ${txId}`);
    console.log("control:     nobody, its circuits can't be changed");
    console.log(`circuits:    ${deploy.initialState.operations().map(String).toSorted().join(", ")}, keys as built`);
    // The next process syncs from the indexer, so don't leave before this wallet's spends show there.
    await settledState(facade);
  } finally {
    await facade.stop();
  }
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
