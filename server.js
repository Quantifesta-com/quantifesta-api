const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const HELIUS_RPC = process.env.HELIUS_RPC || "https://mainnet.helius-rpc.com/?api-key=5887995d-86e5-4f50-8558-c53a988d4ec2";
const JUP_API_KEY = process.env.JUP_API_KEY || "jup_4e01628c96dcadffcf9d5ab360837152bdfc984674151b077d280b7107d9f315";
const BOT_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY || "";
const HELIUS_KEY = "5887995d-86e5-4f50-8558-c53a988d4ec2";

// ── Base58 ───────────────────────────────────────────────────
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(str) {
  const bytes = [0];
  for (const c of str) {
    const val = B58.indexOf(c);
    if (val < 0) throw new Error("Bad char: " + c);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of str) { if (c === "1") bytes.push(0); else break; }
  return Buffer.from(bytes.reverse());
}
function b58encode(buf) {
  const bytes = Array.from(buf);
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = Math.floor(carry / 58); }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let result = "";
  for (let i = 0; i < buf.length && buf[i] === 0; i++) result += "1";
  return result + digits.reverse().map(d => B58[d]).join("");
}

// ── Ed25519 keypair from private key ─────────────────────────
let botPrivKey = null, botPubKey = null;
try {
  const raw = b58decode(BOT_PRIVATE_KEY);
  botPrivKey = raw.slice(0, 32);
  botPubKey = raw.slice(32, 64);
  console.log("✅ Bot wallet:", b58encode(botPubKey));
} catch(e) { console.log("❌ Keypair error:", e.message); }

// ── Sign with Ed25519 ────────────────────────────────────────
function signEd25519(message, privateKey) {
  const keyObj = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]),
      privateKey
    ]),
    format: "der", type: "pkcs8"
  });
  return crypto.sign(null, message, keyObj);
}

const TOKENS = {
  SOL:  "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP:  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  WIF:  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
};

let autoTrading=false,autoInterval=null,tradeLog=[],tradeCount=0,totalPnl=0;
let lastBuyPrice=0;
let autoConfig={amount:1000000,slippageBps:50,intervalSecs:60,takeProfitPct:3,stopLossPct:2,minConfidence:75};
const priceHistory={SOL:[],ETH:[],BTC:[]};

function get(url,headers={}){return new Promise((res,rej)=>{https.get(url,{headers:{"x-api-key":JUP_API_KEY,...headers}},(r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d));}catch{res({error:d});}});}).on("error",rej);});}
function postJson(url,body,headers={}){return new Promise((res,rej)=>{const d=JSON.stringify(body),u=new URL(url);const r=https.request({hostname:u.hostname,path:u.pathname+u.search,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(d),"x-api-key":JUP_API_KEY,...headers}},(rs)=>{let x="";rs.on("data",c=>x+=c);rs.on("end",()=>{try{res(JSON.parse(x));}catch{res({error:x});}});});r.on("error",rej);r.write(d);r.end();});}
function rpc(method,params=[]){return postJson(HELIUS_RPC,{jsonrpc:"2.0",id:1,method,params},{});}

function binancePrice(sym){return new Promise(r=>{https.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`,rs=>{let d="";rs.on("data",c=>d+=c);rs.on("end",()=>{try{const x=JSON.parse(d);r({usd:+x.lastPrice,change24h:+x.priceChangePercent,high24h:+x.highPrice,low24h:+x.lowPrice,volume24h:+x.quoteVolume});}catch{r(null);}});}).on("error",()=>r(null));});}
function binanceKlines(sym,iv="1h",lim=60){return new Promise(r=>{https.get(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${iv}&limit=${lim}`,rs=>{let d="";rs.on("data",c=>d+=c);rs.on("end",()=>{try{r(JSON.parse(d).map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})));}catch{r([]);}});}).on("error",()=>r([]));});}

