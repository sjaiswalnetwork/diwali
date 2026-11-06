/* Diwali GIF maker — renders one full animation cycle to an animated GIF in the browser.
   Exposes window.makeDiwaliGif(name, onProgress) -> Promise<Blob>. Encoder: gifenc (MIT).
   25 fps, ~10 s loop. Only changed pixels are stored per frame (transparent + dispose:1) to keep files small. */
(function(){
const S=400, PX=1080;                                                    // draw in 400-unit space, output 1080×1080 pixels
const FPS=30, TOTAL=10.0, FRAMES=Math.round(TOTAL*FPS);                  // 300 frames, true 30 fps
const DELAY=1000/FPS;                                                    // 33.3 ms
// GIF delays are in 1/100 s, so alternate 30/30/40 ms — averages exactly 33.3 ms (no drift)
const delayOf=i=>Math.round((i+1)*100/FPS)*10-Math.round(i*100/FPS)*10;
const TICK=1/60;                                                         // physics step, same as the website
const TOL=10;                                                            // per-pixel change threshold for diffing
const GIFENC='https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js';

// timeline (seconds)
const IGN=2.0;                 // flame catches
const TITLE=IGN+.7;            // शुभ दीपावली / Happy Diwali fade in
const FW0=3.3, FW_GAP=.3, FW_N=16;   // fireworks: 3.3s → 7.8s
const ROW0=3.9, ROW_GAP=.22;   // small diyas light one by one
const QUOTE=4.2;               // the wish / quote
const LOVE=4.9;                // "— with love, Name"
const OUT=9.3;                 // fade to dark for a seamless loop

const DIYA=`<svg xmlns="http://www.w3.org/2000/svg" width="920" height="440" viewBox="0 0 230 110"><defs>
<linearGradient id="clay" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e06a2a"/><stop offset=".55" stop-color="#a8401a"/><stop offset="1" stop-color="#5e1f0a"/></linearGradient>
<radialGradient id="oil" cx=".5" cy=".4" r=".7"><stop offset="0" stop-color="#7a3b0c"/><stop offset="1" stop-color="#2a0f03"/></radialGradient></defs>
<ellipse cx="100" cy="106" rx="66" ry="4" fill="#000" opacity=".35"/>
<path d="M8 40 Q100 26 178 36 L220 18 Q210 44 188 58 Q172 102 96 104 Q20 100 8 40Z" fill="url(#clay)"/>
<path d="M172 38 L214 21 L184 47Z" fill="#3a1606" stroke="#f0a050" stroke-width="2.4" stroke-linejoin="round"/>
<ellipse cx="94" cy="40" rx="86" ry="13" fill="url(#oil)" stroke="#f0a050" stroke-width="3"/>
<path d="M26 60 Q96 76 166 60" fill="none" stroke="#ffcc66" stroke-width="3" stroke-dasharray="2 8" stroke-linecap="round"/>
<path d="M40 78 Q96 90 152 78" fill="none" stroke="#ffcc66" stroke-width="2.4" opacity=".8"/>
<g fill="#ffcc66"><path d="M48 64 l5 7 l-5 7 l-5 -7z"/><path d="M72 66 l5 7 l-5 7 l-5 -7z"/><path d="M96 68 l5 7 l-5 7 l-5 -7z"/><path d="M120 66 l5 7 l-5 7 l-5 -7z"/><path d="M144 64 l5 7 l-5 7 l-5 -7z"/></g>
<path d="M194 34 L208 24" stroke="#f4e3c0" stroke-width="5" stroke-linecap="round"/></svg>`;

function rng(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const ease=t=>{t=clamp(t,0,1);return t*t*(3-2*t)};                       // smoothstep — gentle in and out
const easeOut=t=>1-Math.pow(1-clamp(t,0,1),3);
const pop=t=>{t=clamp(t,0,1);const c=1.4;return 1+(c+1)*Math.pow(t-1,3)+c*Math.pow(t-1,2)}; // soft overshoot

// let the page repaint the progress % — MessageChannel is not throttled like setTimeout in background tabs
const yieldUI=()=>new Promise(res=>{const ch=new MessageChannel();ch.port1.onmessage=()=>res();ch.port2.postMessage(0)});
function loadImg(src){return new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src=src})}

function flame(c,x,by,w,s,f){if(s<=0.01)return;const h=w*1.9;
 c.save();c.translate(x,by);c.scale(s*(1+f*.05),s*(1-f*.04));
 let g=c.createRadialGradient(0,-h*.4,0,0,-h*.4,w*2.6);g.addColorStop(0,'rgba(255,175,70,.5)');g.addColorStop(1,'rgba(255,120,20,0)');
 c.fillStyle=g;c.beginPath();c.arc(0,-h*.4,w*2.6,0,7);c.fill();
 c.beginPath();c.moveTo(0,-h);c.bezierCurveTo(w*.62,-h*.42,w*.62,0,0,0);c.bezierCurveTo(-w*.62,0,-w*.62,-h*.42,0,-h);
 g=c.createRadialGradient(0,-h*.22,0,0,-h*.3,h*.8);g.addColorStop(0,'#fff');g.addColorStop(.2,'#fff0a8');g.addColorStop(.45,'#ffc23d');g.addColorStop(.72,'#ff8a14');g.addColorStop(1,'rgba(255,77,0,.85)');
 c.fillStyle=g;c.fill();c.restore()}

function plan(seed){const r=rng(seed),PAL=['255,200,80','255,120,40','255,70,130','110,210,255','190,120,255','110,255,160','255,240,200'];
 const types=['peony','ring','willow','double','peony','heart','ring','willow','double','peony','ring','willow','heart','peony','double','willow'];
 return types.map((type,i)=>({t:FW0+i*FW_GAP,x:(i%2?225:45)+r()*130,y:62+r()*165,c:PAL[i%PAL.length],c2:PAL[(i+3)%PAL.length],type,seed:r()*1e9|0}))}

function spawn(b,parts){const r=rng(b.seed),sp=3.3+r()*1.4;const add=p=>{p.d=(p.d||.011)*.8;parts.push(Object.assign({l:1,g:.04,fr:.982,c:b.c,px:b.x,py:b.y,age:0},p))};
 if(b.type==='ring'||b.type==='double'){for(let i=0;i<36;i++){const a=Math.PI*2*i/36;add({x:b.x,y:b.y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,st:1.1,dot:1})}
  if(b.type==='double')for(let i=0;i<24;i++){const a=Math.PI*2*i/24+.07;add({x:b.x,y:b.y,vx:Math.cos(a)*sp*.55,vy:Math.sin(a)*sp*.55,c:b.c2,st:1.1,dot:1})}}
 else if(b.type==='willow'){for(let i=0;i<90;i++){const a=r()*7,v=sp*(.2+r()*.8);add({x:b.x,y:b.y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,c:'255,190,90',d:.006,fr:.965,g:.022})}}
 else if(b.type==='heart'){const s=sp*.17;for(let i=0;i<72;i++){const t=Math.PI*2*i/72;add({x:b.x,y:b.y,vx:16*Math.pow(Math.sin(t),3)*s,vy:-(13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t))*s,c:'255,90,150',d:.01,fr:.975,g:.016})}}
 else{for(let i=0;i<110;i++){const a=r()*7,v=sp*(.25+r()*.75);add({x:b.x,y:b.y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,c:r()<.2?'255,248,230':(r()<.5?b.c:b.c2),d:.009+r()*.008})}}}

