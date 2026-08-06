// Is flow balance PREDICTABLE? Split each ticker's prints in half by time; does first-half
// balance predict second-half balance? If not, the selection rule is unusable ex ante.
const fs=require('fs'),path=require('path');
const rj=f=>fs.readFileSync(path.join(__dirname,f),'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const trades=rj('trades.jsonl');
const byTk={};
for(const t of trades){(byTk[t.tk]=byTk[t.tk]||[]).push(t);}
const rows=[];
for(const [tk,a] of Object.entries(byTk)){
  if(a.length<80)continue;
  a.sort((x,y)=>x.t-y.t);
  const mid=Math.floor(a.length/2);
  const bal=arr=>{let ask=0,bid=0;for(const t of arr){if(t.side==='bid')ask+=t.q;else bid+=t.q;}
    const tot=ask+bid;if(tot<=0)return null;const bs=ask/tot;return {buyShare:bs,balance:1-Math.abs(bs-0.5)*2,tot};};
  const h1=bal(a.slice(0,mid)),h2=bal(a.slice(mid));
  if(!h1||!h2||h1.tot<100||h2.tot<100)continue;
  rows.push({tk,ser:tk.split('-')[0],b1:h1.balance,b2:h2.balance,s1:h1.buyShare,s2:h2.buyShare,n:a.length});
}
const corr=(xs,ys)=>{const n=xs.length;const mx=xs.reduce((a,b)=>a+b,0)/n,my=ys.reduce((a,b)=>a+b,0)/n;
  let sxy=0,sxx=0,syy=0;for(let i=0;i<n;i++){const dx=xs[i]-mx,dy=ys[i]-my;sxy+=dx*dy;sxx+=dx*dx;syy+=dy*dy;}
  return sxx>0&&syy>0?sxy/Math.sqrt(sxx*syy):null;};
console.log(`tickers with enough flow in both halves: ${rows.length}\n`);
console.log(`corr(first-half balance, second-half balance) = ${corr(rows.map(r=>r.b1),rows.map(r=>r.b2))?.toFixed(3)}`);
console.log(`corr(first-half buyShare, second-half buyShare) = ${corr(rows.map(r=>r.s1),rows.map(r=>r.s2))?.toFixed(3)}`);
// decision-relevant framing: if we SELECT on first-half balance, what do we get in the second half?
console.log('\nSELECT on first half, MEASURE second half:');
console.log('  first-half filter        n    mean 2nd-half balance   mean 2nd-half buyShare');
for(const [lab,f] of [['all',()=>true],['balance>=0.6',r=>r.b1>=0.6],['balance>=0.7',r=>r.b1>=0.7],['balance>=0.8',r=>r.b1>=0.8]]){
  const g=rows.filter(f);if(g.length<5)continue;
  const mb=g.reduce((s,r)=>s+r.b2,0)/g.length, ms=g.reduce((s,r)=>s+r.s2,0)/g.length;
  console.log(`  ${lab.padEnd(22)} ${String(g.length).padStart(4)}          ${mb.toFixed(3)}                 ${ms.toFixed(3)}`);
}
// per series
console.log('\nby series (mean balance h1 -> h2, and corr):');
const bySer={};for(const r of rows)(bySer[r.ser]=bySer[r.ser]||[]).push(r);
for(const [s,g] of Object.entries(bySer).sort((a,b)=>b[1].length-a[1].length)){
  if(g.length<8)continue;
  console.log(`  ${s.padEnd(14)} n=${String(g.length).padStart(4)}  h1=${(g.reduce((a,r)=>a+r.b1,0)/g.length).toFixed(2)} h2=${(g.reduce((a,r)=>a+r.b2,0)/g.length).toFixed(2)}  corr=${corr(g.map(r=>r.b1),g.map(r=>r.b2))?.toFixed(3)??'n/a'}`);
}