function rsiCalc(p,n=14){if(p.length<n+1)return 50;let g=0,l=0;for(let i=1;i<=n;i++){const d=p[i]-p[i-1];if(d>0)g+=d;else l-=d;}g/=n;l/=n;return l===0?100:100-100/(1+g/l);}
function maCalc(p,n){if(p.length<n)return p[p.length-1]||0;return p.slice(-n).reduce((a,b)=>a+b,0)/n;}
function getSignal(sym){
  const ph=priceHistory[sym]||[];
  if(ph.length<5)return{signal:"NEUTRAL",confidence:40,score:0,rsi:50};
  const r=rsiCalc(ph),ma7=maCalc(ph,Math.min(7,ph.length)),ma20=maCalc(ph,Math.min(20,ph.length));
  let score=0;
  if(r<25)score+=35;else if(r<35)score+=20;else if(r<45)score+=10;
  else if(r>75)score-=35;else if(r>65)score-=20;else if(r>55)score-=10;
  if(ma7>ma20)score+=15;else score-=15;
  if(ph.length>=6){const rec=ph.slice(-3).reduce((a,b)=>a+b,0)/3,old=ph.slice(-6,-3).reduce((a,b)=>a+b,0)/3;
    if(rec>old*1.008)score+=15;else if(rec>old*1.003)score+=8;else if(rec<old*0.992)score-=15;else if(rec<old*0.997)score-=8;}
  let signal="NEUTRAL",confidence=40;
  if(score>=35){signal="STRONG BUY";confidence=Math.min(95,60+score);}
  else if(score>=18){signal="BUY";confidence=Math.min(80,50+score);}
  else if(score<=-35){signal="STRONG SELL";confidence=Math.min(95,60+Math.abs(score));}
  else if(score<=-18){signal="SELL";confidence=Math.min(80,50+Math.abs(score));}
  return{signal,confidence,score,rsi:Math.round(r),ma7,ma20};
}

