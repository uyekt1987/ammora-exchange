import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import {
  CHAIN_NAME,
  DEFAULT_SLIPPAGE_BPS,
  EXPLORER_URL,
  FAUCET_URL,
  FAUCET_BACKUP_URL,
  PAIRS,
  POOL_ADDRESS,
  SDK_VERSION,
  TOKENS,
  connectWallet,
  executeSwap,
  formatAmount,
  friendlyError,
  getBalances,
  parseAmount,
  prepareQuote,
  type Balances,
  type PreparedSwap,
  type TokenId,
  type WalletConnection,
} from "./ammora";

type TxPhase = "idle" | "preparing" | "waiting" | "confirming" | "done" | "error";

function shortAddr(a: string) {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

export default function App() {
  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");

  const [payId, setPayId] = useState<TokenId>("ETH");
  const [receiveId, setReceiveId] = useState<TokenId>("KGPT");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);

  const [prepared, setPrepared] = useState<PreparedSwap | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [quoting, setQuoting] = useState(false);

  const [txPhase, setTxPhase] = useState<TxPhase>("idle");
  const [txHash, setTxHash] = useState("");
  const [txMessage, setTxMessage] = useState("");
  const [received, setReceived] = useState("");

  const quoteTimer = useRef<number | null>(null);
  const quoteSeq = useRef(0);

  const payToken = TOKENS[payId];
  const receiveToken = TOKENS[receiveId];

  const balanceOf = useCallback(
    (id: TokenId): bigint | null => {
      if (!balances) return null;
      if (id === "ETH") return balances.eth;
      if (id === "WETH") return balances.weth;
      return balances.kgpt;
    },
    [balances],
  );

  const payBalance = balanceOf(payId);
  const amountRaw = useMemo(
    () => (amount ? parseAmount(amount, payToken.decimals) : null),
    [amount, payToken.decimals],
  );
  const insufficient = amountRaw !== null && payBalance !== null && amountRaw > payBalance;
  const validPair = PAIRS.some((p) => p.pay === payId && p.receive === receiveId);

  const refreshBalances = useCallback(async (address: Address) => {
    try {
      setBalances(await getBalances(address));
    } catch {
      // Balances are a convenience; a failed read must not break the swap.
    }
  }, []);

  const doConnect = useCallback(async () => {
    setConnecting(true);
    setConnectError("");
    try {
      const conn = await connectWallet();
      setWallet(conn);
      await refreshBalances(conn.address);
    } catch (e) {
      setConnectError(friendlyError(e));
    } finally {
      setConnecting(false);
    }
  }, [refreshBalances]);

  // Keep balances fresh while connected.
  useEffect(() => {
    if (!wallet) return;
    const t = window.setInterval(() => refreshBalances(wallet.address), 15000);
    return () => window.clearInterval(t);
  }, [wallet, refreshBalances]);

  // Debounced live quote whenever the pay token, receive token, amount or
  // slippage changes. A quote is a read-only SDK call; nothing is signed.
  useEffect(() => {
    setPrepared(null);
    setQuoteError("");
    if (quoteTimer.current) window.clearTimeout(quoteTimer.current);
    if (!wallet || !validPair || amountRaw === null || amountRaw <= 0n || insufficient) return;
    setQuoting(true);
    const seq = ++quoteSeq.current;
    quoteTimer.current = window.setTimeout(async () => {
      try {
        const p = await prepareQuote({
          pay: payId,
          receive: receiveId,
          amountIn: amountRaw,
          payer: wallet.address,
          slippageBps,
        });
        if (quoteSeq.current !== seq) return;
        setPrepared(p);
        setQuoteError("");
      } catch (e) {
        if (quoteSeq.current !== seq) return;
        setQuoteError(friendlyError(e));
      } finally {
        if (quoteSeq.current === seq) setQuoting(false);
      }
    }, 450);
    return () => {
      if (quoteTimer.current) window.clearTimeout(quoteTimer.current);
    };
  }, [wallet, validPair, amountRaw, insufficient, payId, receiveId, slippageBps]);

  const quote = prepared?.quote;
  const flip = () => {
    // Only flip to a pair this pool supports.
    const next = PAIRS.find((p) => p.pay === receiveId && p.receive === payId);
    if (!next) return;
    setPayId(next.pay);
    setReceiveId(next.receive);
    setAmount("");
    setPrepared(null);
    setQuoteError("");
  };

  const doSwap = async () => {
    if (!wallet || !prepared) return;
    setTxPhase("preparing");
    setTxMessage("Preparing swap…");
    setTxHash("");
    setReceived("");
    try {
      if (prepared.isExpired()) {
        setTxMessage("Quote expired, refreshing…");
        await prepared.refresh();
      }
      setTxPhase("waiting");
      setTxMessage("Confirm the transaction in your wallet…");
      const result = await executeSwap(prepared, wallet.walletClient, (status) => {
        if (status.type === "approval-requested") setTxMessage("Approve the token spend in your wallet…");
        else if (status.type === "approval-submitted") setTxMessage("Approval submitted, waiting for confirmation…");
        else if (status.type === "approval-confirmed") setTxMessage("Approval confirmed, sending swap…");
        else if (status.type === "swap-requested") setTxMessage("Confirm the swap in your wallet…");
        else if (status.type === "swap-submitted") { setTxMessage("Swap submitted, waiting for confirmation…"); setTxPhase("confirming"); }
        else if (status.type === "swap-confirmed") setTxPhase("confirming");
        else if (status.type === "quote-refreshed") setTxMessage("Quote refreshed.");
      });
      setTxHash(result.hash);
      setReceived(
        result.amountReceived === null
          ? ""
          : formatAmount(result.amountReceived, receiveToken.decimals),
      );
      setTxPhase("done");
      setTxMessage("Swap confirmed.");
      setAmount("");
      setPrepared(null);
      await refreshBalances(wallet.address);
    } catch (e) {
      setTxPhase("error");
      setTxMessage(friendlyError(e));
    }
  };

  const canSwap =
    wallet && validPair && amountRaw !== null && amountRaw > 0n && !insufficient && !!prepared && !quoting && txPhase !== "waiting" && txPhase !== "confirming" && txPhase !== "preparing";

  const priceImpactBps = quote ? Number(quote.priceImpactBps) : null;

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="logo">AMMORA</span>
          <span className="tag">Swap · {CHAIN_NAME} testnet</span>
        </div>
        {wallet ? (
          <div className="wallet-chip">
            <span className="dot" />
            <span>{shortAddr(wallet.address)}</span>
            <span className="net">{CHAIN_NAME}</span>
          </div>
        ) : (
          <button className="btn primary" onClick={doConnect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </header>

      <main className="main">
        <div className="card">
          <h1>Swap</h1>
          <p className="sub">
            Live quotes from the Ammora SDK (v{SDK_VERSION}) on {CHAIN_NAME}. Testnet only — no real funds.
          </p>

          {!wallet && (
            <div className="notice">
              Connect MetaMask (or any injected EVM wallet) to get a live quote and swap. Your keys never leave your wallet.
            </div>
          )}
          {connectError && <div className="error">{connectError}</div>}

          <label className="field-label">You pay</label>
          <div className="token-row">
            <select value={payId} onChange={(e) => { setPayId(e.target.value as TokenId); setAmount(""); setPrepared(null); setQuoteError(""); }} aria-label="Pay token">
              {(Object.keys(TOKENS) as TokenId[]).map((id) => (
                <option key={id} value={id}>{TOKENS[id].symbol}</option>
              ))}
            </select>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0.0"
              inputMode="decimal"
              aria-label="Amount to pay"
            />
            <button
              className="max-btn"
              disabled={!payBalance || payBalance === 0n}
              onClick={() => payBalance !== null && setAmount(formatAmount(payBalance, payToken.decimals))}
            >
              MAX
            </button>
          </div>
          <div className="balance-line">
            Balance: {payBalance === null ? "—" : `${formatAmount(payBalance, payToken.decimals)} ${payToken.symbol}`}
            {insufficient && <span className="warn"> · Insufficient balance</span>}
          </div>

          <button className="flip" onClick={flip} disabled={!PAIRS.some((p) => p.pay === receiveId && p.receive === payId)} aria-label="Flip direction">
            ⇅
          </button>

          <label className="field-label">You receive (estimated)</label>
          <div className="token-row">
            <select value={receiveId} onChange={(e) => { setReceiveId(e.target.value as TokenId); setAmount(""); setPrepared(null); setQuoteError(""); }} aria-label="Receive token">
              {(Object.keys(TOKENS) as TokenId[]).map((id) => (
                <option key={id} value={id}>{TOKENS[id].symbol}</option>
              ))}
            </select>
            <input
              value={quote ? formatAmount(quote.expectedAmountOut, receiveToken.decimals) : ""}
              readOnly
              placeholder={quoting ? "Quoting…" : "0.0"}
              aria-label="Estimated amount received"
            />
          </div>
          <div className="balance-line">
            Balance: {balanceOf(receiveId) === null ? "—" : `${formatAmount(balanceOf(receiveId) as bigint, receiveToken.decimals)} ${receiveToken.symbol}`}
          </div>

          {!validPair && (
            <div className="error">
              This pool only supports ETH → KGPT, WETH → KGPT and KGPT → WETH.
            </div>
          )}
          {quoteError && <div className="error">{quoteError}</div>}
          {quoting && <div className="muted">Getting live quote…</div>}

          {quote && (
            <div className="quote-box">
              <div><span>Rate</span><b>1 {payToken.symbol} ≈ {amountRaw === null ? "—" : formatAmount((quote.expectedAmountOut * 10n ** BigInt(payToken.decimals)) / amountRaw, receiveToken.decimals)} {receiveToken.symbol}</b></div>
              <div><span>Minimum received</span><b>{formatAmount(quote.minimumAmountOut, receiveToken.decimals)} {receiveToken.symbol}</b></div>
              <div><span>Fee</span><b>{quote.feeAmount === null ? "—" : `${formatAmount(quote.feeAmount, payToken.decimals, 10)} ${payToken.symbol}`}</b></div>
              <div>
                <span>Price impact</span>
                <b className={priceImpactBps !== null && priceImpactBps > 500 ? "warn" : ""}>
                  {priceImpactBps === null ? "—" : `${(priceImpactBps / 100).toFixed(2)}%`}
                </b>
              </div>
              <div><span>Slippage</span><b>{(slippageBps / 100).toFixed(2)}%</b></div>
              <div><span>Pool</span><b><a href={`${EXPLORER_URL}/address/${POOL_ADDRESS}`} target="_blank" rel="noreferrer">{shortAddr(POOL_ADDRESS)}</a></b></div>
            </div>
          )}

          <div className="slippage-row">
            <span>Slippage tolerance</span>
            {[10, 50, 100].map((bps) => (
              <button key={bps} className={slippageBps === bps ? "pill active" : "pill"} onClick={() => setSlippageBps(bps)}>
                {(bps / 100).toFixed(1)}%
              </button>
            ))}
          </div>

          <button className="btn primary big" onClick={doSwap} disabled={!canSwap}>
            {!wallet ? "Connect wallet to swap" : txPhase === "waiting" ? "Confirm in wallet…" : txPhase === "confirming" || txPhase === "preparing" ? "Swapping…" : "Swap"}
          </button>

          {txPhase === "done" && txHash && (
            <div className="success">
              Swap confirmed{received ? ` — received ~${received} ${receiveToken.symbol}` : ""}.{" "}
              <a href={`${EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noreferrer">View on explorer</a>
            </div>
          )}
          {txPhase === "error" && <div className="error">{txMessage}</div>}
          {(txPhase === "waiting" || txPhase === "confirming" || txPhase === "preparing") && (
            <div className="muted">{txMessage}</div>
          )}

          {wallet && balances !== null && balances.eth === 0n && (
            <div className="notice">
              You have no testnet ETH for gas. Get free testnet ETH from the{" "}
              <a href={FAUCET_URL} target="_blank" rel="noreferrer">GIWA Sepolia faucet</a>
              {" "}(backup: <a href={FAUCET_BACKUP_URL} target="_blank" rel="noreferrer">Nodit faucet</a>). Never pay for testnet ETH and never share your seed phrase.
            </div>
          )}
        </div>

        <div className="info">
          <h2>About this pool</h2>
          <p>
            One verified concentrated pool (WETH ↔ KGPT) on {CHAIN_NAME}. It is live but thin
            (about 0.001 WETH in reserve), so swaps must stay small — the SDK refuses
            oversized amounts with a price-range error. Amounts around 0.000001 WETH quote fine.
          </p>
          <p>
            KGPT is a partner test token (9 decimals). WETH is the wrapped native token
            (0x4200…0006). Paying with ETH wraps it to WETH automatically; no approval is needed
            for native ETH, while WETH/KGPT approvals are handled by the swap itself.
          </p>
          <p className="muted">
            Built with @ammora-protocol/sdk@{SDK_VERSION}. Testnet only — tokens here have no value.
          </p>
        </div>
      </main>

      <footer className="footer">
        <span>AMMORA Swap · {CHAIN_NAME} (91342) · SDK {SDK_VERSION}</span>
        <span>
          <a href={EXPLORER_URL} target="_blank" rel="noreferrer">Explorer</a> ·{" "}
          <a href={FAUCET_URL} target="_blank" rel="noreferrer">Faucet</a>
        </span>
      </footer>
    </div>
  );
}
