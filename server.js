const http = require("http");
const https = require("https");
const { Connection, Keypair, VersionedTransaction, PublicKey } = require("@solana/web3.js");

const PORT = process.env.PORT || 3000;
const HELIUS_RPC = process.env.HELIUS_RPC || "https://mainnet.helius-rpc.com/?api-key=5887995d-86e5-4f50-8558-c53a988d4ec2";
const JUP_API_KEY = process.env.JUP_API_KEY || "jup_4e01628c96dcadffcf9d5ab360837152bdfc984674151b077d280b7107d9f315";
const BOT_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY || "";

// ── Base58 decode — no npm needed ───────────────────────────
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(str) {
  const bytes = [0];
  for (const c of str) {
    const val = B58.indexOf(c);
    if (val < 0) throw new Error("Bad base58 char: " + c);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of str) { if (c === "1") bytes.push(0); else break; }
  return Uint8Array.from(bytes.reverse());
}

// ── Bot keypair ──────────────────────────────────────────────
let botKeypair = null;
try {
  botKeypair = Keypair.fromSecretKey(b58decode(BOT_PRIVATE_KEY));
  console.log("✅ Bot wallet:", botKeypair.publicKey.toString());
} catch(e) { console.log("❌ Keypair error:", e.message); }

const connection = new Connection(HELIUS_RPC, "confirmed");

// ── Token mints ──────────────────────────────────────────────
const TOKENS = {
  SOL:  "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP:  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  WIF:  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
};

// ── State ────────────────────────────────────────────────────
let autoTrading = false, autoInterval = null;
let tradeLog = [], tradeCount = 0, totalPnl = 0;
let lastBuyPrice = 0, lastBuyAmount = 0;
let autoConfig = {
  inputMint: TOKENS.USDC,
  outputMint: TOKENS.SOL,
  amount: 1000000, // 1 USDC in lamports
  slippageBps: 50,
  intervalSecs: 60,
  takeProfitPct: 3,
  stopLossPct: 2,
  minConfidence: 75
};
const priceHistory = { SOL: [], ETH: [], BTC: [] };

// ── HTTP helpers ─────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "x-api-key": JUP_API_KEY } }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } });
    }).on("error", reject);
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "x-api-key": JUP_API_KEY }
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } });
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

function rpc(method, params = []) {
  return postJson(HELIUS_RPC, { jsonrpc: "2.0", id: 1, method, params });
}

// ── Prices ───────────────────────────────────────────────────
function binancePrice(sym) {
  return new Promise(r => {
    https.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`, rs => {
      let d = ""; rs.on("data", c => d += c);
      rs.on("end", () => {
        try { const x = JSON.parse(d); r({ usd: +x.lastPrice, change24h: +x.priceChangePercent, high24h: +x.highPrice, low24h: +x.lowPrice, volume24h: +x.quoteVolume }); }
        catch { r(null); }
      });
    }).on("error", () => r(null));
  });
}

function binanceKlines(sym, iv = "1h", lim = 60) {
  return new Promise(r => {
    https.get(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&limit=${lim}`, rs => {
      let d = ""; rs.on("data", c => d += c);
      rs.on("end", () => { try { r(JSON.parse(d).map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))); } catch { r([]); } });
    }).on("error", () => r([]));
  });
}

