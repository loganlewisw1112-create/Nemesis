// Back-of-queue correction done WITHIN series, so thin-book series can't masquerade
// as a queue-position effect via composition.
const fs=require('fs'),path=require('path');
const DIR=__dirname;
const readJsonl=f=>fs.readFileSync(path.join(DIR,f),'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const books=readJsonl('books.jsonl'), trades=readJsonl('trades.jsonl');
const bk={};for(const b of books){(bk[b.tk]=bk[b.tk]||[]).push(b);}for(const k in bk)bk[k].sort((a,b)=>a.t-b.t);
const TOL=12000;
function before(tk,T){const a=bk[tk];if(!a)return null;let lo=0,hi=a.length-1,best=null;
  while(lo<=hi){const m=(lo+hi)>>1;if(a[m].t<=T){best=a[m];lo=m+1}else hi=m-1;}
  return best&&T-best.t<=TOL?best:null;}
function after(tk,T){const a=bk[tk];if(!a)return null;let lo=0,hi=a.length-1,best=null;
  while(lo<=hi){const m=(lo+hi)>>1;if(a[m].t>=T){best=a[m];hi=m-1}else lo=m+1;}
  return best&&best.t-T<=TOL?best:null;}
const H=[30,60,120];
const obs=[];
for(const t of trades){
  const pre=before(t.tk,t.t);if(!pre)continue;
  let D=(t.side==='ask')?1:-1; if(t.os==='no')D=-D; D=-D;      // calibrated sign (mean ES>0)
  const M=(pre.bid+pre.ask)/2;
  const rec={ser:t.tk.split('-')[0],q:t.q,D,ES:2*D*(t.p-M),RS:{}};
  const rest=(D>0)?pre.as:pre.bs;
  rec.sweep = rest>0 && t.q>=rest;
  rec.restSize=rest;
  for(const h of H){const po=after(t.tk,t.t+h*1000);if(po)rec.RS[h]=2*D*(t.p-(po.bid+po.ask)/2);}
  obs.push(rec);
}
const wm=(a,f)=>{let n=0,d=0;for(const x of a){const v=f(x);if(v==null||!isFinite(v))continue;n+=v*x.q;d+=x.q;}return d?n/d:null;};
const fmt=v=>v==null?'  n/a':((v>=0?'+':'')+(v*100).toFixed(2)+'c');
const bySer={};for(const o of obs)(bySer[o.ser]=bySer[o.ser]||[]).push(o);
console.log('WITHIN-SERIES back-of-queue comparison (size-weighted RS)\n');
console.log('series        subset      n     ES      RS30     RS60    RS120   medDepth');
for(const [s,rows] of Object.entries(bySer).sort((a,b)=>b[1].length-a[1].length)){
  for(const [lab,sub] of [['ALL',rows],['sweep',rows.filter(o=>o.sweep)],['non-sweep',rows.filter(o=>!o.sweep&&o.restSize>0)]]){
    if(sub.length<40){console.log(`${s.padEnd(13)} ${lab.padEnd(10)} ${String(sub.length).padStart(5)}   (too few)`);continue}
    const dep=sub.map(o=>o.restSize).filter(x=>x>0).sort((a,b)=>a-b);
    console.log(`${s.padEnd(13)} ${lab.padEnd(10)} ${String(sub.length).padStart(5)}  ${fmt(wm(sub,o=>o.ES))}  ${fmt(wm(sub,o=>o.RS[30]))}  ${fmt(wm(sub,o=>o.RS[60]))}  ${fmt(wm(sub,o=>o.RS[120]))}  ${dep.length?Math.round(dep[Math.floor(dep.length/2)]):'-'}`);
  }
  console.log('');
}
