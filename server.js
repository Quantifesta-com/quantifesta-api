const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const HELIUS_RPC = process.env.HELIUS_RPC || "https://mainnet.helius-rpc.com/?api-key=5887995d-86e5-4f50-8558-c53a988d4ec2";
const JUP_API_KEY = process.env.JUP_API_KEY || "jup_4e01628c96dcadffcf9d5ab360837152bdfc984674151b077d280b7107d9f315";
const BOT_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY || "";

const B58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(str){const bytes=[0];for(const c of str){const val=B58.indexOf(c);if(val<0)throw new Error("Bad char");let carry=val;for(let i=0;i<bytes.length;i++){carry+=bytes[i]*58;bytes[i]=carry&0xff;carry>>=8;}while(carry>0){bytes.push(carry&0xff);carry>>=8;}}for(const c of str){if(c==="1")bytes.push(0);else break;}return Buffer.from(bytes.reverse());}
function b58encode(buf){const bytes=Array.from(buf);const digits=[0];for(const byte of bytes){let carry=byte;for(let i=0;i<digits.length;i++){carry+=digits[i]<<8;digits[i]=carry%58;carry=Math.floor(carry/58);}while(carry>0){digits.push(carry%58);carry=Math.floor(carry/58);}}let result="";for(let i=0;i<buf.length&&buf[i]===0;i++)result+="1";return result+digits.reverse().map(d=>B58[d]).join("");}

let botPrivKey=null,botPubKey=null;
try{const raw=b58decode(BOT_PRIVATE_KEY);botPrivKey=raw.slice(0,32);botPubKey=raw.slice(32,64);console.log("✅ Bot wallet:",b58encode(botPubKey));}
catch(e){console.log("❌ Keypair error:",e.message);}

function signEd25519(message,privateKey){
  const keyObj=crypto.createPrivateKey({key:Buffer.concat([Buffer.from([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]),privateKey]),format:"der",type:"pkcs8"});
  return crypto.sign(null,message,keyObj);
}

const TOKENS={
  SOL:"So11111111111111111111111111111111111111112",
  USDC:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT:"Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  BONK:"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP:"JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  WIF:"EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  PYTH:"HZ1JovNiVvSZEbEbp3p5LUkbgKRGV1Q3bAcfhFkH7uvA",
  RAY:"4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  ORCA:"orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
};

const CG_IDS={SOL:"solana",ETH:"ethereum",BTC:"bitcoin",BONK:"bonk",WIF:"dogwifcoin",JUP:"jupiter-exchange-solana",PYTH:"pyth-network",RAY:"raydium",ORCA:"orca"};

// Jupiter API endpoints — try multiple in order
const JUP_QUOTE_HOSTS=["quote-api.jup.ag","jupiter-swap-api.quiknode.pro","jup.ag"];

let autoTrading=false,autoInterval=null,tradeLog=[],tradeCount=0,totalPnl=0,lastBuyPrice=0,lastBuyToken="SOL";
let autoConfig={amount:1000000,slippageBps:100,intervalSecs:60,takeProfitPct:3,stopLossPct:2,minConfidence:75};
const priceHistory={SOL:[],ETH:[],BTC:[],BONK:[],WIF:[],JUP:[],PYTH:[],RAY:[],ORCA:[]};

function httpsGet(hostname,path,headers={}){
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname,path,method:"GET",headers:{"User-Agent":"Mozilla/5.0","x-api-key":JUP_API_KEY,...headers}},(res)=>{
      let d="";res.on("data",c=>d+=c);
      res.on("end",()=>{try{resolve(JSON.parse(d));}catch{resolve({error:d});}});
    });
    req.on("error",reject);req.end();
  });
}

function httpsPost(hostname,path,body,headers={}){
  return new Promise((resolve,reject)=>{
    const d=JSON.stringify(body);
    const req=https.request({hostname,path,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(d),"User-Agent":"Mozilla/5.0","x-api-key":JUP_API_KEY,...headers}},(res)=>{
      let x="";res.on("data",c=>x+=c);
      res.on("end",()=>{try{resolve(JSON.parse(x));}catch{resolve({error:x});}});
    });
    req.on("error",reject);req.write(d);req.end();
  });
}

