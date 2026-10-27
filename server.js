"use strict";
// Quantifesta Bot v3 — paper mode by default, token-protected controls, no secrets in code.
const http = require("http"), https = require("https"), crypto = require("crypto");

// ── Config: ALL secrets come from environment variables only ──
const PORT = process.env.PORT || 3000;
const RPC_URL = (process.env.HELIUS_RPC || "").trim() || "https://api.mainnet-beta.solana.com";
const JUP_API_KEY = (process.env.JUP_API_KEY || "").trim();
const BOT_PRIVATE_KEY = (process.env.BOT_PRIVATE_KEY || "").trim();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const PAPER_MODE = String(process.env.PAPER_MODE || "true").trim().toLowerCase() !== "false";
const MAX_TRADE_USD = Number(process.env.MAX_TRADE_USD || 5);
const log = (...a) => console.log("[QF]", ...a);

// ── Base58 ──
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const c of s) { const v = B58.indexOf(c); if (v < 0) throw new Error("Bad base58"); n = n * 58n + BigInt(v); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let z = 0; for (const c of s) { if (c === "1") z++; else break; }
  return Buffer.concat([Buffer.alloc(z), body]);
}
function b58encode(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0")), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = "1" + s; else break; }
  return s;
}

// ── Wallet key (validated; private key never logged) ──
const PKCS8 = Buffer.from([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
let botPriv = null, botAddr = "";
if (BOT_PRIVATE_KEY) {
  try {
    const raw = b58decode(BOT_PRIVATE_KEY);
    if (raw.length !== 64) throw new Error("key must decode to 64 bytes");
    const k = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, raw.slice(0, 32)]), format: "der", type: "pkcs8" });
    const derived = crypto.createPublicKey(k).export({ type: "spki", format: "der" }).slice(-32);
    if (!derived.equals(raw.slice(32))) throw new Error("public key does not match private key");
    botPriv = k; botAddr = b58encode(raw.slice(32));
    log("Wallet loaded:", botAddr);
  } catch (e) { log("Wallet key error:", e.message); }
}
log(PAPER_MODE ? "MODE: PAPER (no real trades)" : "MODE: LIVE (real money)");
if (!ADMIN_TOKEN) log("ADMIN_TOKEN not set — start/stop/config are disabled");

const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  PYTH: "HZ1JovNiVvSZEbEbp3p5LUkbgKRGV1Q3bAcfhFkH7uvA",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  ORCA: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
};
const CG_IDS = { SOL:"solana", ETH:"ethereum", BTC:"bitcoin", BONK:"bonk", WIF:"dogwifcoin", JUP:"jupiter-exchange-solana", PYTH:"pyth-network", RAY:"raydium", ORCA:"orca" };
const TRADEABLE = ["SOL", "BONK", "WIF", "JUP", "RAY"];
const MIN_SAMPLES = 20;

// ── State ──
const cfg = { amountUsd: 1, slippageBps: 100, intervalSecs: 60, takeProfitPct: 3, stopLossPct: 2, minConfidence: 75, maxTradesPerDay: 10, maxFailures: 3 };
const LIMITS = { amountUsd:[0.5,MAX_TRADE_USD], slippageBps:[10,500], intervalSecs:[30,3600], takeProfitPct:[0.5,50], stopLossPct:[0.5,30], minConfidence:[50,95], maxTradesPerDay:[1,50], maxFailures:[1,10] };
const S = { autoTrading: false, tradeCount: 0, totalPnl: 0, position: null, log: [], failures: 0, dayKey: "", dayTrades: 0 };
const HIST = {}; for (const k of Object.keys(CG_IDS)) HIST[k] = [];

function applyConfig(c) {
  const changed = [];
  for (const k of Object.keys(LIMITS)) {
    if (c[k] === undefined) continue;
    const v = Number(c[k]);
    if (!Number.isFinite(v) || v < LIMITS[k][0] || v > LIMITS[k][1]) throw new Error(k + " must be between " + LIMITS[k][0] + " and " + LIMITS[k][1]);
    cfg[k] = v; changed.push(k);
  }
  return changed;
}

// ── HTTP helper with timeout ──
function request(urlStr, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr), data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, timeout: 15000,
      headers: { "User-Agent": "quantifesta/3", Accept: "application/json", ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d.slice(0, 200), status: res.statusCode }); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const rpc = (method, params = []) => request(RPC_URL, { method: "POST", body: { jsonrpc: "2.0", id: 1, method, params } });
