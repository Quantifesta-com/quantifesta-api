const http = require("http");
const https = require("https");
const crypto = require("crypto");

const DASHBOARD_HTML=`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Quantifesta — Trading Bot</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#050a14;--surface:#0a1628;--border:#0f2040;--teal:#00d4aa;--teal-dim:#00d4aa22;--violet:#7c3aed;--violet-dim:#7c3aed22;--amber:#f59e0b;--amber-dim:#f59e0b22;--red:#ef4444;--red-dim:#ef444422;--text:#e2e8f0;--muted:#4a6a8a;--font:'Space Grotesk',sans-serif;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;min-height:100%;}
.shell{display:grid;grid-template-rows:auto 1fr auto;min-height:100vh;}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--border);background:rgba(5,10,20,.97);backdrop-filter:blur(20px);position:sticky;top:0;z-index:100;}
.logo{display:flex;align-items:center;gap:10px;}
.logo-mark{width:36px;height:36px;border-radius:9px;flex-shrink:0;background:linear-gradient(135deg,#00d4aa,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:700;color:#fff;box-shadow:0 0 18px rgba(0,212,170,.35);}
.logo-text h1{font-size:15px;font-weight:700;letter-spacing:.5px;color:#fff;line-height:1;}
.logo-text span{font-size:9px;color:var(--muted);font-weight:400;}
.status-pill{display:flex;align-items:center;gap:6px;padding:4px 11px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid var(--border);transition:all .3s;}
.status-pill.running{border-color:var(--teal);color:var(--teal);background:var(--teal-dim);}
.status-pill.stopped{border-color:var(--muted);color:var(--muted);}
.pulse{width:7px;height:7px;border-radius:50%;animation:pulse 1.4s infinite;}
.pulse.on{background:var(--teal);}
.pulse.off{background:var(--muted);animation:none;}
.header-prices{display:flex;gap:14px;flex-wrap:wrap;margin-left:auto;}
.hp .sym{font-size:9px;color:var(--muted);font-weight:500;}
.hp .val{font-size:12px;font-weight:600;}
.up{color:var(--teal);}
.dn{color:var(--red);}
main{display:grid;grid-template-columns:260px 1fr;gap:0;}
.left-panel{border-right:1px solid var(--border);padding:18px;display:flex;flex-direction:column;gap:18px;}
.pnl-hero{text-align:center;padding:22px 14px;background:var(--surface);border-radius:14px;border:1px solid var(--border);}
.pnl-label{font-size:9px;color:var(--muted);font-weight:500;margin-bottom:7px;letter-spacing:.3px;}
.pnl-value{font-size:34px;font-weight:700;line-height:1;transition:color .5s;}
.pnl-value.positive{color:var(--teal);text-shadow:0 0 28px rgba(0,212,170,.4);}
.pnl-value.negative{color:var(--red);}
.pnl-value.zero{color:var(--muted);}
.pnl-sub{font-size:10px;color:var(--muted);margin-top:5px;}
.sec-title{font-size:10px;color:var(--muted);font-weight:500;margin-bottom:11px;letter-spacing:.3px;}
.btn{width:100%;padding:10px;border-radius:9px;border:none;cursor:pointer;font-family:var(--font);font-size:13px;font-weight:600;transition:all .2s;}
.btn-start{background:linear-gradient(135deg,#00d4aa,#00a882);color:#050a14;}
.btn-start:hover{filter:brightness(1.1);transform:translateY(-1px);}
.btn-stop{background:var(--red-dim);color:var(--red);border:1px solid var(--red);}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none;}
.config-grid{display:flex;flex-direction:column;gap:8px;}
.config-row{display:flex;justify-content:space-between;align-items:center;}
.config-label{font-size:10px;color:var(--muted);}
.config-val{font-size:11px;font-weight:600;color:var(--text);}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;}
.stat-box{background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:9px 11px;}
.stat-box .lbl{font-size:9px;color:var(--muted);margin-bottom:3px;}
.stat-box .val{font-size:15px;font-weight:700;color:var(--text);}
.wallet-box{background:var(--violet-dim);border:1px solid var(--violet);border-radius:10px;padding:11px;}
.wallet-box .lbl{font-size:9px;color:var(--violet);font-weight:500;margin-bottom:4px;}
.wallet-box .addr{font-size:9px;color:var(--text);font-family:monospace;word-break:break-all;line-height:1.5;}
.wallet-box .bal{font-size:17px;font-weight:700;color:var(--violet);margin-top:5px;}
.right-panel{padding:18px;display:flex;flex-direction:column;gap:18px;}
.token-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;}
.token-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:13px 14px;transition:border-color .3s;}
.token-card.signal-buy{border-color:var(--teal);box-shadow:0 0 16px rgba(0,212,170,.1);}
.token-card.signal-sell{border-color:var(--red);box-shadow:0 0 16px rgba(239,68,68,.1);}
.tc-sym{font-size:12px;font-weight:600;margin-bottom:2px;}
.tc-name{font-size:9px;color:var(--muted);margin-bottom:8px;}
.tc-price{font-size:17px;font-weight:700;margin-bottom:2px;}
.tc-change{font-size:9px;margin-bottom:8px;}
.signal-badge{padding:2px 7px;border-radius:5px;font-size:9px;font-weight:600;display:inline-block;margin-bottom:7px;}
.sb-neutral{background:rgba(74,106,138,.2);color:var(--muted);}
.sb-buy{background:var(--teal-dim);color:var(--teal);}
.sb-strong-buy{background:rgba(0,212,170,.25);color:var(--teal);border:1px solid var(--teal);}
.sb-sell{background:var(--red-dim);color:var(--red);}
.sb-strong-sell{background:rgba(239,68,68,.25);color:var(--red);border:1px solid var(--red);}
.rsi-bar{height:2px;background:var(--border);border-radius:2px;margin:6px 0 4px;}
.rsi-fill{height:2px;border-radius:2px;transition:width .5s;}
.rsi-label{font-size:8px;color:var(--muted);display:flex;justify-content:space-between;}
.log-section{border-top:1px solid var(--border);padding:18px;}
.log-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
.log-list{display:flex;flex-direction:column;gap:5px;max-height:240px;overflow-y:auto;}
.log-row{display:grid;grid-template-columns:120px 75px 100px 140px 70px 110px;gap:10px;align-items:center;padding:7px 11px;background:var(--surface);border-radius:7px;font-size:10px;}
.log-time{color:var(--muted);}
.log-price{font-weight:600;}
.log-action{font-weight:600;}
.log-tx a{color:var(--violet);text-decoration:none;}
.log-empty{text-align:center;padding:36px;color:var(--muted);font-size:11px;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.fade-in{animation:fadeIn .3s ease;}
@media(max-width:680px){main{grid-template-columns:1fr;}.left-panel{border-right:none;border-bottom:1px solid var(--border);}.log-row{grid-template-columns:1fr 1fr;gap:5px;}.log-tx,.log-pnl{display:none;}}
</style>
</head>
<body>
<div class="shell">
<header>
  <div class="logo">
    <div class="logo-mark">Q</div>
    <div class="logo-text"><h1>Quantifesta</h1><span>Neural Trading Bot · 9 Tokens</span></div>
  </div>
  <div id="statusPill" class="status-pill stopped">
    <div class="pulse off" id="pulseEl"></div>
    <span id="statusText">Stopped</span>
  </div>
  <div class="header-prices" id="headerPrices">
    <div class="hp"><div class="sym">SOL</div><div class="val" id="hSOL">—</div></div>
    <div class="hp"><div class="sym">ETH</div><div class="val" id="hETH">—</div></div>
    <div class="hp"><div class="sym">BTC</div><div class="val" id="hBTC">—</div></div>
    <div class="hp"><div class="sym">BONK</div><div class="val" id="hBONK">—</div></div>
    <div class="hp"><div class="sym">WIF</div><div class="val" id="hWIF">—</div></div>
  </div>
</header>
<main>
<div class="left-panel">
  <div class="pnl-hero">
    <div class="pnl-label">Total P&amp;L</div>
    <div class="pnl-value zero" id="pnlValue">$0.00</div>
    <div class="pnl-sub" id="pnlSub">0 trades · waiting</div>
  </div>
  <div>
    <div class="sec-title">Bot control</div>
    <button class="btn btn-start" id="startBtn" onclick="toggleBot()">Start bot</button>
  </div>
  <div>
    <div class="sec-title">Configuration</div>
    <div class="config-grid">
      <div class="config-row"><span class="config-label">Trade size</span><span class="config-val">$1 USDC</span></div>
      <div class="config-row"><span class="config-label">Take profit</span><span class="config-val">+3%</span></div>
      <div class="config-row"><span class="config-label">Stop loss</span><span class="config-val">-2%</span></div>
      <div class="config-row"><span class="config-label">Min confidence</span><span class="config-val">75%</span></div>
      <div class="config-row"><span class="config-label">Tokens watched</span><span class="config-val">9</span></div>
    </div>
  </div>
  <div>
    <div class="sec-title">Stats</div>
    <div class="stat-grid">
      <div class="stat-box"><div class="lbl">Trades</div><div class="val" id="statTrades">0</div></div>
      <div class="stat-box"><div class="lbl">Position</div><div class="val" id="statPos">—</div></div>
      <div class="stat-box"><div class="lbl">Buy price</div><div class="val" id="statBuy">—</div></div>
      <div class="stat-box"><div class="lbl">Live P&L</div><div class="val" id="statPnl">—</div></div>
    </div>
  </div>
  <div class="wallet-box">
    <div class="lbl">BOT WALLET</div>
    <div class="addr" id="walletAddr">Loading...</div>
    <div class="bal" id="walletBal">— SOL</div>
    <div class="bal" id="walletUsdc" style="font-size:13px;color:var(--teal);margin-top:3px">— USDC</div>
  </div>
  <div style="font-size:9px;color:var(--muted);text-align:center" id="lastUpdate">—</div>
</div>
<div class="right-panel">
  <div>
    <div class="sec-title">9-Token Signal Grid</div>
    <div class="token-grid" id="tokenGrid"></div>
  </div>
</div>
</main>
<div class="log-section">
  <div class="log-header">
    <span class="sec-title" style="margin:0">Activity Log</span>
    <span style="font-size:9px;color:var(--muted)" id="logCount">—</span>
  </div>
  <div class="log-list" id="logList"><div class="log-empty">Bot is watching 9 tokens. Trades appear here.</div></div>
</div>
</div>
<script>
const API="";
const TOKENS=[
  {sym:"SOL",name:"Solana",color:"#9945ff"},{sym:"ETH",name:"Ethereum",color:"#627eea"},
  {sym:"BTC",name:"Bitcoin",color:"#f7931a"},{sym:"BONK",name:"Bonk",color:"#ff6b35"},
  {sym:"WIF",name:"dogwifhat",color:"#c4a35a"},{sym:"JUP",name:"Jupiter",color:"#00d4aa"},
  {sym:"PYTH",name:"Pyth Network",color:"#e6dafe"},{sym:"RAY",name:"Raydium",color:"#5ac4be"},
  {sym:"ORCA",name:"Orca",color:"#7c3aed"}
];
let state={autoTrading:false,tradeCount:0,totalPnl:0,lastBuyPrice:0,lastBuyToken:"SOL",log:[],signals:{},prices:{},botWallet:""};

async function fetchStatus(){
  try{
    const r=await fetch(API+"/auto/status");
    const d=await r.json();
    if(d.success){state={...state,...d,log:d.log||[],signals:d.signals||{},prices:state.prices};}
    updateUI();
  }catch(e){}
}
async function fetchPrices(){
  try{
    const r=await fetch(API+"/prices");
    const d=await r.json();
    if(d.success&&d.prices){state.prices=d.prices;updatePrices();}
  }catch(e){}
}
async function fetchWalletBal(){
  if(!state.botWallet||state.botWallet==="NOT LOADED")return;
  try{
    const r=await fetch(API+"/account?wallet="+state.botWallet);
    const d=await r.json();
    if(d.success&&d.balances){
      const sol=d.balances.find(b=>b.asset==="SOL");
      const usdc=d.balances.find(b=>b.asset==="USDC");
      if(sol)document.getElementById("walletBal").textContent=sol.total.toFixed(4)+" SOL";
      if(usdc)document.getElementById("walletUsdc").textContent=usdc.total.toFixed(2)+" USDC";
    }
  }catch(e){}
}
async function toggleBot(){
  const btn=document.getElementById("startBtn");btn.disabled=true;
  const url=API+(state.autoTrading?"/auto/stop":"/auto/start");
  try{
    const r=await fetch(url);await r.json();await fetchStatus();btn.disabled=false;
  }catch(e){btn.disabled=false;}
}
function fmt(price,sym){
  if(!price)return"—";
  if(sym==="BTC")return"$"+Math.round(price).toLocaleString();
  if(sym==="BONK")return"$"+price.toFixed(7);
  if(price<0.01)return"$"+price.toFixed(6);
  if(price<1)return"$"+price.toFixed(4);
  return"$"+price.toFixed(2);
}
function sbClass(sig){
  if(!sig)return"sb-neutral";
  const s=sig.toUpperCase();
  if(s==="STRONG BUY")return"sb-strong-buy";
  if(s==="BUY")return"sb-buy";
  if(s==="STRONG SELL")return"sb-strong-sell";
  if(s==="SELL")return"sb-sell";
  return"sb-neutral";
}
function updateUI(){
  const pill=document.getElementById("statusPill");const pulse=document.getElementById("pulseEl");
  if(state.autoTrading){pill.className="status-pill running";pulse.className="pulse on";document.getElementById("statusText").textContent="Running";document.getElementById("startBtn").textContent="Stop bot";document.getElementById("startBtn").className="btn btn-stop";}
  else{pill.className="status-pill stopped";pulse.className="pulse off";document.getElementById("statusText").textContent="Stopped";document.getElementById("startBtn").textContent="Start bot";document.getElementById("startBtn").className="btn btn-start";}
  const pnl=parseFloat(state.totalPnl)||0;
  const pnlEl=document.getElementById("pnlValue");
  pnlEl.textContent=(pnl>=0?"+$":"-$")+Math.abs(pnl).toFixed(4);
  pnlEl.className="pnl-value "+(pnl>0?"positive":pnl<0?"negative":"zero");
  document.getElementById("pnlSub").textContent=state.tradeCount+" trade"+(state.tradeCount!==1?"s":"")+" · "+(state.autoTrading?"watching":"stopped");
  document.getElementById("statTrades").textContent=state.tradeCount;
  if(state.lastBuyPrice>0){
    document.getElementById("statPos").textContent=state.lastBuyToken||"SOL";
    document.getElementById("statBuy").textContent="$"+state.lastBuyPrice.toFixed(state.lastBuyPrice<1?4:2);
    const cur=state.prices?.[state.lastBuyToken]?.usd;
    if(cur){const pp=((cur-state.lastBuyPrice)/state.lastBuyPrice)*100;const el=document.getElementById("statPnl");el.textContent=(pp>=0?"+":"")+pp.toFixed(2)+"%";el.style.color=pp>=0?"var(--teal)":"var(--red)";}
  }else{document.getElementById("statPos").textContent="None";document.getElementById("statBuy").textContent="—";document.getElementById("statPnl").textContent="—";document.getElementById("statPnl").style.color="";}
  document.getElementById("walletAddr").textContent=state.botWallet||"Not loaded";
  updateTokenGrid();updateLog();
  document.getElementById("lastUpdate").textContent="Updated "+new Date().toLocaleTimeString();
}
function updatePrices(){
  const p=state.prices;
  const hdr={SOL:"hSOL",ETH:"hETH",BTC:"hBTC",BONK:"hBONK",WIF:"hWIF"};
  for(const[sym,id] of Object.entries(hdr)){const el=document.getElementById(id);if(el&&p[sym]?.usd)el.textContent=fmt(p[sym].usd,sym);}
  updateTokenGrid();
}
function updateTokenGrid(){
  const grid=document.getElementById("tokenGrid");
  grid.innerHTML=TOKENS.map(t=>{
    const price=state.prices?.[t.sym];const sig=state.signals?.[t.sym]||{};
    const rsi=sig.rsi||50;const rsiColor=rsi<30?"var(--teal)":rsi>70?"var(--red)":"var(--amber)";
    const signalStr=sig.signal||"Neutral";
    const cardClass=signalStr==="STRONG BUY"||signalStr==="BUY"?"signal-buy":signalStr==="STRONG SELL"||signalStr==="SELL"?"signal-sell":"";
    const changeStr=price?.change24h!=null&&price.change24h!==0?"<span class='"+(price.change24h>=0?"up":"dn")+"'>"+(price.change24h>=0?"+":"")+price.change24h.toFixed(2)+"%</span>":"";
    return"<div class='token-card "+cardClass+" fade-in'><div class='tc-sym' style='color:"+t.color+"'>"+t.sym+"</div><div class='tc-name'>"+t.name+"</div><div class='tc-price'>"+fmt(price?.usd,t.sym)+"</div><div class='tc-change'>"+(changeStr||"—")+"</div><span class='signal-badge "+sbClass(signalStr)+"'>"+signalStr+"</span><div class='rsi-bar'><div class='rsi-fill' style='width:"+Math.min(100,rsi)+"%;background:"+rsiColor+"'></div></div><div class='rsi-label'><span>RSI "+rsi+"</span><span>Conf "+(sig.confidence||40)+"%</span></div></div>";
  }).join("");
}
function updateLog(){
  const list=document.getElementById("logList");
  if(!state.log||!state.log.length){list.innerHTML='<div class="log-empty">Bot is watching 9 tokens. Trades appear here.</div>';return;}
  document.getElementById("logCount").textContent=state.log.length+" entries";
  list.innerHTML=state.log.slice(0,40).map(e=>{
    const sigColor=e.signal?.includes("BUY")?"var(--teal)":e.signal?.includes("SELL")?"var(--red)":"var(--muted)";
    const actColor=e.action?.includes("BOUGHT")||e.action?.includes("PROFIT")?"var(--teal)":e.action?.includes("STOP")?"var(--red)":e.action?.includes("FAIL")?"var(--amber)":"var(--muted)";
    const pnlStr=e.pnlPct!=null?"<span style='color:"+(e.pnlPct>=0?"var(--teal)":"var(--red)")+"'>"+(e.pnlPct>=0?"+":"")+e.pnlPct+"%</span>":"—";
    const txStr=e.explorerUrl?"<a href='"+e.explorerUrl+"' target='_blank'>View →</a>":"—";
    return"<div class='log-row fade-in'><span class='log-time'>"+new Date(e.time).toLocaleTimeString()+"</span><span class='log-price'>"+(e.price?"$"+e.price.toFixed(2):"—")+"</span><span style='color:"+sigColor+";font-size:10px'>"+(e.signal||"—")+"</span><span class='log-action' style='color:"+actColor+"'>"+(e.action||"—")+"</span><span>"+pnlStr+"</span><span class='log-tx'>"+txStr+"</span></div>";
  }).join("");
}
async function init(){
  await fetchStatus();await fetchPrices();await fetchWalletBal();
  setInterval(fetchStatus,15000);setInterval(fetchPrices,30000);setInterval(fetchWalletBal,60000);
}
init();
</script>
</body>
</html>`;

