# Ammora Swap — GIWA Sepolia Testnet

A light swap UI (exchange) built with the Ammora SDK for the **Ammora Season 2
Builder mission** ("Ship an exchange or launchpad with the Ammora SDK").
Testnet only — no real funds, no private keys anywhere.

![Swap UI with a live quote](ammora-swap-quote.png)

## What it does

- Connects MetaMask (or any injected EVM wallet) and switches/adds the
  **GIWA Sepolia** network (chain id `91342`).
- Shows live ETH / WETH / KGPT balances for the connected wallet.
- Gets a **live quote** from `@ammora-protocol/sdk@0.3.9`
  (`AmmoraSwapClient.prepareExactIn`) as you type, and shows rate, minimum
  received, fee, price impact and slippage.
- Executes the swap through the user's own wallet (`prepared.execute()`),
  including the ERC20 approval step when one is needed. Native ETH needs no
  approval.
- Handles the failure modes honestly: oversized amounts get a clear
  "too large for this pool's liquidity" message, and an empty wallet gets a
  pointer to the GIWA Sepolia faucet.

## The pool (verified live 2026-11-17)

One verified concentrated pool on GIWA Sepolia:

| | |
|---|---|
| Pool | `0xD912Fa18061E5665136AE5dBc002aDa0fc0D3c28` (model `concentrated`) |
| Pair | WETH ↔ KGPT |
| WETH | `0x4200000000000000000000000000000000000006` (18 decimals) |
| KGPT | `0xeFD0b74cB733534D6554894c0FdF5931a711BCFB` (9 decimals, "Korean Guide Partner Test") |
| RPC | `https://sepolia-rpc.giwa.io` |
| Explorer | `https://sepolia-explorer.giwa.io` |

Supported directions: **ETH → KGPT**, **WETH → KGPT**, **KGPT → WETH**.
Paying with ETH wraps it to WETH automatically (`inputAsset: "native"`).

**Thin liquidity — read this.** The pool is live but holds only about
0.001 WETH and ~10 KGPT in reserve, so swaps must stay small. A 0.000001 WETH
swap quotes fine (verified: → ~10.03 KGPT); 0.00001 WETH and above is refused
by the SDK with `PriceRangeViolation`, which the UI translates to a friendly
message. Price impact on the quoted size is high (~99%) and is shown in red.
This is a property of the testnet pool, not a bug in the app.

Two SDK facts that took probing to find (see `src/ammora.ts`):

1. `AmmoraSwapClient.create` **must** receive
   `factoryProfiles: giwaSepoliaAutoRoutePoolProfiles`, or the pool factory is
   reported as "unsupported" and every quote fails.
2. The simple `AmmoraRouteClient.create({ chainId: 91342 })` form from the
   Ammora homepage does **not** work as-is — it needs an explicit
   `verificationBlock` plus the route/deployment catalogs. This app uses the
   single-pool `AmmoraSwapClient` path instead, which is the reviewed
   wallet-facing flow.

On-chain pool discovery (`discoverPools()` / Uniswap V4 handle discovery)
scans millions of blocks over the public RPC and takes many minutes, so it is
deliberately not in this light build. To list another pool, add its address
and model to `POOL_ADDRESS` / `POOL_MODEL` in `src/ammora.ts` and re-verify
with a quote probe first.

## Run locally

Requires Node 22+.

```bash
npm install
npm run dev        # http://localhost:5173
```

To build the production bundle:

```bash
npm run build      # output in dist/
npm run preview    # serve dist/ locally to check it
```

Optional env overrides (`.env` or shell):

- `VITE_AMMORA_RPC_URL` — use a different GIWA Sepolia RPC endpoint.
- `VITE_BASE` — base path for deployment (see below).

## Deploy (GitHub Pages)

1. Create a **public** GitHub repo (the GitHub connector cannot create repos,
   so create it in the GitHub web UI). Suggested name: `ammora-exchange`.
2. Push this folder's contents to the repo's `main` branch.
3. Build with the Pages base path, then publish `dist/`:
   ```bash
   VITE_BASE=/ammora-exchange/ npm run build
   ```
   Then enable GitHub Pages for the repo (Settings → Pages → deploy from the
   `main` branch `/docs` folder, or use a `gh-pages` branch), copying `dist/`
   to the published folder. Any static host works too (Netlify, Vercel, Cloudflare
   Pages) — serve `dist/` as-is with base `/`.
4. The live site is the website link to submit for the Builder mission.

## Get testnet ETH (gas)

- Official faucet: https://faucet.giwa.io (0.005 ETH / 24 h)
- Backup faucet: https://faucet.lambda256.io/giwa-sepolia (0.01 ETH)

Testnet ETH has no value. Never pay for it, and never share a seed phrase —
this app never asks for one.

## Security notes

- No private key, seed phrase or credential is stored in this repo or in the
  app. Reads use the public RPC; writes are signed by the user's own wallet.
- The only external host the app calls is the GIWA Sepolia RPC
  (`sepolia-rpc.giwa.io`) plus the block explorer links.
