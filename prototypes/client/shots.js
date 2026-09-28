/* Макеты мобильных экранов на реальных значениях из app.html.
   Это не снимок браузера — браузер здесь недоступен, — но все цвета,
   размеры, скругления и тексты взяты из файла, а не придуманы. */
const fs = require('fs'), sharp = require('sharp'), { JSDOM } = require('jsdom');
const path = require('path');
const APP = ['index.html','app.html'].map(n=>path.join(__dirname,n)).find(p=>require('fs').existsSync(p));
if(!APP){console.error('не найден index.html');process.exit(1)}
const dom = new JSDOM(fs.readFileSync(APP, 'utf8'),
  { runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window, d = w.document;
w.HTMLElement.prototype.scrollIntoView = function () {};
d.querySelector('#splash').classList.add('hidden');

const CSS = d.querySelector('style').textContent;
const tokOf = body => Object.fromEntries(
  [...body.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{3,6}|rgba?\([^)]*\))/g)].map(m => [m[1], m[2]]));
const ROOT = tokOf(CSS.match(/:root\{([\s\S]*?)\n\}/)[1]);
let LUX = {};
for (const m of CSS.matchAll(/\.shell\[data-theme="lux"\]\{/g)) {
  const b = CSS.slice(m.index, CSS.indexOf('}', m.index));
  if (/--paper:/.test(b)) LUX = tokOf(b);
}
const IC = JSON.parse(fs.readFileSync(APP, 'utf8').match(/const IC=(\{.*?\});/s)[1]);

const S = 2, W = 390 * S, H = 844 * S;
const px = n => n * S;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const ico = (k, c, size) => IC[k]
  ? `<svg viewBox='0 0 256 256' width='${size}' height='${size}' fill='${c}'>${IC[k]}</svg>` : '';

/* читаем живые данные приложения */
const grab = () => ({
  title: d.querySelector('.res-title').textContent,
  note: (d.querySelector('.res-note') || {}).textContent || '',
  count: (d.querySelector('.res-count') || {}).textContent || '',
  cats: [...d.querySelectorAll('.cat')].slice(0, 4).map(c => ({
    n: c.querySelector('.cat-n').textContent,
    on: c.getAttribute('aria-pressed') === 'true' })),
  crit: [...d.querySelectorAll('#crit .seg')].map(s => ({
    l: s.querySelector('.seg-l').textContent, v: s.querySelector('.seg-v').textContent })),
  cards: [...d.querySelectorAll('#list .card')].slice(0, 2).map(c => ({
    n: c.querySelector('.b-name').textContent,
    m: c.querySelector('.b-meta').textContent,
    p: c.querySelector('.b-price b').textContent,
    r: (c.querySelector('.b-rate') || {}).textContent || '',
    cta: (c.querySelector('.b-cta') || {}).textContent || '' })),
  nav: [...d.querySelectorAll('#nav [data-tab]')].map(b => ({
    n: b.querySelector('.lbl').textContent,
    on: b.getAttribute('aria-pressed') === 'true',
    icon: b.dataset.tab })),
});

const NAVICONS = ['home', 'lux', 'heart', 'notepad'];

function screen(T, data, opts) {
  const bg = T['--paper'], panel = T['--white'] || '#fff', ink = T['--ink'],
        muted = T['--muted'], acc = T['--coral-deep'] || T['--coral'],
        accFill = T['--coral'], line = T['--rule'], soft = T['--coral-soft'],
        btnInk = T['--btnInk'] || '#fff', raise = T['--raise'] || panel;
  const sel = T['--selInk'] || '#fff';
  let y = 0, s = '';

  s += `<rect width='${W}' height='${H}' fill='${bg}'/>`;
  if (opts.glow) s += `<rect width='${W}' height='${H}' fill='url(#glow)'/>`;

  /* строка состояния устройства */
  s += `<text x='${px(24)}' y='${px(30)}' font-family='sans-serif' font-size='${px(13)}' font-weight='700' fill='${ink}'>9:41</text>`;
  s += `<rect x='${px(336)}' y='${px(19)}' width='${px(26)}' height='${px(13)}' rx='${px(4)}' fill='none' stroke='${ink}' stroke-width='${px(1.2)}' opacity='.5'/>`;
  s += `<rect x='${px(338)}' y='${px(21)}' width='${px(18)}' height='${px(9)}' rx='${px(2)}' fill='${ink}' opacity='.6'/>`;
  y = 52;

  /* шапка */
  s += `<line x1='0' y1='${px(y + 44)}' x2='${W}' y2='${px(y + 44)}' stroke='${line}' stroke-width='${px(1)}'/>`;
  if (opts.lux) {
    s += `<rect x='${px(14)}' y='${px(y + 9)}' width='${px(102)}' height='${px(26)}' rx='${px(13)}' fill='none' stroke='${line}' stroke-width='${px(1)}'/>`;
    s += `<text x='${px(38)}' y='${px(y + 26)}' font-family='sans-serif' font-size='${px(11.5)}' font-weight='600' fill='${muted}'>bayram.uz</text>`;
    s += `<text x='${px(126)}' y='${px(y + 28)}' font-family='Unbounded,Georgia,serif' font-size='${px(15)}' font-weight='600' fill='${ink}'>Премиум</text>`;
  } else {
    s += `<text x='${px(18)}' y='${px(y + 29)}' font-family='Unbounded,Georgia,serif' font-size='${px(16)}' font-weight='700' fill='${ink}'>bayram<tspan fill='${accFill}'>.</tspan>uz</text>`;
  }
  /* переключатель языка + профиль */
  const lx = opts.lux ? 252 : 268;
  s += `<rect x='${px(lx)}' y='${px(y + 9)}' width='${px(72)}' height='${px(26)}' rx='${px(13)}' fill='${opts.lux ? 'none' : ROOT['--lilac']}' ${opts.lux ? `stroke='${line}'` : ''}/>`;
  s += `<rect x='${px(lx + 3)}' y='${px(y + 12)}' width='${px(33)}' height='${px(20)}' rx='${px(10)}' fill='${opts.lux ? ink : panel}'/>`;
  s += `<text x='${px(lx + 19)}' y='${px(y + 26)}' text-anchor='middle' font-family='sans-serif' font-size='${px(11)}' font-weight='700' fill='${opts.lux ? sel : ink}'>RU</text>`;
  s += `<text x='${px(lx + 53)}' y='${px(y + 26)}' text-anchor='middle' font-family='sans-serif' font-size='${px(11)}' font-weight='700' fill='${muted}'>UZ</text>`;
  if (!opts.lux) {
    s += `<rect x='${px(348)}' y='${px(y + 8)}' width='${px(28)}' height='${px(28)}' rx='${px(11)}' fill='${panel}' stroke='${line}' stroke-width='${px(1)}'/>`;
    s += `<g transform='translate(${px(356)},${px(y + 16)})'>${ico('user', muted, px(12))}</g>`;
  }
  y += 44;

  /* карточка критериев (только обычная лента) */
  if (opts.crit) {
    y += 14;
    s += `<rect x='${px(18)}' y='${px(y)}' width='${px(354)}' height='${px(64)}' rx='${px(18)}' fill='${panel}' stroke='${accFill}' stroke-width='${px(1)}'/>`;
    data.crit.forEach((c, i) => {
      const cx = 18 + 14 + i * 104;
      s += `<text x='${px(cx)}' y='${px(y + 26)}' font-family='sans-serif' font-size='${px(9.5)}' font-weight='700' letter-spacing='${px(1.6)}' fill='${T['--muted-lt'] || muted}'>${esc(c.l.toUpperCase())}</text>`;
      s += `<text x='${px(cx)}' y='${px(y + 45)}' font-family='sans-serif' font-size='${px(13.5)}' font-weight='600' fill='${T['--muted-lt'] || muted}'>${esc(c.v)}</text>`;
      if (i < 2) s += `<line x1='${px(cx + 88)}' y1='${px(y + 20)}' x2='${px(cx + 88)}' y2='${px(y + 46)}' stroke='${line}' stroke-width='${px(1)}'/>`;
    });
    s += `<rect x='${px(330)}' y='${px(y + 15)}' width='${px(34)}' height='${px(34)}' rx='${px(12)}' fill='${accFill}'/>`;
    s += `<g transform='translate(${px(340)},${px(y + 25)})'>${ico('caretDown', btnInk, px(14))}</g>`;
    y += 64;
  }

  /* категории */
  y += 14;
  let cx2 = 18;
  data.cats.forEach(c => {
    const wgt = 22 + c.n.length * 6.4;
    s += `<rect x='${px(cx2)}' y='${px(y)}' width='${px(wgt)}' height='${px(36)}' rx='${px(18)}' fill='${c.on ? accFill : raise}' stroke='${c.on ? accFill : line}' stroke-width='${px(1)}'/>`;
    s += `<text x='${px(cx2 + wgt / 2)}' y='${px(y + 23)}' text-anchor='middle' font-family='sans-serif' font-size='${px(12.5)}' font-weight='600' fill='${c.on ? btnInk : (opts.lux ? muted : ink)}'>${esc(c.n)}</text>`;
    cx2 += wgt + 8;
  });
  y += 36 + 22;

  /* заголовок */
  s += `<text x='${px(18)}' y='${px(y)}' font-family='Unbounded,Georgia,serif' font-size='${px(23)}' font-weight='600' fill='${ink}'>${esc(data.title)}</text>`;
  if (data.count) s += `<text x='${px(372)}' y='${px(y)}' text-anchor='end' font-family='sans-serif' font-size='${px(12.5)}' font-weight='700' fill='${muted}'>${esc(data.count.trim())}</text>`;
  y += 18;
  if (data.note) s += `<text x='${px(18)}' y='${px(y)}' font-family='sans-serif' font-size='${px(12.5)}' fill='${muted}'>${esc(data.note.slice(0, 46))}</text>`;
  y += 16;

  /* карточки */
  data.cards.forEach(c => {
    const cw = 354, ih = Math.round(cw / 1.5), bh = 92, ch = ih + bh;
    s += `<path d='M${px(18)} ${px(y + 44)} a${px(44)} ${px(44)} 0 0 1 ${px(44)} -${px(44)} h${px(cw - 88)} a${px(44)} ${px(44)} 0 0 1 ${px(44)} ${px(44)} v${px(ch - 64)} a${px(20)} ${px(20)} 0 0 1 -${px(20)} ${px(20)} h-${px(cw - 40)} a${px(20)} ${px(20)} 0 0 1 -${px(20)} -${px(20)} z' fill='${panel}' stroke='${line}' stroke-width='${px(1)}'/>`;
    s += `<path d='M${px(18)} ${px(y + 44)} a${px(44)} ${px(44)} 0 0 1 ${px(44)} -${px(44)} h${px(cw - 88)} a${px(44)} ${px(44)} 0 0 1 ${px(44)} ${px(44)} v${px(ih - 44)} h-${px(cw)} z' fill='${opts.lux ? (LUX['--cellWk'] || '#EFE3D8') : ROOT['--lilac']}'/>`;
    /* сердечко в правом верхнем углу */
    s += `<circle cx='${px(355)}' cy='${px(y + 29)}' r='${px(17)}' fill='${raise}' ${opts.lux ? `stroke='${line}'` : ''}/>`;
    s += `<g transform='translate(${px(347)},${px(y + 21)})'>${ico('heart', ink, px(16))}</g>`;
    const by = y + ih;
    s += `<text x='${px(34)}' y='${px(by + 30)}' font-family='Unbounded,Georgia,serif' font-size='${px(19)}' font-weight='600' fill='${ink}'>${esc(c.n)}</text>`;
    const rt = c.r.replace(/\s+/g, ' ').trim();
    s += `<text x='${px(356)}' y='${px(by + 30)}' text-anchor='end' font-family='sans-serif' font-size='${px(12.5)}' font-weight='700' fill='${ink}'><tspan fill='${acc}'>★</tspan> ${esc(rt)}</text>`;
    s += `<text x='${px(34)}' y='${px(by + 50)}' font-family='sans-serif' font-size='${px(12.5)}' fill='${muted}'>${esc(c.m)}</text>`;
    s += `<text x='${px(34)}' y='${px(by + 78)}' font-family='Unbounded,Georgia,serif' font-size='${px(19)}' font-weight='600' fill='${ink}'>${esc(c.p)}</text>`;
    if (c.cta) {
      s += `<rect x='${px(292)}' y='${px(by + 60)}' width='${px(68)}' height='${px(26)}' rx='${px(10)}' fill='none' stroke='${acc}' stroke-width='${px(1.5)}'/>`;
      s += `<text x='${px(326)}' y='${px(by + 78)}' text-anchor='middle' font-family='sans-serif' font-size='${px(12)}' font-weight='700' fill='${acc}'>${esc(c.cta.trim())}</text>`;
    }
    y += ch + 18;
  });

  /* панель навигации */
  const navY = 844 - 10 - 68 - 24;
  const navBg = opts.lux ? (LUX['--rail-bg'] || panel) : 'rgba(250,247,244,.94)';
  s += `<rect x='${px(14)}' y='${px(navY)}' width='${px(362)}' height='${px(68)}' rx='${px(22)}' fill='${navBg}' stroke='${line}' stroke-width='${px(1)}'/>`;
  const n = data.nav.length, colW = (362 - 58) / n;
  data.nav.forEach((b, i) => {
    const bx = 14 + i * colW + colW / 2;
    if (b.on) s += `<rect x='${px(bx - 16)}' y='${px(navY + 9)}' width='${px(32)}' height='${px(32)}' rx='${px(11)}' fill='${opts.lux ? soft : accFill}'/>`;
    const key = NAVICONS[+b.icon] || 'home';
    s += `<g transform='translate(${px(bx - 8.5)},${px(navY + 16.5)})'>${ico(b.on ? key + 'Fill' : key, b.on ? (opts.lux ? acc : '#fff') : muted, px(17))}</g>`;
    s += `<text x='${px(bx)}' y='${px(navY + 56)}' text-anchor='middle' font-family='sans-serif' font-size='${px(9)}' font-weight='700' fill='${b.on ? (opts.lux ? ink : acc) : muted}'>${esc(b.n)}</text>`;
  });
  const fx = 14 + 362 - 54;
  s += `<circle cx='${px(fx + 25)}' cy='${px(navY + 34)}' r='${px(25)}' fill='${opts.lux ? accFill : ROOT['--plum']}'/>`;
  s += `<g transform='translate(${px(fx + 14.5)},${px(navY + 23.5)})'>${ico('searchB', btnInk, px(21))}</g>`;
  /* полоса жеста */
  s += `<rect x='${px(137)}' y='${px(828)}' width='${px(116)}' height='${px(5)}' rx='${px(2.5)}' fill='${ink}' opacity='.25'/>`;
  return s;
}


/* экран «Мои заявки» — на тех же токенах */
function reqScreen(T) {
  const bg = T['--paper'], panel = T['--white'], ink = T['--ink'],
        muted = T['--muted'], acc = T['--coral-deep'], line = T['--rule'],
        lilac = T['--lilac'], berry = T['--berry'];
  const rows = [
    { n: 'ASR', m: 'Площадка · 14 сен · 200 гостей', st: 'ждём ответа', left: 'осталось 9 ч', late: false },
    { n: 'Zarafshon dekor', m: 'Декор · 14 сен · 200 гостей', st: 'ответили', left: null, late: false },
    { n: 'Studio Nur', m: 'Фото и видео · 14 сен · 200 гостей', st: 'ждём ответа', left: 'ждём дольше 12 ч', late: true },
  ];
  let s = `<rect width='${W}' height='${H}' fill='${bg}'/>`;
  s += `<text x='${px(24)}' y='${px(30)}' font-family='sans-serif' font-size='${px(13)}' font-weight='700' fill='${ink}'>9:41</text>`;
  s += `<rect x='${px(336)}' y='${px(19)}' width='${px(26)}' height='${px(13)}' rx='${px(4)}' fill='none' stroke='${ink}' stroke-width='${px(1.2)}' opacity='.5'/>`;
  let y = 52;
  s += `<line x1='0' y1='${px(y + 44)}' x2='${W}' y2='${px(y + 44)}' stroke='${line}' stroke-width='${px(1)}'/>`;
  s += `<circle cx='${px(34)}' cy='${px(y + 22)}' r='${px(17)}' fill='${panel}' stroke='${line}' stroke-width='${px(1)}'/>`;
  s += `<g transform='translate(${px(26)},${px(y + 14)})'>${ico('back', ink, px(16))}</g>`;
  s += `<text x='${px(64)}' y='${px(y + 28)}' font-family='Unbounded,Georgia,serif' font-size='${px(16)}' font-weight='600' fill='${ink}'>Мои заявки</text>`;
  y += 44 + 22;
  s += `<text x='${px(18)}' y='${px(y)}' font-family='sans-serif' font-size='${px(12.5)}' fill='${muted}'>Статус ставит вендор. Если не ответит за 12</text>`;
  s += `<text x='${px(18)}' y='${px(y + 17)}' font-family='sans-serif' font-size='${px(12.5)}' fill='${muted}'>часов — покажем похожих.</text>`;
  y += 40;
  rows.forEach(r => {
    s += `<text x='${px(18)}' y='${px(y + 20)}' font-family='sans-serif' font-size='${px(15)}' font-weight='700' fill='${ink}'>${esc(r.n)}</text>`;
    s += `<text x='${px(18)}' y='${px(y + 40)}' font-family='sans-serif' font-size='${px(12.5)}' fill='${muted}'>${esc(r.m)}</text>`;
    const stW = r.st.length * 6.2 + 18;
    const stBg = r.st === 'ответили' ? '#FDE7DC' : lilac;
    const stFg = r.st === 'ответили' ? '#9E3F22' : muted;
    s += `<rect x='${px(372 - stW)}' y='${px(y + 6)}' width='${px(stW)}' height='${px(20)}' rx='${px(10)}' fill='${stBg}'/>`;
    s += `<text x='${px(372 - stW / 2)}' y='${px(y + 20)}' text-anchor='middle' font-family='sans-serif' font-size='${px(11)}' font-weight='600' fill='${stFg}'>${esc(r.st)}</text>`;
    if (r.left) s += `<text x='${px(372)}' y='${px(y + 41)}' text-anchor='end' font-family='sans-serif' font-size='${px(11)}' font-weight='600' fill='${r.late ? berry : muted}'>${esc(r.left)}</text>`;
    y += 56;
    s += `<line x1='${px(18)}' y1='${px(y - 8)}' x2='${px(372)}' y2='${px(y - 8)}' stroke='${line}' stroke-width='${px(1)}'/>`;
  });
  return s;
}

function frame(inner, label) {
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'>
<defs><radialGradient id='glow' cx='70%' cy='-10%' r='90%'>
  <stop offset='0' stop-color='#A3302A' stop-opacity='.06'/><stop offset='.6' stop-color='#A3302A' stop-opacity='0'/>
</radialGradient></defs>${inner}</svg>`;
}

(async () => {
  const light = grab();
  d.querySelector('[data-tab="1"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const lux = grab();

  const shots = [
    ['mob-1-lenta.png', screen(ROOT, light, { crit: true })],
    ['mob-2-premium.png', screen({ ...ROOT, ...LUX }, lux, { lux: true, glow: true })],
    ['mob-3-zayavki.png', reqScreen(ROOT)],
  ];
  for (const [name, body] of shots) {
    await sharp(Buffer.from(frame(body))).png().toFile(__dirname + '/' + name);
    console.log('готово:', name);
  }
})();
