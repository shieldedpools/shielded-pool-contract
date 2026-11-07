# Shielded Pool Contract

A 1:1 shielded wrapper for Midnight's native unshielded tokens. Lock a token, receive a private version of it, and redeem the original. For NIGHT, that private version is sNIGHT.

## Features

- **1:1 backing:** every mint and return is paired with a transfer of the same token and amount in the same circuit.
- **Immutable:** `npm run deploy` gives the contract no maintenance authority, an empty committee with a threshold of 1 that no signature can meet. It is impossible to change the circuits or pause the contract after deployment.
- **Any ledger token:** one contract wraps NIGHT and any other token that uses the ledger's unshielded coins.
- **Private transfers:** wrapped tokens are ordinary shielded coins, which hide the sender, recipient, amount and token. A transfer's fee and time stay public.
- **Public entry and exit:** `shield` shows the depositor, token and amount, and `unshield` shows the recipient, token and amount. Matching amounts can link the two.

## Circuits

### `shield`

Locks `amount` of `token` in the contract and mints the same amount of its wrapped token to `recipient`, a coin key. That's usually the caller's own key, but it can be anyone's: the caller pays either way. The depositor, token and amount are public. The recipient stays private, because only the new coin's commitment reaches the ledger, which needs a fresh secret `nonce` for each call.

The recipient's wallet finds the coin only if the transaction encrypts it to that wallet's encryption key, which the contract can't check. So take a recipient as a full shielded address, which carries both keys, not as a bare coin key.

```compact
export circuit shield(
  token: Bytes<32>,
  amount: Uint<64>,
  nonce: Bytes<32>,
  recipient: ZswapCoinPublicKey
): ShieldedCoinInfo {
  const underlying = disclose(token);
  const value = disclose(amount);
  // disclose() only acknowledges that the recipient goes into the coin's commitment, which
  // reaches the ledger. It stays hidden as long as `nonce` is fresh and secret.
  const to = disclose(recipient);
  assert(to != default<ZswapCoinPublicKey>, "shielded-pools: zero recipient");

  receiveUnshielded(underlying, value);
  return mintShieldedToken(
    underlying,
    value,
    disclose(nonce),
    left<ZswapCoinPublicKey, ContractAddress>(to)
  );
}
```

### `unshield`

Takes a wrapped coin the caller pays in, checks that it wraps `token`, and releases the same amount of `token` to `recipient`. The recipient, token and amount are public, but whose funds paid for it stays private. The wallet funds the coin from the wrapped coins it holds and keeps the change, so amounts don't have to match an earlier `shield`.

```compact
export circuit unshield(token: Bytes<32>, coin: ShieldedCoinInfo, recipient: UserAddress): [] {
  const underlying = disclose(token);
  const paid = disclose(coin);
  const to = disclose(recipient);
  // Only this contract's wrapped form of `token` may release its backing.
  assert(paid.color == tokenType(underlying, kernel.self()), "shielded-pools: wrong token");
  assert(to != default<UserAddress>, "shielded-pools: zero recipient");

  receiveShielded(paid);
  sendUnshielded(underlying, paid.value, right<ContractAddress, UserAddress>(to));
}
```

## Deploying

```sh
npm ci
npm run build
export MIDNIGHT_SEED=0000000000000000000000000000000000000000000000000000000000000001
npm run -s deploy
```

This pays the fee from the wallet with that seed, using a proof server on `127.0.0.1:6300`, and fails unless the chain shows that nobody can change the contract. No maintenance key is ever created. `MIDNIGHT_NETWORK` picks the network, which defaults to the local one. Public networks use the [deploy workflow](.github/workflows/deploy.yml).

## License

Copyright 2026 The Shielded Pool Authors. Apache-2.0: see [`LICENSE`](LICENSE). Contributions are made under the same license.

The license doesn't cover the Shielded Pool names or logos. Don't imply that your project is official or endorsed, and give a modified version its own name.
