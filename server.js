const http=require("http"),https=require("https"),crypto=require("crypto");
const PORT=process.env.PORT||3000;
const KEY=process.env.COINBASE_API_KEY||"";
const SEC=process.env.COINBASE_SECRET||"";

function jwt(method,path){
  const now=Math.floor(Date.now()/1000);
  const hdr={alg:"ES256",kid:KEY,nonce:crypto.randomBytes(16).toString("hex")};
  const pay={iss:"cdp",nbf:now,exp:now+120,sub:KEY,uri:`${method} api.coinbase.com${path}`};
  const u=(s)=>Buffer.from(s).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  const msg=`${u(JSON.stringify(hdr))}.${u(JSON.stringify(pay))}`;
  const raw=Buffer.from(SEC.trim(),"base64url");
  const p=raw.slice(0,32);
  const der=Buffer.concat([Buffer.from([0x30,0x41,0x02,0x01,0x00,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x04,0x27,0x30,0x25,0x02,0x01,0x01,0x04,0x20]),p]);
  const k=crypto.createPrivateKey({key:der,format:"der",type:"pkcs8"});
  const s=crypto.sign("SHA256",Buffer.from(msg),{key:k,dsaEncoding:"ieee-p1363"});
  return `${msg}.${u(s)}`;
}

function cb(method,path,body=null){
  return new Promise((res,rej)=>{
    const b=body?JSON.stringify(body):"";
    const t=jwt(method,path);
    const r=https.request({hostname:"api.coinbase.com",path,method,headers:{"Content-Type":"application/json","Authorization":`Bearer ${t}`,"Content-Length":Buffer.byteLength(b)}},(rs)=>{
      let d="";rs.on("data",c=>d+=c);rs.on("end",()=>{try{res(JSON.parse(d));}catch{res({error:d});}});
    });
    r.on("error",rej);if(b)r.write(b);r.end();
  });
}

function bp(sym){return new Promise(r=>{https.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`,rs=>{let d="";rs.on("data",c=>d+=c);rs.on("end",()=>{try{const x=JSON.parse(d);r({usd:+x.lastPrice,change24h:+x.priceChangePercent,high24h:+x.highPrice,low24h:+x.lowPrice,volume24h:+x.quoteVolume});}catch{r(null);}});}).on("error",()=>r(null));});}
function bk(sym,iv="1h",lim=60){return new Promise(r=>{https.get(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&limit=${lim}`,rs=>{let d="";rs.on("data",c=>d+=c);rs.on("end",()=>{try{r(JSON.parse(d).map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})));}catch{r([]);}});}).on("error",()=>r([]));});}

function cors(r){r.setHeader("Access-Control-Allow-Origin","*");r.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");r.setHeader("Access-Control-Allow-Headers","Content-Type");}
function out(r,d,s=200){cors(r);r.writeHead(s,{"Content-Type":"application/json"});r.end(JSON.stringify(d));}

http.createServer(async(req,res)=>{
  if(req.method==="OPTIONS"){cors(res);res.writeHead(204);res.end();return;}
  const u=new URL(req.url,"http://x"),p=u.pathname;
  if(p==="/health")return out(res,{ok:true,ts:new Date().toISOString()});
  if(p==="/debug"){
    let bytes=0,ok=false,err="";
    try{const b=Buffer.from(SEC.trim(),"base64url");bytes=b.length;const pr=b.slice(0,32);const d=Buffer.concat([Buffer.from([0x30,0x41,0x02,0x01,0x00,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x04,0x27,0x30,0x25,0x02,0x01,0x01,0x04,0x20]),pr]);crypto.createPrivateKey({key:d,format:"der",type:"pkcs8"});ok=true;}catch(e){err=e.message;}
    return out(res,{secretLen:SEC.length,secretStart:SEC.slice(0,20),decodedBytes:bytes,pkcs8ok:ok,err});
  }
  if(p==="/prices"){try{const[S,E,B]=await Promise.all([bp("SOLUSDT"),bp("ETHUSDT"),bp("BTCUSDT")]);return out(res,{success:true,prices:{SOL:S,ETH:E,BTC:B}});}catch(e){return out(res,{success:false,error:e.message});}}
  if(p==="/klines"){const s=u.searchParams.get("symbol")||"SOLUSDT";return out(res,{success:true,candles:await bk(s,u.searchParams.get("interval")||"1h",+(u.searchParams.get("limit")||60))});}
  if(p==="/account"){try{const d=await cb("GET","/api/v3/brokerage/accounts");if(d.accounts){const b=d.accounts.filter(a=>+(a.available_balance?.value||0)>0||+(a.hold?.value||0)>0).map(a=>({asset:a.currency,free:+(a.available_balance?.value||0),locked:+(a.hold?.value||0),total:+(a.available_balance?.value||0)+ +(a.hold?.value||0)}));return out(res,{success:true,balances:b});}return out(res,{success:false,error:"Auth failed",raw:d});}catch(e){return out(res,{success:false,error:e.message});}}
  if(p==="/order"&&req.method==="POST"){let b="";req.on("data",c=>b+=c);req.on("end",async()=>{try{const{symbol,side,quantity,type,price}=JSON.parse(b);const pid=symbol.replace("USDT","-USDT");const oc=type==="LIMIT"?{limit_limit_gtc:{base_size:String(quantity),limit_price:String(price),post_only:false}}:{market_market_ioc:{base_size:String(quantity)}};const r=await cb("POST","/api/v3/brokerage/orders",{client_order_id:`qf-${Date.now()}`,product_id:pid,side:side==="BUY"?"BUY":"SELL",order_configuration:oc});if(r.success)return out(res,{success:true,orderId:r.order_id,status:"FILLED",executedQty:String(quantity)});return out(res,{success:false,error:r.error_response?.message||r.error||JSON.stringify(r)});}catch(e){return out(res,{success:false,error:e.message});}});return;}
  if(p==="/trades"){try{const s=u.searchParams.get("symbol")||"SOLUSDT";const d=await cb("GET",`/api/v3/brokerage/orders/historical/fills?product_id=${s.replace("USDT","-USDT")}&limit=20`);return out(res,{success:true,trades:(d.fills||[]).map(f=>({id:f.trade_id,time:new Date(f.trade_time).getTime(),side:f.side,price:+f.price,qty:+f.size,total:+f.price*+f.size}))});}catch(e){return out(res,{success:false,error:e.message});}}
  out(res,{error:"Not found"},404);
}).listen(PORT,()=>console.log("Quantifesta API running"));
