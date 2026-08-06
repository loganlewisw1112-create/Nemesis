// Determine the taker_book_side convention EMPIRICALLY.
// A print at/below the prevailing bid consumed the BID; at/above the ask consumed the ASK.
// Cross-tabulate that ground truth against (taker_book_side, taker_outcome_side).
const fs=require('fs'),path=require('path');
const rj=f=>fs.readFileSync(path.join(__dirname,f),'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const books=rj('books.jsonl'),trades=rj('trades.jsonl');
const bk={};for(const b of books){(bk[b.tk]=bk[b.tk]||[]).push(b);}for(const k in bk)bk[k].sort((a,b)=>a.t-b.t);
const before=(tk,T)=>{const a=bk[tk];if(!a)return null;let lo=0,hi=a.length-1,r=null;while(lo<=hi){const m=(lo+hi)>>1;if(a[m].t<=T){r=a[m];lo=m+1}else hi=m-1;}return r&&T-r.t<=12000?r:null;};
const tab={};let n=0,amb=0;
for(const t of trades){
  const b=before(t.tk,t.t);if(!b)continue;
  const eps=1e-6;
  let truth=null;
  if(Math.abs(t.p-b.bid)<eps) truth='bid';
  else if(Math.abs(t.p-b.ask)<eps) truth='ask';
  else { amb++; continue; }          // inside/outside the quoted touch: skip, unambiguous only
  const key=`side=${t.side} os=${t.os}`;
  tab[key]=tab[key]||{bid:0,ask:0};
  tab[key][truth]++;n++;
}
console.log(`unambiguous prints matched to a touch: ${n}  (skipped ${amb} not exactly at bid or ask)\n`);
console.log('(taker_book_side, taker_outcome_side)   -> consumed BID    consumed ASK   => implied YES-book side');
for(const [k,v] of Object.entries(tab).sort((a,b)=>(b[1].bid+b[1].ask)-(a[1].bid+a[1].ask))){
  const tot=v.bid+v.ask;
  const implied=v.bid>v.ask?'bid':'ask';
  const purity=(100*Math.max(v.bid,v.ask)/tot).toFixed(1);
  console.log(`${k.padEnd(38)} ${String(v.bid).padStart(9)} ${String(v.ask).padStart(14)}   => ${implied}  (${purity}% consistent, n=${tot})`);
}
