
const http = require("http");
const https = require("https");

const PORT = Number(process.env.PORT) || 3000;
const HELIUS_RPC = process.env.HELIUS_RPC || "https://mainnet.helius-rpc.com/";
const HELIUS_KEY = process.env.HELIUS_KEY || "";
const ENABLE_LIVE_TRADING = process.env.ENABLE_LIVE_TRADING === "true";

// Live trading stays disabled unless explicitly configured.
// This version provides market data and monitoring, not live swap execution.
let autoTrading = false;
let tradeLog = [];
let tradeCount = 0;
let totalPnl = 0;

const priceHistory = { SOL: [], ETH: [], BTC: [] };

function requestJson(url, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === null ? null : JSON.stringify(body);
    const headers = { Accept: "application/json" };

    if (data !== null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }

    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers
    }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => text += chunk);
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          return reject(new Error(`Invalid JSON (HTTP ${res.statusCode})`));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(
            `HTTP ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`
          ));
        }
        resolve(parsed);
      });
    });

    req.setTimeout(12000, () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

async function rpc(method, params = []) {
  const u = new URL(HELIUS_RPC);
  if (HELIUS_KEY && !u.searchParams.has("api-key")) {
    u.searchParams.set("api-key", HELIUS_KEY);
  }
  return requestJson(u.toString(), "POST", {
    jsonrpc: "2.0",
    id: 1,
    method,
    params
  });
}

// Coinbase public market data; no API key required.
async function coinbasePrice(productId) {
  try {
    const data = await requestJson(
      `https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(productId)}`
    );

    const usd = Number(data.price);
    if (!Number.isFinite(usd) || usd <= 0) {
      throw new Error("Coinbase returned an invalid price");
    }

    const numberOrNull = value => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    return {
      usd,
      change24h: numberOrNull(data.price_percentage_change_24h),
      high24h: numberOrNull(data.high_24h),
      low24h: numberOrNull(data.low_24h),
      volume24h: numberOrNull(data.approximate_quote_24h_volume)
    };
  } catch (error) {
    console.error("Coinbase price error:", productId, error.message);
    return null;
  }
}

function productForSymbol(symbol) {
  const s = String(symbol || "SOLUSDT").toUpperCase().replace(/[^A-Z0-9-]/g, "");
  const base = s.split("-")[0].replace(/USDT$/, "").replace(/USD$/, "");

  if (["SOL", "ETH", "BTC"].includes(base)) return `${base}-USD`;
  return null;
}

function coinbaseGranularity(interval) {
  const map = {
    "1m": "ONE_MINUTE",
    "5m": "FIVE_MINUTE",
    "15m": "FIFTEEN_MINUTE",
    "30m": "THIRTY_MINUTE",
    "1h": "ONE_HOUR",
    "2h": "TWO_HOUR",
    "4h": "FOUR_HOUR",
    "6h": "SIX_HOUR",
    "1d": "ONE_DAY"
  };
  return map[interval] || "ONE_HOUR";
}

async function coinbaseKlines(symbol, interval = "1h", limit = 60) {
  const productId = productForSymbol(symbol);
  if (!productId) throw new Error("Unsupported symbol. Use SOL, ETH or BTC.");

  const allowedLimits = Math.max(1, Math.min(300, Number(limit) || 60));
  const secondsByInterval = {
    "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600,
    "1d": 86400
  };
  const step = secondsByInterval[interval] || 3600;
  const end = Math.floor(Date.now() / 1000);
  const start = end - step * allowedLimits;

  const params = new URLSearchParams({
    start: String(start),
    end: String(end),
    granularity: coinbaseGranularity(interval)
  });

  const data = await requestJson(
    `https://api.coinbase.com/api/v3/brokerage/market/products/${productId}/candles?${params}`
  );

  if (!Array.isArray(data.candles)) {
    throw new Error("Unexpected Coinbase candle response");
  }

  return data.candles.map(c => ({
    t: Number(c.start) * 1000,
    o: Number(c.open),
    h: Number(c.high),
    l: Number(c.low),
    c: Number(c.close),
    v: Number(c.volume)
  })).filter(c =>
    Number.isFinite(c.t) &&
    Number.isFinite(c.o) &&
    Number.isFinite(c.h) &&
    Number.isFinite(c.l) &&
    Number.isFinite(c.c)
  ).sort((a, b) => a.t - b.t);
}

function rsiCalc(prices, period = 14) {
  if (prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function getSignal(symbol) {
  const prices = priceHistory[symbol] || [];
  if (prices.length < 5) {
    return { signal: "NEUTRAL", confidence: 40, score: 0, rsi: 50 };
  }

  const rsi = rsiCalc(prices);
  const last = prices[prices.length - 1];
  const recent = prices.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const older = prices.slice(-10, -5);

  let score = 0;
  if (rsi < 30) score += 25;
  else if (rsi < 40) score += 10;
  else if (rsi > 70) score -= 25;
  else if (rsi > 60) score -= 10;

  if (older.length) {
    const oldAverage = older.reduce((a, b) => a + b, 0) / older.length;
    if (recent > oldAverage) score += 15;
    else if (recent < oldAverage) score -= 15;
  }

  let signal = "NEUTRAL";
  let confidence = 40;
  if (score >= 30) {
    signal = "BUY";
    confidence = Math.min(85, 50 + score);
  } else if (score <= -30) {
    signal = "SELL";
    confidence = Math.min(85, 50 + Math.abs(score));
  }

  return {
    signal,
    confidence,
    score,
    rsi: Math.round(rsi),
    price: last
  };
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

async function getPrices() {
  const [SOL, ETH, BTC] = await Promise.all([
    coinbasePrice("SOL-USD"),
    coinbasePrice("ETH-USD"),
    coinbasePrice("BTC-USD")
  ]);

  for (const [symbol, value] of [["SOL", SOL], ["ETH", ETH], ["BTC", BTC]]) {
    if (value && Number.isFinite(value.usd)) {
      priceHistory[symbol].push(value.usd);
      if (priceHistory[symbol].length > 100) priceHistory[symbol].shift();
    }
  }

  return { SOL, ETH, BTC };
}

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  try {
    if (path === "/") {
      return out(res, {
        service: "Quantifesta API",
        status: "online",
        exchange: "Coinbase",
        endpoints: [
          "/health", "/prices", "/klines", "/signal",
          "/account", "/trades", "/auto/start",
          "/auto/stop", "/auto/status", "/auto/log"
        ]
      });
    }

    if (path === "/health") {
      return out(res, {
        ok: true,
        exchange: "Coinbase",
        liveTradingEnabled: ENABLE_LIVE_TRADING,
        autoTrading,
        tradeCount,
        totalPnl: Number(totalPnl.toFixed(4)),
        ts: new Date().toISOString()
      });
    }

    if (path === "/prices") {
      const prices = await getPrices();
      const success = Object.values(prices).every(
        p => p && Number.isFinite(p.usd) && p.usd > 0
      );

      return out(res, {
        success,
        prices,
        ...(success ? {} : {
          error: "Coinbase price request failed; check Render logs"
        }),
        ts: new Date().toISOString()
      }, success ? 200 : 502);
    }

    if (path === "/klines") {
      const symbol = url.searchParams.get("symbol") || "SOLUSDT";
      const interval = url.searchParams.get("interval") || "1h";
      const limit = Number(url.searchParams.get("limit") || 60);
      const candles = await coinbaseKlines(symbol, interval, limit);
      return out(res, { success: candles.length > 0, candles });
    }

    if (path === "/signal") {
      const symbol = (url.searchParams.get("symbol") || "SOL").toUpperCase();
      if (!priceHistory[symbol]) {
        return out(res, { success: false, error: "Unsupported symbol" }, 400);
      }
      return out(res, { success: true, ...getSignal(symbol) });
    }

    if (path === "/account") {
      const wallet = url.searchParams.get("wallet");
      if (!wallet) {
        return out(res, {
          success: false,
          error: "Pass ?wallet=YOUR_PUBLIC_SOLANA_ADDRESS"
        }, 400);
      }

      const result = await rpc("getBalance", [wallet]);
      if (result.error) throw new Error(result.error.message || "RPC error");

      const balance = Number(result.result?.value || 0) / 1e9;
      return out(res, {
        success: true,
        wallet,
        balances: [{
          asset: "SOL",
          free: balance,
          locked: 0,
          total: balance
        }]
      });
    }

    if (path === "/auto/start") {
      // This server version does not execute swaps.
      autoTrading = false;
      return out(res, {
        success: false,
        autoTrading: false,
        error: "Live trading is not implemented in this Coinbase market-data version. No trades were placed."
      }, 403);
    }

    if (path === "/auto/stop") {
      autoTrading = false;
      return out(res, { success: true, autoTrading: false });
    }

    if (path === "/auto/status") {
      return out(res, {
        success: true,
        autoTrading: false,
        liveTradingEnabled: ENABLE_LIVE_TRADING,
        mode: "market-data-only"
      });
    }

    if (path === "/auto/log" || path === "/trades") {
      return out(res, {
        success: true,
        trades: tradeLog,
        logs: tradeLog,
        tradeCount,
        totalPnl
      });
    }

    return out(res, { success: false, error: "Endpoint not found" }, 404);
  } catch (error) {
    console.error("API error:", path, error.message);
    return out(res, {
      success: false,
      error: error.message,
      ts: new Date().toISOString()
    }, 502);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Quantifesta API running on port ${PORT}`);
  console.log("Market data provider: Coinbase");
  console.log("Live swap execution is not enabled in this version.");
});
