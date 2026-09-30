/* Контраст по всем экранам кабинета: считаем фактические пары «текст на фоне».
   Порог по ТЗ 8.1: 4,5:1 для текста мельче 18px, 3:1 для 18px+ и полужирного 14px+. */
const fs=require('fs'),{JSDOM}=require('jsdom');
const src=fs.readFileSync(__dirname+'/vendor-panel.html','utf8');
const dom=new JSDOM(src,{runScripts:'dangerously',pretendToBeVisual:true});
const w=dom.window,d=w.document;w.open=()=>{};
const CSS=src.split('<style>')[1].split('</style>')[0];
/* токенов два блока: базовый и дополнения — берём оба */
const rootTok=[...CSS.matchAll(/:root\{([\s\S]*?)\}/g)].map(m=>m[1]).join(';');
/* имя токена — в регулярку буквально */
const escRe=k=>k.replace(/[\\^$.*+?()[\]{}|-]/g,'\\$&');
const V=k=>{const m=rootTok.match(new RegExp(escRe(k)+':\\s*([^;]+)'));
  if(m)return m[1].trim();
  const m2=CSS.match(new RegExp(escRe(k)+':\\s*([^;]+);'));return m2?m2[1].trim():null};
function toRGB(c,depth){if(!c||(depth||0)>4)return null;c=String(c).trim();
  if(c.startsWith('--'))return toRGB(V(c),(depth||0)+1);
  if(c.startsWith('var('))return toRGB(V(c.slice(4,-1).split(',')[0].trim()),(depth||0)+1);
  if(/^#[0-9A-Fa-f]{6}$/.test(c))return [1,3,5].map(i=>parseInt(c.substr(i,2),16));
  if(/^#[0-9A-Fa-f]{3}$/.test(c))return [1,2,3].map(i=>parseInt(c[i]+c[i],16));
  const m=c.match(/rgba?\(([^)]+)\)/);if(m){const p=m[1].split(',').map(Number);return [p[0],p[1],p[2]]}
  if(c==='white')return[255,255,255];if(c==='black')return[0,0,0];return null}
const lum=r=>{const f=r.map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});
  return .2126*f[0]+.7152*f[1]+.0722*f[2]};
const ratio=(a,b)=>{const L1=lum(a),L2=lum(b);return (Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05)};
/* пары берём из токенов так, как они применяются в разметке */
const PAIRS=[
 ['основной текст на бумаге','--ink','--paper',14],
 ['вторичный текст на бумаге','--muted','--paper',12.5],
 ['подписи на бумаге','--muted-lt','--paper',11],
 ['заголовки на бумаге','--plum','--paper',19],
 ['текст на карточке','--ink','--white',14],
 ['вторичный на карточке','--muted','--white',12.5],
 ['подписи на карточке','--muted-lt','--white',11],
 ['белый на кнопке','#FFFFFF','--coral-deep',14],
 ['белый на тёмной кнопке','#FFFFFF','--plum',14],
 ['белый в тёмном блоке','#FFFFFF','--plum-deep',13.5],
 ['цена и рейтинг','--coral-deep','--white',12.5],
 ['готово на своей подложке','--done','#E4EFE8',11],
 ['предупреждение на подложке','--warn-ink','#FAF0DC',11],
 ['просрочено на подложке','--late','#F6E3E1',11],
 ['премиум на подложке','--gold','--gold-soft',11],
 ['текст на лиловой подложке','--plum','--lilac',13.5],
 ['занятый день','#8C586B','#FBEEF1',13.5],
 ['полоса предупреждения','--warn','--lilac',24]];
let bad=0;
for(const [name,fg,bg,size] of PAIRS){
  const need=size>=18||size>=14&&/белый/.test(name)?3:4.5;
  const r=ratio(toRGB(fg),toRGB(bg));
  const pass=r>=need;if(!pass)bad++;
  console.log(`${pass?'  ok':'ПРОВАЛ'}  ${r.toFixed(2)}:1  (нужно ${need})  ${name}`);
}
console.log(bad?`\n${bad} пар не проходят`:'\nвсе пары проходят порог');
process.exit(bad?1:0);
