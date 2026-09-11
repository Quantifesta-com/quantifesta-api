const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const CB_KEY_ID = process.env.COINBASE_API_KEY || "";
const RAW_SECRET = process.env.COINBASE_SECRET || "";

function buildPrivateKey() {
  const buf = Buffer.from(RAW_SECRET, "base64");
  try { return crypto.createPrivateKey({ key: buf, format: "der", type: "pkcs8" }); } catch {}
  try { return crypto.createPrivateKey({ key: buf, format: "der", type: "sec1" }); } catch {}
  const priv = buf.slice(0, 32);
  const der = Buffer.concat([Buffer.from([0x30,0x41,0x02,0x01,0x00,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x04,0x27,0x30,0x25,0x02,0x01,0x01,0x04,0x20]), priv]);
  try { return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" }); } catch {}
  const priv2 = buf.slice(buf.length - 32);
  const der2 = Buffer.concat([Buffer.from([0x30,0x41,0x02,0x01,0x00,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x04,0x27,0x30,0x25,0x02,0x01,0x01,0x04,0x20]), priv2]);
  try { return crypto.createPrivateKey({ key: der2, format: "der", type: "pkcs8" }); } catch {}
  return null;
}

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}

function makeJWT(method, path) {
  const privateKey = buildPrivateKey();
  if (!privateKey) throw new Error("Cannot parse private key");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg:"ES256", kid:CB_KEY_ID, nonce:crypto.randomBytes(16).toString("hex") };
  const payload = { iss:"cdp", nbf:now, exp:now+120, sub:CB_KEY_ID, uri:`${method} api.coinbase.com${path}` };
  const toSign = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
  const sig = crypto.sign("SHA256", Buffer.from(toSign), { key:privateKey, dsaEncoding:"ieee-p1363" });
  return `${toSign}.${base64url(sig)}`;
}

function makeHMACHeaders(method, path, body="") {
  const timestamp = Math.floor(Date.now()/1000).toString();
  const message = timestamp + method + path + body;
  const secret = Buffer.from(RAW_SECRET, "base64");
  const sig = crypto.createHmac("sha256", secret).update(message).digest("base64");
  return { "CB-ACCESS-KEY":CB_KEY_ID, "CB-ACCESS-SIGN":sig, "CB-ACCESS-TIMESTAMP":timestamp };
}

