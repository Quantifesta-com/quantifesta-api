
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const HELIUS_RPC = process.env.HELIUS_RPC || "https://mainnet.helius-rpc.com/";
const JUP_API_KEY = process.env.JUP_API_KEY || "";
const BOT_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY || "";
const ENABLE_LIVE_TRADING = process.env.ENABLE_LIVE_TRADING === "true";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58decode(str) {
  if (!str) throw new Error("Private key not configured");
  const bytes = [0];

  for (const c of str) {
    const val = B58.indexOf(c);
    if (val < 0) throw new Error("Invalid Base58 character");

    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }

  for (const c of str) {
    if (c === "1") bytes.push(0);
    else break;
  }

  return Buffer.from(bytes.reverse());
}

function b58encode(buf) {
  if (!buf || !buf.length) return "";

  const digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let prefix = "";
  for (let i = 0; i < buf.length && buf[i] === 0; i++) {
    prefix += "1";
  }

  return prefix + digits.reverse().map(d => B58[d]).join("");
}

let botPrivKey = null;
let botPubKey = null;
let keypairError = null;

if (BOT_PRIVATE_KEY) {
  try {
    const raw = b58decode(BOT_PRIVATE_KEY);
    if (raw.length !== 64) {
      throw new Error("BOT_PRIVATE_KEY must decode to 64 bytes");
    }

    botPrivKey = raw.subarray(0, 32);
    botPubKey = raw.subarray(32, 64);
    console.log("Bot keypair loaded");
  } catch (e) {
    keypairError = e.message;
    console.error("Bot keypair configuration error:", e.message);
  }
} else {
  console.log("Bot keypair not configured; trading unavailable");
}

function signEd25519(message, privateKey) {
  const keyObj = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from([
        0x30, 0x2e, 0x02, 0x01, 0x00,
        0x30, 0x05, 0x06, 0x03, 0x2b,
        0x65, 0x70, 0x04, 0x22, 0x04, 0x20
      ]),
      privateKey
    ]),
    format: "der",
    type: "pkcs8"
  });

  return crypto.sign(null, message, keyObj);
}

const TOKENS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"
};

let autoTrading = false;
let autoInterval = null;
let tradeLog = [];
let tradeCount = 0;
let totalPnl = 0;
let lastBuyPrice = 0;

let autoConfig = {
  amount: 1000000,
  slippageBps: 50,
  intervalSecs: 60,
  takeProfitPct: 3,
  stopLossPct: 2,
  minConfidence: 75
};

const priceHistory = {
  SOL: [],
  ETH: [],
  BTC: []
};

function requestJson(url, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === null ? null : JSON.stringify(body);
    const h = { ...headers };

    if (data !== null) {
      h["Content-Type"] = "application/json";
      h["Content-Length"] = Buffer.byteLength(data);
    }

    if (JUP_API_KEY && u.hostname.includes("jup.ag")) {
      h["x-api-key"] = JUP_API_KEY;
    }

    const req = (u.protocol === "https:" ? https : http).request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: h
    }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => text += chunk);

      res.on("end", () => {
        let parsed;

        try {
          parsed = JSON.parse(text);
        } catch {
          return reject(
            new Error(`Invalid JSON response (HTTP ${res.statusCode})`)
          );
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(
            new Error(
              `HTTP ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 400)}`
            )
          );
        }

        resolve(parsed);
      });
    });

    req.setTimeout(12000, () => {
      req.destroy(new Error("Request timed out"));
    });

    req.on("error", reject);

    if (data !== null) req.write(data);
    req.end();
  });
}

const get = url => requestJson(url);
const postJson = (url, body) => requestJson(url, "POST", body);

function rpc(method, params = []) {
  const u = new URL(HELIUS_RPC);

  if (
    process.env.HELIUS_KEY &&
    !u.searchParams.has("api-key")
  ) {
    u.searchParams.set("api-key", process.env.HELIUS_KEY);
  }

  return postJson(u.toString(), {
    jsonrpc: "2.0",
    id: 1,
    method,
    params
  });
}

