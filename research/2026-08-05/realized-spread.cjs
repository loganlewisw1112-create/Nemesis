// Realized-spread / adverse-selection analyzer for Kalshi maker viability.
//
// Implements the standard decomposition:
//   ES_i    = 2 * D_i * (P_i - M_i)                 effective spread (taker cost)
//   RS_i(t) = 2 * D_i * (P_i - M_{i+t})             realized spread  (MAKER revenue net of adverse selection)
//   PI_i(t) = 2 * D_i * (M_{i+t} - M_i)             price impact     (permanent/informational)
//   identity: ES = RS + PI
//
// D_i = +1 if the TAKER BOUGHT, -1 if the taker sold. We are handed the taker side by
// Kalshi, so we skip Lee-Ready inference entirely -- but the yes/no outcome-side encoding
// is easy to get backwards, so the sign convention is CALIBRATED FROM THE DATA:
// in a well-formed book a marketable order executes at or through the mid, so mean ES
// must be >= 0. If it comes out negative we have D inverted and we flip it, loudly.
//
// THE CORRECTION THAT MATTERS: tape-wide RS is an UPPER BOUND for a new entrant, not an
// estimate. Time priority means a back-of-queue order is only filled by prints large
// enough to consume everyone ahead of it -- disproportionately informed flow. So we also
// compute RS restricted to "sweep" prints (those consuming >= the full visible resting
// size at that side a moment earlier), which proxies what a back-of-queue maker actually gets.
const fs=require('fs'),path=require('path');
const DIR=__dirname;
const HORIZONS=[30,60,120,300];           // seconds
const readJsonl=f=>{const p=path.join(DIR,f);if(!fs.existsSync(p))return[];
  return fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);};

const books=readJsonl('books.jsonl');
const trades=readJsonl('trades.jsonl');
if(!books.length||!trades.length){console.log('need both books.jsonl and trades.jsonl');process.exit(0);}

// index book snapshots per ticker, time-sorted
const bk={};
for(const b of books){(bk[b.tk]=bk[b.tk]||[]).push(b);}
for(const k in bk) bk[k].sort((a,b)=>a.t-b.t);

// mid at-or-before time T (prevailing quote), and at-or-after T (for horizon lookups)
function midBefore(tk,T,tolMs){const a=bk[tk];if(!a)return null;
  let lo=0,hi=a.length-1,best=null;
  while(lo<=hi){const m=(lo+hi)>>1; if(a[m].t<=T){best=a[m];lo=m+1}else hi=m-1;}
  if(!best)return null; if(T-best.t>tolMs)return null;
  return {mid:(best.bid+best.ask)/2,bid:best.bid,ask:best.ask,bs:best.bs,as:best.as,t:best.t};}
function midAfter(tk,T,tolMs){const a=bk[tk];if(!a)return null;
  let lo=0,hi=a.length-1,best=null;
  while(lo<=hi){const m=(lo+hi)>>1; if(a[m].t>=T){best=a[m];hi=m-1}else lo=m+1;}
  if(!best)return null; if(best.t-T>tolMs)return null;
  return {mid:(best.bid+best.ask)/2,t:best.t};}

// Nearest-snapshot tolerance. MUST stay well below the price-move timescale or the
// "prevailing mid" is stale and ES/RS become garbage -- the first pass ran at 45s against
// a 40s book cadence and produced impossible values (ES=-11c, RS=-86c on a $1 contract).
// Collector now snapshots every 10s, so 12s keeps the quote genuinely prevailing.
const TOL=Number(process.env.RS_TOL_MS||12000);
// build observations
function build(sign){
  const obs=[];
  for(const t of trades){
    const pre=midBefore(t.tk,t.t,TOL); if(!pre)continue;
    // Direction: D=+1 when the taker CONSUMED THE ASK (a buy).
    // `taker_book_side` names the side the taker's OWN order sat on, so a buyer ('bid')
    // lifts the ask. Established empirically in sidecheck.cjs against 53,949 prints matched
    // to a prevailing quote: side=bid consumed the ask 32,681 vs 4,913 (86.9%), side=ask
    // consumed the bid 12,952 vs 3,403 (79.2%). `taker_outcome_side` adds nothing -- it is
    // perfectly correlated with taker_book_side in every observed row.
    // The PREVIOUS version derived this from the sign of mean ES and got side=ask backwards,
    // mis-signing 30% of prints. An aggregate self-consistency check cannot catch a flipped
    // subset, which is why this is now pinned to measured ground truth.
    let D=(t.side==='bid')?1:-1;
    D*=sign;
    const rec={tk:t.tk,ser:t.tk.split('-')[0],t:t.t,P:t.p,q:t.q,D,M:pre.mid,bid:pre.bid,ask:pre.ask,
      restBid:pre.bs,restAsk:pre.as,ES:2*D*(t.p-pre.mid),RS:{},PI:{}};
    for(const h of HORIZONS){
      const post=midAfter(t.tk,t.t+h*1000,TOL);
      if(!post)continue;
      rec.RS[h]=2*D*(t.p-post.mid);
      rec.PI[h]=2*D*(post.mid-pre.mid);
    }
    obs.push(rec);
  }
  return obs;
}
let obs=build(1);
const meanES=obs.reduce((s,o)=>s+o.ES,0)/Math.max(obs.length,1);
let sign=1;
if(meanES<0){sign=-1;obs=build(-1);console.log(`!! direction convention INVERTED (mean ES was ${meanES.toFixed(4)}); flipped and recomputed`);}
const meanES2=obs.reduce((s,o)=>s+o.ES,0)/Math.max(obs.length,1);
console.log(`observations: ${obs.length}   mean effective spread: ${(meanES2*100).toFixed(3)}c  (must be >=0 to be well-formed)`);

