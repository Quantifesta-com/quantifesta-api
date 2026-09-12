const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const CB_KEY_NAME = process.env.COINBASE_API_KEY || "";
const RAW_SECRET = process.env.COINBASE_SECRET || "";

function makeJWT(method, path) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg:"ES256", kid:CB_KEY_NAME, nonce:crypto.randomBytes(16).toString("hex") };
  const payload = { iss:"cdp", nbf:now, exp:now+120, sub:CB_KEY_NAME, uri:`${method} api.coinbase.com${path}` };
  const b64u = (s) => Buffer.from(s).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  const toSign = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const keyBuf = Buffer.from(RAW_SECRET.trim().replace(/ /g,"+"), "base64");
  const privBytes = keyBuf.slice(0, 32);
  const pkcs8 = Buffer.concat([
    Buffer.from([0x30,0x41,0x02,0x01,0x00,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x04,0x27,0x30,0x25,0x02,0x01,0x01,0x04,0x20]),
    privBytes
  ]);
  const privateKey = crypto.createPrivateKey({ key:pkcs8, format:"der", type:"pkcs8" });
  const sig = crypto.sign("SHA256", Buffer.from(toSign), { key:privateKey, dsaEncoding:"ieee-p1363" });
  return `${toSign}.${b64u(sig)}`;
}

function cbRequest(method, path, body=null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : "";
    const token = makeJWT(method, path);
    const options = {
      hostname:"api.coinbase.com", path, method,
      headers: { "Content-Type":"application/json", "Authorization":`Bearer ${token}`, "Content-Length":Buffer.byteLength(bodyStr) }
    };
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

  if(path==="/health") return json(res,{success:true,status:"live",ts:new Date().toISOString()});

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
}).listen(PORT,()=>console.log(`Quantifesta API on port ${PORT}`));