function rpc(method,params=[]){
  const u=new URL(HELIUS_RPC);
  return httpsPost(u.hostname,u.pathname+u.search,{jsonrpc:"2.0",id:1,method,params});
}

// ── Try Jupiter quote from multiple hosts ────────────────────
async function jupQuote(inputMint,outputMint,amount,slippageBps){
  const path=`/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  for(const host of JUP_QUOTE_HOSTS){
    try{
      const q=await httpsGet(host,path);
      if(q&&!q.error&&q.inAmount)return{quote:q,host};
    }catch(e){console.log(`[JUP] ${host} failed: ${e.message}`);}
  }
  throw new Error("All Jupiter quote hosts failed");
}

async function jupSwap(host,quoteResponse,userPublicKey){
  return httpsPost(host,"/v6/swap",{quoteResponse,userPublicKey,wrapAndUnwrapSol:true,dynamicComputeUnitLimit:true,prioritizationFeeLamports:"auto"});
}

// ── Prices ───────────────────────────────────────────────────
function fetchAllPricesCG(ids){
  return new Promise(r=>{
    httpsGet("api.coingecko.com",`/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`)
      .then(d=>r(d||{})).catch(()=>r({}));
  });
}

function fetchCoinbasePriceReq(ticker){
  return new Promise(r=>{
    httpsGet("api.coinbase.com",`/v2/prices/${ticker.toUpperCase()}-USD/spot`,{"CB-VERSION":"2016-02-18"})
      .then(d=>{if(d?.data?.amount)r(+d.data.amount);else r(null);}).catch(()=>r(null));
  });
}

async function fetchAllPrices(){
  const allIds=Object.values(CG_IDS);
  const cgData=await fetchAllPricesCG(allIds);
  const prices={};
  for(const[sym,cgId] of Object.entries(CG_IDS)){
    const d=cgData[cgId];
    if(d?.usd){prices[sym]={usd:+d.usd,change24h:+(d.usd_24h_change||0),high24h:+d.usd,low24h:+d.usd,volume24h:+(d.usd_24h_vol||0)};}
    else if(["SOL","ETH","BTC"].includes(sym)){
      const p=await fetchCoinbasePriceReq(sym);
      if(p)prices[sym]={usd:p,change24h:0,high24h:p,low24h:p,volume24h:0};
    }
  }
  return prices;
}

// ── Signal engine ────────────────────────────────────────────
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

function getBestSignal(type="BUY"){
  let best=null;
  for(const sym of["SOL","BONK","WIF","JUP","RAY"]){
    const sig=getSignal(sym);
    const match=type==="BUY"?(sig.signal==="STRONG BUY"||sig.signal==="BUY"):( sig.signal==="STRONG SELL"||sig.signal==="SELL");
    if(match&&sig.confidence>=autoConfig.minConfidence){
      if(!best||sig.confidence>best.confidence)best={sym,...sig};
    }
  }
  return best;
}

// ── Execute swap ─────────────────────────────────────────────
async function executeSwap(inputMint,outputMint,amount,slippageBps=100){
  if(!botPrivKey||!botPubKey)throw new Error("No bot keypair");
  const pubKeyB58=b58encode(botPubKey);

  const{quote,host}=await jupQuote(inputMint,outputMint,amount,slippageBps);
  const swapRes=await jupSwap(host,quote,pubKeyB58);
  if(!swapRes.swapTransaction)throw new Error("No swap tx: "+JSON.stringify(swapRes).slice(0,200));

  const txBuf=Buffer.from(swapRes.swapTransaction,"base64");
  const numSigs=txBuf[1];
  const messageBytes=txBuf.slice(2+(numSigs*64));
  const sig=signEd25519(messageBytes,botPrivKey);
  const signedTx=Buffer.from(txBuf);
  sig.copy(signedTx,2,0,64);

  const u=new URL(HELIUS_RPC);
  const sendRes=await httpsPost(u.hostname,u.pathname+u.search,{jsonrpc:"2.0",id:1,method:"sendTransaction",params:[signedTx.toString("base64"),{encoding:"base64",skipPreflight:false,maxRetries:3}]});
  if(sendRes.error)throw new Error("Send failed: "+JSON.stringify(sendRes.error));

  const signature=sendRes.result;
  for(let i=0;i<30;i++){
    await new Promise(r=>setTimeout(r,2000));
    const status=await httpsPost(u.hostname,u.pathname+u.search,{jsonrpc:"2.0",id:1,method:"getSignatureStatuses",params:[[signature]]});
    const s=status?.result?.value?.[0];
    if(s&&(s.confirmationStatus==="confirmed"||s.confirmationStatus==="finalized"))break;
    if(s?.err)throw new Error("Tx error: "+JSON.stringify(s.err));
  }
  return{signature,explorerUrl:`https://solscan.io/tx/${signature}`,outAmount:quote.outAmount};
}

