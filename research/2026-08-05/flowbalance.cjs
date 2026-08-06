// The sim showed the binding constraint is FLOW BALANCE, not spread: a symmetric quoter in
// one-sided flow warehouses inventory against the drift. Screen for both together.
// Consumed side = OPPOSITE of taker_book_side (sidecheck.cjs).
const fs=require('fs'),path=require('path');
const rj=f=>fs.readFileSync(path.join(__dirname,f),'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const books=rj('books.jsonl'),trades=rj('trades.jsonl');
const spread={};   // ticker -> median spread
{
  const tmp={};
  for(const b of books){ if(b.bid>0&&b.ask<1){(tmp[b.tk]=tmp[b.tk]||[]).push(b.ask-b.bid);} }
  for(const [tk,a] of Object.entries(tmp)){a.sort((x,y)=>x-y);spread[tk]=a[Math.floor(a.length/2)];}
}
const agg={};
for(const t of trades){
  const consumed = t.side==='bid' ? 'ask' : 'bid';   // taker's own side -> opposite consumed
  const ser=t.tk.split('-')[0];
  for(const key of [`SERIES:${ser}`,`TK:${t.tk}`]){
    const a=agg[key]=agg[key]||{askC:0,bidC:0,n:0,ser};
    if(consumed==='ask')a.askC+=t.q; else a.bidC+=t.q;   // ask consumed = taker BOUGHT
    a.n++;
  }
}
const rows=[];
for(const [k,a] of Object.entries(agg)){
  const tot=a.askC+a.bidC; if(tot<200)continue;
  const buyShare=a.askC/tot;                 // share of flow that was buying (lifting asks)
  const balance=1-Math.abs(buyShare-0.5)*2;  // 1 = perfectly two-sided, 0 = entirely one way
  rows.push({k,ser:a.ser,tot,n:a.n,buyShare,balance});
}
// series-level
console.log('SERIES-LEVEL flow balance vs spread');
console.log('series'.padEnd(16)+'contracts'.padStart(10)+'prints'.padStart(8)+'buyShare'.padStart(10)+'balance'.padStart(9)+'medSpread'.padStart(11)+'  spread x balance');
for(const r of rows.filter(r=>r.k.startsWith('SERIES:')).sort((a,b)=>b.tot-a.tot)){
  const ser=r.k.slice(7);
  const sp=(()=>{const a=Object.entries(spread).filter(([tk])=>tk.startsWith(ser+'-')).map(([,v])=>v).sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:null})();
  const score=sp!=null?sp*r.balance:null;
  console.log(ser.padEnd(16)+String(Math.round(r.tot)).padStart(10)+String(r.n).padStart(8)
    +(100*r.buyShare).toFixed(0).padStart(9)+'%'+r.balance.toFixed(2).padStart(9)
    +(sp!=null?sp.toFixed(3):'  -').padStart(11)+(score!=null?(score*100).toFixed(2)+'c':'  -').padStart(18));
}
// per-ticker: is there a POCKET with both?
console.log('\nTOP TICKERS by (spread x balance) -- need >=400 contracts and balance>=0.6');
const cands=rows.filter(r=>r.k.startsWith('TK:')&&r.tot>=400&&r.balance>=0.6)
  .map(r=>({...r,tk:r.k.slice(3),sp:spread[r.k.slice(3)]}))
  .filter(r=>r.sp!=null).map(r=>({...r,score:r.sp*r.balance}))
  .sort((a,b)=>b.score-a.score);
console.log('ticker'.padEnd(34)+'contracts'.padStart(10)+'buyShare'.padStart(10)+'balance'.padStart(9)+'spread'.padStart(8)+'score'.padStart(9));
for(const r of cands.slice(0,20))
  console.log(r.tk.padEnd(34)+String(Math.round(r.tot)).padStart(10)+(100*r.buyShare).toFixed(0).padStart(9)+'%'
    +r.balance.toFixed(2).padStart(9)+r.sp.toFixed(3).padStart(8)+((r.score*100).toFixed(2)+'c').padStart(9));
console.log(`\n${cands.length} tickers pass balance>=0.6 with >=400 contracts, of ${rows.filter(r=>r.k.startsWith('TK:')&&r.tot>=400).length} liquid enough to judge`);