const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(()=>{
  try{const u=new URL(SELF_URL+"/health");const mod=u.protocol==="https:"?https:http;mod.get({hostname:u.hostname,path:u.pathname,port:u.port||undefined,headers:{"User-Agent":"keepalive"}},()=>{}).on("error",()=>{});}catch(e){}
},9*60*1000);
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
let autoConfig={amount:1000000,slippageBps:100,intervalSecs:60,takeProfitPct:3,stopLossPct:2,minConfidence:60};
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

  if(p==="/"||p==="/dashboard"){cors(res);res.writeHead(200,{"Content-Type":"text/html"});return res.end(DASHBOARD_HTML);}

  if(p==="/health")return out(res,{ok:true,exchange:"jupiter+helius",botWallet:botPubKey?b58encode(botPubKey):"NOT LOADED",autoTrading,tradeCount,totalPnl:+totalPnl.toFixed(4),lastBuyPrice,lastBuyToken,ts:new Date().toISOString()});

  if(p==="/prices"){
    try{const all=await fetchAllPrices();for(const[sym,price] of Object.entries(all)){if(price?.usd&&priceHistory[sym]!==undefined){priceHistory[sym].push(price.usd);if(priceHistory[sym].length>100)priceHistory[sym].shift();}}return out(res,{success:true,prices:all});}
    catch(e){return out(res,{success:false,error:e.message});}
  }

  if(p==="/signal"){const s=u.searchParams.get("symbol")||"SOL";return out(res,{success:true,...getSignal(s)});}
  if(p==="/account"){const w=u.searchParams.get("wallet")||(botPubKey?b58encode(botPubKey):null);if(!w)return out(res,{success:false,error:"Pass ?wallet=ADDRESS"});try{
    const solR=await rpc("getBalance",[w]);
    const solBal=(solR.result?.value||0)/1e9;
    const tokR=await rpc("getTokenAccountsByOwner",[w,{mint:TOKENS.USDC},{encoding:"jsonParsed"}]);
    const usdcRaw=tokR.result?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount||0;
    return out(res,{success:true,balances:[{asset:"SOL",free:solBal,locked:0,total:solBal},{asset:"USDC",free:usdcRaw,locked:0,total:usdcRaw}],wallet:w});
  }catch(e){return out(res,{success:false,error:e.message});}}

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
