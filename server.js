const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const CB_API_KEY = process.env.COINBASE_API_KEY || "";
const CB_SECRET = process.env.COINBASE_SECRET || "";

// ── Coinbase Advanced Trade API helper ──────────────────────
function cbRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyStr = body ? JSON.stringify(body) : "";
    const message = timestamp + method + path + bodyStr;
    const signature = crypto
      .createHmac("sha256", CB_SECRET)
      .update(message)
      .digest("hex");

    const options = {
      hostname: "api.coinbase.com",
      path: path,
      method: method,
      headers: {
        "Content-Type": "application/json",
        "CB-ACCESS-KEY": CB_API_KEY,
        "CB-ACCESS-SIGN": signature,
        "CB-ACCESS-TIMESTAMP": timestamp,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: data }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Binance public price (no auth needed) ───────────────────
function binancePrice(symbol) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const d = JSON.parse(data);
            resolve({
              usd: parseFloat(d.lastPrice),
              change24h: parseFloat(d.priceChangePercent),
              high24h: parseFloat(d.highPrice),
              low24h: parseFloat(d.lowPrice),
              volume24h: parseFloat(d.quoteVolume),
            });
          } catch { resolve(null); }
        });
      }
    );
    req.on("error", () => resolve(null));
  });
}

function binanceKlines(symbol, interval = "1h", limit = 60) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const raw = JSON.parse(data);
            resolve(raw.map((k) => ({
              t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]),
              l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
            })));
          } catch { resolve([]); }
        });
      }
    );
    req.on("error", () => resolve([]));
  });
}

// ── CORS helper ─────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── Server ───────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost`);
  const path = url.pathname;

  // Health
  if (path === "/health") {
    return json(res, { success: true, exchange: "coinbase", status: "live", ts: new Date().toISOString() });
  }

  // Prices (Binance public — no auth needed)
  if (path === "/prices") {
    try {
      const [SOL, ETH, BTC] = await Promise.all([
        binancePrice("SOLUSDT"),
        binancePrice("ETHUSDT"),
        binancePrice("BTCUSDT"),
      ]);
      return json(res, { success: true, prices: { SOL, ETH, BTC } });
    } catch (e) {
      return json(res, { success: false, error: e.message });
    }
  }

  // Klines (Binance public)
  if (path === "/klines") {
    const symbol = url.searchParams.get("symbol") || "SOLUSDT";
    const interval = url.searchParams.get("interval") || "1h";
    const limit = parseInt(url.searchParams.get("limit") || "60");
    const candles = await binanceKlines(symbol, interval, limit);
    return json(res, { success: true, candles });
  }

  // Account (Coinbase)
  if (path === "/account") {
    try {
      const data = await cbRequest("GET", "/api/v3/brokerage/accounts");
      if (data.accounts) {
        const balances = data.accounts
          .filter((a) => parseFloat(a.available_balance?.value || 0) > 0)
          .map((a) => ({
            asset: a.currency,
            free: parseFloat(a.available_balance?.value || 0),
            locked: parseFloat(a.hold?.value || 0),
            total: parseFloat(a.available_balance?.value || 0) + parseFloat(a.hold?.value || 0),
          }));
        return json(res, { success: true, balances, exchange: "coinbase" });
      }
      return json(res, { success: false, error: "No accounts found", raw: data });
    } catch (e) {
      return json(res, { success: false, error: e.message });
    }
  }

  // Place order (Coinbase)
  if (path === "/order" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { symbol, side, quantity, type, price } = JSON.parse(body);
        // Convert SOLUSDT → SOL-USDT for Coinbase
        const productId = symbol.replace("USDT", "-USDT");
        const clientOrderId = `qf-${Date.now()}`;

        const orderConfig = type === "LIMIT"
          ? { limit_limit_gtc: { base_size: String(quantity), limit_price: String(price), post_only: false } }
          : { market_market_ioc: { base_size: String(quantity) } };

        const payload = {
          client_order_id: clientOrderId,
          product_id: productId,
          side: side === "BUY" ? "BUY" : "SELL",
          order_configuration: orderConfig,
        };

        const result = await cbRequest("POST", "/api/v3/brokerage/orders", payload);

        if (result.success) {
          return json(res, {
            success: true,
            orderId: result.order_id || clientOrderId,
            status: result.order?.status || "FILLED",
            executedQty: String(quantity),
            cummulativeQuoteQty: String(quantity * (price || 0)),
            exchange: "coinbase",
          });
        }
        return json(res, { success: false, error: result.error_response?.message || result.error || JSON.stringify(result) });
      } catch (e) {
        return json(res, { success: false, error: e.message });
      }
    });
    return;
  }

  // Trades history (Coinbase)
  if (path === "/trades") {
    try {
      const symbol = url.searchParams.get("symbol") || "SOLUSDT";
      const productId = symbol.replace("USDT", "-USDT");
      const data = await cbRequest("GET", `/api/v3/brokerage/orders/historical/fills?product_id=${productId}&limit=20`);
      if (data.fills) {
        const trades = data.fills.map((f) => ({
          id: f.trade_id,
          time: new Date(f.trade_time).getTime(),
          side: f.side,
          price: parseFloat(f.price),
          qty: parseFloat(f.size),
          total: parseFloat(f.price) * parseFloat(f.size),
        }));
        return json(res, { success: true, trades });
      }
      return json(res, { success: true, trades: [] });
    } catch (e) {
      return json(res, { success: false, error: e.message });
    }
  }

  json(res, { error: "Not found" }, 404);
});

server.listen(PORT, () => console.log(`Quantifesta API (Coinbase) running on port ${PORT}`));