// ── Execute swap via Jupiter + manual signing ────────────────
async function executeSwap(inputMint,outputMint,amount,slippageBps=50){
  if(!botPrivKey||!botPubKey)throw new Error("No bot keypair");
  const pubKeyB58=b58encode(botPubKey);

  // Get quote
  const quote=await get(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`);
  if(!quote||quote.error)throw new Error("Quote failed: "+(quote?.error||"unknown"));

  // Get swap transaction
  const swapRes=await postJson("https://quote-api.jup.ag/v6/swap",{
    quoteResponse:quote,userPublicKey:pubKeyB58,
    wrapAndUnwrapSol:true,dynamicComputeUnitLimit:true,prioritizationFeeLamports:"auto"
  });
  if(!swapRes.swapTransaction)throw new Error("No swap tx");

  // Deserialize versioned transaction manually
  const txBuf=Buffer.from(swapRes.swapTransaction,"base64");

  // Find the message bytes to sign (skip prefix byte and signatures)
  // Versioned tx: [0] = version prefix, [1] = num signatures, then signatures, then message
  const numSigs=txBuf[1];
  const sigSize=64;
  const messageOffset=2+(numSigs*sigSize);
  const messageBytes=txBuf.slice(messageOffset);

  // Sign the message
  const sig=signEd25519(messageBytes,botPrivKey);

  // Put signature into transaction
  const signedTx=Buffer.from(txBuf);
  sig.copy(signedTx,2,0,64);

  // Send via Helius RPC
  const b64tx=signedTx.toString("base64");
  const sendRes=await postJson(HELIUS_RPC,{
    jsonrpc:"2.0",id:1,method:"sendTransaction",
    params:[b64tx,{encoding:"base64",skipPreflight:false,maxRetries:3}]
  });

  if(sendRes.error)throw new Error("Send failed: "+JSON.stringify(sendRes.error));
  const signature=sendRes.result;

  // Confirm
  let confirmed=false;
  for(let i=0;i<30;i++){
    await new Promise(r=>setTimeout(r,2000));
    const status=await postJson(HELIUS_RPC,{jsonrpc:"2.0",id:1,method:"getSignatureStatuses",params:[[signature]]});
    const s=status?.result?.value?.[0];
    if(s&&(s.confirmationStatus==="confirmed"||s.confirmationStatus==="finalized")){confirmed=true;break;}
    if(s?.err)throw new Error("Tx error: "+JSON.stringify(s.err));
  }

  return{signature,explorerUrl:`https://solscan.io/tx/${signature}`,confirmed,outAmount:quote.outAmount,priceImpactPct:quote.priceImpactPct};
}

// ── Auto trade loop ──────────────────────────────────────────
async function runAutoTrade(){
  try{
    const[SOL,ETH,BTC]=await Promise.all([binancePrice("SOLUSDT"),binancePrice("ETHUSDT"),binancePrice("BTCUSDT")]);
    if(SOL){priceHistory.SOL.push(SOL.usd);if(priceHistory.SOL.length>100)priceHistory.SOL.shift();}
    if(ETH){priceHistory.ETH.push(ETH.usd);if(priceHistory.ETH.length>100)priceHistory.ETH.shift();}
    if(BTC){priceHistory.BTC.push(BTC.usd);if(priceHistory.BTC.length>100)priceHistory.BTC.shift();}

    const price=SOL?.usd||0;
    const sig=getSignal("SOL");
    const entry={time:new Date().toISOString(),price,signal:sig.signal,confidence:sig.confidence,rsi:sig.rsi,action:"WATCHING"};

    // Take profit / stop loss
    if(lastBuyPrice>0&&price>0){
      const pnlPct=((price-lastBuyPrice)/lastBuyPrice)*100;
      entry.pnlPct=+pnlPct.toFixed(3);
      if(pnlPct>=autoConfig.takeProfitPct||pnlPct<=-autoConfig.stopLossPct){
        const label=pnlPct>=autoConfig.takeProfitPct?"TAKE_PROFIT":"STOP_LOSS";
        entry.action=label;
        try{
          const solBal=await rpc("getBalance",[b58encode(botPubKey)]);
          const solLamports=Math.floor((solBal.result?.value||0)*0.92);
          if(solLamports>5000){
            const result=await executeSwap(TOKENS.SOL,TOKENS.USDC,solLamports,autoConfig.slippageBps);
            totalPnl+=(pnlPct/100)*autoConfig.amount/1e6;
            entry.action=label+"_DONE";entry.signature=result.signature;
            entry.explorerUrl=result.explorerUrl;entry.type="SELL";
            lastBuyPrice=0;tradeCount++;
            console.log(`[BOT] ✅ ${label} at ${pnlPct.toFixed(2)}% | ${result.signature}`);
          }
        }catch(e){entry.action=label+"_FAILED";entry.error=e.message;console.log(`[BOT] ❌ ${label} failed:`,e.message);}
      }
    }

    // Buy
    if(lastBuyPrice===0&&sig.signal==="STRONG BUY"&&sig.confidence>=autoConfig.minConfidence){
      entry.action="BUYING";
      try{
        const result=await executeSwap(TOKENS.USDC,TOKENS.SOL,autoConfig.amount,autoConfig.slippageBps);
        lastBuyPrice=price;entry.action="BOUGHT";
        entry.signature=result.signature;entry.explorerUrl=result.explorerUrl;
        entry.type="BUY";tradeCount++;
        console.log(`[BOT] ✅ BOUGHT at $${price} | ${result.signature}`);
      }catch(e){entry.action="BUY_FAILED";entry.error=e.message;console.log("[BOT] ❌ Buy failed:",e.message);}
    }

    tradeLog.unshift(entry);tradeLog=tradeLog.slice(0,200);
    console.log(`[BOT] $${price} | ${sig.signal} ${sig.confidence}% | ${entry.action}`);
  }catch(e){console.log("[BOT ERROR]",e.message);}
}

function startAuto(){if(autoInterval)clearInterval(autoInterval);autoTrading=true;runAutoTrade();autoInterval=setInterval(runAutoTrade,autoConfig.intervalSecs*1000);}
function stopAuto(){if(autoInterval)clearInterval(autoInterval);autoTrading=false;autoInterval=null;}

function cors(r){r.setHeader("Access-Control-Allow-Origin","*");r.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");r.setHeader("Access-Control-Allow-Headers","Content-Type");}
function out(r,d,s=200){cors(r);r.writeHead(s,{"Content-Type":"application/json"});r.end(JSON.stringify(d));}

http.createServer(async(req,res)=>{
  if(req.method==="OPTIONS"){cors(res);res.writeHead(204);res.end();return;}
  const u=new URL(req.url,"http://x"),p=u.pathname;

  if(p==="/health")return out(res,{ok:true,exchange:"jupiter+helius",botWallet:botPubKey?b58encode(botPubKey):"NOT LOADED",autoTrading,tradeCount,totalPnl:+totalPnl.toFixed(4),lastBuyPrice,ts:new Date().toISOString()});
  if(p==="/prices"){try{const[S,E,B]=await Promise.all([binancePrice("SOLUSDT"),binancePrice("ETHUSDT"),binancePrice("BTCUSDT")]);if(S)priceHistory.SOL.push(S.usd);if(E)priceHistory.ETH.push(E.usd);if(B)priceHistory.BTC.push(B.usd);return out(res,{success:true,prices:{SOL:S,ETH:E,BTC:B}});}catch(e){return out(res,{success:false,error:e.message});}}
  if(p==="/klines"){const s=u.searchParams.get("symbol")||"SOLUSDT";return out(res,{success:true,candles:await binanceKlines(s,u.searchParams.get("interval")||"1h",+(u.searchParams.get("limit")||60))});}
  if(p==="/signal"){const s=u.searchParams.get("symbol")||"SOL";return out(res,{success:true,...getSignal(s)});}
  if(p==="/account"){const w=u.searchParams.get("wallet")||(botPubKey?b58encode(botPubKey):null);if(!w)return out(res,{success:false,error:"Pass ?wallet=ADDRESS"});try{const r=await rpc("getBalance",[w]);const bal=(r.result?.value||0)/1e9;return out(res,{success:true,balances:[{asset:"SOL",free:bal,locked:0,total:bal}],wallet:w});}catch(e){return out(res,{success:false,error:e.message});}}
  if(p==="/auto/start"){
    if(req.method==="POST"){let b="";req.on("data",c=>b+=c);req.on("end",()=>{try{const cfg=JSON.parse(b||"{}");Object.assign(autoConfig,cfg);}catch{}startAuto();out(res,{success:true,message:"🤖 STARTED",config:autoConfig,botWallet:botPubKey?b58encode(botPubKey):"none"});});}
    else{startAuto();out(res,{success:true,message:"🤖 STARTED",config:autoConfig,botWallet:botPubKey?b58encode(botPubKey):"none"});}
    return;
  }
  if(p==="/auto/stop"){stopAuto();return out(res,{success:true,message:"🛑 STOPPED",tradeCount,totalPnl});}
  if(p==="/auto/status")return out(res,{success:true,autoTrading,config:autoConfig,tradeCount,totalPnl:+totalPnl.toFixed(4),lastBuyPrice,log:tradeLog.slice(0,30),signals:{SOL:getSignal("SOL"),ETH:getSignal("ETH"),BTC:getSignal("BTC")},botWallet:botPubKey?b58encode(botPubKey):"none"});
  if(p==="/auto/log")return out(res,{success:true,log:tradeLog});
  if(p==="/trades")return out(res,{success:true,trades:tradeLog.filter(t=>t.type),tradeCount,totalPnl});
  out(res,{error:"Not found"},404);
}).listen(PORT,()=>console.log(`Quantifesta Bot running on port ${PORT}`));
