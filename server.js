const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const HELIUS_RPC = process.env.HELIUS_RPC || "https://mainnet.helius-rpc.com/?api-key=5887995d-86e5-4f50-8558-c53a988d4ec2";
const JUP_API_KEY = process.env.JUP_API_KEY || "jup_4e01628c96dcadffcf9d5ab360837152bdfc984674151b077d280b7107d9f315";

// ── HTTP helpers ─────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "x-api-key": JUP_API_KEY } }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } });
    }).on("error", reject);
  });
}

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "x-api-key": JUP_API_KEY, ...headers }
    };
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } });
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

function rpc(method, params = []) {
  return post(HELIUS_RPC, { jsonrpc: "2.0", id: 1, method, params });
}

// ── Binance public prices ────────────────────────────────────
function binancePrice(symbol) {
  return new Promise((resolve) => {
    https.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try {
          const x = JSON.parse(d);
          resolve({ usd: +x.lastPrice, change24h: +x.priceChangePercent, high24h: +x.highPrice, low24h: +x.lowPrice, volume24h: +x.quoteVolume });
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

function binanceKlines(symbol, interval = "1h", limit = 60) {
  return new Promise((resolve) => {
    https.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d).map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))); }
        catch { resolve([]); }
      });
    }).on("error", () => resolve([]));
  });
}

// ── Token mints ──────────────────────────────────────────────
const TOKENS = {
  SOL:  "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  ETH:  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  BTC:  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",
};

function cors(r) {
  r.setHeader("Access-Control-Allow-Origin", "*");
  r.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  r.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function out(r, d, s = 200) {
  cors(r); r.writeHead(s, { "Content-Type": "application/json" });
  r.end(JSON.stringify(d));
}

// ── Server ───────────────────────────────────────────────────
http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, "http://x"), p = u.pathname;

  // Health
  if (p === "/health") return out(res, { ok: true, exchange: "jupiter+helius", ts: new Date().toISOString() });

  // Prices (Binance public)
  if (p === "/prices") {
    try {
      const [SOL, ETH, BTC] = await Promise.all([binancePrice("SOLUSDT"), binancePrice("ETHUSDT"), binancePrice("BTCUSDT")]);
      return out(res, { success: true, prices: { SOL, ETH, BTC } });
    } catch (e) { return out(res, { success: false, error: e.message }); }
  }

  // Klines (Binance public)
  if (p === "/klines") {
    const sym = u.searchParams.get("symbol") || "SOLUSDT";
    const candles = await binanceKlines(sym, u.searchParams.get("interval") || "1h", +(u.searchParams.get("limit") || 60));
    return out(res, { success: true, candles });
  }

  // Wallet balance via Helius
  if (p === "/account") {
    const wallet = u.searchParams.get("wallet");
    if (!wallet) return out(res, { success: false, error: "Pass ?wallet=YOUR_PHANTOM_ADDRESS" });
    try {
      // SOL balance
      const solRes = await rpc("getBalance", [wallet]);
      const solBal = (solRes.result?.value || 0) / 1e9;
      // Token accounts
      const tokRes = await rpc("getTokenAccountsByOwner", [
        wallet,
        { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { encoding: "jsonParsed" }
      ]);
      const tokens = (tokRes.result?.value || []).map(t => {
        const info = t.account.data.parsed.info;
        return { asset: info.mint, free: +info.tokenAmount.uiAmount, locked: 0, total: +info.tokenAmount.uiAmount };
      }).filter(t => t.total > 0);
      const balances = [{ asset: "SOL", free: solBal, locked: 0, total: solBal }, ...tokens];
      return out(res, { success: true, balances, exchange: "solana" });
    } catch (e) { return out(res, { success: false, error: e.message }); }
  }

  // Jupiter quote
  if (p === "/quote") {
    const inputMint = u.searchParams.get("inputMint") || TOKENS.USDC;
    const outputMint = u.searchParams.get("outputMint") || TOKENS.SOL;
    const amount = u.searchParams.get("amount") || "1000000";
    try {
      const quote = await get(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`);
      return out(res, { success: true, quote });
    } catch (e) { return out(res, { success: false, error: e.message }); }
  }

  // Jupiter swap transaction (returns transaction for wallet to sign)
  if (p === "/swap" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { inputMint, outputMint, amount, userPublicKey, slippageBps = 50 } = JSON.parse(body);
        // Get quote first
        const quote = await get(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`);
        if (quote.error) return out(res, { success: false, error: quote.error });
        // Get swap transaction
        const swapRes = await post("https://quote-api.jup.ag/v6/swap", {
          quoteResponse: quote,
          userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: "auto"
        });
        if (swapRes.swapTransaction) {
          return out(res, { success: true, swapTransaction: swapRes.swapTransaction, quote });
        }
        return out(res, { success: false, error: swapRes.error || JSON.stringify(swapRes) });
      } catch (e) { return out(res, { success: false, error: e.message }); }
    });
    return;
  }

  // Order endpoint (maps to Jupiter swap)
  if (p === "/order" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { symbol, side, quantity, userPublicKey } = JSON.parse(body);
        const sym = symbol.replace("USDT", "");
        const inputMint = side === "BUY" ? TOKENS.USDC : (TOKENS[sym] || TOKENS.SOL);
        const outputMint = side === "BUY" ? (TOKENS[sym] || TOKENS.SOL) : TOKENS.USDC;
        const decimals = side === "BUY" ? 6 : 9;
        const amount = Math.floor(quantity * Math.pow(10, decimals));
        const quote = await get(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`);
        if (quote.error) return out(res, { success: false, error: quote.error });
        if (!userPublicKey) return out(res, { success: false, error: "Pass userPublicKey — connect Phantom wallet first" });
        const swapRes = await post("https://quote-api.jup.ag/v6/swap", {
          quoteResponse: quote, userPublicKey, wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto"
        });
        if (swapRes.swapTransaction) {
          return out(res, { success: true, swapTransaction: swapRes.swapTransaction, message: "Sign this transaction in Phantom to complete the swap", quote });
        }
        return out(res, { success: false, error: swapRes.error || JSON.stringify(swapRes) });
      } catch (e) { return out(res, { success: false, error: e.message }); }
    });
    return;
  }

  // Trades (recent Helius transactions)
  if (p === "/trades") {
    const wallet = u.searchParams.get("wallet");
    if (!wallet) return out(res, { success: true, trades: [] });
    try {
      const txRes = await get(`https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=5887995d-86e5-4f50-8558-c53a988d4ec2&limit=20&type=SWAP`);
      const trades = Array.isArray(txRes) ? txRes.map(tx => ({
        id: tx.signature,
        time: tx.timestamp * 1000,
        side: "SWAP",
        price: 0,
        qty: 0,
        total: 0,
        description: tx.description || ""
      })) : [];
      return out(res, { success: true, trades });
    } catch (e) { return out(res, { success: false, error: e.message }); }
  }

  out(res, { error: "Not found" }, 404);
}).listen(PORT, () => console.log(`Quantifesta API (Jupiter+Helius) on port ${PORT}`));
        