function cbRequest(method, path, body=null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : "";
    let headers = { "Content-Type":"application/json", "Content-Length":Buffer.byteLength(bodyStr) };
    try {
      const token = makeJWT(method, path);
      headers["Authorization"] = `Bearer ${token}`;
    } catch(e) {
      Object.assign(headers, makeHMACHeaders(method, path, bodyStr));
    }
    const options = { hostname:"api.coinbase.com", path, method, headers };
    const req = https.request(options, (res) => {
      let data=""; res.on("data",(c)=>(data+=c));
      res.on("end",()=>{ try{resolve(JSON.parse(data));}catch{resolve({error:data});} });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function binancePrice(symbol) {
  return new Promise((resolve) => {
    https.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,(res)=>{
      let data=""; res.on("data",(c)=>(data+=c));
      res.on("end",()=>{
        try{const d=JSON.parse(data);resolve({usd:parseFloat(d.lastPrice),change24h:parseFloat(d.priceChangePercent),high24h:parseFloat(d.highPrice),low24h:parseFloat(d.lowPrice),volume24h:parseFloat(d.quoteVolume)});}
        catch{resolve(null);}
      });
    }).on("error",()=>resolve(null));
  });
}

function binanceKlines(symbol,interval="1h",limit=60) {
  return new Promise((resolve) => {
    https.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,(res)=>{
      let data=""; res.on("data",(c)=>(data+=c));
      res.on("end",()=>{try{resolve(JSON.parse(data).map((k)=>({t:k[0],o:parseFloat(k[1]),h:parseFloat(k[2]),l:parseFloat(k[3]),c:parseFloat(k[4]),v:parseFloat(k[5])})));}catch{resolve([]);}});
    }).on("error",()=>resolve([]));
  });
}

function cors(res){res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");}
function json(res,data,status=200){cors(res);res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(data));}

http.createServer(async(req,res)=>{
  if(req.method==="OPTIONS"){cors(res);res.writeHead(204);res.end();return;}
  const url=new URL(req.url,"http://localhost");
  const path=url.pathname;

  if(path==="/health") return json(res,{success:true,exchange:"coinbase",status:"live",ts:new Date().toISOString()});

  if(path==="/prices"){
    try{const[SOL,ETH,BTC]=await Promise.all([binancePrice("SOLUSDT"),binancePrice("ETHUSDT"),binancePrice("BTCUSDT")]);
      return json(res,{success:true,prices:{SOL,ETH,BTC}});}
    catch(e){return json(res,{success:false,error:e.message});}
  }

  if(path==="/klines"){
    const symbol=url.searchParams.get("symbol")||"SOLUSDT";
    const candles=await binanceKlines(symbol,url.searchParams.get("interval")||"1h",parseInt(url.searchParams.get("limit")||"60"));
    return json(res,{success:true,candles});
  }

  if(path==="/account"){
    try{
      const data=await cbRequest("GET","/api/v3/brokerage/accounts");
      if(data.accounts){
        const balances=data.accounts
          .filter((a)=>parseFloat(a.available_balance?.value||0)>0||parseFloat(a.hold?.value||0)>0)
          .map((a)=>({asset:a.currency,free:parseFloat(a.available_balance?.value||0),locked:parseFloat(a.hold?.value||0),total:parseFloat(a.available_balance?.value||0)+parseFloat(a.hold?.value||0)}));
        return json(res,{success:true,balances,exchange:"coinbase"});
      }
      return json(res,{success:false,error:"Auth failed",raw:data});
    }catch(e){return json(res,{success:false,error:e.message});}
  }

  if(path==="/order"&&req.method==="POST"){
    let body=""; req.on("data",(c)=>(body+=c));
    req.on("end",async()=>{
      try{
        const{symbol,side,quantity,type,price}=JSON.parse(body);
        const productId=symbol.replace("USDT","-USDT");
        const clientOrderId=`qf-${Date.now()}`;
        const orderConfig=type==="LIMIT"
          ?{limit_limit_gtc:{base_size:String(quantity),limit_price:String(price),post_only:false}}
          :{market_market_ioc:{base_size:String(quantity)}};
        const result=await cbRequest("POST","/api/v3/brokerage/orders",{
          client_order_id:clientOrderId,product_id:productId,
          side:side==="BUY"?"BUY":"SELL",order_configuration:orderConfig});
        if(result.success) return json(res,{success:true,orderId:result.order_id||clientOrderId,status:"FILLED",executedQty:String(quantity),cummulativeQuoteQty:"0",exchange:"coinbase"});
        return json(res,{success:false,error:result.error_response?.message||result.error||JSON.stringify(result)});
      }catch(e){return json(res,{success:false,error:e.message});}
    });
    return;
  }

  if(path==="/trades"){
    try{
      const symbol=url.searchParams.get("symbol")||"SOLUSDT";
      const productId=symbol.replace("USDT","-USDT");
      const data=await cbRequest("GET",`/api/v3/brokerage/orders/historical/fills?product_id=${productId}&limit=20`);
      const trades=(data.fills||[]).map((f)=>({id:f.trade_id,time:new Date(f.trade_time).getTime(),side:f.side,price:parseFloat(f.price),qty:parseFloat(f.size),total:parseFloat(f.price)*parseFloat(f.size)}));
      return json(res,{success:true,trades});
    }catch(e){return json(res,{success:false,error:e.message});}
  }

  json(res,{error:"Not found"},404);
}).listen(PORT,()=>console.log(`Quantifesta API (Coinbase) on port ${PORT}`));
