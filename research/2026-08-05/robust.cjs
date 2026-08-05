const fs=require('fs'),path=require('path');
const rj=f=>fs.readFileSync(path.join(__dirname,f),'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const books=rj('books.jsonl'),trades=rj('trades.jsonl');
const bk={};for(const b of books){(bk[b.tk]=bk[b.tk]||[]).push(b);}for(const k in bk)bk[k].sort((a,b)=>a.t-b.t);
const TOL=12000;
const before=(tk,T)=>{const a=bk[tk];if(!a)return null;let lo=0,hi=a.length-1,b=null;while(lo<=hi){const m=(lo+hi)>>1;if(a[m].t<=T){b=a[m];lo=m+1}else hi=m-1;}return b&&T-b.t<=TOL?b:null;};
const after=(tk,T)=>{const a=bk[tk];if(!a)return null;let lo=0,hi=a.length-1,b=null;while(lo<=hi){const m=(lo+hi)>>1;if(a[m].t>=T){b=a[m];hi=m-1}else lo=m+1;}return b&&b.t-T<=TOL?b:null;};
function obsFor(pref,filt){
  const out=[];
  for(const t of trades){
    if(!t.tk.startsWith(pref+'-'))continue;
    if(filt&&!filt(t))continue;
    const pre=before(t.tk,t.t);if(!pre)continue;
    let D=(t.side==='ask')?1:-1;if(t.os==='no')D=-D;D=-D;
    const po=after(t.tk,t.t+60000);if(!po)continue;
    out.push({tk:t.tk,t:t.t,v:2*D*(t.p-(po.bid+po.ask)/2),q:t.q,ev:t.tk.split('-').slice(0,2).join('-')});
  }
  return out;
}
const wm=a=>a.length?a.reduce((s,x)=>s+x.v*x.q,0)/a.reduce((s,x)=>s+x.q,0):null;
const f=v=>v==null?'n/a':((v>=0?'+':'')+(v*100).toFixed(2)+'c');
for(const SER of ['KXCS2GAME','KXITFWMATCH','KXBTCD']){
  const o=obsFor(SER);
  if(o.length<100){console.log(SER,'too few');continue}
  const t0=Math.min(...o.map(x=>x.t)),t1=Math.max(...o.map(x=>x.t)),mid=(t0+t1)/2;
  const h1=o.filter(x=>x.t<mid),h2=o.filter(x=>x.t>=mid);
  const evs={};for(const x of o)(evs[x.ev]=evs[x.ev]||[]).push(x);
  console.log(`\n=== ${SER}  n=${o.length}  overall RS60 ${f(wm(o))}`);
  console.log(`   first half  n=${h1.length}  ${f(wm(h1))}`);
  console.log(`   second half n=${h2.length}  ${f(wm(h2))}`);
  console.log(`   distinct events/matches: ${Object.keys(evs).length}`);
  const rows=Object.entries(evs).filter(([k,v])=>v.length>=40).sort((a,b)=>b[1].length-a[1].length).slice(0,8);
  for(const [ev,v] of rows) console.log(`     ${ev.padEnd(34)} n=${String(v.length).padStart(4)}  ${f(wm(v))}`);
}
