/* Аудит фактического контраста: считает цвет и фон как их видит браузер */
const fs=require('fs');const {JSDOM}=require('jsdom');
const path = require('path');
const APP = ['index.html','app.html'].map(n=>path.join(__dirname,n)).find(p=>require('fs').existsSync(p));
if(!APP){console.error('не найден index.html');process.exit(1)}
const dom=new JSDOM(fs.readFileSync(APP,'utf8'),{runScripts:'dangerously',pretendToBeVisual:true});
const w=dom.window,d=w.document; w.HTMLElement.prototype.scrollIntoView=function(){};
d.querySelector('#splash').classList.add('hidden');
const click=s=>{const e=typeof s==='string'?d.querySelector(s):s; if(e)e.dispatchEvent(new w.MouseEvent('click',{bubbles:true}))};
const key=k=>d.dispatchEvent(new w.KeyboardEvent('keydown',{key:k,bubbles:true}));
const CSS=d.querySelector('style').textContent;
/* jsdom не вычисляет var() — резолвим сами.
   Внутри премиума токены переопределены, поэтому берём их блок первым. */
const rootTok = (() => {
  const m = CSS.match(/:root\{([\s\S]*?)\}/); return m ? m[1] : '';
})();
const luxTok = (() => {
  /* блоков .shell[data-theme="lux"]{ несколько; нужен тот, где объявлены токены */
  for (const m of CSS.matchAll(/\.shell\[data-theme="lux"\]\{/g)) {
    const body = CSS.slice(m.index, CSS.indexOf('}', m.index));
    if (/--paper:/.test(body)) return body;
  }
  return '';
})();
let THEME = 'all';
/* имя токена — в регулярку буквально */
const escRe=k=>k.replace(/[\\^$.*+?()[\]{}|-]/g,'\\$&');
const V = k => {
  const re = new RegExp(escRe(k) + ':\\s*([^;]+)');
  if (THEME === 'lux') { const m = luxTok.match(re); if (m) return m[1].trim(); }
  const m2 = rootTok.match(re); if (m2) return m2[1].trim();
  const m3 = CSS.match(new RegExp(escRe(k) + ':\\s*([^;]+);'));
  return m3 ? m3[1].trim() : null;
};
function toRGB(c,depth){
  if(!c||depth>4) return null; c=String(c).trim();
  if(c.startsWith('var(')) return toRGB(V(c.slice(4,-1).trim()),(depth||0)+1);
  if(/^#[0-9A-Fa-f]{6}$/.test(c)) return {rgb:[1,3,5].map(i=>parseInt(c.substr(i,2),16)),a:1};
  if(/^#[0-9A-Fa-f]{3}$/.test(c)){const s=c.slice(1);return {rgb:[0,1,2].map(i=>parseInt(s[i]+s[i],16)),a:1}}
  const m=c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if(m) return {rgb:[+m[1],+m[2],+m[3]],a:m[4]===undefined?1:+m[4]};
  return null;
}
const over=(f,b)=>f.rgb.map((v,i)=>Math.round(v*f.a+b[i]*(1-f.a)));
const L=rgb=>{const [r,g,b]=rgb.map(v=>v/255).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b};
const CR=(a,b)=>{const l=[L(a),L(b)].sort((x,y)=>y-x);return (l[0]+.05)/(l[1]+.05)};
const hidden=el=>{let n=el;while(n&&n.nodeType===1){const s=w.getComputedStyle(n);
  if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0') return true; n=n.parentElement}return false};
/* jsdom не заполняет backgroundColor из сокращённой записи background:
   — читаем и её, иначе кнопки выглядят как провал контраста */
function ownBg(el){
  const cs=w.getComputedStyle(el);
  let c=toRGB(cs.backgroundColor,0);
  if(c&&c.a>0.5) return c;
  const sh=cs.background||'';
  const m=sh.match(/(var\(--[\w-]+\)|#[0-9A-Fa-f]{3,6}|rgba?\([^)]*\))/);
  if(m){ c=toRGB(m[1],0); if(c&&c.a>0.5) return c }
  return null;
}
function bgOf(el){let n=el;while(n&&n.nodeType===1){const c=ownBg(n);
  if(c) return c.rgb; n=n.parentElement}return toRGB(V('--lx-ink'),0).rgb}
function audit(label,root){
  const bad=[];
  d.querySelectorAll(root+' *').forEach(el=>{
    if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())) return;
    if(hidden(el)) return;
    const cs=w.getComputedStyle(el);
    const fg=toRGB(cs.color,0); if(!fg) return;
    const bg=bgOf(el);
    const r=CR(over(fg,bg),bg);
    const fsz=parseFloat(cs.fontSize)||13, bold=+cs.fontWeight>=700;
    const need=(fsz>=18||(fsz>=14&&bold))?3:4.5;
    if(r<need) bad.push({sel:el.className||el.tagName,txt:el.textContent.trim().slice(0,20),r:r.toFixed(2),need,fsz});
  });
  console.log('\n'+label+': '+(bad.length?bad.length+' проблем':'чисто'));
  const seen=new Set();
  bad.forEach(b=>{const k=b.sel+'|'+b.r; if(seen.has(k))return; seen.add(k);
    console.log(`   ${String(b.sel).slice(0,28).padEnd(28)} ${b.r}:1  нужно ${b.need}  ${b.fsz}px  «${b.txt}»`)});
}
click('[data-tab="1"]'); THEME='lux';
audit('ЛЕНТА','#viewSearch');
click('#list .card'); audit('ПРОФИЛЬ','#profile');
click('#pfReq');      audit('ЗАЯВКА','#req');
key('Escape'); key('Escape');
click('[data-tab="2"]'); audit('ИЗБРАННОЕ','#viewSaved');
click('[data-tab="3"]'); audit('СОБЫТИЕ','#viewToy');
click('#navSearch'); audit('ПОИСК','#search');