function binancePrice(sym) {
  return new Promise(resolve => {
    const url =
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(sym)}`;

    const req = https.get(url, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => data += chunk);

      res.on("end", () => {
        try {
          const x = JSON.parse(data);
          const usd = Number(x.lastPrice);

          if (
            res.statusCode !== 200 ||
            x.code ||
            !Number.isFinite(usd) ||
            usd <= 0
          ) {
            console.error(
              "Binance price error:",
              sym,
              res.statusCode,
              data.slice(0, 400)
            );
            return resolve(null);
          }

          const num = v =>
            Number.isFinite(Number(v)) ? Number(v) : null;

          resolve({
            usd,
            change24h: num(x.priceChangePercent),
            high24h: num(x.highPrice),
            low24h: num(x.lowPrice),
            volume24h: num(x.quoteVolume)
          });
        } catch (e) {
          console.error("Binance parse error:", sym, e.message);
          resolve(null);
        }
      });
    });

    req.setTimeout(10000, () => {
      req.destroy(new Error("Binance request timed out"));
    });

    req.on("error", e => {
      console.error("Binance request error:", sym, e.message);
      resolve(null);
    });
  });
}

function binanceKlines(sym, interval = "1h", limit = 60) {
  const intervals = new Set([
    "1m", "5m", "15m", "30m", "1h", "4h", "1d"
  ]);

  const iv = intervals.has(interval) ? interval : "1h";
  const lim = Math.max(1, Math.min(500, Number(limit) || 60));

  return new Promise(resolve => {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=${iv}&limit=${lim}`;

    const req = https.get(url, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => data += chunk);

      res.on("end", () => {
        try {
          const x = JSON.parse(data);

          if (res.statusCode !== 200 || !Array.isArray(x)) {
            console.error(
              "Binance klines error:",
              res.statusCode,
              data.slice(0, 300)
            );
            return resolve([]);
          }

          resolve(x.map(k => ({
            t: k[0],
            o: +k[1],
            h: +k[2],
            l: +k[3],
            c: +k[4],
            v: +k[5]
          })));
        } catch (e) {
          console.error("Klines parse error:", e.message);
          resolve([]);
        }
      });
    });

    req.setTimeout(10000, () => {
      req.destroy(new Error("Klines timed out"));
    });

    req.on("error", e => {
      console.error("Klines request error:", e.message);
      resolve([]);
    });
  });
}