// ── Auto trade loop ──────────────────────────────────────────
async function runAutoTrade(){
  try{
    const allPrices=await fetchAllPrices();
    for(const[sym,price] of Object.entries(allPrices)){
      if(price?.usd&&priceHistory[sym]!==undefined){priceHistory[sym].push(price.usd);if(priceHistory[sym].length>100)priceHistory[sym].shift();}
    }
    const price=allPrices.SOL?.usd||0;
    const solSig=getSignal("SOL");
    const entry={time:new Date().toISOString(),price,signal:solSig.signal,confidence:solSig.confidence,rsi:solSig.rsi,action:"WATCHING"};

    if(lastBuyPrice>0&&price>0){
      const curPrice=allPrices[lastBuyToken]?.usd||price;
      const pnlPct=((curPrice-lastBuyPrice)/lastBuyPrice)*100;
      entry.pnlPct=+pnlPct.toFixed(3);entry.position=lastBuyToken;
      if(pnlPct>=autoConfig.takeProfitPct||pnlPct<=-autoConfig.stopLossPct){
        const label=pnlPct>=autoConfig.takeProfitPct?"TAKE_PROFIT":"STOP_LOSS";
        entry.action=label;
        try{
          const tokenMint=TOKENS[lastBuyToken]||TOKENS.SOL;
          const solBal=await rpc("getBalance",[b58encode(botPubKey)]);
          const lamports=Math.floor((solBal.result?.value||0)*0.92);
          if(lamports>5000){
            const result=await executeSwap(tokenMint,TOKENS.USDC,lamports,autoConfig.slippageBps);
            totalPnl+=(pnlPct/100)*autoConfig.amount/1e6;
            entry.action=label+"_DONE";entry.signature=result.signature;entry.explorerUrl=result.explorerUrl;entry.type="SELL";
            lastBuyPrice=0;lastBuyToken="SOL";tradeCount++;
            console.log(`[BOT] ✅ ${label} | ${result.signature}`);
          }
        }catch(e){entry.action=label+"_FAILED";entry.error=e.message;}
      }
    }

    if(lastBuyPrice===0){
      const best=getBestSignal("BUY");
      if(best){
        entry.action=`BUYING ${best.sym}`;
        try{
          const result=await executeSwap(TOKENS.USDC,TOKENS[best.sym]||TOKENS.SOL,autoConfig.amount,autoConfig.slippageBps);
          lastBuyPrice=allPrices[best.sym]?.usd||price;lastBuyToken=best.sym;
          entry.action=`BOUGHT ${best.sym}`;entry.signature=result.signature;entry.explorerUrl=result.explorerUrl;entry.type="BUY";entry.token=best.sym;tradeCount++;
          console.log(`[BOT] ✅ BOUGHT ${best.sym} at $${lastBuyPrice} | ${result.signature}`);
        }catch(e){entry.action=`BUY_${best.sym}_FAILED`;entry.error=e.message;console.log(`[BOT] ❌`,e.message);}
      }
    }

    tradeLog.unshift(entry);tradeLog=tradeLog.slice(0,200);
    console.log(`[BOT] SOL $${price} | ${solSig.signal} ${solSig.confidence}% | ${entry.action}`);
  }catch(e){console.log("[BOT ERROR]",e.message);}
}

function startAuto(){if(autoInterval)clearInterval(autoInterval);autoTrading=true;runAutoTrade();autoInterval=setInterval(runAutoTrade,autoConfig.intervalSecs*1000);}
function stopAuto(){if(autoInterval)clearInterval(autoInterval);autoTrading=false;autoInterval=null;}

