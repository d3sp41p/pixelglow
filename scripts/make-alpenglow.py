import os, re
os.chdir(r'C:\Users\MSI\OneDrive\Desktop\ДРУГОЕ\димка пиксели\app\public')
s = open('index.html', encoding='utf-8').read()

def sub(a, b):
    global s
    assert s.count(a) == 1, (s.count(a), a[:80])
    s = s.replace(a, b)

# ---------- palette: night sky, dusk violet, the rose-and-peach light on snow ----------
sub("""    --bg:#000000; --surface:#111111; --surface-2:#232323; --mid:#1e0d4d;
    --ink:#ffffff; --muted:#a9a9b8; --accent:#d8ff00; --accent-ink:#000000; --accent-2:#c6ea00;
    --field:#7027ff; --on-field:#ffffff; --on-field-2:#e3d8ff; --field-2:#5814e6;
    --glow:#d8ff00; --glow-ink:#000000;
    --px-a:#151515; --px-b:#101010; --px-bg:#121212; --rival-1:#3d3a4f; --rival-2:#5c586f; --rival-3:#2c2a38; --rival-4:#7a7590;""",
"""    /* Alpenglow: the rose and peach light that hits snowy peaks after sunset, over a night-blue sky */
    --bg:#0b0f26; --surface:#141a3a; --surface-2:#222a5c; --mid:#2c2150;
    --ink:#f7efe8; --muted:#aeb0d6; --accent:#ffb38a; --accent-ink:#1a0f2e; --accent-2:#ffc7a6;
    --field:#c94c7f; --on-field:#fff5ef; --on-field-2:#ffdbe4; --field-2:#a83f6b;
    --glow:#ffb38a; --glow-ink:#1a0f2e;
    --px-a:#161c40; --px-b:#121838; --px-bg:#141a3b; --rival-1:#4a4f86; --rival-2:#6c5f9a; --rival-3:#3b3f6e; --rival-4:#8a7fb5;""")
sub('<title>Pixelglow — claim the chain</title>', '<title>Pixelglow — claim the chain (alpenglow)</title>\n<meta name="robots" content="noindex">')

# ---------- the pixel Alps ----------
sub("</style>", """
  /* pixel Alps: a scene drawn on a small canvas and scaled up without smoothing */
  canvas.alp{display:block;width:100%;image-rendering:pixelated;image-rendering:crisp-edges}
  .card canvas.alp{height:156px;margin:0 -28px;width:calc(100% + 56px)}
  .card .band{display:none}
  footer{background:#0d1132;padding-top:0}
  footer canvas.alp{height:220px;margin-bottom:28px}
  .word{margin-top:-6px}
  @media (max-width:900px){.card canvas.alp{height:124px;margin:0 -20px;width:calc(100% + 40px)}footer canvas.alp{height:150px}}
</style>""")
sub('<div class="band" id="band" aria-hidden="true"></div>',
    '<canvas class="alp" data-seed="11" data-snow="1" aria-hidden="true"></canvas>\n        <div class="band" id="band" aria-hidden="true"></div>')
sub('<footer id="buy">\n  <div class="wrap">',
    '<footer id="buy">\n  <canvas class="alp" data-seed="4" data-near="#0d1132" aria-hidden="true"></canvas>\n  <div class="wrap">')
sub("WORDCOL=['#14f195','#19a7f3','#ff4fa3','#ffb627','#d6ff2e','#ff7a2e','#0fb5a8','#ff4766'];",
    "WORDCOL=['#ffe2b0','#ffc29a','#ff9a8a','#ee6f86','#c94c87','#ee6f86','#ff9a8a','#ffc29a','#ffe2b0'];")

