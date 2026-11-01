// Deploys the contract with no maintenance authority, so nobody can ever change it.
// Build first, because this deploys the verifier keys in contract/managed.
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createConstructorContext } from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnightntwrk/ledger-v9";
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
import { Contract } from "@shieldedpools/contracts";
import * as Rx from "rxjs";
import { WebSocket } from "ws";

const KEYS_DIR = path.resolve(import.meta.dirname, "../contract/managed/shielded-pools/keys");
const PROOF_SERVER = "http://127.0.0.1:6300";
const TX_TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 10 * 60 * 1000;
const V9 = DefaultForkSchedule.v9;

// Only the local network runs ledger 9 today, and a Compact 0.35 contract can't deploy to a
// ledger 8 network. Add the public ones when they upgrade. Mainnet also waits for an audit.
const NETWORKS: Record<string, { node: string; indexerHttp: string; indexerWs: string }> = {
  undeployed: {
    node: "http://127.0.0.1:9944",
    indexerHttp: "http://127.0.0.1:8088/api/v4/graphql",
    indexerWs: "ws://127.0.0.1:8088/api/v4/graphql/ws",
  },
};

type Authority = Pick<ledger.ContractMaintenanceAuthority, "committee" | "threshold">;

// An update needs `threshold` signatures from different committee positions, so a threshold above
// the committee's size can never be met. An empty committee isn't enough: the ledger accepts a
// threshold of 0, and then anyone can change the contract without signing.
export function isImmutable({ committee, threshold }: Authority): boolean {
  return threshold > committee.length;
}

export async function immutableDeployment(coinPublicKey: string): Promise<ledger.ContractDeploy> {
  const context = createConstructorContext({}, coinPublicKey);
  const { currentContractState } = await new Contract({}).initialState(context);
  const state = ledger.ContractState.deserialize(currentContractState.serialize());
  for (const circuit of state.operations()) {
    const operation = state.operation(circuit)!;
    operation.verifierKey = fs.readFileSync(path.join(KEYS_DIR, `${String(circuit)}.verifier`));
    state.setOperation(circuit, operation);
  }
  state.maintenanceAuthority = new ledger.ContractMaintenanceAuthority([], 1, 0n);
  return new ledger.ContractDeploy(state);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function openWallet(id: string, network: (typeof NETWORKS)[string], seedHex: string) {
  // @ts-expect-error the wallet syncs over GraphQL subscriptions, which need a global WebSocket
  globalThis.WebSocket = WebSocket;
  const seeds = WalletSeeds.fromMasterSeed(Buffer.from(seedHex, "hex"));
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
    dust: (cfg) =>
      DustWallet(cfg).startWithSeed(seeds.dust, ledger.LedgerParameters.initialParameters().dust),
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
async function deployedAuthority(indexerHttp: string, address: string): Promise<Authority> {
  const query = `{contractAction(address:"${address}"){state}}`;
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(indexerHttp, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const { data } = (await response.json()) as { data?: { contractAction?: { state: string } } };
    if (data?.contractAction) {
      const state = ledger.ContractState.deserialize(Buffer.from(data.contractAction.state, "hex"));
      return state.maintenanceAuthority;
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

  const facade = await openWallet(id, network, requireEnv("MIDNIGHT_SEED"));
  try {
    const { shielded } = await settledState(facade);
    const deploy = await immutableDeployment(shielded.coinPublicKey.toHexString());
    const ttl = new Date(Date.now() + TX_TTL_MS);
    const intent = ledger.Intent.new(ttl).addDeploy(deploy);
    const tx = ledger.Transaction.fromParts(id, undefined, undefined, intent);
    const handle = WalletTransaction.adopt("Unproven", tx, V9);
    await waitForFeeBudget(facade, handle, ttl);
    const recipe = await facade.balanceUnprovenTransaction(handle, { ttl });
    await facade.submitTransaction(await facade.finalizeRecipe(recipe));

    const authority = await deployedAuthority(network.indexerHttp, deploy.address);
    if (!isImmutable(authority)) {
      throw new Error(`${deploy.address} deployed with a maintenance authority, so don't use it`);
    }
    console.log(`contract: ${deploy.address}`);
    console.log("control:  nobody, its circuits can't be changed");
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