const wmean=(a,f,w)=>{let n=0,d=0;for(const x of a){const ww=w?w(x):1;const v=f(x);if(v==null||!isFinite(v))continue;n+=v*ww;d+=ww;}return d?n/d:null;};
const fmt=v=>v==null?'   n/a':((v>=0?'+':'')+(v*100).toFixed(2)+'c');

function report(label,rows){
  if(rows.length<25){console.log(`\n${label}: n=${rows.length} (too few)`);return;}
  const es=wmean(rows,o=>o.ES,o=>o.q);
  let line=`\n${label}  n=${rows.length}  ES=${fmt(es)}`;
  console.log(line);
  console.log('   horizon    RS (maker revenue)   PI (adverse selection)   n');
  for(const h of HORIZONS){
    const sub=rows.filter(o=>o.RS[h]!=null);
    if(sub.length<15)continue;
    const rs=wmean(sub,o=>o.RS[h],o=>o.q), pi=wmean(sub,o=>o.PI[h],o=>o.q);
    console.log(`   ${String(h).padStart(4)}s      ${fmt(rs)}                ${fmt(pi)}          ${sub.length}`);
  }
}

// 1. whole tape (UPPER BOUND -- mixes all queue positions)
report('ALL SERIES (tape-wide upper bound)',obs);

// 2. per series
const bySer={};for(const o of obs)(bySer[o.ser]=bySer[o.ser]||[]).push(o);
for(const [s,rows] of Object.entries(bySer).sort((a,b)=>b[1].length-a[1].length))
  report(`series ${s}`,rows);

// 3. per price band (never trust an all-strikes average)
const bands=[[0.02,0.15],[0.15,0.35],[0.35,0.65],[0.65,0.85],[0.85,0.98]];
console.log('\n===== BY PRICE BAND (tape-wide) =====');
for(const [lo,hi] of bands) report(`price ${lo}-${hi}`,obs.filter(o=>o.M>=lo&&o.M<hi));

// 4. BACK-OF-QUEUE PROXY: prints that consumed >= the full visible resting size on the
//    side they hit. A new maker joining the back only gets filled by these.
console.log('\n===== BACK-OF-QUEUE PROXY (sweep prints only) =====');
console.log('A new entrant sits behind the whole visible queue, so only prints that consume it reach them.');
const sweeps=obs.filter(o=>{
  const rest=(o.D>0)?o.restAsk:o.restBid;      // taker bought -> consumed ask side
  return rest>0 && o.q>=rest;
});
report('SWEEP PRINTS (what a back-of-queue maker actually gets)',sweeps);
const nonsweep=obs.filter(o=>{const rest=(o.D>0)?o.restAsk:o.restBid;return rest>0&&o.q<rest;});
report('non-sweep prints (front-of-queue makers get these)',nonsweep);

fs.writeFileSync(path.join(DIR,'realized-spread-obs.json'),JSON.stringify({sign,n:obs.length,
  sweeps:sweeps.length,nonsweep:nonsweep.length}));
console.log('\nNOTE: RS>0 means the maker profits net of adverse selection, BEFORE fees.');
console.log('Maker fee on a `quadratic` series is ZERO, so RS maps ~directly to maker P&L per contract.');
console.log('The SWEEP number is the one that matters for us. The tape-wide number is an upper bound.');
