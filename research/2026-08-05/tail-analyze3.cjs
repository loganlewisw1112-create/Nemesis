const fs=require('fs');
const rows=JSON.parse(fs.readFileSync('tail-rows.json','utf8'));
const fee=P=>{const raw=0.07*P*(1-P);const cc=Math.ceil(raw*10000-1e-9)/10000;return Math.ceil(cc*100-1e-9)/100;};
// Wilson score interval. The Wald interval 1.96*sqrt(p(1-p)/n) collapses to ZERO width when
// every outcome is identical, which made degenerate 14-sample series read as infinitely
// significant in the previous pass. Wilson stays honest at p=0 and p=1.
function wilson(k,n,z=1.96){const p=k/n,d=1+z*z/n;
  const c=(p+z*z/(2*n))/d, h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
  return {lo:Math.max(0,c-h),hi:Math.min(1,c+h)};}
const med=a=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]};
const f=v=>(v>=0?'+':'')+v.toFixed(3);
function stat(g){
  const n=g.length, m=g.reduce((s,r)=>s+r.mid,0)/n, k=g.reduce((s,r)=>s+r.res,0), w=k/n;
  const {lo,hi}=wilson(k,n);
  const sp=med(g.map(r=>r.ask-r.bid)), rt=sp+2*fee(m);
  // significant only if the WHOLE Wilson interval sits off the quoted mid
  const sig = m<lo || m>hi;
  const shortfall = m<lo ? lo-m : (m>hi ? m-hi : 0);   // conservative edge estimate
  const degenerate = k===0 || k===n;                    // all one outcome: direction, not mispricing
  return {n,m,w,edge:w-m,lo,hi,sp,rt,sig,shortfall,degenerate};
}
console.log('=== 1. BOOK QUALITY: does the edge survive where the mid is a real probability? ===');
console.log('filter              n   mid    real   edge    Wilson CI        sig?');
for(const [lab,fl] of [['all',()=>true],['spread<=0.02',r=>r.ask-r.bid<=0.0201],['spread<=0.03',r=>r.ask-r.bid<=0.0301],['spread<=0.05',r=>r.ask-r.bid<=0.0501]]){
  const g=rows.filter(fl); if(g.length<25)continue; const s=stat(g);
  console.log(`${lab.padEnd(18)} ${String(s.n).padStart(4)} ${s.m.toFixed(3)}  ${s.w.toFixed(3)}  ${f(s.edge)}  [${s.lo.toFixed(3)},${s.hi.toFixed(3)}]   ${s.sig?'YES':'no'}`);
}
console.log('\n=== 2. SERIES, with Wilson CI and degenerate-outcome flag ===');
const bySer={};for(const r of rows)(bySer[r.ser]=bySer[r.ser]||[]).push(r);
const cands=Object.entries(bySer).filter(([,g])=>g.length>=8).map(([ser,g])=>({ser,cat:g[0].cat,...stat(g)}));
const tradeable=cands.filter(c=>c.sig&&c.shortfall>c.rt);
console.log('series                      cat          n  mid  real   edge   WilsonCI       cost  degen  verdict');
for(const c of [...cands].sort((a,b)=>b.shortfall-a.shortfall).slice(0,20))
  console.log(`${c.ser.slice(0,26).padEnd(27)} ${String(c.cat).slice(0,10).padEnd(11)} ${String(c.n).padStart(2)} ${c.m.toFixed(2)} ${c.w.toFixed(2)}  ${f(c.edge)} [${c.lo.toFixed(2)},${c.hi.toFixed(2)}]  ${c.rt.toFixed(3)}  ${c.degenerate?'YES ':'no  '}  ${c.sig?(c.shortfall>c.rt?'** beats cost **':'sig<cost'):'not sig'}`);
console.log(`\nseries judged: ${cands.length}`);
console.log(`significant (Wilson): ${cands.filter(c=>c.sig).length}   of which degenerate (all-one-outcome): ${cands.filter(c=>c.sig&&c.degenerate).length}`);
console.log(`beats round-trip cost: ${tradeable.length}   of which degenerate: ${tradeable.filter(c=>c.degenerate).length}`);
console.log(`beats cost AND non-degenerate: ${tradeable.filter(c=>!c.degenerate).length}`);
console.log(`\nMULTIPLE COMPARISONS: ${cands.length} series at 95% => ~${(cands.length*0.05).toFixed(1)} expected by chance; ${cands.filter(c=>c.sig).length} observed significant.`);

// 3. The directional-artifact test: within a series, are outcomes one-sided because the
// UNDERLYING trended over the sample window? Split by settle time; a real mispricing persists,
// a trend artifact does not.
console.log('\n=== 3. DIRECTIONAL ARTIFACT CHECK (commodities/max-min style) ===');
console.log('If a series edge comes from a trending underlying, its outcome share is one-sided AND');
console.log('near-identical in both halves of the window; a genuine mispricing would still show');
console.log('mixed outcomes. Reporting outcome share by half for the top-edge series:');
for(const c of [...cands].sort((a,b)=>b.shortfall-a.shortfall).slice(0,10)){
  const g=bySer[c.ser].slice().sort((a,b)=>(a.tk>b.tk?1:-1));
  const h1=g.slice(0,Math.floor(g.length/2)),h2=g.slice(Math.floor(g.length/2));
  const sh=a=>a.length?(a.reduce((s,r)=>s+r.res,0)/a.length).toFixed(2):'n/a';
  console.log(`   ${c.ser.slice(0,26).padEnd(27)} overall=${c.w.toFixed(2)}  h1=${sh(h1)} h2=${sh(h2)}  ${c.degenerate?'<== ALL ONE OUTCOME':''}`);
}