function wrap(c,text,maxW){const words=text.split(' '),lines=[];let cur='';
 for(const w of words){const t=cur?cur+' '+w:w;if(c.measureText(t).width>maxW&&cur){lines.push(cur);cur=w}else cur=t}
 if(cur)lines.push(cur);return lines}

async function makeDiwaliGif(name,onProgress,quote){
 const {GIFEncoder,quantize,applyPalette}=await import(GIFENC);
 await Promise.all(['36px "Yatra One"','italic 18px Poppins','300 15px Poppins','600 15px Poppins'].map(f=>document.fonts.load(f).catch(()=>{})));
 const diya=await loadImg('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(DIYA));
 const cv=document.createElement('canvas');cv.width=cv.height=PX;const c=cv.getContext('2d',{willReadFrequently:true});
 c.imageSmoothingQuality='high';
 c.font='400 13.5px Poppins';const qLines=quote?wrap(c,quote,330).slice(0,3):[];
 const r=rng(7),stars=[...Array(55)].map((_,i)=>[r()*S,45+r()*250,r()*.6+.25,r()*6,i%4===0]);   // only 1 in 4 twinkles
 const bursts=plan(name.length*131+17),parts=[];let fired=0,ticks=0;
 const gif=GIFEncoder();let ref=null;const sample=new Uint8ClampedArray(Math.ceil(PX*PX/3)*4);
 const DW=186,DH=DW*110/230,DX=(S-DW)/2-8,DY=160, fx=DX+DW*.9055,fy=DY+DH*(1-.77);
 const Q0=270-(qLines.length-1)*9;   // quote block, centred around y≈278

 for(let i=0;i<FRAMES;i++){const t=i*DELAY/1000;
  // physics in real time: same 60 Hz step as the website
  while(ticks*TICK<=t){const tt=ticks*TICK;
   while(fired<bursts.length&&bursts[fired].t<=tt){spawn(bursts[fired],parts);fired++}
   for(let j=parts.length-1;j>=0;j--){const p=parts[j];p.age++;p.px=p.x;p.py=p.y;p.x+=p.vx;p.y+=p.vy;p.vx*=p.fr;p.vy=p.vy*p.fr+p.g;p.l-=p.d;if(p.l<=0)parts.splice(j,1)}
   ticks++}

  // background
  let g=c.createRadialGradient(S/2,S*1.1,10,S/2,S*1.1,S*1.15);g.addColorStop(0,'#3a1020');g.addColorStop(.45,'#1c0c33');g.addColorStop(1,'#0b0820');
  c.setTransform(PX/S,0,0,PX/S,0,0);
  c.globalCompositeOperation='source-over';c.globalAlpha=1;c.shadowBlur=0;c.fillStyle=g;c.fillRect(0,0,S,S);
  for(const [x,y,a,ph,tw] of stars){c.fillStyle=`rgba(255,255,255,${tw?a*(.55+.45*Math.sin(t*2+ph)):a})`;c.fillRect(x,y,1.6,1.6)}

  const glow=ease((t-IGN)/1.5);
  if(glow>0){g=c.createRadialGradient(fx,fy,0,fx,fy,240);g.addColorStop(0,`rgba(255,180,80,${.42*glow})`);g.addColorStop(.35,`rgba(255,130,40,${.16*glow})`);g.addColorStop(1,'rgba(255,100,20,0)');c.fillStyle=g;c.fillRect(0,0,S,S)}

  // rockets + particles (motion-blurred streaks)
  c.globalCompositeOperation='lighter';c.lineCap='round';
  for(const b of bursts){const u=(t-(b.t-.7))/.7;if(u>0&&u<1){const y=S+10-(S+10-b.y)*easeOut(u);
   const ra=.9*clamp((250-y)/30,0,1);if(ra>0){c.strokeStyle=`rgba(255,215,150,${ra})`;c.lineWidth=2.2;c.beginPath();c.moveTo(b.x,y);c.lineTo(b.x,Math.min(y+18,250));c.stroke()}}}
  // sparks bloom in over ~0.12s so bursts don't start as a solid white blob
  for(const p of parts){const al=Math.min(1,p.l*1.3)*clamp(.25+p.age/9,0,1)*clamp((258-p.y)/40,0,1),k=p.st||3;if(al<=0.01)continue;
   c.strokeStyle=`rgba(${p.c},${al})`;c.lineWidth=p.age<6?1.6:2.4;c.beginPath();c.moveTo(p.x-(p.x-p.px)*k,p.y-(p.y-p.py)*k);c.lineTo(p.x,p.y);c.stroke();
   if(p.dot){c.fillStyle=`rgba(${p.c},${al})`;c.beginPath();c.arc(p.x,p.y,1.9,0,7);c.fill()}}
  c.globalCompositeOperation='source-over';

  // diya + flame (smooth flicker, no frame-rate aliasing)
  const flick=.55*Math.sin(t*11)+.35*Math.sin(t*23+1);
  c.drawImage(diya,DX,DY,DW,DH);
  flame(c,fx,fy+2,DW*.07,pop((t-IGN)/.6),flick);

  // row of small diyas
  for(let k=0;k<7;k++){const w=40,x=S/2-((7*w+6*8)/2)+k*(w+8),y=338,a=ease((t-ROW0-k*ROW_GAP)/.4);if(a<=0)continue;
   c.globalAlpha=a;c.drawImage(diya,x,y+(1-a)*10,w,w*110/230);c.globalAlpha=1;
   flame(c,x+w*.9055,y+(1-a)*10+w*110/230*.23+1,w*.075,pop((t-ROW0-.2-k*ROW_GAP)/.45),.55*Math.sin(t*12+k)+.35*Math.sin(t*25+k*2))}

  // text
  c.textAlign='center';
  const hi=1-ease((t-IGN-.3)/.6);
  if(hi>0){c.globalAlpha=hi;c.fillStyle='#d8c7b0';c.font='300 15px Poppins';c.fillText('A Diwali surprise for you',S/2,118);
   const la=clamp((IGN-t)/.3,0,1);
   if(la>0){c.fillStyle='#ffcc66';c.font='600 15px Poppins';c.globalAlpha=la*(.55+.45*Math.sin(t*4));c.fillText('✨ lighting the diya… ✨',S/2,310)}
   c.globalAlpha=1}
  const ta=ease((t-TITLE)/.8);
  if(ta>0){c.globalAlpha=ta;c.shadowColor='rgba(255,160,50,.8)';c.shadowBlur=14;
   c.fillStyle='#ffcc66';c.font='34px "Yatra One"';c.fillText('शुभ दीपावली',S/2,92-(1-ta)*8);
   g=c.createLinearGradient(0,108,0,152);g.addColorStop(0,'#fff3c4');g.addColorStop(.6,'#ffb347');g.addColorStop(1,'#ff7a1a');
   c.fillStyle=g;c.font='46px "Yatra One"';c.fillText('Happy Diwali!',S/2,146-(1-ta)*6);c.shadowBlur=0;c.globalAlpha=1}
  const qa=ease((t-QUOTE)/.9);
  if(qa>0&&qLines.length){c.globalAlpha=qa;c.shadowColor='#0b0820';c.shadowBlur=10;c.fillStyle='#fff6e6';c.font='400 13.5px Poppins';
   qLines.forEach((ln,k)=>c.fillText(ln,S/2,Q0+k*18+(1-qa)*6));c.shadowBlur=0;c.globalAlpha=1}
  const fa=ease((t-LOVE)/.8);
  if(fa>0){c.globalAlpha=fa;c.shadowColor='#0b0820';c.shadowBlur=8;c.fillStyle='#ffcc66';c.font='italic 18px Poppins';
   c.fillText('— with love, '+name,S/2,Q0+qLines.length*18+16);c.shadowBlur=0;c.globalAlpha=1}

  // tiny watermark, bottom-right
  c.textAlign='right';c.fillStyle='rgba(216,199,176,.42)';c.font='italic 300 9px Poppins';c.fillText('made by Sj',S-7,S-6);

  // toran (marigold garland)
  for(let x=-4;x<=S+4;x+=13){const y=4+22*Math.sin(Math.PI*(x+4)/(S+8));
   if(Math.round(x/13)%3===0){c.fillStyle='#2f8a3a';c.beginPath();c.ellipse(x,y+14,3.2,8,0,0,7);c.fill()}
   c.fillStyle=(Math.round(x/13)%2)?'#ffb000':'#ff7a00';c.beginPath();c.arc(x,y,7,0,7);c.fill();
   c.fillStyle='#b34700';c.beginPath();c.arc(x,y,2.2,0,7);c.fill()}

  // fade in at the start + fade out at the end = seamless loop
  const dark=Math.max(1-ease(t/.5),ease((t-OUT)/(TOTAL-OUT-DELAY/1000)));
  if(dark>0){c.fillStyle=`rgba(11,8,32,${dark})`;c.fillRect(0,0,S,S)}

  // encode: quantize, then mark pixels that did not visibly change as transparent
  c.setTransform(1,0,0,1,0,0);
  const {data}=c.getImageData(0,0,PX,PX);
  // build the 255-colour palette from every 3rd pixel (fast at 1080p, same colours), then map all pixels
  for(let q=0,o=0;q<data.length;q+=12,o+=4){sample[o]=data[q];sample[o+1]=data[q+1];sample[o+2]=data[q+2];sample[o+3]=255}
  const pal=quantize(sample,255),idx=applyPalette(data,pal),dl=delayOf(i);
  if(!ref){ref=new Uint8ClampedArray(data);gif.writeFrame(idx,PX,PX,{palette:pal,delay:dl,repeat:0})}
  else{const T=pal.length;pal.push([0,0,0]);
   for(let p=0,q=0;q<data.length;p++,q+=4){
    if(Math.abs(data[q]-ref[q])+Math.abs(data[q+1]-ref[q+1])+Math.abs(data[q+2]-ref[q+2])<=TOL)idx[p]=T;
    else{ref[q]=data[q];ref[q+1]=data[q+1];ref[q+2]=data[q+2]}}
   gif.writeFrame(idx,PX,PX,{palette:pal,delay:dl,transparent:true,transparentIndex:T,dispose:1})}
  if(onProgress)onProgress((i+1)/FRAMES);
  await yieldUI();
 }
 gif.finish();
 return new Blob([gif.bytes()],{type:'image/gif'});
}
window.makeDiwaliGif=makeDiwaliGif;
})();