function cors(r){r.setHeader("Access-Control-Allow-Origin","*");r.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");r.setHeader("Access-Control-Allow-Headers","Content-Type");}
function out(r,d,s=200){cors(r);r.writeHead(s,{"Content-Type":"application/json"});r.end(JSON.stringify(d));}

http.createServer(async(req,res)=>{
  if(req.method==="OPTIONS"){cors(res);res.writeHead(204);res.end();return;}
  const u=new URL(req.url,"http://x"),p=u.pathname;

  if(p==="/health")return out(res,{ok:true,exchange:"jupiter+helius",botWallet:botPubKey?b58encode(botPubKey):"NOT LOADED",autoTrading,tradeCount,totalPnl:+totalPnl.toFixed(4),lastBuyPrice,lastBuyToken,ts:new Date().toISOString()});

  if(p==="/prices"){
    try{const all=await fetchAllPrices();for(const[sym,price] of Object.entries(all)){if(price?.usd&&priceHistory[sym]!==undefined){priceHistory[sym].push(price.usd);if(priceHistory[sym].length>100)priceHistory[sym].shift();}}return out(res,{success:true,prices:all});}
    catch(e){return out(res,{success:false,error:e.message});}
  }

  if(p==="/signal"){const s=u.searchParams.get("symbol")||"SOL";return out(res,{success:true,...getSignal(s)});}
  if(p==="/account"){const w=u.searchParams.get("wallet")||(botPubKey?b58encode(botPubKey):null);if(!w)return out(res,{success:false,error:"Pass ?wallet=ADDRESS"});try{const r=await rpc("getBalance",[w]);const bal=(r.result?.value||0)/1e9;return out(res,{success:true,balances:[{asset:"SOL",free:bal,locked:0,total:bal}],wallet:w});}catch(e){return out(res,{success:false,error:e.message});}}

  if(p==="/auto/start"){
    if(req.method==="POST"){let b="";req.on("data",c=>b+=c);req.on("end",()=>{try{const cfg=JSON.parse(b||"{}");Object.assign(autoConfig,cfg);}catch{}startAuto();out(res,{success:true,message:"🤖 STARTED",config:autoConfig,botWallet:botPubKey?b58encode(botPubKey):"none"});});}
    else{startAuto();out(res,{success:true,message:"🤖 STARTED",config:autoConfig,botWallet:botPubKey?b58encode(botPubKey):"none"});}
    return;
  }
  if(p==="/auto/stop"){stopAuto();return out(res,{success:true,message:"🛑 STOPPED",tradeCount,totalPnl});}
  if(p==="/auto/status"){
    const allSigs={};for(const sym of Object.keys(priceHistory))allSigs[sym]=getSignal(sym);
    return out(res,{success:true,autoTrading,config:autoConfig,tradeCount,totalPnl:+totalPnl.toFixed(4),lastBuyPrice,lastBuyToken,log:tradeLog.slice(0,30),signals:allSigs,botWallet:botPubKey?b58encode(botPubKey):"none"});
  }
  if(p==="/auto/log")return out(res,{success:true,log:tradeLog});
  if(p==="/trades")return out(res,{success:true,trades:tradeLog.filter(t=>t.type),tradeCount,totalPnl});

  if(p==="/order"&&req.method==="POST"){let b="";req.on("data",c=>b+=c);req.on("end",async()=>{try{const{symbol,side,quantity,userPublicKey}=JSON.parse(b);const sym=symbol.replace("USDT","");const inputMint=side==="BUY"?TOKENS.USDC:(TOKENS[sym]||TOKENS.SOL);const outputMint=side==="BUY"?(TOKENS[sym]||TOKENS.SOL):TOKENS.USDC;const amount=Math.floor(quantity*(side==="BUY"?1e6:1e9));if(!userPublicKey)return out(res,{success:false,error:"Need userPublicKey"});const{quote,host}=await jupQuote(inputMint,outputMint,amount,50);const swapRes=await jupSwap(host,quote,userPublicKey);out(res,{success:true,swapTransaction:swapRes.swapTransaction,quote,mode:"frontend-sign"});}catch(e){out(res,{success:false,error:e.message});}});return;}

  out(res,{error:"Not found"},404);
}).listen(PORT,()=>console.log(`Quantifesta Bot running on port ${PORT}`));