function rsiCalc(p, n = 14) {
  if (p.length < n + 1) return 50;

  let g = 0;
  let l = 0;

  for (let i = 1; i <= n; i++) {
    const d = p[i] - p[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }

  g /= n;
  l /= n;

  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function maCalc(p, n) {
  if (p.length < n) return p[p.length - 1] || 0;
  return p.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function getSignal(sym) {
  const p = priceHistory[sym] || [];

  if (p.length < 5) {
    return {
      signal: "NEUTRAL",
      confidence: 40,
      score: 0,
      rsi: 50
    };
  }

  const r = rsiCalc(p);
  const ma7 = maCalc(p, Math.min(7, p.length));
  const ma20 = maCalc(p, Math.min(20, p.length));

  let score = 0;

  if (r < 25) score += 35;
  else if (r < 35) score += 20;
  else if (r < 45) score += 10;
  else if (r > 75) score -= 35;
  else if (r > 65) score -= 20;
  else if (r > 55) score -= 10;

  if (ma7 > ma20) score += 15;
  else score -= 15;

  if (p.length >= 6) {
    const recent = p.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const old = p.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;

    if (recent > old * 1.008) score += 15;
    else if (recent > old * 1.003) score += 8;
    else if (recent < old * 0.992) score -= 15;
    else if (recent < old * 0.997) score -= 8;
  }

  let signal = "NEUTRAL";
  let confidence = 40;

  if (score >= 35) {
    signal = "STRONG BUY";
    confidence = Math.min(95, 60 + score);
  } else if (score >= 18) {
    signal = "BUY";
    confidence = Math.min(80, 50 + score);
  } else if (score <= -35) {
    signal = "STRONG SELL";
    confidence = Math.min(95, 60 + Math.abs(score));
  } else if (score <= -18) {
    signal = "SELL";
    confidence = Math.min(80, 50 + Math.abs(score));
  }

  return {
    signal,
    confidence,
    score,
    rsi: Math.round(r),
    ma7,
    ma20
  };
}

async function executeSwap(
  inputMint,
  outputMint,
  amount,
  slippageBps = 50
) {
  if (!ENABLE_LIVE_TRADING) {
    throw new Error("Live trading disabled by configuration");
  }

  if (!botPrivKey || !botPubKey) {
    throw new Error("Bot keypair not configured");
  }

  const publicKey = b58encode(botPubKey);

  const quote = await get(
    `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
  );

  if (!quote || quote.error || !quote.outAmount) {
    throw new Error(
      "Jupiter quote failed: " + (quote?.error || "invalid quote")
    );
  }

  const swap = await postJson(
    "https://quote-api.jup.ag/v6/swap",
    {
      quoteResponse: quote,
      userPublicKey: publicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto"
    }
  );

  if (!swap.swapTransaction) {
    throw new Error("Jupiter returned no swap transaction");
  }

  const tx = Buffer.from(swap.swapTransaction, "base64");
  const signatureCount = tx[0] & 0x7f;
  const messageOffset = 1 + signatureCount * 64;

  if (tx.length <= messageOffset || signatureCount < 1) {
    throw new Error("Invalid swap transaction");
  }

  const sig = signEd25519(tx.subarray(messageOffset), botPrivKey);
  const signed = Buffer.from(tx);
  sig.copy(signed, 1, 0, 64);

  const sent = await rpc("sendTransaction", [
    signed.toString("base64"),
    {
      encoding: "base64",
      skipPreflight: false,
      maxRetries: 3
    }
  ]);

  if (sent.error || !sent.result) {
    throw new Error(
      "Transaction send failed: " + JSON.stringify(sent.error || sent)
    );
  }

  const signature = sent.result;
  let confirmed = false;

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));

    const status = await rpc("getSignatureStatuses", [[signature]]);
    const s = status?.result?.value?.[0];

    if (
      s &&
      (
        s.confirmationStatus === "confirmed" ||
        s.confirmationStatus === "finalized"
      )
    ) {
      confirmed = true;
      break;
    }

    if (s?.err) {
      throw new Error("Transaction failed: " + JSON.stringify(s.err));
    }
  }

  return {
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    confirmed,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct
  };
}

async function runAutoTrade() {
  if (!ENABLE_LIVE_TRADING || !botPrivKey || !botPubKey) {
    stopAuto();
    return;
  }

  try {
    const [sol, eth, btc] = await Promise.all([
      binancePrice("SOLUSDT"),
      binancePrice("ETHUSDT"),
      binancePrice("BTCUSDT")
    ]);

    if (!sol?.usd || !eth?.usd || !btc?.usd) {
      console.error("Trading loop paused: valid prices unavailable");
      return;
    }

    for (const [s, v] of [
      ["SOL", sol],
      ["ETH", eth],
      ["BTC", btc]
    ]) {
      priceHistory[s].push(v.usd);
      if (priceHistory[s].length > 100) priceHistory[s].shift();
    }

    const price = sol.usd;
    const sig = getSignal("SOL");

    const entry = {
      time: new Date().toISOString(),
      price,
      signal: sig.signal,
      confidence: sig.confidence,
      rsi: sig.rsi,
      action: "WATCHING"
    };

    if (lastBuyPrice > 0 && price > 0) {
      const pnlPct = (price - lastBuyPrice) / lastBuyPrice * 100;
      entry.pnlPct = +pnlPct.toFixed(3);

      if (
        pnlPct >= autoConfig.takeProfitPct ||
        pnlPct <= -autoConfig.stopLossPct
      ) {
        const label =
          pnlPct >= autoConfig.takeProfitPct
            ? "TAKE_PROFIT"
            : "STOP_LOSS";

        entry.action = label;

        try {
          const bal = await rpc("getBalance", [b58encode(botPubKey)]);
          const lamports = Math.floor((bal.result?.value || 0) * 0.92);

          if (lamports > 5000) {
            const result = await executeSwap(
              TOKENS.SOL,
              TOKENS.USDC,
              lamports,
              autoConfig.slippageBps
            );

            totalPnl += (pnlPct / 100) * autoConfig.amount / 1e6;

            Object.assign(entry, {
              action: label + "_DONE",
              signature: result.signature,
              explorerUrl: result.explorerUrl,
              type: "SELL"
            });

            lastBuyPrice = 0;
            tradeCount++;
          }
        } catch (e) {
          entry.action = label + "_FAILED";
          entry.error = e.message;
        }
      }
    }

    if (
      lastBuyPrice === 0 &&
      sig.signal === "STRONG BUY" &&
      sig.confidence >= autoConfig.minConfidence
    ) {
      entry.action = "BUYING";

      try {
        const result = await executeSwap(
          TOKENS.USDC,
          TOKENS.SOL,
          autoConfig.amount,
          autoConfig.slippageBps
        );

        lastBuyPrice = price;

        Object.assign(entry, {
          action: "BOUGHT",
          signature: result.signature,
          explorerUrl: result.explorerUrl,
          type: "BUY"
        });

        tradeCount++;
      } catch (e) {
        entry.action = "BUY_FAILED";
        entry.error = e.message;
      }
    }

    tradeLog.unshift(entry);
    tradeLog = tradeLog.slice(0, 200);

    console.log(
      `[BOT] $${price} | ${sig.signal} ${sig.confidence}% | ${entry.action}`
    );
  } catch (e) {
    console.error("[BOT ERROR]", e.message);
  }
}

function startAuto() {
  if (!ENABLE_LIVE_TRADING || !botPrivKey || !botPubKey) {
    return false;
  }

  if (autoInterval) clearInterval(autoInterval);

  autoTrading = true;
  runAutoTrade();

  autoInterval = setInterval(
    runAutoTrade,
    Math.max(15, Number(autoConfig.intervalSecs) || 60) * 1000
  );

  return true;
}

function stopAuto() {
  if (autoInterval) clearInterval(autoInterval);
  autoTrading = false;
  autoInterval = null;
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function out(res, data, status = 200) {
  cors(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  if (p === "/") {
    return out(res, {
      service: "Quantifesta API",
      status: "online",
      endpoints: [
        "/health",
        "/prices",
        "/klines",
        "/signal",
        "/account",
        "/trades"
      ]
    });
  }

  if (p === "/health") {
    return out(res, {
      ok: true,
      exchange: "Binance",
      botWallet: botPubKey ? b58encode(botPubKey) : "NOT CONFIGURED",
      keypairConfigured: Boolean(botPrivKey && botPubKey),
      keypairError: keypairError || undefined,
      liveTradingEnabled: ENABLE_LIVE_TRADING,
      autoTrading,
      tradeCount,
      totalPnl: +totalPnl.toFixed(4),
      lastBuyPrice,
      ts: new Date().toISOString()
    });
  }

  if (p === "/prices") {
    const [S, E, B] = await Promise.all([
      binancePrice("SOLUSDT"),
      binancePrice("ETHUSDT"),
      binancePrice("BTCUSDT")
    ]);

    const prices = {
      SOL: S,
      ETH: E,
      BTC: B
    };

    const valid = Object.values(prices).every(
      v => v && Number.isFinite(v.usd)
    );

    return out(res, {
      success: valid,
      prices,
      ...(valid
        ? {}
        : { error: "One or more price requests failed; check Render logs" }),
      ts: new Date().toISOString()
    }, valid ? 200 : 502);
  }

  if (p === "/klines") {
    const sym = (u.searchParams.get("symbol") || "SOLUSDT").toUpperCase();

    if (!/^[A-Z0-9]{5,20}$/.test(sym)) {
      return out(res, {
        success: false,
        error: "Invalid symbol"
      }, 400);
    }

    const candles = await binanceKlines(
      sym,
      u.searchParams.get("interval") || "1h",
      Number(u.searchParams.get("limit") || 60)
    );

    return out(res, {
      success: candles.length > 0,
      candles
    });
  }

  if (p === "/signal") {
    return out(res, {
      success: true,
      ...getSignal((u.searchParams.get("symbol") || "SOL").toUpperCase())
    });
  }

  if (p === "/account") {
    const wallet =
      u.searchParams.get("wallet") ||
      (botPubKey ? b58encode(botPubKey) : null);

    if (!wallet) {
      return out(res, {
        success: false,
        error: "Pass ?wallet=PUBLIC_ADDRESS"
      }, 400);
    }

    try {
      const r = await rpc("getBalance", [wallet]);

      if (r.error) {
        throw new Error(r.error.message || "RPC error");
      }

      const bal = (r.result?.value || 0) / 1e9;

      return out(res, {
        success: true,
        balances: [{
          asset: "SOL",
          free: bal,
          locked: 0,
          total: bal
        }],
        wallet
      });
    } catch (e) {
      return out(res, {
        success: false,
        error: e.message
      }, 502);
    }
  }

  if (p === "/auto/start") {
    if (!ENABLE_LIVE_TRADING) {
      return out(res, {
        success: false,
        error: "Live trading is disabled by configuration"
      }, 403);
    }

    if (!botPrivKey || !botPubKey) {
      return out(res, {
        success: false,
        error: "BOT_PRIVATE_KEY is not configured correctly"
      }, 503);
    }

    const startWithBody = () => {
      const started = startAuto();

      return out(res, {
        success: started,
        message: started
          ? "Auto-trading started"
          : "Auto-trading could not start",
        config: autoConfig
      });
    };

    if (req.method === "POST") {
      let body = "";

      req.on("data", c => {
        body += c;
        if (body.length > 10000) req.destroy();
      });

      req.on("end", () => {
        try {
          const cfg = JSON.parse(body || "{}");

          if (Number.isFinite(Number(cfg.amount)) && Number(cfg.amount) > 0) {
            autoConfig.amount = Number(cfg.amount);
          }

          if (Number.isFinite(Number(cfg.slippageBps))) {
            autoConfig.slippageBps = Math.max(
              1,
              Math.min(300, Number(cfg.slippageBps))
            );
          }

          if (Number.isFinite(Number(cfg.intervalSecs))) {
            autoConfig.intervalSecs = Math.max(
              15,
              Math.min(3600, Number(cfg.intervalSecs))
            );
          }

          if (Number.isFinite(Number(cfg.takeProfitPct))) {
            autoConfig.takeProfitPct = Math.max(
              0.1,
              Number(cfg.takeProfitPct)
            );
          }

          if (Number.isFinite(Number(cfg.stopLossPct))) {
            autoConfig.stopLossPct = Math.max(
              0.1,
              Number(cfg.stopLossPct)
            );
          }

          if (Number.isFinite(Number(cfg.minConfidence))) {
            autoConfig.minConfidence = Math.max(
              1,
              Math.min(100, Number(cfg.minConfidence))
            );
          }
        } catch {
          return out(res, {
            success: false,
            error: "Invalid JSON config"
          }, 400);
        }

        return startWithBody();
      });
    } else {
      return startWithBody();
    }

    return;
  }

  if (p === "/auto/stop") {
    stopAuto();

    return out(res, {
      success: true,
      message: "STOPPED",
      tradeCount,
      totalPnl
    });
  }

  if (p === "/auto/status") {
    return out(res, {
      success: true,
      autoTrading,
      liveTradingEnabled: ENABLE_LIVE_TRADING,
      config: autoConfig,
      tradeCount,
      totalPnl: +totalPnl.toFixed(4),
      lastBuyPrice,
      log: tradeLog.slice(0, 30),
      signals: {
        SOL: getSignal("SOL"),
        ETH: getSignal("ETH"),
        BTC: getSignal("BTC")
      },
      botWallet: botPubKey ? b58encode(botPubKey) : "NOT CONFIGURED"
    });
  }

  if (p === "/auto/log") {
    return out(res, {
      success: true,
      log: tradeLog
    });
  }

  if (p === "/trades") {
    return out(res, {
      success: true,
      trades: tradeLog.filter(t => t.type),
      tradeCount,
      totalPnl
    });
  }

  return out(res, {
    error: "Not found",
    path: p
  }, 404);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Quantifesta API listening on port ${PORT}`);
});
