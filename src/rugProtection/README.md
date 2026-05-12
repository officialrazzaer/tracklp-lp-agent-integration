# Rug protection

Gates that run against a candidate pool's "risky side" token before
any capital touches it. The contract:

> **Every gate fails CLOSED on a data-source error.** If we can't
> verify, we treat it as failed and skip the candidate. Asymmetric
> risk — missing a legitimate trade is cheap, entering a rug is
> unrecoverable.

## Why this exists

The obvious-looking holder-count check — `getProgramAccounts` against
the SPL Token program with a `memcmp` filter on the mint — does not
work against Helius. Helius rejects the call with:

```
{ "error": { "code": -32600, "message": "Too many accounts requested..." } }
```

The JSON-RPC `result` field is missing. A parser that checks
`Array.isArray(json?.result)` returns `null` on every call. If
upstream code treats `null` as "unknown → allow", every rug gets
approved. This is a fail-OPEN pattern hiding under what looks like a
working safety check.

The hardened approach:

1. **Use Helius DAS `getTokenAccounts`** (paginated cursor, accepts a
   `mint` parameter) instead of `getProgramAccounts`. Count accounts
   with `amount > 0`.
2. **Return `null` on every error path** — RPC errors, HTTP non-200,
   unexpected response shape, parse failure. No silent degradation.
3. **Fail CLOSED at the orchestrator.** `runRugGates` treats `null`
   as a failed gate and short-circuits.

## Gates shipped here

| Gate | Source | Threshold | Notes |
|---|---|---|---|
| `holderCount` | Helius DAS `getTokenAccounts` | ≥ 200 (configurable) | Early-exits at 1000 — anything above is "well-distributed" for rug purposes. SOL/USDC and other well-known mints short-circuit without an RPC call via a sentinel value. |
| `mintAuthority` | Solana RPC `getAccountInfo` | option = 0 (disabled) | A live mint authority is an instant rug vector. |
| `freezeAuthority` | same RPC call | option = 0 (disabled) | A live freeze authority can lock user balances. |

Gates we run in production but didn't extract (the wrapper depends on a
Jupiter data-API client that's not in this repo):

- `top10Concentration` — top-10 holders ≤ 60% of supply.
- `bundlerPattern` — % of top-100 holders flagged as bundlers,
  with consensus-tiered tolerance (more leader corroboration = more
  tolerance for pump.fun launch patterns).

You can compose these in: keep `runRugGates` as the floor, then
add your own gate functions that return a `GateResult` and short-
circuit before opening if any fails.

## Usage

```ts
import { runRugGates } from '@tracklp/lp-agent-integration';

const outcome = await runRugGates(
  {
    tokenXMint: pool.tokenXMint,
    tokenYMint: pool.tokenYMint,
    quoteMint: 'So11111111111111111111111111111111111111112', // SOL
    poolAddress: pool.address,
  },
  {
    heliusRpcUrl: process.env.HELIUS_RPC_URL,
    minHolders: 200,
    logger: { warn: console.warn, error: console.error },
  },
);

if (!outcome.passed) {
  console.log(`Skip pool — ${outcome.failedGate} failed:`, outcome.results);
  return;
}

// Safe to proceed. outcome.results is the audit log of which gates ran.
```

The orchestrator runs cheap-first — holder count, then the single
`getAccountInfo` call that returns both mint and freeze authority. A
typical pass costs two RPC calls. A typical reject costs one.

## Why `KNOWN_TOKEN_HOLDER_SENTINEL` is exported

If you write your own gate-orchestrator and want to skip rug checks
on SOL/USDC/USDT-only pools, importing the sentinel makes that an
explicit comparison instead of a magic number:

```ts
import { getHolderCount, KNOWN_TOKEN_HOLDER_SENTINEL } from '@tracklp/lp-agent-integration';
const holders = await getHolderCount(mint);
const wellKnown = holders === KNOWN_TOKEN_HOLDER_SENTINEL;
```