async function solBalance(addr = botAddr) { const r = await rpc("getBalance", [addr]); return r.result?.value || 0; }
async function tokenRaw(mint, addr = botAddr) {
  const r = await rpc("getTokenAccountsByOwner", [addr, { mint }, { encoding: "jsonParsed" }]);
  let t = 0n; for (const a of r.result?.value || []) t += BigInt(a.account.data.parsed.info.tokenAmount.amount);
  return t;
}

// ── Jupiter (swap/v1). With an API key, api.jup.ag is tried first, then the free lite host ──
const JUP_HOSTS = JUP_API_KEY ? ["https://api.jup.ag", "https://lite-api.jup.ag"] : ["https://lite-api.jup.ag"];
const jupHeaders = h => (h.startsWith("https://api.") && JUP_API_KEY ? { "x-api-key": JUP_API_KEY } : {});
async function jupQuote(inMint, outMint, amount, slip) {
  const qs = `inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slip}&restrictIntermediateTokens=true`;
  let last = "no host";
  for (const h of JUP_HOSTS) {
    try { const q = await request(`${h}/swap/v1/quote?${qs}`, { headers: jupHeaders(h) }); if (q && q.outAmount) return { quote: q, host: h }; last = JSON.stringify(q).slice(0, 150); }
    catch (e) { last = e.message; }
  }
  throw new Error("Jupiter quote failed: " + last);
}
function jupSwapBuild(host, quote, userPublicKey) {
  return request(`${host}/swap/v1/swap`, { method: "POST", headers: jupHeaders(host), body: {
    quoteResponse: quote, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 500000, priorityLevel: "high" } },
  } });
}
// Transaction layout: [sig count][64-byte signatures...][message]. Jupiter returns one empty signature slot.
function signTx(b64) {
  const tx = Buffer.from(b64, "base64");
  if (tx[0] !== 1) throw new Error("unexpected signer count: " + tx[0]);
  const sig = crypto.sign(null, tx.slice(1 + 64), botPriv);
  sig.copy(tx, 1);
  return tx;
}
async function executeSwap(inMint, outMint, amount, slip) {
  if (!botPriv) throw new Error("no wallet key loaded");
  const { quote, host } = await jupQuote(inMint, outMint, String(amount), slip);
  const sw = await jupSwapBuild(host, quote, botAddr);
  if (!sw.swapTransaction) throw new Error("No swap tx: " + JSON.stringify(sw).slice(0, 200));
  const tx = signTx(sw.swapTransaction);
  const send = await rpc("sendTransaction", [tx.toString("base64"), { encoding: "base64", skipPreflight: false, maxRetries: 3 }]);
  if (send.error) throw new Error("Send failed: " + JSON.stringify(send.error).slice(0, 200));
  const signature = send.result;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const st = await rpc("getSignatureStatuses", [[signature]]);
    const s = st.result?.value?.[0];
    if (s?.err) throw new Error("Tx error: " + JSON.stringify(s.err));
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"))
      return { signature, explorerUrl: "https://solscan.io/tx/" + signature, outAmount: String(quote.outAmount) };
  }
  throw new Error("UNCONFIRMED after 60s — check solscan.io/tx/" + signature);
}

// ── Prices (20s cache; one CoinGecko call serves everything) ──
let priceCache = { t: 0, data: {} };
async function fetchAllPrices(force) {
  if (!force && Date.now() - priceCache.t < 20000 && Object.keys(priceCache.data).length) return priceCache.data;
  const prices = {};
  try {
    const d = await request(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(CG_IDS).join(",")}&vs_currencies=usd&include_24hr_change=true`);
    for (const [sym, id] of Object.entries(CG_IDS)) if (d?.[id]?.usd) prices[sym] = { usd: +d[id].usd, change24h: +(d[id].usd_24h_change || 0) };
  } catch (e) { log("CoinGecko error:", e.message); }
  for (const sym of ["SOL", "ETH", "BTC"]) {
    if (prices[sym]) continue;
    try { const d = await request(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`, { headers: { "CB-VERSION": "2016-02-18" } }); if (d?.data?.amount) prices[sym] = { usd: +d.data.amount, change24h: 0 }; } catch {}
  }
  if (Object.keys(prices).length) { priceCache = { t: Date.now(), data: { ...priceCache.data, ...prices } }; }
  return priceCache.data;
}
function sample(prices) { for (const [sym, p] of Object.entries(prices)) if (p?.usd && HIST[sym]) { HIST[sym].push(p.usd); if (HIST[sym].length > 200) HIST[sym].shift(); } }

