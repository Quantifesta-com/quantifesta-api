const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const HELIUS_RPC = process.env.HELIUS_RPC || "https://mainnet.helius-rpc.com/?api-key=5887995d-86e5-4f50-8558-c53a988d4ec2";
const JUP_API_KEY = process.env.JUP_API_KEY || "jup_4e01628c96dcadffcf9d5ab360837152bdfc984674151b077d280b7107d9f315";

const TOKENS = {
  SOL:"So11111111111111111111111111111111111111112",
  USDC:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT:"Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

let autoTrading=false,tradeLog=[],tradeCount=0,autoInterval=null;
let autoConfig={amount:1000000,slippageBps:50,intervalSecs:60};
const priceHistory={SOL:[],ETH:[],BTC:[]};

function get(url){return new Promise((res,rej)=>{https.get(url,{headers:{"x-api-key":JUP_API_KEY}},(r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d));}catch{res({error:d});}});}).on("error",rej);});}
function postJson(url,body){return new Promise((res,rej)=>{const d=JSON.stringify(body),u=new URL(url);const r=https.request({hostname:u.hostname,path:u.pathname+u.search,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(d),"x-api-key":JUP_API_KEY}},(rs)=>{let x="";rs.on("data",c=>x+=c);rs.on("end",()=>{try{res(JSON.parse(x));}catch{res({error:x});}});});r.on("error",rej);r.write(d);r.end();});}
function rpc(method,params=[]){return postJson(HELIUS_RPC,{jsonrpc:"2.0",id:1,method,params});}

function binancePrice(sym){return new Promise(r=>{https.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`,rs=>{let d="";rs.on("data",c=>d+=c);rs.on("end",()=>{try{const x=JSON.parse(d);r({usd:+x.lastPrice,change24h:+x.priceChangePercent,high24h:+x.highPrice,low24h:+x.lowPrice,volume24h:+x.quoteVolume});}catch{r(null);}});}).on("error",()=>r(null));});}
function binanceKlines(sym,iv="1h",lim=60){return new Promise(r=>{https.get(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&limit=${lim}`,rs=>{let d="";rs.on("data",c=>d+=c);rs.on("end",()=>{try{r(JSON.parse(d).map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})));}catch{r([]);}});}).on("error",()=>r([]));});}

function rsiCalc(p,n=14){if(p.length<n+1)return 50;let g=0,l=0;for(let i=1;i<=n;i++){const d=p[i]-p[i-1];if(d>0)g+=d;else l-=d;}g/=n;l/=n;return l===0?100:100-100/(1+g/l);}
function maCalc(p,n){if(p.length<n)return p[p.length-1]||0;return p.slice(-n).reduce((a,b)=>a+b,0)/n;}
function getSignal(sym){
  const ph=priceHistory[sym]||[];
  if(ph.length<5)return{signal:"NEUTRAL",confidence:40,score:0};
  const r=rsiCalc(ph),ma7=maCalc(ph,Math.min(7,ph.length)),ma20=maCalc(ph,Math.min(20,ph.length));
  let score=0;
  if(r<30)score+=30;else if(r<40)score+=15;else if(r>70)score-=30;else if(r>60)score-=15;
  if(ma7>ma20)score+=10;else score-=10;
  let signal="NEUTRAL",confidence=40;
  if(score>=30){signal="STRONG BUY";confidence=Math.min(95,65+score);}
  else if(score>=15){signal="BUY";confidence=Math.min(80,55+score);}
  else if(score<=-30){signal="STRONG SELL";confidence=Math.min(95,65+Math.abs(score));}
  else if(score<=-15){signal="SELL";confidence=Math.min(80,55+Math.abs(score));}
  return{signal,confidence,score,rsi:Math.round(r),ma7,ma20};
}

async function runAutoTrade(){
  try{
    const[SOL,ETH,BTC]=await Promise.all([binancePrice("SOLUSDT"),binancePrice("ETHUSDT"),binancePrice("BTCUSDT")]);
    if(SOL){priceHistory.SOL.push(SOL.usd);if(priceHistory.SOL.length>100)priceHistory.SOL.shift();}
    if(ETH){priceHistory.ETH.push(ETH.usd);if(priceHistory.ETH.length>100)priceHistory.ETH.shift();}
    if(BTC){priceHistory.BTC.push(BTC.usd);if(priceHistory.BTC.length>100)priceHistory.BTC.shift();}
    const sig=getSignal("SOL");
    const entry={time:new Date().toISOString(),signal:sig.signal,confidence:sig.confidence,rsi:sig.rsi,action:"WATCHING"};
    if(sig.signal==="STRONG BUY"&&sig.confidence>=75){
      entry.action="GETTING QUOTE";
      try{
        const quote=await get(`https://quote-api.jup.ag/v6/quote?inputMint=${TOKENS.USDC}&outputMint=${TOKENS.SOL}&amount=${autoConfig.amount}&slippageBps=${autoConfig.slippageBps}`);
        if(quote&&!quote.error){entry.action="QUOTE_READY";entry.quote=quote;entry.type="BUY_SIGNAL";tradeCount++;}
        else entry.action="QUOTE_FAILED";
      }catch(e){entry.action="ERROR";entry.error=e.message;}
    }
    tradeLog.unshift(entry);
    tradeLog=tradeLog.slice(0,100);
    console.log(`[AUTO] ${sig.signal} ${sig.confidence}% → ${entry.action}`);
  }catch(e){console.log("[AUTO ERROR]",e.message);}
}