// ── Signal engine ────────────────────────────────────────────
function rsiCalc(p, n = 14) {
  if (p.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = p[i] - p[i-1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function maCalc(p, n) {
  if (p.length < n) return p[p.length-1] || 0;
  return p.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function getSignal(sym) {
  const ph = priceHistory[sym] || [];
  if (ph.length < 5) return { signal: "NEUTRAL", confidence: 40, score: 0, rsi: 50 };
  const r = rsiCalc(ph);
  const ma7 = maCalc(ph, Math.min(7, ph.length));
  const ma20 = maCalc(ph, Math.min(20, ph.length));
  let score = 0;
  if (r < 25) score += 35; else if (r < 35) score += 20; else if (r < 45) score += 10;
  else if (r > 75) score -= 35; else if (r > 65) score -= 20; else if (r > 55) score -= 10;
  if (ma7 > ma20) score += 15; else score -= 15;
  if (ph.length >= 6) {
    const recent = ph.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const older = ph.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
    if (recent > older * 1.008) score += 15;
    else if (recent > older * 1.003) score += 8;
    else if (recent < older * 0.992) score -= 15;
    else if (recent < older * 0.997) score -= 8;
  }
  let signal = "NEUTRAL", confidence = 40;
  if (score >= 35) { signal = "STRONG BUY"; confidence = Math.min(95, 60 + score); }
  else if (score >= 18) { signal = "BUY"; confidence = Math.min(80, 50 + score); }
  else if (score <= -35) { signal = "STRONG SELL"; confidence = Math.min(95, 60 + Math.abs(score)); }
  else if (score <= -18) { signal = "SELL"; confidence = Math.min(80, 50 + Math.abs(score)); }
  return { signal, confidence, score, rsi: Math.round(r), ma7, ma20 };
}

// ── Jupiter swap executor ────────────────────────────────────
async function executeSwap(inputMint, outputMint, amount, slippageBps = 50) {
  if (!botKeypair) throw new Error("No bot keypair — check BOT_PRIVATE_KEY env var");

  // 1. Get quote
  const quote = await get(
    `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
  );
  if (!quote || quote.error) throw new Error("Quote failed: " + (quote?.error || "unknown"));

  // 2. Get swap transaction
  const swapRes = await postJson("https://quote-api.jup.ag/v6/swap", {
    quoteResponse: quote,
    userPublicKey: botKeypair.publicKey.toString(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: "auto"
  });
  if (!swapRes.swapTransaction) throw new Error("No swap tx: " + JSON.stringify(swapRes).slice(0, 200));

  // 3. Sign and send
  const txBuf = Buffer.from(swapRes.swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([botKeypair]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(sig, "confirmed");

  return {
    signature: sig,
    inputMint, outputMint, amount,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
    explorerUrl: `https://solscan.io/tx/${sig}`
  };
}

// ── Auto trade engine ────────────────────────────────────────
async function runAutoTrade() {
  try {
    // Update price history
    const [SOL, ETH, BTC] = await Promise.all([
      binancePrice("SOLUSDT"), binancePrice("ETHUSDT"), binancePrice("BTCUSDT")
    ]);
    if (SOL) { priceHistory.SOL.push(SOL.usd); if (priceHistory.SOL.length > 100) priceHistory.SOL.shift(); }
    if (ETH) { priceHistory.ETH.push(ETH.usd); if (priceHistory.ETH.length > 100) priceHistory.ETH.shift(); }
    if (BTC) { priceHistory.BTC.push(BTC.usd); if (priceHistory.BTC.length > 100) priceHistory.BTC.shift(); }

    const currentPrice = SOL?.usd || 0;
    const sig = getSignal("SOL");
    const entry = {
      time: new Date().toISOString(),
      price: currentPrice,
      signal: sig.signal,
      confidence: sig.confidence,
      rsi: sig.rsi,
      action: "WATCHING"
    };

    // Check take profit / stop loss if we have a position
    if (lastBuyPrice > 0 && currentPrice > 0) {
      const pnlPct = ((currentPrice - lastBuyPrice) / lastBuyPrice) * 100;
      entry.pnlPct = pnlPct.toFixed(2);

      if (pnlPct >= autoConfig.takeProfitPct) {
        entry.action = "TAKING PROFIT";
        console.log(`[AUTO] Taking profit at +${pnlPct.toFixed(2)}%`);
        try {
          const solBal = await rpc("getBalance", [botKeypair.publicKey.toString()]);
          const solAmount = Math.floor((solBal.result?.value || 0) * 0.95);
          if (solAmount > 5000) {
            const result = await executeSwap(TOKENS.SOL, TOKENS.USDC, solAmount, autoConfig.slippageBps);
            const profit = (pnlPct / 100) * autoConfig.amount;
            totalPnl += profit;
            entry.action = "PROFIT_TAKEN";
            entry.signature = result.signature;
            entry.explorerUrl = result.explorerUrl;
            entry.profit = profit.toFixed(2);
            entry.type = "SELL_PROFIT";
            lastBuyPrice = 0; lastBuyAmount = 0;
            tradeCount++;
          }
        } catch(e) { entry.action = "SELL_FAILED"; entry.error = e.message; }
      } else if (pnlPct <= -autoConfig.stopLossPct) {
        entry.action = "STOP LOSS";
        console.log(`[AUTO] Stop loss triggered at ${pnlPct.toFixed(2)}%`);
        try {
          const solBal = await rpc("getBalance", [botKeypair.publicKey.toString()]);
          const solAmount = Math.floor((solBal.result?.value || 0) * 0.95);
          if (solAmount > 5000) {
            const result = await executeSwap(TOKENS.SOL, TOKENS.USDC, solAmount, autoConfig.slippageBps);
            const loss = (pnlPct / 100) * autoConfig.amount;
            totalPnl += loss;
            entry.action = "STOP_LOSS_EXECUTED";
            entry.signature = result.signature;
            entry.explorerUrl = result.explorerUrl;
            entry.loss = loss.toFixed(2);
            entry.type = "SELL_STOPLOSS";
            lastBuyPrice = 0; lastBuyAmount = 0;
            tradeCount++;
          }
        } catch(e) { entry.action = "STOPLOSS_FAILED"; entry.error = e.message; }
      }
    }

    // Buy signal — only if no position
    if (lastBuyPrice === 0 && sig.signal === "STRONG BUY" && sig.confidence >= autoConfig.minConfidence) {
      entry.action = "BUYING";
      console.log(`[AUTO] STRONG BUY signal — executing swap`);
      try {
        const result = await executeSwap(
          autoConfig.inputMint, autoConfig.outputMint,
          autoConfig.amount, autoConfig.slippageBps
        );
        lastBuyPrice = currentPrice;
        lastBuyAmount = autoConfig.amount;
        entry.action = "BOUGHT";
        entry.signature = result.signature;
        entry.explorerUrl = result.explorerUrl;
        entry.boughtAt = currentPrice;
        entry.type = "BUY";
        tradeCount++;
        console.log(`[AUTO] ✅ BOUGHT at $${currentPrice} | tx: ${result.signature}`);
      } catch(e) { entry.action = "BUY_FAILED"; entry.error = e.message; console.log("[AUTO] ❌ Buy failed:", e.message); }
    }

    tradeLog.unshift(entry);
    tradeLog = tradeLog.slice(0, 200);
    console.log(`[AUTO] $${currentPrice} | ${sig.signal} ${sig.confidence}% | RSI:${sig.rsi} | ${entry.action}${entry.pnlPct ? " | PnL:"+entry.pnlPct+"%" : ""}`);

  } catch(e) { console.log("[AUTO ERROR]", e.message); }
}

function startAuto() {
  if (autoInterval) clearInterval(autoInterval);
  autoTrading = true;
  runAutoTrade();
  autoInterval = setInterval(runAutoTrade, autoConfig.intervalSecs * 1000);
}
function stopAuto() {
  if (autoInterval) clearInterval(autoInterval);
  autoTrading = false; autoInterval = null;
}

// ── CORS + JSON ──────────────────────────────────────────────
function cors(r) { r.setHeader("Access-Control-Allow-Origin","*"); r.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS"); r.setHeader("Access-Control-Allow-Headers","Content-Type"); }
function out(r, d, s = 200) { cors(r); r.writeHead(s, {"Content-Type":"application/json"}); r.end(JSON.stringify(d)); }

// ── Server ───────────────────────────────────────────────────
http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, "http://x"), p = u.pathname;

  if (p === "/health") return out(res, {
    ok: true, exchange: "jupiter+helius",
    botWallet: botKeypair?.publicKey.toString() || "NOT LOADED",
    autoTrading, tradeCount, totalPnl: totalPnl.toFixed(4),
    lastBuyPrice, ts: new Date().toISOString()
  });

  if (p === "/prices") {
    try {
      const [S, E, B] = await Promise.all([binancePrice("SOLUSDT"), binancePrice("ETHUSDT"), binancePrice("BTCUSDT")]);
      if (S) priceHistory.SOL.push(S.usd);
      if (E) priceHistory.ETH.push(E.usd);
      if (B) priceHistory.BTC.push(B.usd);
      return out(res, { success: true, prices: { SOL: S, ETH: E, BTC: B } });
    } catch(e) { return out(res, { success: false, error: e.message }); }
  }

  if (p === "/klines") {
    const s = u.searchParams.get("symbol") || "SOLUSDT";
    return out(res, { success: true, candles: await binanceKlines(s, u.searchParams.get("interval") || "1h", +(u.searchParams.get("limit") || 60)) });
  }

  if (p === "/signal") {
    const s = u.searchParams.get("symbol") || "SOL";
    return out(res, { success: true, ...getSignal(s), priceHistory: (priceHistory[s] || []).slice(-20) });
  }

  if (p === "/account") {
    const wallet = u.searchParams.get("wallet") || botKeypair?.publicKey.toString();
    if (!wallet) return out(res, { success: false, error: "Pass ?wallet=ADDRESS" });
    try {
      const r = await rpc("getBalance", [wallet]);
      const bal = (r.result?.value || 0) / 1e9;
      return out(res, { success: true, balances: [{ asset: "SOL", free: bal, locked: 0, total: bal }], wallet });
    } catch(e) { return out(res, { success: false, error: e.message }); }
  }

  // ── Auto trade controls ──
  if (p === "/auto/start") {
    if (req.method === "POST") {
      let b = ""; req.on("data", c => b += c);
      req.on("end", () => {
        try {
          const cfg = JSON.parse(b || "{}");
          if (cfg.amount) autoConfig.amount = cfg.amount;
          if (cfg.slippageBps) autoConfig.slippageBps = cfg.slippageBps;
          if (cfg.intervalSecs) autoConfig.intervalSecs = cfg.intervalSecs;
          if (cfg.takeProfitPct) autoConfig.takeProfitPct = cfg.takeProfitPct;
          if (cfg.stopLossPct) autoConfig.stopLossPct = cfg.stopLossPct;
          if (cfg.minConfidence) autoConfig.minConfidence = cfg.minConfidence;
        } catch {}
        startAuto();
        out(res, { success: true, message: "🤖 Auto trading STARTED", config: autoConfig, botWallet: botKeypair?.publicKey.toString() });
      });
    } else {
      startAuto();
      out(res, { success: true, message: "🤖 Auto trading STARTED", config: autoConfig, botWallet: botKeypair?.publicKey.toString() });
    }
    return;
  }

  if (p === "/auto/stop") { stopAuto(); return out(res, { success: true, message: "🛑 Stopped", tradeCount, totalPnl }); }
  if (p === "/auto/status") return out(res, {
    success: true, autoTrading, config: autoConfig, tradeCount,
    totalPnl: totalPnl.toFixed(4), lastBuyPrice,
    log: tradeLog.slice(0, 30),
    signals: { SOL: getSignal("SOL"), ETH: getSignal("ETH"), BTC: getSignal("BTC") },
    botWallet: botKeypair?.publicKey.toString()
  });
  if (p === "/auto/log") return out(res, { success: true, log: tradeLog });

  if (p === "/order" && req.method === "POST") {
    let b = ""; req.on("data", c => b += c);
    req.on("end", async () => {
      try {
        const { symbol, side, quantity, userPublicKey } = JSON.parse(b);
        const sym = symbol.replace("USDT", "");
        const inputMint = side === "BUY" ? TOKENS.USDC : (TOKENS[sym] || TOKENS.SOL);
        const outputMint = side === "BUY" ? (TOKENS[sym] || TOKENS.SOL) : TOKENS.USDC;
        const amount = Math.floor(quantity * (side === "BUY" ? 1e6 : 1e9));
        if (userPublicKey) {
          const quote = await get(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`);
          const swapRes = await postJson("https://quote-api.jup.ag/v6/swap", { quoteResponse: quote, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" });
          return out(res, { success: true, swapTransaction: swapRes.swapTransaction, quote, mode: "frontend-sign" });
        }
        const result = await executeSwap(inputMint, outputMint, amount);
        out(res, { success: true, ...result, mode: "bot-sign" });
      } catch(e) { out(res, { success: false, error: e.message }); }
    });
    return;
  }

  if (p === "/trades") return out(res, { success: true, trades: tradeLog.filter(t => t.type), tradeCount, totalPnl });
  out(res, { error: "Not found" }, 404);

}).listen(PORT, () => console.log(`Quantifesta Auto-Trading Bot (Jupiter+Helius) on port ${PORT}`));
