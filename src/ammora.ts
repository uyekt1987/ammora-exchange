/**
 * Ammora SDK wiring for the GIWA Sepolia testnet swap UI.
 *
 * Chain: GIWA Sepolia, chain id 91342, RPC https://sepolia-rpc.giwa.io.
 * Everything here is testnet. No private key is ever used: reads go through
 * the public RPC, writes go through the user's own injected wallet
 * (MetaMask) via viem. Never paste a seed phrase or private key anywhere.
 *
 * Verified 2026-11-17 (probe scripts in /tmp/ammora-probe):
 * - AmmoraSwapClient MUST be created with factoryProfiles:
 *   giwaSepoliaAutoRoutePoolProfiles, otherwise the concentrated pool
 *   factory is reported as "unsupported" and quotes fail.
 * - Pool 0xD912Fa18061E5665136AE5dBc002aDa0fc0D3c28 is a "concentrated"
 *   WETH/KGPT pool. It is live (isActive) but THIN: ~0.001 WETH and
 *   ~10 KGPT in reserve. Swaps must be small or the SDK refuses with
 *   PriceRangeViolation. A 0.000001 WETH swap quotes fine.
 * - Native ETH input works: tokenIn = WETH address, inputAsset "native",
 *   approvals = 0, value = amountIn, tx goes to the native router.
 */
import {
  AmmoraSwapClient,
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaAutoRoutePoolProfiles,
  type SafeSwapStatus,
} from "@ammora-protocol/sdk";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";

export const CHAIN_ID = 91342;
export const CHAIN_NAME = "GIWA Sepolia";
/** Overridable for local verification (VITE_AMMORA_RPC_URL). Defaults to the public GIWA RPC. */
export const RPC_URL = import.meta.env.VITE_AMMORA_RPC_URL || "https://sepolia-rpc.giwa.io";
export const EXPLORER_URL = "https://sepolia-explorer.giwa.io";
export const FAUCET_URL = "https://faucet.giwa.io";
export const FAUCET_BACKUP_URL = "https://faucet.lambda256.io/giwa-sepolia";
export const SDK_VERSION = "0.3.9";

export const POOL_ADDRESS = "0xD912Fa18061E5665136AE5dBc002aDa0fc0D3c28" as Address;
export const POOL_MODEL = "concentrated" as const;

/** WETH on GIWA Sepolia (wrapped native, also the pool quote token). */
export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as Address;
/** KGPT, "Korean Guide Partner Test" (9 decimals), the pool base token. */
export const KGPT_ADDRESS = "0xeFD0b74cB733534D6554894c0FdF5931a711BCFB" as Address;

export type TokenId = "ETH" | "WETH" | "KGPT";

export interface TokenInfo {
  id: TokenId;
  symbol: string;
  name: string;
  decimals: number;
  /** ERC20 address; null for the native token. */
  address: Address | null;
  /** True when the token is paid as native ETH (inputAsset "native"). */
  native: boolean;
}

export const TOKENS: Record<TokenId, TokenInfo> = {
  ETH: { id: "ETH", symbol: "ETH", name: "Ether (testnet)", decimals: 18, address: null, native: true },
  WETH: { id: "WETH", symbol: "WETH", name: "Wrapped Ether", decimals: 18, address: WETH_ADDRESS, native: false },
  KGPT: { id: "KGPT", symbol: "KGPT", name: "Korean Guide Partner Test", decimals: 9, address: KGPT_ADDRESS, native: false },
};

/** The token pairs this pool supports, in (pay -> receive) order. */
export const PAIRS: Array<{ pay: TokenId; receive: TokenId }> = [
  { pay: "ETH", receive: "KGPT" },
  { pay: "WETH", receive: "KGPT" },
  { pay: "KGPT", receive: "WETH" },
];

export const DEFAULT_SLIPPAGE_BPS = 50;

export const giwaSepoliaChain = {
  id: CHAIN_ID,
  name: CHAIN_NAME,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "GIWA Sepolia Explorer", url: EXPLORER_URL } },
} as const;

let publicClient: PublicClient | null = null;
export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: giwaSepoliaChain,
      transport: http(RPC_URL),
    });
  }
  return publicClient;
}

let swapClient: AmmoraSwapClient | null = null;
export async function getSwapClient(): Promise<AmmoraSwapClient> {
  if (!swapClient) {
    swapClient = await AmmoraSwapClient.create(getPublicClient(), {
      deploymentCatalog: { [CHAIN_ID]: giwaSepoliaAutoRouteDeployment },
      factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
    });
  }
  return swapClient;
}