function cors(r){r.setHeader("Access-Control-Allow-Origin","*");r.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");r.setHeader("Access-Control-Allow-Headers","Content-Type");}
function out(r,d,s=200){cors(r);r.writeHead(s,{"Content-Type":"application/json"});r.end(JSON.stringify(d));}

http.createServer(async(req,res)=>{
  if(req.method==="OPTIONS"){cors(res);res.writeHead(204);res.end();return;}
  const u=new URL(req.url,"http://x"),p=u.pathname;

  if(p==="/health")return out(res,{ok:true,exchange:"jupiter+helius",autoTrading,tradeCount,ts:new Date().toISOString()});
  if(p==="/prices"){try{const[S,E,B]=await Promise.all([binancePrice("SOLUSDT"),binancePrice("ETHUSDT"),binancePrice("BTCUSDT")]);if(S)priceHistory.SOL.push(S.usd);if(E)priceHistory.ETH.push(E.usd);if(B)priceHistory.BTC.push(B.usd);return out(res,{success:true,prices:{SOL:S,ETH:E,BTC:B}});}catch(e){return out(res,{success:false,error:e.message});}}
  if(p==="/klines"){const s=u.searchParams.get("symbol")||"SOLUSDT";return out(res,{success:true,candles:await binanceKlines(s,u.searchParams.get("interval")||"1h",+(u.searchParams.get("limit")||60))});}
  if(p==="/signal"){const s=u.searchParams.get("symbol")||"SOL";return out(res,{success:true,...getSignal(s)});}

  if(p==="/account"){
    const wallet=u.searchParams.get("wallet");
    if(!wallet)return out(res,{success:false,error:"Pass ?wallet=ADDRESS"});
    try{const r=await rpc("getBalance",[wallet]);const bal=(r.result?.value||0)/1e9;return out(res,{success:true,balances:[{asset:"SOL",free:bal,locked:0,total:bal}],wallet});}
    catch(e){return out(res,{success:false,error:e.message});}
  }

  if(p==="/auto/start"&&req.method==="POST"){
    let b="";req.on("data",c=>b+=c);
    req.on("end",()=>{
      try{const cfg=JSON.parse(b||"{}");if(cfg.amount)autoConfig.amount=cfg.amount;if(cfg.slippageBps)autoConfig.slippageBps=cfg.slippageBps;if(cfg.intervalSecs)autoConfig.intervalSecs=cfg.intervalSecs;
        if(autoInterval)clearInterval(autoInterval);autoTrading=true;runAutoTrade();autoInterval=setInterval(runAutoTrade,autoConfig.intervalSecs*1000);
        out(res,{success:true,message:"Auto trading started 🤖",config:autoConfig});}
      catch(e){out(res,{success:false,error:e.message});}
    });return;
  }

  if(p==="/auto/stop"){if(autoInterval)clearInterval(autoInterval);autoTrading=false;autoInterval=null;return out(res,{success:true,message:"Stopped",tradeCount});}
  if(p==="/auto/status")return out(res,{success:true,autoTrading,config:autoConfig,tradeCount,log:tradeLog.slice(0,20),signals:{SOL:getSignal("SOL"),ETH:getSignal("ETH"),BTC:getSignal("BTC")}});
  if(p==="/auto/log")return out(res,{success:true,log:tradeLog});

  if(p==="/order"&&req.method==="POST"){
    let b="";req.on("data",c=>b+=c);
    req.on("end",async()=>{
      try{
        const{symbol,side,quantity,userPublicKey}=JSON.parse(b);
        const sym=symbol.replace("USDT","");
        const inputMint=side==="BUY"?TOKENS.USDC:(TOKENS[sym]||TOKENS.SOL);
        const outputMint=side==="BUY"?(TOKENS[sym]||TOKENS.SOL):TOKENS.USDC;
        const amount=Math.floor(quantity*(side==="BUY"?1e6:1e9));
        const quote=await get(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`);
        if(!userPublicKey)return out(res,{success:false,error:"Need userPublicKey to sign transaction"});
        const swapRes=await postJson("https://quote-api.jup.ag/v6/swap",{quoteResponse:quote,userPublicKey,wrapAndUnwrapSol:true,dynamicComputeUnitLimit:true,prioritizationFeeLamports:"auto"});
        out(res,{success:true,swapTransaction:swapRes.swapTransaction,quote,mode:"frontend-sign"});
      }catch(e){out(res,{success:false,error:e.message});}
    });return;
  }

  if(p==="/trades")return out(res,{success:true,trades:tradeLog.filter(t=>t.type)});
  out(res,{error:"Not found"},404);
}).listen(PORT,()=>console.log(`Quantifesta Bot running on port ${PORT}`));