// ── Signals ──
function rsiCalc(p, n = 14) {
  const w = p.slice(-(n + 1)); if (w.length < n + 1) return 50;
  let g = 0, l = 0; for (let i = 1; i < w.length; i++) { const d = w[i] - w[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n; return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const maCalc = (p, n) => { const w = p.slice(-n); return w.reduce((a, b) => a + b, 0) / (w.length || 1); };
function getSignal(sym) {
  const ph = HIST[sym] || [];
  if (ph.length < MIN_SAMPLES) return { signal: "NEUTRAL", confidence: 0, score: 0, rsi: 50, warm: true };
  const r = rsiCalc(ph), ma7 = maCalc(ph, 7), ma20 = maCalc(ph, 20);
  let score = 0;
  if (r < 25) score += 35; else if (r < 35) score += 20; else if (r < 45) score += 10;
  else if (r > 75) score -= 35; else if (r > 65) score -= 20; else if (r > 55) score -= 10;
  score += ma7 > ma20 ? 15 : -15;
  const rec = maCalc(ph, 3), old = ph.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
  if (rec > old * 1.008) score += 15; else if (rec > old * 1.003) score += 8; else if (rec < old * 0.992) score -= 15; else if (rec < old * 0.997) score -= 8;
  let signal = "NEUTRAL", confidence = 40;
  if (score >= 35) { signal = "STRONG BUY"; confidence = Math.min(95, 60 + score); }
  else if (score >= 18) { signal = "BUY"; confidence = Math.min(80, 50 + score); }
  else if (score <= -35) { signal = "STRONG SELL"; confidence = Math.min(95, 60 + Math.abs(score)); }
  else if (score <= -18) { signal = "SELL"; confidence = Math.min(80, 50 + Math.abs(score)); }
  return { signal, confidence, score, rsi: Math.round(r) };
}
function bestBuy() {
  let best = null;
  for (const sym of TRADEABLE) { const s = getSignal(sym); if ((s.signal === "STRONG BUY" || s.signal === "BUY") && s.confidence >= cfg.minConfidence && (!best || s.confidence > best.confidence)) best = { sym, ...s }; }
  return best;
}

// ── Optional Postgres persistence (needs "pg" in package.json; falls back to memory) ──
let pool = null;
async function dbInit() {
  if (!DATABASE_URL) return;
  let Pool; try { ({ Pool } = require("pg")); } catch { log("pg not installed — running in memory only"); return; }
  try {
    let cs = DATABASE_URL; try { const u = new URL(cs); u.searchParams.delete("channel_binding"); cs = u.toString(); } catch {}
    pool = new Pool({ connectionString: cs, max: 3, ssl: { rejectUnauthorized: false } });
    await pool.query("CREATE TABLE IF NOT EXISTS bot_state(id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())");
    await pool.query("CREATE TABLE IF NOT EXISTS bot_log(id SERIAL PRIMARY KEY, entry JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now())");
    const r = await pool.query("SELECT data FROM bot_state WHERE id=1");
    if (r.rows[0]) {
      const d = r.rows[0].data;
      S.tradeCount = d.tradeCount || 0; S.totalPnl = d.totalPnl || 0; S.position = d.position || null;
      S.autoTrading = !!d.autoTrading && PAPER_MODE; // never auto-resume live trading after a restart
      try { applyConfig(d.cfg || {}); } catch {}
    }
    const l = await pool.query("SELECT entry FROM bot_log ORDER BY id DESC LIMIT 60");
    S.log = l.rows.map(x => x.entry);
    log("Database connected");
  } catch (e) { log("DB error:", e.message); pool = null; }
}
async function persist(entry) {
  if (!pool) return;
  try {
    const data = JSON.stringify({ tradeCount: S.tradeCount, totalPnl: S.totalPnl, position: S.position, autoTrading: S.autoTrading, cfg });
    await pool.query("INSERT INTO bot_state(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=$1, updated_at=now()", [data]);
    if (entry && (entry.type || entry.error)) await pool.query("INSERT INTO bot_log(entry) VALUES($1)", [JSON.stringify(entry)]);
  } catch (e) { log("persist error:", e.message); }
}

// ── Trading ──
function fail(entry, label, e) {
  entry.action = label; entry.error = e.message; S.failures++;
  if (S.failures >= cfg.maxFailures || /UNCONFIRMED/.test(e.message)) { S.autoTrading = false; entry.halted = true; log("Bot halted:", e.message); }
  log("Trade failed:", label, e.message);
}
async function preflight(amountRaw) {
  if (!botPriv) throw new Error("no wallet key loaded");
  const [sol, usdc] = await Promise.all([solBalance(), tokenRaw(TOKENS.USDC)]);
  if (sol < 10000000) throw new Error("need at least 0.01 SOL for fees");
  if (usdc < BigInt(amountRaw)) throw new Error("not enough USDC in bot wallet");
}
async function openPosition(best, price, entry) {
  const usd = Math.min(cfg.amountUsd, MAX_TRADE_USD), amountRaw = Math.round(usd * 1e6);
  entry.action = "BUYING " + best.sym;
  try {
    let r = {};
    if (!PAPER_MODE) { await preflight(amountRaw); r = await executeSwap(TOKENS.USDC, TOKENS[best.sym], amountRaw, cfg.slippageBps); }
    S.position = { token: best.sym, entryPrice: price, usd, rawAmount: r.outAmount || null, openedAt: new Date().toISOString(), paper: PAPER_MODE };
    S.tradeCount++; S.dayTrades++; S.failures = 0;
    Object.assign(entry, { action: "BOUGHT " + best.sym, type: "BUY", token: best.sym, signature: r.signature, explorerUrl: r.explorerUrl });
  } catch (e) { fail(entry, "BUY_" + best.sym + "_FAILED", e); }
}
async function closePosition(reason, pct, entry) {
  const pos = S.position; entry.action = reason;
  try {
    let r = {};
    if (!PAPER_MODE) {
      const mint = TOKENS[pos.token], recorded = pos.rawAmount ? BigInt(pos.rawAmount) : null;
      let bal = pos.token === "SOL" ? BigInt(await solBalance()) - 20000000n : await tokenRaw(mint); // keep 0.02 SOL for fees
      if (bal < 0n) bal = 0n;
      const amt = recorded !== null && recorded < bal ? recorded : bal;
      if (amt <= 0n) throw new Error("nothing to sell");
      r = await executeSwap(mint, TOKENS.USDC, amt.toString(), cfg.slippageBps);
    }
    const pnlUsd = pos.usd * pct / 100;
    S.totalPnl += pnlUsd; S.tradeCount++; S.dayTrades++; S.failures = 0; S.position = null;
    Object.assign(entry, { action: reason + "_DONE", type: "SELL", pnlUsd: +pnlUsd.toFixed(4), signature: r.signature, explorerUrl: r.explorerUrl });
  } catch (e) { fail(entry, reason + "_FAILED", e); }
}
async function trade(prices) {
  const day = new Date().toISOString().slice(0, 10);
  if (S.dayKey !== day) { S.dayKey = day; S.dayTrades = 0; }
  if (!PAPER_MODE && !botPriv) { S.autoTrading = false; return; }
  const sol = getSignal("SOL");
  const entry = { time: new Date().toISOString(), price: prices.SOL?.usd || 0, signal: sol.signal, confidence: sol.confidence, rsi: sol.rsi, action: "WATCHING", mode: PAPER_MODE ? "PAPER" : "LIVE" };
  const pos = S.position;
  if (pos) {
    const cur = prices[pos.token]?.usd;
    if (cur) {
      const pct = (cur - pos.entryPrice) / pos.entryPrice * 100;
      entry.pnlPct = +pct.toFixed(3); entry.position = pos.token;
      const sg = getSignal(pos.token);
      const reason = pct >= cfg.takeProfitPct ? "TAKE_PROFIT" : pct <= -cfg.stopLossPct ? "STOP_LOSS" : (sg.signal === "STRONG SELL" && sg.confidence >= cfg.minConfidence ? "SIGNAL_EXIT" : null);
      if (reason) await closePosition(reason, pct, entry);
    }
  } else if (S.dayTrades >= cfg.maxTradesPerDay) { entry.action = "DAILY_LIMIT"; }
  else { const b = bestBuy(); if (b && prices[b.sym]?.usd) await openPosition(b, prices[b.sym].usd, entry); }
  S.log.unshift(entry); S.log = S.log.slice(0, 200);
  if (entry.type || entry.error) await persist(entry);
  log(`SOL $${entry.price} | ${sol.signal} ${sol.confidence}% | ${entry.action}`);
}
let ticking = false, timer = null;
async function tick() {
  if (ticking) return; ticking = true;
  try { const prices = await fetchAllPrices(true); sample(prices); if (S.autoTrading) await trade(prices); }
  catch (e) { log("tick error:", e.message); } finally { ticking = false; }
}
function restartLoop() { if (timer) clearInterval(timer); timer = setInterval(tick, cfg.intervalSecs * 1000); tick(); }

// ── Auth & HTTP plumbing ──
const failedAuth = new Map();
function authed(req, strict) {
  // Paper mode with no token set: controls are open, since nothing real can be spent.
  // LIVE mode, or strict endpoints (/order), always require ADMIN_TOKEN.
  if (!ADMIN_TOKEN) return PAPER_MODE && !strict;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const rec = failedAuth.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - rec.t > 600000) { rec.n = 0; rec.t = Date.now(); }
  if (rec.n >= 10) { log("Auth locked out for this IP (10 failed tries, resets after 10 min)"); return false; }
  const h = String(req.headers["x-admin-token"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const a = Buffer.from(h), b = Buffer.from(ADMIN_TOKEN);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { rec.n++; failedAuth.set(ip, rec); log("Auth failed: sent " + h.length + " chars, server expects " + ADMIN_TOKEN.length + " chars (attempt " + rec.n + "/10)"); }
  return ok;
}
function cors(r) { r.setHeader("Access-Control-Allow-Origin", "*"); r.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); r.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-token,Authorization"); }
function out(r, d, s = 200) { cors(r); r.writeHead(s, { "Content-Type": "application/json" }); r.end(JSON.stringify(d)); }
function readBody(req) {
  return new Promise((res, rej) => {
    let b = ""; req.on("data", c => { b += c; if (b.length > 10000) { rej(new Error("body too large")); req.destroy(); } });
    req.on("end", () => { try { res(b ? JSON.parse(b) : {}); } catch { rej(new Error("bad JSON")); } });
  });
}
const needAuth = (req, res, strict) => { if (authed(req, strict)) return true; out(res, { success: false, error: ADMIN_TOKEN ? "Unauthorized" : "Controls disabled: set ADMIN_TOKEN" }, ADMIN_TOKEN ? 401 : 403); return false; };
const statusPayload = () => {
  const sigs = {}; for (const s of Object.keys(HIST)) sigs[s] = getSignal(s);
  return { success: true, mode: PAPER_MODE ? "PAPER" : "LIVE", autoTrading: S.autoTrading, config: cfg, tradeCount: S.tradeCount, dayTrades: S.dayTrades, totalPnl: +S.totalPnl.toFixed(4), position: S.position, log: S.log.slice(0, 40), signals: sigs, samples: HIST.SOL.length, minSamples: MIN_SAMPLES, botWallet: botAddr || "", hasWallet: !!botPriv, persisted: !!pool };
};

async function route(req, res) {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }
  const u = new URL(req.url, "http://x"), p = u.pathname;
  if (p === "/" || p === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'" });
    return res.end(DASHBOARD_HTML);
  }
  if (p === "/health") return out(res, { ok: true, mode: PAPER_MODE ? "PAPER" : "LIVE", autoTrading: S.autoTrading, tradeCount: S.tradeCount, ts: new Date().toISOString() });
  if (p === "/prices") return out(res, { success: true, prices: await fetchAllPrices(false) });
  if (p === "/signal") return out(res, { success: true, ...getSignal((u.searchParams.get("symbol") || "SOL").toUpperCase()) });
  if (p === "/account") {
    const w = u.searchParams.get("wallet") || botAddr;
    if (!w || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) return out(res, { success: false, error: "No wallet (paper mode has none)" });
    const sol = (await solBalance(w)) / 1e9, usdc = Number(await tokenRaw(TOKENS.USDC, w)) / 1e6;
    return out(res, { success: true, wallet: w, balances: [{ asset: "SOL", total: sol }, { asset: "USDC", total: usdc }] });
  }
  if (p === "/auto/status") return out(res, statusPayload());
  if (p === "/auto/log") return out(res, { success: true, log: S.log });
  if (p === "/trades") return out(res, { success: true, trades: S.log.filter(t => t.type), tradeCount: S.tradeCount, totalPnl: S.totalPnl });

  if (p === "/auto/start" && req.method === "POST") {
    if (!needAuth(req, res)) return;
    if (!PAPER_MODE && !botPriv) return out(res, { success: false, error: "LIVE mode needs a valid BOT_PRIVATE_KEY" }, 400);
    S.autoTrading = true; S.failures = 0; await persist(); return out(res, { success: true, message: "STARTED (" + (PAPER_MODE ? "PAPER" : "LIVE") + ")" });
  }
  if (p === "/auto/stop" && req.method === "POST") {
    if (!needAuth(req, res)) return;
    S.autoTrading = false; await persist(); return out(res, { success: true, message: "STOPPED" });
  }
  if (p === "/auto/config" && req.method === "POST") {
    if (!needAuth(req, res)) return;
    try { const changed = applyConfig(await readBody(req)); if (changed.includes("intervalSecs")) restartLoop(); await persist(); return out(res, { success: true, changed, config: cfg }); }
    catch (e) { return out(res, { success: false, error: e.message }, 400); }
  }
  if (p === "/order" && req.method === "POST") {
    if (!needAuth(req, res, true)) return;
    try {
      const { symbol, side, quantity, userPublicKey } = await readBody(req);
      const sym = String(symbol || "").replace("USDT", "");
      if (!TOKENS[sym] || !["BUY", "SELL"].includes(side) || !(quantity > 0) || !userPublicKey) return out(res, { success: false, error: "Need valid symbol, side, quantity, userPublicKey" }, 400);
      const inMint = side === "BUY" ? TOKENS.USDC : TOKENS[sym], outMint = side === "BUY" ? TOKENS[sym] : TOKENS.USDC;
      const amount = Math.floor(quantity * (side === "BUY" ? 1e6 : 1e9));
      const { quote, host } = await jupQuote(inMint, outMint, amount, 50);
      const sw = await jupSwapBuild(host, quote, userPublicKey);
      return out(res, { success: true, swapTransaction: sw.swapTransaction, quote, mode: "frontend-sign" });
    } catch (e) { return out(res, { success: false, error: e.message }, 400); }
  }
  out(res, { error: "Not found" }, 404);
}

const DASHBOARD_HTML = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Quantifesta</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#050a14;--sf:#0a1628;--bd:#0f2040;--teal:#00d4aa;--vio:#7c3aed;--amb:#f59e0b;--red:#ef4444;--tx:#e2e8f0;--mu:#6b8aaa}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font:14px 'Space Grotesk',sans-serif;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:#050a14f2;z-index:5}
.logo{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#00d4aa,#7c3aed);display:grid;place-items:center;font-weight:700}
h1{font-size:15px}.sub{font-size:10px;color:var(--mu)}
.pill{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid var(--bd);color:var(--mu)}
.pill.on{color:var(--teal);border-color:var(--teal)}.pill.paper{color:var(--amb);border-color:var(--amb)}.pill.live{color:var(--red);border-color:var(--red)}
.prices{display:flex;gap:14px;flex-wrap:wrap;margin-left:auto}.prices b{display:block;font-size:12px}.prices span{font-size:9px;color:var(--mu)}
.wrap{padding:16px;display:grid;gap:14px;max-width:1100px;margin:auto}
.card{background:var(--sf);border:1px solid var(--bd);border-radius:14px;padding:14px}
.t{font-size:10px;color:var(--mu);margin-bottom:8px}
.pnl{font-size:34px;font-weight:700;text-align:center}.pos{color:var(--teal)}.neg{color:var(--red)}.zero{color:var(--mu)}
.btn{width:100%;padding:11px;border-radius:9px;border:1px solid var(--teal);background:#00d4aa22;color:var(--teal);font:600 13px 'Space Grotesk',sans-serif;cursor:pointer}
.btn.stop{border-color:var(--red);background:#ef444422;color:var(--red)}.btn:disabled{opacity:.4}
input{width:100%;padding:9px;border-radius:8px;border:1px solid var(--bd);background:var(--bg);color:var(--tx);margin-bottom:8px}
.row{display:flex;justify-content:space-between;padding:4px 0;font-size:12px}.row span:first-child{color:var(--mu)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.tok{border:1px solid var(--bd);border-radius:12px;padding:12px;background:var(--sf)}.tok.buy{border-color:var(--teal)}.tok.sell{border-color:var(--red)}
.tok .s{font-weight:600}.tok .p{font-size:17px;font-weight:700;margin:3px 0}.tok .m{font-size:10px;color:var(--mu)}
.log{display:grid;grid-template-columns:90px 70px 1fr 70px;gap:8px;font-size:11px;padding:7px 9px;background:var(--bg);border-radius:7px;margin-bottom:5px}
.log .err{grid-column:1/-1;color:var(--amb);font-size:10px}
a{color:var(--vio)}#msg{font-size:11px;color:var(--amb);min-height:14px;margin-top:6px}
.addr{font:10px monospace;word-break:break-all}
</style></head><body>
<header>
 <div class="logo">Q</div>
 <div><h1>Quantifesta</h1><div class="sub">Neural trading bot · 9 tokens</div></div>
 <span class="pill" id="mode">—</span><span class="pill" id="state">Stopped</span>
 <div class="prices" id="hdr"></div>
</header>
<div class="wrap">
 <div class="card"><div class="t">Total P&amp;L (<span id="pnlSub">0 trades</span>)</div><div class="pnl zero" id="pnl">$0.0000</div></div>
 <div class="card">
  <div class="t">Bot control</div>
  <input id="tok" type="password" placeholder="Admin token" autocomplete="off">
  <button class="btn" id="saveTok" style="margin-bottom:8px;background:none;border-color:var(--bd);color:var(--mu)">Save token</button>
  <button class="btn" id="go">Start bot</button>
  <div id="msg"></div>
 </div>
 <div class="card"><div class="t">Configuration</div><div id="cfg"></div></div>
 <div class="card"><div class="t">Position &amp; wallet</div><div id="posn"></div><div class="addr" id="addr"></div></div>
 <div><div class="t">Signal grid</div><div class="grid" id="grid"></div></div>
 <div class="card"><div class="t">Activity log <span id="cnt"></span></div><div id="log"></div></div>
</div>
<script>
var TOKEN="";try{TOKEN=localStorage.getItem("qf_token")||""}catch(e){}
var TK=[["SOL","Solana"],["ETH","Ethereum"],["BTC","Bitcoin"],["BONK","Bonk"],["WIF","dogwifhat"],["JUP","Jupiter"],["PYTH","Pyth"],["RAY","Raydium"],["ORCA","Orca"]];
var S={autoTrading:false,mode:"PAPER",tradeCount:0,totalPnl:0,position:null,log:[],signals:{},config:{},samples:0,minSamples:20,botWallet:"",hasWallet:false};
var P={},bal=null;
function $(i){return document.getElementById(i)}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function fmt(v,s){if(!v)return"—";if(s==="BTC")return"$"+Math.round(v).toLocaleString();if(v<0.01)return"$"+v.toFixed(7);if(v<1)return"$"+v.toFixed(4);return"$"+v.toFixed(2)}
function msg(t){$("msg").textContent=t||""}
async function getJSON(u){var r=await fetch(u);return r.json()}
async function status(){try{var d=await getJSON("/auto/status");if(d.success){S=d;render()}}catch(e){}}
async function prices(){try{var d=await getJSON("/prices");if(d.success){P=d.prices;render()}}catch(e){}}
async function wallet(){if(!S.hasWallet)return;try{var d=await getJSON("/account");if(d.success){bal=d.balances;render()}}catch(e){}}
async function toggle(){
  $("go").disabled=true;msg("");
  try{var r=await fetch(S.autoTrading?"/auto/stop":"/auto/start",{method:"POST",headers:{"Content-Type":"application/json","x-admin-token":TOKEN},body:"{}"});
  var d=await r.json();if(!d.success)msg(d.error||"Failed")}catch(e){msg("Network error")}
  $("go").disabled=false;status()
}
$("tok").value=TOKEN;
$("saveTok").onclick=function(){TOKEN=$("tok").value.trim();try{localStorage.setItem("qf_token",TOKEN)}catch(e){}msg("Token saved on this device")};
$("go").onclick=toggle;
function row(a,b){return "<div class='row'><span>"+a+"</span><span>"+b+"</span></div>"}
function render(){
  var m=$("mode");m.textContent=S.mode;m.className="pill "+(S.mode==="LIVE"?"live":"paper");
  var st=$("state");st.textContent=S.autoTrading?"Running":"Stopped";st.className="pill"+(S.autoTrading?" on":"");
  $("go").textContent=S.autoTrading?"Stop bot":"Start bot";$("go").className="btn"+(S.autoTrading?" stop":"");
  var pnl=Number(S.totalPnl)||0,e=$("pnl");e.textContent=(pnl>=0?"+$":"-$")+Math.abs(pnl).toFixed(4);e.className="pnl "+(pnl>0?"pos":pnl<0?"neg":"zero");
  $("pnlSub").textContent=S.tradeCount+" trades"+(S.samples<S.minSamples?" · warming up "+S.samples+"/"+S.minSamples:"");
  var c=S.config||{};
  $("cfg").innerHTML=row("Trade size","$"+c.amountUsd+" USDC")+row("Take profit","+"+c.takeProfitPct+"%")+row("Stop loss","-"+c.stopLossPct+"%")+row("Min confidence",c.minConfidence+"%")+row("Max trades/day",c.maxTradesPerDay)+row("Check every",c.intervalSecs+"s");
  var ps=S.position,h="";
  if(ps){var cur=P[ps.token]&&P[ps.token].usd,pct=cur?((cur-ps.entryPrice)/ps.entryPrice*100):null;
   h=row("Holding",esc(ps.token)+(ps.paper?" (paper)":""))+row("Entry",fmt(ps.entryPrice,ps.token))+row("Live P&amp;L",pct==null?"—":(pct>=0?"+":"")+pct.toFixed(2)+"%")}
  else h=row("Holding","None");
  if(bal)h+=row("SOL",bal[0].total.toFixed(4))+row("USDC",bal[1].total.toFixed(2));
  $("posn").innerHTML=h;$("addr").textContent=S.hasWallet?S.botWallet:"Paper mode: no wallet connected";
  var hd="";["SOL","ETH","BTC","BONK","WIF"].forEach(function(s){hd+="<div><span>"+s+"</span><b>"+fmt(P[s]&&P[s].usd,s)+"</b></div>"});$("hdr").innerHTML=hd;
  var g="";TK.forEach(function(t){var s=t[0],sg=S.signals[s]||{},sig=sg.signal||"NEUTRAL",pr=P[s]||{},ch=pr.change24h;
   var cl=sig.indexOf("BUY")>=0?"buy":sig.indexOf("SELL")>=0?"sell":"";
   g+="<div class='tok "+cl+"'><div class='s'>"+s+" <span class='m'>"+t[1]+"</span></div><div class='p'>"+fmt(pr.usd,s)+"</div><div class='m'>"+(ch?(ch>=0?"+":"")+ch.toFixed(2)+"% 24h":"—")+"</div><div class='m'>"+esc(sig)+" · RSI "+(sg.rsi||50)+" · "+(sg.confidence||0)+"%</div></div>"});
  $("grid").innerHTML=g;
  var L=S.log||[];$("cnt").textContent=L.length?"("+L.length+")":"";
  $("log").innerHTML=L.length?L.slice(0,30).map(function(x){
   var link=x.explorerUrl&&String(x.explorerUrl).indexOf("https://solscan.io/")===0?"<a href='"+esc(x.explorerUrl)+"' target='_blank' rel='noopener'>tx</a>":"";
   return "<div class='log'><span>"+new Date(x.time).toLocaleTimeString()+"</span><span>"+fmt(x.price,"SOL")+"</span><span>"+esc(x.action)+"</span><span>"+(x.pnlPct!=null?x.pnlPct+"%":"")+" "+link+"</span>"+(x.error?"<span class='err'>"+esc(x.error)+"</span>":"")+"</div>"}).join(""):"<div class='m'>Trades appear here.</div>"
}
status();prices();wallet();setInterval(status,15000);setInterval(prices,30000);setInterval(wallet,60000);
</script></body></html>`;

process.on("unhandledRejection", e => log("unhandled:", e && e.message));
const server = http.createServer((req, res) => { route(req, res).catch(e => { try { out(res, { success: false, error: e.message }, 500); } catch {} }); });
(async () => { await dbInit(); restartLoop(); server.listen(PORT, () => log("Quantifesta Bot running on port " + PORT)); })();