const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export interface Balances {
  eth: bigint;
  weth: bigint;
  kgpt: bigint;
}

export async function getBalances(owner: Address): Promise<Balances> {
  const client = getPublicClient();
  const [eth, weth, kgpt] = await Promise.all([
    client.getBalance({ address: owner }),
    client.readContract({ address: WETH_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: KGPT_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
  ]);
  return { eth, weth, kgpt };
}

export interface QuoteRequest {
  pay: TokenId;
  receive: TokenId;
  /** Raw amount in the pay token's smallest unit. */
  amountIn: bigint;
  payer: Address;
  slippageBps: number;
}

export type PreparedSwap = Awaited<ReturnType<AmmoraSwapClient["prepareExactIn"]>>;

/**
 * Build a live quote with the Ammora SDK. Returns the prepared swap, whose
 * `.quote` holds expected/minimum output, fee and price impact, and whose
 * `.execute(wallet)` sends the approval (if any) and the swap.
 * Throws the SDK error when the pool cannot quote (for example
 * PriceRangeViolation when the amount is too large for pool liquidity).
 */
export async function prepareQuote(req: QuoteRequest): Promise<PreparedSwap> {
  const swaps = await getSwapClient();
  const payToken = TOKENS[req.pay];
  const tokenIn = payToken.native ? WETH_ADDRESS : (payToken.address as Address);
  return swaps.prepareExactIn({
    model: POOL_MODEL,
    pool: POOL_ADDRESS,
    tokenIn,
    inputAsset: payToken.native ? "native" : "erc20",
    amountIn: req.amountIn,
    payer: req.payer,
    recipient: req.payer,
    slippageBps: req.slippageBps,
    executionMode: "direct-wallet",
  });
}

export interface WalletConnection {
  walletClient: WalletClient;
  address: Address;
  chainId: number;
}

/** Connect MetaMask (or any injected wallet) and switch it to GIWA Sepolia. */
export async function connectWallet(): Promise<WalletConnection> {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!eth) throw new Error("NO_WALLET");
  const walletClient = createWalletClient({
    chain: giwaSepoliaChain,
    transport: custom(eth as never),
  });
  const [address] = await walletClient.requestAddresses();
  if (!address) throw new Error("NO_ACCOUNT");
  let chainId = await walletClient.getChainId();
  if (chainId !== CHAIN_ID) {
    try {
      await walletClient.switchChain({ id: CHAIN_ID });
    } catch (e) {
      const err = e as { code?: number };
      // 4902 = chain not added to the wallet yet.
      if (err && err.code === 4902) {
        await walletClient.addChain({ chain: giwaSepoliaChain });
        await walletClient.switchChain({ id: CHAIN_ID });
      } else {
        throw e;
      }
    }
    chainId = await walletClient.getChainId();
  }
  return { walletClient, address, chainId };
}

/** Run a prepared swap through the user's wallet. Handles ERC20 approval first when required. */
export async function executeSwap(
  prepared: PreparedSwap,
  walletClient: WalletClient,
  onStatus?: (status: SafeSwapStatus) => void,
) {
  return prepared.execute(walletClient, { autoRefresh: true, onStatus });
}

/** Human-readable message for the errors the SDK and wallet surface. */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("NO_WALLET")) return "No wallet found. Install MetaMask (or another EVM wallet) and try again.";
  if (msg.includes("NO_ACCOUNT")) return "No account connected. Unlock MetaMask and connect an account.";
  if (msg.includes("PriceRangeViolation")) return "Amount too large for this pool's liquidity. Try a much smaller amount (the pool only holds ~0.001 WETH).";
  if (msg.includes("no reviewed exact-input route")) return "No route is available for this pair right now.";
  if (msg.includes("User rejected") || msg.includes("user rejected") || msg.includes("User denied")) return "Transaction rejected in your wallet.";
  if (msg.includes("insufficient funds") || msg.includes("Insufficient")) return "Insufficient balance (check your token balance and testnet ETH for gas).";
  if (msg.includes("unsupported") && msg.includes("factory")) return "This pool is not in the reviewed Ammora generation. The app only lists the verified WETH/KGPT pool.";
  return msg.length > 300 ? msg.slice(0, 300) + "..." : msg;
}

/** Format a raw bigint amount into a human string with up to 6 decimals. */
export function formatAmount(raw: bigint, decimals: number, maxDecimals = 6): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, maxDecimals).replace(/0+$/, "");
  const out = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${out}` : out;
}

/** Parse a human decimal string into raw units. Returns null when invalid. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return raw;
}
