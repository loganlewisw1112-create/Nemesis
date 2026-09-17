// Capacity, done per-BOOK and capital-constrained.
// v1 divided total flow across ALL books by ONE book's depth -> 12,627 fills/hr, nonsense.
const fs=require('fs'),path=require('path');
const DIR=__dirname;
const rj=f=>fs.readFileSync(path.join(DIR,f),'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const books=rj('books.jsonl'),trades=rj('trades.jsonl');
const bk={};for(const b of books){(bk[b.tk]=bk[b.tk]||[]).push(b);}for(const k in bk)bk[k].sort((a,b)=>a.t-b.t);
const TOL=12000;
const before=(tk,T)=>{const a=bk[tk];if(!a)return null;let lo=0,hi=a.length-1,b=null;while(lo<=hi){const m=(lo+hi)>>1;if(a[m].t<=T){b=a[m];lo=m+1}else hi=m-1;}return b&&T-b.t<=TOL?b:null;};
const after=(tk,T)=>{const a=bk[tk];if(!a)return null;let lo=0,hi=a.length-1,b=null;while(lo<=hi){const m=(lo+hi)>>1;if(a[m].t>=T){b=a[m];hi=m-1}else lo=m+1;}return b&&b.t-T<=TOL?b:null;};
const CAPITAL=5000, S=25;              // post 25 contracts per book
for(const SER of ['KXCS2GAME','KXITFWMATCH','KXMLBGAME','KXBTCD']){
  const tr=trades.filter(t=>t.tk.startsWith(SER+'-'));
  if(tr.length<200){console.log(SER,'too few');continue}
  const hours=(Math.max(...tr.map(t=>t.t))-Math.min(...tr.map(t=>t.t)))/3.6e6;
  // per-book: flow and depth and RS
  const perBook={};
  for(const t of tr){
    const pre=before(t.tk,t.t);if(!pre)continue;
    let D=(t.side==='ask')?1:-1;if(t.os==='no')D=-D;D=-D;
    const po=after(t.tk,t.t+60000);
    const b=perBook[t.tk]=perBook[t.tk]||{q:0,depths:[],rs:[],px:[]};
    b.q+=t.q;b.px.push(t.p);
    const rest=(D>0)?pre.as:pre.bs; if(rest>0)b.depths.push(rest);
    if(po)b.rs.push({v:2*D*(t.p-(po.bid+po.ask)/2),q:t.q});
  }
  const med=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]};
  let totFills=0,totGross=0,activeBooks=0,capUsed=0;
  const rows=[];
  for(const [tk,b] of Object.entries(perBook)){
    if(b.rs.length<8||!b.depths.length)continue;
    const d=med(b.depths); const flowHr=b.q/hours;          // both sides, this book
    const sideHr=flowHr/2;
    const fills=sideHr*S/(d+S);                              // contracts filled/hr for us
    const rsMean=b.rs.reduce((s,x)=>s+x.v*x.q,0)/b.rs.reduce((s,x)=>s+x.q,0);
    const px=med(b.px)||0.5;
    if(!isFinite(fills)||!isFinite(rsMean))continue;
    rows.push({tk,d,fills,rsMean,px});
  }
  // rank by expected gross, take as many books as capital allows (inventory = S contracts * price)
  rows.sort((a,b)=>b.fills*b.rsMean-a.fills*a.rsMean);
  for(const r of rows){
    const need=S*r.px;                                       // capital to hold one side
    if(capUsed+need>CAPITAL)break;
    capUsed+=need;activeBooks++;totFills+=r.fills;totGross+=r.fills*r.rsMean;
  }
  console.log(`\n=== ${SER}  (${hours.toFixed(2)}h window)`);
  console.log(`  books with usable data: ${rows.length} | quotable within $${CAPITAL}: ${activeBooks} (capital used $${capUsed.toFixed(0)})`);
  console.log(`  median depth ahead: ${Math.round(med(rows.map(r=>r.d)))} contracts`);
  console.log(`  est fills: ${totFills.toFixed(1)} contracts/hr across those books`);
  console.log(`  est GROSS: $${totGross.toFixed(2)}/hr  ->  $${(totGross*8).toFixed(2)} per 8h session`);
}
