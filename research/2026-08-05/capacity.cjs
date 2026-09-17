// Capacity + robustness for the surviving candidate.
// A mean is not enough: check the DISTRIBUTION (tail risk) and whether a $5k account
// can actually earn anything meaningful at the observed flow.
const fs=require('fs'),path=require('path');
const DIR=__dirname;
const rj=f=>fs.readFileSync(path.join(DIR,f),'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const books=rj('books.jsonl'),trades=rj('trades.jsonl');
const bk={};for(const b of books){(bk[b.tk]=bk[b.tk]||[]).push(b);}for(const k in bk)bk[k].sort((a,b)=>a.t-b.t);
const TOL=12000;
const before=(tk,T)=>{const a=bk[tk];if(!a)return null;let lo=0,hi=a.length-1,b=null;while(lo<=hi){const m=(lo+hi)>>1;if(a[m].t<=T){b=a[m];lo=m+1}else hi=m-1;}return b&&T-b.t<=TOL?b:null;};
const after=(tk,T)=>{const a=bk[tk];if(!a)return null;let lo=0,hi=a.length-1,b=null;while(lo<=hi){const m=(lo+hi)>>1;if(a[m].t>=T){b=a[m];hi=m-1}else lo=m+1;}return b&&b.t-T<=TOL?b:null;};
for(const SER of ['KXCS2GAME','KXITFWMATCH','KXMLBGAME','KXBTCD']){
  const tr=trades.filter(t=>t.tk.startsWith(SER+'-'));
  if(!tr.length){console.log(SER,'no trades');continue}
  const t0=Math.min(...tr.map(t=>t.t)),t1=Math.max(...tr.map(t=>t.t));
  const hours=(t1-t0)/3.6e6;
  const totalContracts=tr.reduce((s,t)=>s+t.q,0);
  const rs=[];
  for(const t of tr){
    const pre=before(t.tk,t.t);if(!pre)continue;
    let D=(t.side==='ask')?1:-1;if(t.os==='no')D=-D;D=-D;
    const po=after(t.tk,t.t+60000);if(!po)continue;
    rs.push({v:2*D*(t.p-(po.bid+po.ask)/2),q:t.q,rest:(D>0)?pre.as:pre.bs});
  }
  if(rs.length<50){console.log(SER,'too few obs');continue}
  rs.sort((a,b)=>a.v-b.v);
  const q=p=>rs[Math.floor(rs.length*p)].v;
  const mean=rs.reduce((s,x)=>s+x.v*x.q,0)/rs.reduce((s,x)=>s+x.q,0);
  const posShare=rs.filter(x=>x.v>0).length/rs.length;
  const medDepth=(()=>{const d=rs.map(x=>x.rest).filter(x=>x>0).sort((a,b)=>a-b);return d.length?d[Math.floor(d.length/2)]:0})();
  // capacity: a maker posting size S behind depth D captures ~ S/(D+S) of flow on that side
  const S=25;                        // 25 contracts ~ $12 risk at 50c; conservative for $5k
  const sideFlow=totalContracts/2/Math.max(hours,1e-9);
  const fillsHr=sideFlow*S/(medDepth+S);
  console.log(`\n=== ${SER}`);
  console.log(`  window ${hours.toFixed(2)}h  trades ${tr.length}  contracts ${Math.round(totalContracts)}  obs ${rs.length}`);
  console.log(`  RS60 mean ${(mean*100).toFixed(2)}c | p10 ${(q(.1)*100).toFixed(1)}c  median ${(q(.5)*100).toFixed(1)}c  p90 ${(q(.9)*100).toFixed(1)}c | share>0 ${(posShare*100).toFixed(0)}%`);
  console.log(`  median depth ahead ${Math.round(medDepth)} | posting ${S} contracts -> ~${fillsHr.toFixed(1)} fills/hr`);
  console.log(`  => gross ~$${(fillsHr*mean).toFixed(2)}/hr  (~$${(fillsHr*mean*8).toFixed(2)} per 8h session)`);
}