alps = r'''<script>
// Pixel Alps at alpenglow: sky in stepped bands from night to sunset, three ridges, west-facing slopes and snow
// lit rose and peach, a few twinkling stars. Deterministic per seed, redrawn on resize.
(function(){
  const SKY=['#0b0f26','#11163a','#1a1c4d','#262163','#38246f','#4f2a7c','#6b2f86','#8c368a','#b04489','#d45487','#ee6f86','#ff8f88','#ffb08f','#ffcf9e','#ffe6b8'];
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd=(seed)=>{let t=seed>>>0;return()=>{t+=0x6D2B79F5;let r=Math.imul(t^t>>>15,1|t);r^=r+Math.imul(r^r>>>7,61|r);return((r^r>>>14)>>>0)/4294967296;};};
  function ridge(w,base,amp,rough,R){ // smooth random skyline, one height per column
    const pts=[];let v=0;for(let i=0;i<=Math.ceil(w/6)+2;i++)pts.push(R());
    const out=[];for(let x=0;x<w;x++){const f=x/6,i=Math.floor(f),t=f-i,s=t*t*(3-2*t);
      v=pts[i]*(1-s)+pts[i+1]*s;out.push(Math.round(base-amp*v-(R()-.5)*rough));}
    for(let k=0;k<2;k++)for(let x=1;x<w-1;x++)out[x]=Math.round((out[x-1]+out[x]*2+out[x+1])/4);
    return out;
  }
  function draw(cv){
    const px=window.innerWidth<600?4:5, w=Math.max(40,Math.round(cv.clientWidth/px)), h=Math.max(20,Math.round(cv.clientHeight/px));
    cv.width=w;cv.height=h;const ctx=cv.getContext('2d'),R=rnd(+cv.dataset.seed||1);
    const set=(x,y,c)=>{ctx.fillStyle=c;ctx.fillRect(x,y,1,1);};
    // sky: stepped bands with a dithered seam between each pair
    const bandH=(h*.66)/SKY.length; // the warm bands end just above the peaks, where the glow shows
    for(let y=0;y<h;y++){const b=Math.min(SKY.length-1,Math.floor(y/bandH)),frac=y/bandH-b;
      for(let x=0;x<w;x++){const next=SKY[Math.min(SKY.length-1,b+1)];set(x,y,frac>.7&&((x+y)&1)?next:SKY[b]);}}
    // stars in the dark part of the sky
    const stars=[];for(let i=0;i<w*h/90;i++){const x=(R()*w)|0,y=(R()*h*.38)|0;stars.push([x,y,SKY[Math.floor(y/bandH)]]);set(x,y,R()<.3?'#ffe6b8':'#cdd2ff');}
    cv._stars=stars;
    // far ridge: dusk violet, faintly lit
    const far=ridge(w,h*.72,h*.3,1.5,R);
    for(let x=0;x<w;x++)for(let y=far[x];y<h;y++)set(x,y,(x>0&&far[x]<far[x-1]&&y-far[x]<3)?'#8a4f8f':'#3c2f6e');
    // main ridge: rock, snow above the snowline, west-facing faces in alpenglow
    const mid=ridge(w,h*.9,h*.55,2,R),snowline=h*.58;
    for(let x=0;x<w;x++){const lit=x>0&&mid[x]<=mid[x-1];
      for(let y=mid[x];y<h;y++){const snow=cv.dataset.snow&&y<snowline+(x%5)-2&&y-mid[x]<6;
        set(x,y,snow?(lit?(y-mid[x]<2?'#ffe6d2':'#ffbfae'):'#8f93cc'):(lit&&y-mid[x]<4?'#b9577f':(lit?'#5a3a7c':'#2a2452')));}}
    // near ridge: night silhouette that melts into the page
    const near=ridge(w,h*1.02,h*.28,1,R),nc=cv.dataset.near||getComputedStyle(cv.parentElement).backgroundColor||'#141a3a';
    for(let x=0;x<w;x++)for(let y=near[x];y<h;y++)set(x,y,y===near[x]&&x>0&&near[x]<near[x-1]?'#3d2a5e':nc);
  }
  const scenes=[...document.querySelectorAll('canvas.alp')];
  const drawAll=()=>scenes.forEach(draw);
  drawAll();
  let rt=0;addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(drawAll,150);});
  if(!reduce)setInterval(()=>{if(document.hidden)return;for(const cv of scenes){const st=cv._stars;if(!st||!st.length)continue;
    const ctx=cv.getContext('2d');for(let k=0;k<3;k++){const [x,y,bg]=st[(Math.random()*st.length)|0];ctx.fillStyle=Math.random()<.5?bg:'#ffe6b8';ctx.fillRect(x,y,1,1);}}},500);
})();
</script>
<script type="module" src="/app.js"></script>'''
sub('<script type="module" src="/app.js"></script>', alps)
open('alpenglow.html', 'w', encoding='utf-8').write(s)
print('ok', len(s))
