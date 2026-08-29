// ╔══════════════════════════════════════════════════════════╗
// ║  QUANTIFESTA — Railway Backend Server                   ║
// ║  Secure Binance API integration                         ║
// ║  Deploy this to Railway as server.js                    ║
// ╚══════════════════════════════════════════════════════════╝

const http = require("http");
const crypto = require("crypto");
const https = require("https");
const url = require("url");

const PORT = process.env.PORT || 3000;
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || "";
const BINANCE_SECRET = process.env.BINANCE_SECRET || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const BINANCE_BASE = "https://api.binance.com";

// ── HMAC-SHA256 signature (required by Binance for private endpoints) ──
function sign(queryString) {
  return crypto
    .createHmac("sha256", BINANCE_SECRET)
    .update(queryString)
    .digest("hex");
}

// ── Make a signed Binance API request ──────────────────────
function binanceRequest(path, params, method) {
  method = method || "GET";
  const timestamp = Date.now();
  const paramStr = Object.entries(Object.assign({}, params, { timestamp }))
    .map(function(e) { return e[0] + "=" + e[1]; })
    .join("&");
  const signature = sign(paramStr);
  const fullQuery = paramStr + "&signature=" + signature;
  const fullPath = path + "?" + fullQuery;

  return new Promise(function(resolve, reject) {
    const options = {
      hostname: "api.binance.com",
      path: fullPath,
      method: method,
      headers: {
        "X-MBX-APIKEY": BINANCE_API_KEY,
        "Content-Type": "application/json",
      },
    };
    const req = https.request(options, function(res) {
      let data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Invalid JSON: " + data)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Public Binance request (no signature needed) ───────────
function binancePublic(path, params) {
  const query = params ? "?" + Object.entries(params).map(function(e) { return e[0] + "=" + e[1]; }).join("&") : "";
  return new Promise(function(resolve, reject) {
    https.get("https://api.binance.com" + path + query, {
      headers: { "X-MBX-APIKEY": BINANCE_API_KEY }
    }, function(res) {
      let data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Invalid JSON")); }
      });
    }).on("error", reject);
  });
}

// ── CORS headers ────────────────────────────────────────────
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ── Send JSON response ──────────────────────────────────────
function sendJSON(res, data, status) {
  res.writeHead(status || 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── Route handlers ──────────────────────────────────────────

// GET /health — check server is alive
async function handleHealth(res) {
  sendJSON(res, {
    status: "ok",
    service: "Quantifesta API",
    timestamp: new Date().toISOString(),
    binance: BINANCE_API_KEY ? "configured" : "missing",
  });
}

// GET /prices — real prices from Binance
async function handlePrices(res) {
  try {
    const symbols = ["SOLUSDT", "ETHUSDT", "BTCUSDT"];
    const results = await Promise.all(
      symbols.map(function(s) {
        return binancePublic("/api/v3/ticker/24hr", { symbol: s });
      })
    );
    const prices = {};
    results.forEach(function(r) {
      const sym = r.symbol.replace("USDT", "");
      prices[sym] = {
        usd: parseFloat(r.lastPrice),
        change24h: parseFloat(r.priceChangePercent),
        high24h: parseFloat(r.highPrice),
        low24h: parseFloat(r.lowPrice),
        volume24h: parseFloat(r.quoteVolume),
        bidPrice: parseFloat(r.bidPrice),
        askPrice: parseFloat(r.askPrice),
        lastUpdate: new Date().toISOString(),
      };
    });
    sendJSON(res, { success: true, prices });
  } catch(e) {
    sendJSON(res, { success: false, error: e.message }, 500);
  }
}

// GET /account — real Binance account balances
async function handleAccount(res) {
  try {
    const account = await binanceRequest("/api/v3/account", {});
    const balances = account.balances
      .filter(function(b) { return parseFloat(b.free) > 0 || parseFloat(b.locked) > 0; })
      .map(function(b) {
        return {
          asset: b.asset,
          free: parseFloat(b.free),
          locked: parseFloat(b.locked),
          total: parseFloat(b.free) + parseFloat(b.locked),
        };
      });
    sendJSON(res, {
      success: true,
      balances,
      canTrade: account.canTrade,
      accountType: account.accountType,
      permissions: account.permissions,
    });
  } catch(e) {
    sendJSON(res, { success: false, error: e.message }, 500);
  }
}

// GET /orderbook?symbol=SOLUSDT — real order book
async function handleOrderbook(res, query) {
  try {
    const symbol = query.symbol || "SOLUSDT";
    const data = await binancePublic("/api/v3/depth", { symbol, limit: 10 });
    sendJSON(res, {
      success: true,
      symbol,
      bids: data.bids.map(function(b) { return { price: parseFloat(b[0]), qty: parseFloat(b[1]) }; }),
      asks: data.asks.map(function(a) { return { price: parseFloat(a[0]), qty: parseFloat(a[1]) }; }),
    });
  } catch(e) {
    sendJSON(res, { success: false, error: e.message }, 500);
  }
}

// GET /klines?symbol=SOLUSDT&interval=1h — candlestick data
async function handleKlines(res, query) {
  try {
    const symbol = query.symbol || "SOLUSDT";
    const interval = query.interval || "1h";
    const limit = query.limit || 48;
    const data = await binancePublic("/api/v3/klines", { symbol, interval, limit });
    const candles = data.map(function(k) {
      return {
        t: k[0],
        o: parseFloat(k[1]),
        h: parseFloat(k[2]),
        l: parseFloat(k[3]),
        c: parseFloat(k[4]),
        v: parseFloat(k[5]),
      };
    });
    sendJSON(res, { success: true, symbol, interval, candles });
  } catch(e) {
    sendJSON(res, { success: false, error: e.message }, 500);
  }
}

// POST /order — place a real spot order
async function handleOrder(req, res) {
  let body = "";
  req.on("data", function(chunk) { body += chunk; });
  req.on("end", async function() {
    try {
      const params = JSON.parse(body);
      // Safety checks
      if (!params.symbol) return sendJSON(res, { success: false, error: "symbol required" }, 400);
      if (!params.side) return sendJSON(res, { success: false, error: "side required (BUY/SELL)" }, 400);
      if (!params.quantity) return sendJSON(res, { success: false, error: "quantity required" }, 400);

      const orderParams = {
        symbol: params.symbol,           // e.g. SOLUSDT
        side: params.side,               // BUY or SELL
        type: params.type || "MARKET",   // MARKET or LIMIT
        quantity: params.quantity,       // amount to trade
      };

      // Add price for LIMIT orders
      if (params.type === "LIMIT" && params.price) {
        orderParams.price = params.price;
        orderParams.timeInForce = "GTC";
      }

      const order = await binanceRequest("/api/v3/order", orderParams, "POST");
      sendJSON(res, {
        success: true,
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.side,
        status: order.status,
        executedQty: order.executedQty,
        cummulativeQuoteQty: order.cummulativeQuoteQty,
        fills: order.fills,
      });
    } catch(e) {
      sendJSON(res, { success: false, error: e.message }, 500);
    }
  });
}

// GET /trades?symbol=SOLUSDT — recent trade history
async function handleTrades(res, query) {
  try {
    const symbol = query.symbol || "SOLUSDT";
    const data = await binanceRequest("/api/v3/myTrades", { symbol, limit: 20 });
    const trades = data.map(function(t) {
      return {
        id: t.id,
        symbol: t.symbol,
        side: t.isBuyer ? "BUY" : "SELL",
        price: parseFloat(t.price),
        qty: parseFloat(t.qty),
        total: parseFloat(t.quoteQty),
        commission: parseFloat(t.commission),
        commissionAsset: t.commissionAsset,
        time: new Date(t.time).toISOString(),
      };
    });
    sendJSON(res, { success: true, trades });
  } catch(e) {
    sendJSON(res, { success: false, error: e.message }, 500);
  }
}

// ── Main server ─────────────────────────────────────────────
const server = http.createServer(async function(req, res) {
  setCORS(res);

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const query = parsed.query;

  console.log(req.method + " " + path);

  try {
    if (path === "/health" && req.method === "GET") return await handleHealth(res);
    if (path === "/prices" && req.method === "GET") return await handlePrices(res);
    if (path === "/account" && req.method === "GET") return await handleAccount(res);
    if (path === "/orderbook" && req.method === "GET") return await handleOrderbook(res, query);
    if (path === "/klines" && req.method === "GET") return await handleKlines(res, query);
    if (path === "/trades" && req.method === "GET") return await handleTrades(res, query);
    if (path === "/order" && req.method === "POST") return await handleOrder(req, res);

    sendJSON(res, {
      service: "Quantifesta API",
      version: "1.0.0",
      endpoints: ["/health", "/prices", "/account", "/orderbook", "/klines", "/trades", "/order"],
    }, 404);
  } catch(e) {
    console.error(e);
    sendJSON(res, { success: false, error: "Server error: " + e.message }, 500);
  }
});

server.listen(PORT, function() {
  console.log("Quantifesta API server running on port " + PORT);
  console.log("Binance API: " + (BINANCE_API_KEY ? "configured ✓" : "MISSING ✗"));
  console.log("Endpoints: /health /prices /account /orderbook /klines /trades /order");
});
