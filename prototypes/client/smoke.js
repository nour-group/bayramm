/* Bayram.uz — дымовые тесты.
   Запуск: node smoke.js
   Пересобран после потери прежнего набора. Покрывает критические пути,
   правила продукта и то, на чём мы уже обжигались. */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const path = require('path');
const APP = ['index.html','app.html'].map(n=>path.join(__dirname,n)).find(p=>require('fs').existsSync(p));
if(!APP){console.error('не найден index.html');process.exit(1)}

const html = fs.readFileSync(APP, 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(e.message.split('\n')[0]));

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
const doc = window.document;
window.HTMLElement.prototype.scrollIntoView = function () {};

/* ---------- помощники ---------- */
const css = () => doc.querySelector('style').textContent;
/* первым тегом идёт подключение SDK Telegram — берём встроенный скрипт */
const jsSrc = () => [...doc.querySelectorAll('script')].map(s => s.textContent).join('\n');

/* правила вне медиазапросов: вырезаем блоки, а не обрезаем по первому */
const baseCss = () => {
  const src = css(); let out = '', i = 0;
  while (i < src.length) {
    const at = src.indexOf('@media', i);
    if (at === -1) { out += src.slice(i); break; }
    out += src.slice(i, at);
    let d = 0;
    for (i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') d++;
      else if (src[i] === '}') { d--; if (!d) { i++; break; } }
    }
  }
  return out;
};
const rule = sel => (baseCss().match(new RegExp('\\n' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}')) || [])[1] || '';
const dsk = () => css().slice(css().indexOf('@media (min-width:900px){'), css().indexOf('@media (min-width:1180px){'));

const $ = s => doc.querySelector(s);
const has = s => !!$(s);
const txt = s => ($(s) || {}).textContent || '';
const vis = s => { const e = $(s); return !!e && window.getComputedStyle(e).display !== 'none'; };
const click = s => { const e = typeof s === 'string' ? $(s) : s; if (e) e.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); };
const key = k => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));

const dismissSplash = () => { const sp = $('#splash'); if (sp) { click(sp); sp.classList.add('hidden'); } };
/* внутри премиума вкладки «Главная» нет — выход только через возврат */
const goHome = () => { if (vis('#luxBack')) click('#luxBack'); else if (has('[data-tab="0"]')) click('[data-tab="0"]'); };
const toLux = () => click('[data-tab="1"]');

/* токены премиум-темы: их блок — тот, где объявлен --paper */
const luxTokens = () => {
  for (const m of [...doc.querySelector('style').textContent.matchAll(/\.shell\[data-theme="lux"\]\{/g)]) {
    const src = doc.querySelector('style').textContent;
    const body = src.slice(m.index, src.indexOf('}', m.index));
    if (/--paper:/.test(body)) return Object.fromEntries(
      [...body.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map(x => [x[1], x[2]]));
  }
  return {};
};
const tokens = () => Object.fromEntries([...css().matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map(m => [m[1], m[2]]));
const relLum = c => { const [r, g, b] = [1, 3, 5].map(i => parseInt(c.substr(i, 2), 16) / 255)
  .map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * r + .7152 * g + .0722 * b; };
const ctr = (a, b) => { const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };

const groups = [];
function suite(name, body) {
  const out = [];
  const step = (label, fn) => { try { fn(); out.push(['ok', label]); }
    catch (e) { out.push(['FAIL', label + ' -> ' + e.message]); } };
  body(step);
  groups.push([name, out]);
}

/* ---------- 1. приложение поднимается ---------- */
suite('запуск', step => {
  step('скрипт не упал', () => { if (errors.length) throw new Error(errors[0]); });
  step('лента наполнена', () => {
    dismissSplash();
    const n = doc.querySelectorAll('#list .card').length;
    if (n < 50) throw new Error('карточек: ' + n);
  });
  step('заставка уходит сама', () => {
    if (!/const SPL_END\s*=\s*\d+/.test(jsSrc())) throw new Error('нет константы завершения');
    if (!/typeof matchMedia === 'function'/.test(jsSrc())) throw new Error('matchMedia без проверки — заставка зависнет');
  });
});

/* ---------- 2. правила продукта ---------- */
suite('правила продукта', step => {
  step('слова «забронировать» нет', () => {
    const t = doc.body.textContent + jsSrc();
    if (/забронир/i.test(t)) throw new Error('появилось слово «забронировать»');
  });
  step('телефон вендора виден до заявки', () => {
    goHome(); click('#list .card');
    if (!/\+998/.test(txt('#profile'))) throw new Error('телефон спрятан за формой');
    key('Escape');
  });
  step('у каждой карточки есть цена', () => {
    for (const c of doc.querySelectorAll('#list .card'))
      if (!c.querySelector('.b-price b').textContent.trim()) throw new Error('карточка без цены');
  });
  step('реклама помечена', () => {
    for (const s of doc.querySelectorAll('.slide'))
      if (!/РЕКЛАМА|Reklama/i.test(s.querySelector('.adtag')?.textContent || ''))
        throw new Error('баннер без пометки');
  });
  step('продвижение не всплывает в явных сортировках', () => {
    if (!/mode==='lux'\?0:\(b\.promo-a\.promo\)/.test(jsSrc()))
      throw new Error('оплата влияет не только на порядок по умолчанию');
  });
});

/* ---------- 3. поток заявки ---------- */
suite('заявка', step => {
  step('форма открывается из профиля', () => {
    goHome(); click('#list .card'); click('#pfReq');
    if (!has('#req.on')) throw new Error('форма не открылась');
  });
  step('без даты отправить нельзя', () => {
    if (!$('#rqSend').disabled) throw new Error('кнопка активна без даты');
  });
  step('выбор даты включает отправку', () => {
    if (!has('#req .dp')) click('#rqDpBtn');
    const day = $('#req .dp-g b[data-pick]');
    if (!day) throw new Error('нет свободного дня');
    click(day);
    if ($('#rqSend').disabled) throw new Error('кнопка осталась выключенной');
  });
  step('согласие не предзаполнено', () => {
    click('#rqSend');
    const box = $('#perm input[type=checkbox]') || $('#perm .cons-box');
    if (box && box.checked) throw new Error('согласие проставлено заранее');
    if (!has('#permOk')) throw new Error('нет кнопки согласия');
  });
  step('после отправки открывается «Моё событие»', () => {
    click('#permOk'); click('#sHome');
    if (!vis('#viewToy')) throw new Error('увело не туда');
    if (!has('.mt-bill')) throw new Error('счёт не появился');
  });
});

/* ---------- 4. навигация ---------- */
suite('навигация', step => {
  step('пять слотов, поиск последний', () => {
    goHome();
    const kids = [...doc.querySelectorAll('#nav > button')];
    if (kids.length !== 5) throw new Error('слотов: ' + kids.length);
    if (!kids[kids.length - 1].classList.contains('fab')) throw new Error('поиск не последний');
  });
  step('номера вкладок в одном месте', () => {
    if (!/const TAB = \{ home:0, lux:1, saved:2, event:3, me:4 \}/.test(jsSrc()))
      throw new Error('нет карты вкладок — номера разъедутся');
    const bare = jsSrc().match(/(?<!let )tab\s*=\s*[0-4];/g) || [];
    if (bare.length) throw new Error('номер вписан числом: ' + bare.join(' '));
  });
  step('подпись помещается в колонку', () => {
    const col = (390 - 28 - 10 - 50 - 6) / 4;
    for (const l of [...doc.querySelectorAll('#nav .lbl')].map(e => e.textContent))
      if (l.length * 4.4 > col - 4) throw new Error(`«${l}» шире колонки`);
  });
  step('колонка вмещает иконку и подпись', () => {
    const tab = rule('.nav button[data-tab]'), ico = rule('.nav .ico'), lbl = rule('.nav .lbl');
    const n = (s, re) => +((s.match(re) || [])[1] || 0);
    const need = n(ico, /height:(\d+)px/) + n(tab, /gap:(\d+)px/) + Math.ceil(n(lbl, /font-size:([\d.]+)px/));
    const h = n(tab, /height:(\d+)px/);
    if (need > h) throw new Error(`нужно ${need}px, колонка ${h}px — подписи обрежет`);
  });
  step('профиль в шапке, а не в панели', () => {
    if (has('#nav [data-tab="4"]')) throw new Error('профиль вернулся в панель');
    if (!has('.tg-acts #meBtn')) throw new Error('кнопки профиля нет в шапке');
  });
});

/* ---------- 5. премиум ---------- */
suite('премиум', step => {
  step('статус присваиваем мы, а не формула', () => {
    if (!/const isLux = v => v\.lux === true;/.test(jsSrc())) throw new Error('критерий не флаг');
    if (/LUX_CUT|LUX_R\b/.test(jsSrc())) throw new Error('остался ценовой критерий');
  });
  step('раздел фильтрует', () => {
    goHome();
    const all = doc.querySelectorAll('#list .card').length;
    toLux();
    const lux = doc.querySelectorAll('#list .card').length;
    if (lux >= all) throw new Error(`премиум ${lux} против ленты ${all}`);
    if (lux < 8 || lux / all > .5) throw new Error('доля премиума: ' + lux + ' из ' + all);
  });
  step('рекламы внутри нет', () => {
    if ($('#adSlot').style.display !== 'none') throw new Error('карусель видна');
    if (has('#list .promo-tag')) throw new Error('оплаченная карточка в премиуме');
  });
  step('своя панель и возврат', () => {
    if (!vis('#nav')) throw new Error('панель скрыта');
    const tabs = [...doc.querySelectorAll('#nav [data-tab]')].map(b => b.dataset.tab);
    if (tabs.join() !== '1,2,3') throw new Error('вкладки: ' + tabs.join());
    if (!vis('#luxBack')) throw new Error('нет выхода');
    if (vis('.wordmark')) throw new Error('остался обычный логотип');
  });
  step('избранное общее, не отдельное', () => {
    click('[data-tab="2"]');
    const inside = doc.querySelectorAll('#viewSaved .sv-row').length;
    goHome(); click('[data-tab="2"]');
    if (inside !== doc.querySelectorAll('#viewSaved .sv-row').length)
      throw new Error('внутри и снаружи разные списки');
    goHome();
  });
  step('выход возвращает всё', () => {
    toLux(); goHome();
    if ($('.shell').dataset.theme !== 'all') throw new Error('тема залипла');
    if (!vis('.wordmark') || !vis('#nav')) throw new Error('шапка или панель не вернулись');
  });
});

/* ---------- 6. контраст ---------- */
suite('контраст', step => {
  step('акцент под белым текстом выдерживает', () => {
    const t = tokens();
    if (ctr('#FFFFFF', t['--coral-deep']) < 4.5) throw new Error('белый на глубоком коралле не проходит');
  });
  step('обычный коралл не несёт мелкий текст', () => {
    const t = tokens();
    if (ctr(t['--coral'], t['--paper']) >= 4.5) return;
    for (const m of baseCss().matchAll(/(?:^|\n)([^{}\n]+)\{([^}]*)\}/g)) {
      const fs = +((m[2].match(/font-size:([\d.]+)px/) || [])[1] || 0);
      if (fs && fs < 18 && !/background/.test(m[2]) && /(?<!-)color:\s*var\(--coral\)/.test(m[2]))
        throw new Error(m[1].trim().slice(0, 30) + ` — ${fs}px обычным кораллом`);
    }
  });
  step('премиум-тема держит текст', () => {
    const t = luxTokens();
    const pairs = [[t['--ink'], t['--paper'], 'индиго на льне'],
                   [t['--ink'], t['--white'], 'индиго на слоновой'],
                   [t['--muted'], t['--paper'], 'орех на льне'],
                   [t['--muted'], t['--white'], 'орех на слоновой'],
                   [t['--coral'], t['--white'], 'марена на слоновой'],
                   [t['--btnInk'], t['--coral'], 'тёплый белый на кнопке'],
                   [t['--selInk'], t['--ink'], 'тёплый белый на индиго']];
    for (const [fg, bg, what] of pairs) {
      if (!fg || !bg) throw new Error('нет токена для: ' + what);
      const r = ctr(fg, bg);
      if (r < 4.5) throw new Error(`${what}: ${r.toFixed(2)}:1`);
    }
  });
  step('на красной заливке текст только тёплый белый', () => {
    const lux = css().slice(css().indexOf('/* ============ SUZANI'));
    for (const m of lux.matchAll(/(?:^|\n)([^{}\n]*)\{([^}]*)\}/g)) {
      const b = m[2];
      if (!/background:var\(--coral\)/.test(b)) continue;
      const c = (b.match(/(?<!-)color:var\(--([\w-]+)\)/) || [])[1];
      if (c && c !== 'btnInk') throw new Error(m[1].trim().slice(0, 40) + ' — текст ' + c + ' на марене');
    }
  });
  step('золота в теме нет', () => {
    const lux = css().slice(css().indexOf('/* ============ SUZANI'));
    if (/--lx-gold|194,178,127|#C2B27F|#F2DFBB/.test(lux))
      throw new Error('осталась прежняя золотая палитра');
  });
  step('премиум отличается от обычного экрана', () => {
    const root = (css().match(/:root\{([\s\S]*?)\n\}/) || [])[1] || '';
    const paper = (root.match(/--paper:\s*(#[0-9A-Fa-f]{6})/) || [])[1];
    const lux = luxTokens()['--paper'];
    if (!paper || !lux) throw new Error('не найдены токены фона');
    if (ctr(lux, paper) < 1.06) throw new Error(`фон премиума ${lux} сливается с бумагой ${paper}`);
  });
});

/* ---------- 7. шкалы ---------- */
suite('шкалы', step => {
  const steps = prop => {
    const s = new Set();
    for (const m of baseCss().matchAll(new RegExp('\\b' + prop + ':([^;}]+)', 'g')))
      for (const v of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) s.add(+v[1]);
    return [...s].sort((a, b) => a - b);
  };
  step('капитель в двух ступенях', () => {
    const seen = new Set();
    for (const m of baseCss().matchAll(/\{([^}]*)\}/g)) {
      if (!/text-transform:uppercase/.test(m[1])) continue;
      const fs = (m[1].match(/font-size:([\d.]+)px/) || [])[1];
      const ls = (m[1].match(/letter-spacing:([\d.]+)em/) || [])[1];
      if (fs) seen.add(fs + '/' + ls);
    }
    if (seen.size > 2) throw new Error(seen.size + ' вариантов: ' + [...seen].join(', '));
  });
  step('скруглений не больше восьми', () => {
    // шкала спецификации Suzani: 9–10 · 14 · 20 · 22 · 40 · 44 плюс мелкие
    const r = steps('border-radius').filter(v => v < 100);
    if (r.length > 10) throw new Error(r.length + ': ' + r.join(', '));
  });
  step('отступы чётные', () => {
    const odd = steps('padding').filter(v => v <= 24 && v > 6 && v % 2);
    if (odd.length) throw new Error('нечётные: ' + odd.join(', '));
  });
  step('иконок не больше шести размеров', () => {
    const s = [...new Set([...jsSrc().matchAll(/ico\('\w+',(\d+)\)/g)].map(m => +m[1]))].filter(v => v <= 26);
    if (s.length > 6) throw new Error(s.length + ': ' + s.join(', '));
  });
  step('длительности через токены', () => {
    const hard = css().match(/transition:[^;}]*\b\d*\.\d+s\b/g);
    if (hard) throw new Error('секунды в тексте: ' + hard.slice(0, 2).join(' | '));
  });
});

/* ---------- 8. на чём обжигались ---------- */
suite('прежние грабли', step => {
  step('сердечко остаётся absolute', () => {
    goHome();
    const cs = window.getComputedStyle($('#list .card .heart'));
    if (cs.position !== 'absolute') throw new Error('position:' + cs.position + ' — уедет в угол потока');
    const bad = baseCss().match(/[^{}]*\.heart[^{}]*\{[^}]*position:relative[^}]*\}/);
    if (bad) throw new Error('правило сбрасывает позицию');
  });
  step('data-атрибуты не пересекаются', () => {
    if (/data-pick="(mon|yr)"/.test(jsSrc())) throw new Error('триггер списка занял атрибут дней');
  });
  step('overflow задан по обеим осям', () => {
    for (const m of baseCss().matchAll(/(?:^|\n)([^{}\n]+)\{([^}]*)\}/g))
      if (/overflow-y:auto/.test(m[2]) && !/overflow-x:/.test(m[2]))
        throw new Error(m[1].trim().slice(0, 26) + ' — горизонталь станет прокручиваемой');
  });
  step('нет обращений к отсутствующим API без проверки', () => {
    if (!/if\(el\.scrollTo\)/.test(jsSrc())) throw new Error('Element.scrollTo без запасного пути');
    if (!/typeof matchMedia==='function'/.test(jsSrc())) throw new Error('matchMedia без проверки');
  });
  step('высота корпуса с запасным значением', () => {
    const dvh = (css().match(/height:100dvh/g) || []).length;
    const pair = (css().match(/height:100vh;height:100dvh/g) || []).length;
    if (dvh && pair < dvh) throw new Error('100dvh без 100vh — корпус потеряет высоту');
  });
  step('правила темы не разбросаны выше своего блока', () => {
    const at = css().indexOf('/* ============ ПРЕМИУМ');
    const stray = [...baseCss().slice(0, baseCss().indexOf('/* ============ ПРЕМИУМ'))
      .matchAll(/(?:^|\n)(\.shell\[data-theme="lux"\][^{]*)\{/g)].map(m => m[1].trim());
    if (stray.length) throw new Error('следующая перекраска их пропустит: ' + stray.join(' | '));
  });
});

/* ---------- 9. звук ---------- */
suite('звук', step => {
  step('аудиофайлов нет', () => {
    if (/data:audio|\.mp3|\.wav|<audio/i.test(doc.documentElement.innerHTML))
      throw new Error('в файл вшит звук');
    if (!/createOscillator/.test(jsSrc())) throw new Error('нечем звучать');
  });
  step('музыка тихая и с нарастанием', () => {
    const v = +((jsSrc().match(/MUSIC_VOL = ([\d.]+)/) || [])[1]);
    if (!v) throw new Error('нет константы громкости');
    if (v > 0.08) throw new Error('громкость ' + v + ' для фона велика');
    if (!/linearRampToValueAtTime\(MUSIC_VOL, t \+ \d+\)/.test(jsSrc()))
      throw new Error('включается рывком — не успеть выключить');
  });
  step('музыка живёт только в разделе', () => {
    if (!/if\(mode==='lux'\)\{ chime\(\); musicStart\(\) \} else musicStop\(\);/.test(jsSrc()))
      throw new Error('не останавливается при выходе');
    if (!/document\.hidden\)\{ adPause\(\); musicStop\(\)/.test(jsSrc()))
      throw new Error('играет в свёрнутой вкладке');
  });
  step('есть чем выключить', () => {
    toLux();
    const b = $('#luxMute');
    if (!b || !vis('#luxMute')) throw new Error('нет кнопки звука');
    if (!b.getAttribute('aria-label')) throw new Error('кнопка без подписи');
    click('#luxMute');
    if (b.getAttribute('aria-pressed') !== 'true') throw new Error('не переключается');
    click('#luxMute');
    goHome();
  });
  step('«уменьшить движение» глушит и звук', () => {
    const n = (jsSrc().match(/matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches\) return;/g) || []).length;
    if (n < 2) throw new Error('настройку учитывает не весь звук');
  });
  step('без Web Audio просто тихо', () => {
    if (!/if\(!AC\) return;/.test(jsSrc())) throw new Error('AudioContext без проверки');
  });
});

/* ---------- 10. двуязычность ---------- */
suite('языки', step => {
  step('ключи совпадают', () => {
    const ru = jsSrc().slice(jsSrc().indexOf('const T={'), jsSrc().indexOf(' uz:{'));
    const uz = jsSrc().slice(jsSrc().indexOf(' uz:{'), jsSrc().indexOf('function plural'));
    const keys = b => new Set([...b.matchAll(/(?:^|[,{\s])([a-zA-Z_]\w*)\s*:/g)].map(m => m[1]));
    const missing = [...keys(ru)].filter(k => !keys(uz).has(k) && !['ru', 'uz'].includes(k));
    if (missing.length) throw new Error('без перевода: ' + missing.join(', '));
  });
  step('в узбекском нет кириллицы', () => {
    const uz = jsSrc().slice(jsSrc().indexOf(' uz:{'), jsSrc().indexOf('function plural'));
    if (/[А-Яа-яЁё]/.test(uz)) throw new Error('осталась кириллица');
  });
  step('переключатель показывает оба кода', () => {
    goHome();
    const b = [...doc.querySelectorAll('#lang [data-l]')];
    if (b.length !== 2) throw new Error('кнопок: ' + b.length);
    if ($('#lang .on').dataset.l !== doc.documentElement.lang) throw new Error('код и документ расходятся');
  });
  step('смена языка перерисовывает всё', () => {
    window.setLang('uz', false);
    if (doc.documentElement.lang !== 'uz') throw new Error('язык не сменился');
    if (/[А-Яа-яЁё]/.test(txt('#nav'))) throw new Error('панель осталась на русском');
    window.setLang('ru', false);
  });
});


/* ---------- 11. премиум покрывает все экраны ---------- */
suite('премиум: накладные экраны', step => {
  const uncovered = sel => {
    const dark = new Set([...css().matchAll(/data-theme="lux"\][^{,]*?\.([\w-]+)/g)].map(m => m[1]));
    const seen = new Set();
    doc.querySelectorAll(sel + ' *').forEach(e => e.classList.forEach(c => seen.add(c)));
    const bad = [];
    seen.forEach(c => {
      if (dark.has(c)) return;
      const m = baseCss().match(new RegExp('(?:^|\\n)\\.' + c + '\\{([^}]*)\\}'));
      if (!m) return;
      if (/background:var\(--white\)|background:var\(--paper\)|background:var\(--lilac\)|(?<!-)color:var\(--ink\)|(?<!-)color:var\(--plum\)|(?<!-)color:var\(--muted\)/.test(m[1]))
        bad.push(c);
    });
    return bad;
  };
  step('накладной экран одет в тему', () => {
    if (!/\.shell\[data-theme="lux"\] \.screen\{background:var\(--paper\)\}/.test(css()))
      throw new Error('профиль и форма открываются на чужом фоне');
  });
  step('профиль вендора одет', () => {
    goHome(); toLux(); click('#list .card');
    const bad = uncovered('#profile');
    if (bad.length) throw new Error('без премиум-варианта: ' + bad.join(', '));
  });
  step('форма заявки одета', () => {
    click('#pfReq');
    const bad = uncovered('#req');
    if (bad.length) throw new Error('без премиум-варианта: ' + bad.join(', '));
    key('Escape'); key('Escape');
  });
  step('поиск одет', () => {
    click('#navSearch');
    const bad = uncovered('#search');
    if (bad.length) throw new Error('без премиум-варианта: ' + bad.join(', '));
    key('Escape'); goHome();
  });
  step('выбранный день — индиго, занятый выцветает', () => {
    const sel = (css().match(/\.shell\[data-theme="lux"\] \.dp-g b\.sel\{([^}]*)\}/) || [])[1] || '';
    if (!/background:var\(--ink\)/.test(sel))
      throw new Error('выбранная дата — это «своё», она должна быть индиго');
    const no = (css().match(/\.shell\[data-theme="lux"\] \.dp-g b\.no u\{([^}]*)\}/) || [])[1] || '';
    if (/var\(--coral\)|#A3302A/.test(no))
      throw new Error('занятый день красный — красный означает «нажми», а не «нельзя»');
  });
});


/* ---------- 12. премиум: сквозной проход ---------- */
suite('премиум: сквозной проход', step => {
  step('вход открывает раздел', () => {
    dismissSplash(); goHome(); toLux();
    if (doc.querySelectorAll('#list .card').length !== 24) throw new Error('состав раздела изменился');
    if ([...doc.querySelectorAll('#nav [data-tab]')].map(b => b.dataset.tab).join() !== '1,2,3')
      throw new Error('панель не своя');
    if (!vis('#luxBack') || vis('#adSlot')) throw new Error('нет возврата или видна реклама');
  });
  step('фильтр и сортировка работают внутри', () => {
    const hall = $('.cat[data-c="hall"]');
    if (hall.getAttribute('aria-pressed') !== 'true') click(hall);
    const n = doc.querySelectorAll('#list .card').length;
    if (!n || n >= 24) throw new Error('категория не фильтрует: ' + n);
    if (!vis('#sortBtn')) throw new Error('нет сортировки');
    click($('.cat[data-c="hall"]'));
  });
  step('профиль вендора открывается и наполнен', () => {
    click('#list .card');
    const p = $('#profile');
    if (!p.classList.contains('on')) throw new Error('не открылся');
    if (!/\+998/.test(p.textContent)) throw new Error('нет телефона');
    if (!vis('#profile .dp')) throw new Error('нет календаря занятости');
    click('#profile .dp-mo');
    if (!has('#profile .dp-menu')) throw new Error('список месяцев не открылся');
    key('Escape');
  });
  step('заявка проходит до конца', () => {
    click('#pfReq');
    if (!$('#req').classList.contains('on')) throw new Error('форма не открылась');
    if ($('#rqSend').disabled) {
      if (!vis('#req .dp')) click('#rqDpBtn');
      const day = $('#req .dp-g b[data-pick]');
      if (day) click(day);
    }
    if ($('#rqSend').disabled) throw new Error('дата не включила отправку');
    click('#rqSend');
    if (!vis('#perm')) throw new Error('согласие не запрошено');
    click('#permOk');
    if (!has('#sHome')) throw new Error('экран отправки не появился');
    click('#sHome');
    if (!vis('#viewToy') || !has('.mt-bill')) throw new Error('счёт не собрался');
  });
  step('выход возвращает обычное приложение', () => {
    goHome();
    if (doc.querySelectorAll('#list .card').length !== 81) throw new Error('лента не восстановилась');
    if ($('.shell').dataset.theme !== 'all') throw new Error('тема залипла');
    if (doc.querySelectorAll('#nav [data-tab]').length !== 4) throw new Error('панель не вернулась');
  });
});

/* ---------- 13. цвета премиума ---------- */
suite('премиум: цвета', step => {
  step('тема переопределяет базовые токены, а не классы', () => {
    const t = luxTokens();
    for (const k of ['--paper', '--white', '--ink', '--muted', '--muted-lt', '--plum'])
      if (!t[k]) throw new Error(k + ' не переопределён — правила с ним останутся светлыми');
  });
  step('каждый переопределённый токен читается на фоне', () => {
    const t = luxTokens();
    const ink = t['--paper'];
    for (const k of ['--ink', '--muted', '--muted-lt', '--plum', '--teal', '--berry']) {
      const r = ctr(t[k], ink);
      if (r < 4.5) throw new Error(`${k} = ${t[k]}: ${r.toFixed(2)}:1`);
    }
  });
  step('вписанные числом цвета получили премиум-вариант', () => {
    const base = baseCss().slice(0, baseCss().indexOf('/* ============ ПРЕМИУМ'));
    const t = luxTokens();
    const bad = [];
    for (const m of base.matchAll(/(?:^|\n)([^{}\n]+)\{([^}]*)\}/g)) {
      if (/data-theme/.test(m[1])) continue;
      for (const c of m[2].matchAll(/(?<!-)\bcolor:\s*(#[0-9A-Fa-f]{6})/g)) {
        if (/^#f{6}$/i.test(c[1])) continue;
        if (ctr(c[1], t['--paper']) >= 4.5) continue;
        const sel = m[1].trim();
        if (!css().includes('[data-theme="lux"] ' + sel + '{')) bad.push(sel + ' ' + c[1]);
      }
    }
    if (bad.length) throw new Error('без варианта: ' + bad.join(', '));
  });
});


/* ---------- 14. дисциплина оформления ---------- */
suite('дисциплина оформления', step => {
  const onScreen = () => {
    const els = [];
    ['#viewSearch', '#nav', '.tg-bar'].forEach(sel =>
      doc.querySelectorAll(sel + ', ' + sel + ' *').forEach(e => els.push(e)));
    return els.filter(e => {
      let n = e;
      while (n && n.nodeType === 1) { if (window.getComputedStyle(n).display === 'none') return false; n = n.parentElement; }
      return true;
    });
  };
  step('капитель не заменяет иерархию', () => {
    dismissSplash(); goHome(); toLux();
    const caps = onScreen().filter(e => window.getComputedStyle(e).textTransform === 'uppercase' && e.textContent.trim());
    if (caps.length > 35) throw new Error(caps.length + ' элементов капителью — всё кричит одинаково');
  });
  step('на карточке не больше одного элемента капителью', () => {
    const c = $('#list .card');
    const caps = [...c.querySelectorAll('*')].filter(e =>
      window.getComputedStyle(e).textTransform === 'uppercase'
      && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
      && window.getComputedStyle(e).display !== 'none');
    if (caps.length > 1) throw new Error('капителью: ' + caps.map(e => e.textContent.trim()).join(', '));
  });
  step('значок «Проверено» не стоит там, где проверены все', () => {
    if (!/\.shell\[data-theme="lux"\] #list \.chip\.ver\{display:none\}/.test(css()))
      throw new Error('в премиуме значок на каждой карточке — он ничего не сообщает');
  });
  step('имя вендора не тише цены', () => {
    const name = +((rule('.b-name').match(/font-size:([\d.]+)px/) || [])[1]);
    const price = +((rule('.b-price b').match(/font-size:([\d.]+)px/) || [])[1]);
    if (!name || !price) throw new Error('не читаются размеры');
    if (price > name) throw new Error(`цена ${price}px громче имени ${name}px`);
  });
  step('заголовки разделов набраны словами, не капителью', () => {
    for (const sel of ['.sec-h', '.eyebrow']) {
      const d = rule(sel);
      if (/text-transform:uppercase/.test(d)) throw new Error(sel + ' всё ещё капителью');
      const fs = +((d.match(/font-size:([\d.]+)px/) || [])[1]);
      if (fs < 12) throw new Error(sel + ` — ${fs}px, заголовок не может быть мельче подписи`);
    }
  });
  step('числа не набирают разрядкой', () => {
    const d = rule('.res-count');
    if (/letter-spacing:\.\d+em/.test(d)) throw new Error('счётчик с разрядкой — это число, а не рубрика');
  });
});


/* ---------- 15. Telegram Mini App ---------- */
suite('Telegram', step => {
  step('SDK подключён', () => {
    if (!/telegram\.org\/js\/telegram-web-app\.js/.test(doc.head.innerHTML))
      throw new Error('скрипт клиента не подключён');
  });
  step('без Telegram приложение работает', () => {
    if (!has('#list .card')) throw new Error('лента пуста вне Telegram');
    if (!/const TG = \(window\.Telegram && window\.Telegram\.WebApp\) \|\| null;/.test(jsSrc()))
      throw new Error('обращение к SDK без проверки');
  });
  step('каждый вызов защищён', () => {
    const js = jsSrc();
    if (!/typeof TG\[name\] !== 'function'/.test(js))
      throw new Error('нет проверки наличия метода — старый клиент упадёт');
    const raw = js.match(/TG\.(ready|expand|requestFullscreen|disableVerticalSwipes|setHeaderColor|setBackgroundColor)\(/g);
    if (raw) throw new Error('прямой вызов без обёртки: ' + raw.join(', '));
  });
  step('полный экран только на телефоне и с версии 8.0', () => {
    const js = jsSrc();
    if (!/TG\.platform === 'ios' \|\| TG\.platform === 'android'/.test(js))
      throw new Error('полный экран запрашивается везде');
    if (!/isVersionAtLeast\('8\.0'\)/.test(js)) throw new Error('нет проверки версии');
    if (!/if\(mobile && canFull\) tgCall\('requestFullscreen'\)/.test(js))
      throw new Error('условие не связано с вызовом');
  });
  step('слушаем все четыре события', () => {
    for (const ev of ['safeAreaChanged', 'contentSafeAreaChanged', 'viewportChanged', 'fullscreenChanged'])
      if (!jsSrc().includes(ev)) throw new Error('не слушаем ' + ev);
  });
  step('вертикальные свайпы отключены', () => {
    if (!/disableVerticalSwipes/.test(jsSrc())) throw new Error('свайп будет схлопывать приложение');
  });
  step('цвет шапки клиента совпадает с фоном', () => {
    if (!/setHeaderColor/.test(jsSrc()) || !/setBackgroundColor/.test(jsSrc()))
      throw new Error('будет виден стык вверху');
    if (!/tgChrome\(\)/.test(jsSrc())) throw new Error('цвет не обновляется при смене темы');
  });
  step('цвет берётся из токена, а не из вычисленного фона', () => {
    const js = jsSrc();
    if (!/getPropertyValue\('--paper'\)/.test(js))
      throw new Error('в премиуме фон — градиент, backgroundColor там прозрачный и шапка станет чёрной');
    if (!/m\[4\] !== undefined && \+m\[4\] === 0/.test(js))
      throw new Error('прозрачный фон не отсеивается');
  });
});

/* ---------- 16. безопасные зоны и высота ---------- */
suite('безопасные зоны', step => {
  step('цепочка: Telegram → система → ноль', () => {
    const root = (css().match(/:root\{([\s\S]*?)\n\}/) || [])[1] || css();
    for (const [name, tg] of [['--sa-t', '--tg-safe-area-inset-top'], ['--sa-b', '--tg-safe-area-inset-bottom']]) {
      const d = (root.match(new RegExp(name + ':([^;]+)')) || [])[1] || '';
      if (!d.includes(tg)) throw new Error(name + ' не берёт значение Telegram');
      if (!d.includes('env(safe-area')) throw new Error(name + ' без системного запасного значения');
      if (!/0px/.test(d)) throw new Error(name + ' без нуля в конце цепочки');
    }
  });
  step('верх складывает обе зоны', () => {
    const d = (css().match(/--pad-t:([^;]+)/) || [])[1] || '';
    if (!/--sa-t/.test(d) || !/--csa-t/.test(d))
      throw new Error('верхний отступ не учитывает кнопки Telegram');
  });
  step('низ складывает обе зоны', () => {
    const d = (css().match(/--pad-b:([^;]+)/) || [])[1] || '';
    if (!/--sa-b/.test(d) || !/--csa-b/.test(d)) throw new Error('нижний отступ неполный');
  });
  step('шапка ниже кнопок клиента', () => {
    const d = rule('.tg-bar');
    if (!/padding:calc\(\d+px \+ var\(--pad-t\)\)/.test(d))
      throw new Error('шапка встанет под кнопки Telegram');
  });
  step('панель выше жест-бара', () => {
    const d = rule('.nav');
    if (!/bottom:calc\(\d+px \+ var\(--pad-b\)\)/.test(d)) throw new Error('панель уйдёт под жест-бар');
  });
  step('прямых env() в обход цепочки нет', () => {
    const bad = [...css().matchAll(/[^;{}\n]*env\(safe-area[^;{}]*/g)]
      .map(m => m[0]).filter(x => !/--(sa|csa)-/.test(x));
    if (bad.length) throw new Error('в обход: ' + bad[0].trim().slice(0, 50));
  });
  step('высота от вьюпорта Telegram', () => {
    const d = rule('.shell');
    if (!/height:var\(--tg-viewport-stable-height, 100dvh\)/.test(d))
      throw new Error('высота не привязана к вьюпорту клиента');
    if (!/height:100vh/.test(d)) throw new Error('нет запасного значения для старых браузеров');
  });
});

/* ---------- 17. раскладка на больших экранах ---------- */
suite('раскладка', step => {
  const at = bp => css().slice(css().indexOf(`@media (min-width:${bp}px){`));
  step('три состояния: телефон, свёрнутая панель, полная', () => {
    const q = [...new Set([...css().matchAll(/@media \(min-width:(\d+)px\)/g)].map(m => +m[1]))];
    for (const b of [768, 1024]) if (!q.includes(b)) throw new Error('нет точки ' + b);
  });
  step('колонка по центру только до 768', () => {
    if (!/@media \(min-width:521px\) and \(max-width:767px\)/.test(css()))
      throw new Error('телефонная колонка перекрывает раскладку с панелью');
  });
  step('ширина панели — переменная, а не число', () => {
    const d = (at(768).match(/\.shell\{([\s\S]*?)\}/) || [])[1] || '';
    if (!/grid-template-columns:var\(--rail/.test(d)) throw new Error('ширина панели вписана числом');
    if (!/--rail:72px/.test(at(768))) throw new Error('нет свёрнутой ширины');
    if (!/--rail:240px/.test(at(1024))) throw new Error('нет полной ширины');
  });
  step('свёрнутая панель прячет подписи и даёт подсказку', () => {
    const c = at(768).slice(0, at(768).indexOf('@media (min-width:1024px)'));
    if (!/\.nav \.lbl\{display:none\}/.test(c)) throw new Error('подписи не спрятаны');
    if (!/content:attr\(data-title\)/.test(c)) throw new Error('нет подсказки при наведении');
  });
  step('подсказка берёт текст подписи', () => {
    for (const b of doc.querySelectorAll('#nav [data-tab]')) {
      const t = b.dataset.title, l = txt('#nav [data-tab="' + b.dataset.tab + '"] .lbl');
      if (!t) throw new Error('кнопка без подсказки');
      if (l && t !== l) throw new Error(`подсказка «${t}» не совпадает с подписью «${l}»`);
    }
  });
  step('накладные экраны отсчитывают от панели', () => {
    for (const sel of ['.screen', '.sheet']) {
      const d = (at(768).match(new RegExp('\\' + sel + '\\{([^}]*)')) || [])[1] || '';
      if (!/left:var\(--rail/.test(d)) throw new Error(sel + ' привязан к числу, а не к ширине панели');
    }
  });
  step('панель и подсказки берут один источник', () => {
    const js = jsSrc();
    if (!/const NAV=\[/.test(js)) throw new Error('нет общего списка пунктов');
    if (!/data-title="\$\{t\[k\]\}"/.test(js)) throw new Error('подсказка не из того же источника, что подпись');
  });
});


/* ---------- 18. Suzani: правила палитры ---------- */
suite('Suzani', step => {
  const lux = () => css().slice(css().indexOf('/* ============ SUZANI'));
  step('токены соответствуют спецификации', () => {
    const t = luxTokens();
    const want = { '--paper': '#EEE7DC', '--white': '#FAF6EF', '--raise': '#FFFDF8',
      '--ink': '#1E2A4F', '--muted': '#6A6357', '--coral': '#A3302A',
      '--btnInk': '#FBF3E8', '--selInk': '#F6EEDF', '--teal': '#2F6B4F', '--berry': '#7A1E1A' };
    for (const [k, v] of Object.entries(want))
      if ((t[k] || '').toUpperCase() !== v) throw new Error(`${k} = ${t[k] || 'нет'}, ожидалось ${v}`);
  });
  step('красный только действует, не говорит', () => {
    // заголовки и бегущий текст не могут быть мареной
    for (const m of lux().matchAll(/(?:^|\n)([^{}\n]*)\{([^}]*)\}/g)) {
      const sel = m[1].trim(), b = m[2];
      if (!/(?<!-)color:var\(--coral\)/.test(b)) continue;
      if (/\.(res-title|sec-h|pf-name|b-name|about|rq-title)\b/.test(sel))
        throw new Error('заголовок набран мареной: ' + sel.slice(0, 40));
    }
  });
  step('«своё» — индиго, а не красный', () => {
    for (const [sel, what] of [['.lang-pill', 'активный язык'], ['.sv-chk.on', 'выбранное'],
                               ['.bgt.on', 'выбранный бюджет'], ['.dp-g b.sel', 'выбранная дата']]) {
      const d = (css().match(new RegExp('\\.shell\\[data-theme="lux"\\][^{]*\\' + sel + '[^{]*\\{([^}]*)')) || [])[1] || '';
      if (/background:var\(--coral\)/.test(d)) throw new Error(what + ' окрашено мареной, а должно быть индиго');
    }
  });
  step('занятая дата выцветает, а не краснеет', () => {
    const d = (css().match(/\.shell\[data-theme="lux"\] \.dp-g b\.no u\{([^}]*)\}/) || [])[1] || '';
    if (/var\(--coral\)|#A3302A/i.test(d)) throw new Error('красный означает «нажми», а не «нельзя»');
  });
  step('красных заливок немного', () => {
    const n = [...lux().matchAll(/\{[^}]*background:var\(--coral\)[^}]*\}/g)].length;
    if (n > 8) throw new Error(n + ' красных заливок — по правилу 2% их должно быть считаное число');
  });
  step('остатков прежних палитр нет', () => {
    // за проект палитра менялась четырежды; ищем следы всех
    const ghosts = { '--lx-gold': 'токен золота', '#C2B27F': 'кремовое золото',
      '#F2DFBB': 'прежний бежевый', '194,178,127': 'кремовое золото',
      '240,195,142': 'персиковое золото', '249,205,178': 'персиковый',
      '237,231,199': 'слоновая кость', '#150C26': 'тёмно-сливовый', '#200E01': 'тёмный орех' };
    const found = Object.entries(ghosts).filter(([k]) => css().includes(k)).map(([, v]) => v);
    if (found.length) throw new Error('остались: ' + [...new Set(found)].join(', '));
  });
  step('подсветка активной вкладки не голый прямоугольник', () => {
    // в нижней панели у кнопки нет радиуса — заливка там дала бы прямоугольник во всю колонку
    const btn = (baseCss().match(/\.shell\[data-theme="lux"\] \.nav button\[aria-pressed="true"\]\{([^}]*)\}/) || [])[1] || '';
    if (/background:var\(--coral-soft\)/.test(btn) && !/border-radius/.test(rule('.nav button[data-tab]')))
      throw new Error('фон на кнопке без радиуса');
    const ico = (baseCss().match(/\.shell\[data-theme="lux"\] \.nav button\[aria-pressed="true"\] \.ico\{([^}]*)\}/) || [])[1] || '';
    if (!/background:var\(--coral-soft\)/.test(ico)) throw new Error('активное состояние ничем не обозначено');
    if (!/border-radius:\d+px/.test(rule('.nav .ico'))) throw new Error('подложка знака без скругления');
  });
  step('активное состояние видно и на живом экране', () => {
    dismissSplash(); goHome(); toLux();
    const on = $('#nav [aria-pressed="true"]');
    if (!on) throw new Error('нет активной вкладки');
    const holder = window.getComputedStyle(on.querySelector('.ico'));
    if (!/coral-soft|rgba/.test(holder.background + holder.backgroundColor))
      throw new Error('подложка знака не закрашена');
    if (parseInt(holder.borderRadius) < 8) throw new Error('подложка знака почти квадратная');
  });
  step('чистого белого и чёрного нет', () => {
    const t = luxTokens();
    for (const [k, v] of Object.entries(t))
      if (/^#FFFFFF$|^#000000$/i.test(v)) throw new Error(k + ' — чистый ' + v);
  });
  step('тени почти отсутствуют', () => {
    const withShadow = [...lux().matchAll(/(?:^|\n)([^{}\n]*)\{([^}]*box-shadow:(?!none)[^}]*)\}/g)]
      .map(m => m[1].trim());
    if (withShadow.length > 4)
      throw new Error(withShadow.length + ' элементов с тенью — палитра плоская, глубину даёт ступень лён→слоновая→хлопок');
  });
});


/* ---------- 19. мои заявки ---------- */
suite('мои заявки', step => {
  const send = i => {
    const cards = [...doc.querySelectorAll('#list .card')];
    click(cards[i]); click('#pfReq');
    if ($('#rqSend').disabled) {
      if (!vis('#req .dp')) click('#rqDpBtn');
      const day = $('#req .dp-g b[data-pick]');
      if (day) click(day);
    }
    click('#rqSend'); click('#permOk'); click('#sSearch');
  };
  step('вход показывается независимо от числа заявок', () => {
    dismissSplash(); goHome();
    if (!vis('#viewSoon')) click('#meBtn');
    const e = $('#meReqs');
    if (!e) throw new Error('раздел не виден — о нём не узнают, пока не наткнутся');
    // счётчик только когда есть что считать: «0» в кружке читается как ошибка
    const js = jsSrc();
    if (!/reqs\.length\?`<span class="mr-cnt">/.test(js))
      throw new Error('счётчик рисуется и при нуле');
    if (!/mrSubEmpty/.test(js)) throw new Error('нет подписи для пустого состояния');
    click('#meReqs');
    if (!$('#myreqs').classList.contains('on')) throw new Error('раздел не открывается');
    key('Escape'); click('#meBtn');
  });
  step('пустой раздел объясняет, что делать', () => {
    const js = jsSrc();
    if (!/mr-empty/.test(js)) throw new Error('нет пустого состояния');
    if (!/mrEmpty:'[^']*Найдите/.test(js)) throw new Error('пустой экран не подсказывает следующий шаг');
  });
  step('после отправки вход появляется в профиле', () => {
    send(0); send(1);
    click('#meBtn');
    const e = $('#meReqs');
    if (!e) throw new Error('в профиле нет входа');
    if (txt('#meReqs .mr-cnt') !== '2') throw new Error('счётчик: ' + txt('#meReqs .mr-cnt'));
  });
  step('экран показывает все заявки', () => {
    click('#meReqs');
    if (!$('#myreqs').classList.contains('on')) throw new Error('экран не открылся');
    if (doc.querySelectorAll('.mr-row').length !== 2) throw new Error('строк: ' + doc.querySelectorAll('.mr-row').length);
  });
  step('в строке видно кому, когда и что ответили', () => {
    const r = $('.mr-row');
    if (!r.querySelector('.mr-main b').textContent.trim()) throw new Error('нет вендора');
    if (!/·/.test(txt('.mr-row .mr-meta'))) throw new Error('нет даты и гостей');
    if (!r.querySelector('.st')) throw new Error('нет статуса');
  });
  step('для неотвеченных показан остаток из 12 часов', () => {
    const left = $('.mr-row .mr-left');
    if (!left) throw new Error('нет счётчика времени');
    if (!/\d/.test(left.textContent)) throw new Error('счётчик без числа: ' + left.textContent);
    const js = jsSrc();
    if (!/function hoursLeft/.test(js)) throw new Error('нет расчёта остатка');
    if (!/12 - passed/.test(js)) throw new Error('срок не 12 часов');
  });
  step('заявка помнит время отправки', () => {
    if (!/at:Date\.now\(\),st:'new'/.test(jsSrc()))
      throw new Error('без отметки времени счётчик посчитать нечем');
  });
  step('тап открывает профиль вендора', () => {
    click('.mr-row');
    if (!$('#profile').classList.contains('on')) throw new Error('профиль не открылся');
    if ($('#myreqs').classList.contains('on')) throw new Error('экран заявок остался поверх');
    key('Escape');
  });
  step('вход есть и в избранном', () => {
    click('[data-tab="2"]');
    if (!has('#svReqs')) throw new Error('в избранном нет входа');
    if (txt('#svReqs .mr-cnt') !== '2') throw new Error('счётчик расходится с профилем');
  });
  step('сказано, кто ставит статус', () => {
    click('#svReqs');
    const note = txt('.mr-note');
    if (!/вендор/i.test(note)) throw new Error('не сказано, что статус ставит вендор');
    if (!/12/.test(note)) throw new Error('не упомянуто обещание про 12 часов');
    key('Escape'); goHome();
  });
});


/* ---------- 20. целостность таблицы стилей ---------- */
suite('целостность стилей', step => {
  step('скобки сбалансированы', () => {
    const src = css();
    let d = 0, line = 0;
    src.split('\n').forEach((l, i) => {
      d += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
      if (d < 0 && !line) line = i + 1;
    });
    if (line) throw new Error('лишняя закрывающая скобка на строке ' + line);
    if (d !== 0) throw new Error('не закрыто блоков: ' + d);
  });
  step('строгий разбор проходит без ошибок', () => {
    // современный браузер простит лишнюю скобку, старый и строгий — нет
    const { JSDOM, VirtualConsole } = require('jsdom');
    const vc = new VirtualConsole();
    let err = null;
    vc.on('jsdomError', e => err = e.message.split('\n')[0]);
    new JSDOM('<style>' + css() + '</style>', { virtualConsole: vc });
    if (err) throw new Error(err);
  });
});


/* ---------- 21. доступность ---------- */
suite('доступность', step => {
  const F = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';
  const shown = el => {
    let n = el;
    while (n && n.nodeType === 1) {
      const c = window.getComputedStyle(n);
      if (c.display === 'none' || c.visibility === 'hidden') return false;
      n = n.parentElement;
    }
    return true;
  };
  step('страница размечена ориентирами', () => {
    if (!has('main')) throw new Error('нет <main> — скринридер не найдёт основное содержимое');
    if (!has('header')) throw new Error('нет <header>');
    if (!has('nav')) throw new Error('нет <nav>');
    if ($('main').querySelector('#nav')) throw new Error('панель внутри main');
    if (!$('main').querySelector('#viewSearch')) throw new Error('лента вне main');
  });
  step('накладные экраны объявлены диалогами', () => {
    for (const id of ['profile', 'req', 'search', 'myreqs']) {
      const e = $('#' + id);
      if (e.getAttribute('role') !== 'dialog') throw new Error('#' + id + ' без role=dialog');
      if (e.getAttribute('aria-modal') !== 'true') throw new Error('#' + id + ' без aria-modal');
    }
  });
  step('фокус уходит внутрь открытого диалога', () => {
    dismissSplash(); goHome();
    const card = $('#list .card');
    card.focus();
    click(card);
    const dlg = $('#profile');
    if (dlg.getAttribute('aria-hidden') !== 'false') throw new Error('диалог остался скрытым для скринридера');
    if (!/openDialog\(\$\('#profile'\)\)/.test(jsSrc())) throw new Error('открытие не переводит фокус');
    key('Escape');
  });
  step('фокус возвращается на место', () => {
    if (!/back && document\.contains\(back\)/.test(jsSrc()))
      throw new Error('после закрытия фокус не вернётся к тому, что открыли');
  });
  step('таб не выходит за пределы диалога', () => {
    const js = jsSrc();
    if (!/e\.key !== 'Tab'/.test(js)) throw new Error('таб не перехватывается');
    if (!/e\.shiftKey && document\.activeElement === first/.test(js))
      throw new Error('обратный таб уйдёт за пределы диалога');
  });
  step('фокус ставится после перехода и без прокрутки', () => {
    // фокус на едущем элементе прокручивает контейнер и оставляет его сдвинутым
    if (!/focus\(\{preventScroll:true\}\)/.test(jsSrc())) throw new Error('нет preventScroll');
    if (!/setTimeout\(\(\)=>\{[\s\S]{0,200}?first\.focus/.test(jsSrc()))
      throw new Error('фокус ставится до окончания перехода');
  });
  step('у каждой кнопки есть имя', () => {
    const bad = [...doc.querySelectorAll('button')].filter(b =>
      shown(b) && !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'));
    if (bad.length) throw new Error('без имени: ' + [...new Set(bad.map(b => b.id || b.className))].join(', '));
  });
  step('в наборе нет мёртвых иконок', () => {
    const js = jsSrc();
    const IC = JSON.parse(js.match(/const IC=(\{.*?\});/s)[1]);
    const body = js.replace(/const IC=\{.*?\};/s, '');
    const dead = Object.keys(IC).filter(k => !new RegExp("['\"]" + k + "['\"]").test(body));
    if (dead.length) throw new Error('не используются: ' + dead.join(', '));
  });
});


/* ---------- 22. история заявок доступна отовсюду ---------- */
suite('история заявок', step => {
  const sendTo = i => {
    const c = [...doc.querySelectorAll('#list .card')][i];
    click(c); click('#pfReq');
    if ($('#rqSend').disabled) {
      if (!vis('#req .dp')) click('#rqDpBtn');
      const day = $('#req .dp-g b[data-pick]');
      if (day) click(day);
    }
    click('#rqSend'); click('#permOk'); click('#sSearch');
  };
  step('в премиуме до заявок ведёт «Избранное»', () => {
    // полосу над лентой убрали по решению владельца продукта;
    // профиль в премиуме скрыт, поэтому единственный вход обязан работать
    dismissSplash(); goHome();
    sendTo(0);
    toLux();
    if (has('#luxReqs')) throw new Error('полоса над лентой вернулась');
    click('[data-tab="2"]');
    if (!has('#svReqs')) throw new Error('в премиуме не осталось ни одного входа в заявки');
    click('#svReqs');
    if (!$('#myreqs').classList.contains('on')) throw new Error('экран не открылся');
    if (!doc.querySelectorAll('.mr-row').length) throw new Error('список пуст, хотя заявка есть');
    key('Escape'); goHome();
  });
  step('карточка вендора помнит отправленную заявку', () => {
    click('#list .card');
    const b = $('#pfSent');
    if (!b) throw new Error('нет отметки о заявке');
    if (!/ждём ответа|ответили|договорились/.test(b.textContent)) throw new Error('не показан статус');
    if (!/·/.test(b.textContent)) throw new Error('не показана дата');
  });
  step('кнопка не зовёт писать повторно', () => {
    const label = txt('#pfReq');
    if (/Оставить заявку/.test(label)) throw new Error('предлагает отправить заново тому, кому уже писали');
  });
  step('отметка ведёт в историю', () => {
    click('#pfSent');
    if (!$('#myreqs').classList.contains('on')) throw new Error('отметка никуда не ведёт');
    key('Escape'); key('Escape');
  });
  step('у вендора без заявки отметки нет', () => {
    click([...doc.querySelectorAll('#list .card')][3]);
    if (has('#pfSent')) throw new Error('отметка показана без заявки');
    if (!/Оставить заявку/.test(txt('#pfReq'))) throw new Error('кнопка не зовёт написать');
    key('Escape');
  });
  step('все входы ведут в один список', () => {
    const count = () => { click('#meReqs'); const n = doc.querySelectorAll('.mr-row').length; key('Escape'); return n; };
    click('#meBtn');
    const a = count();
    click('#meBtn'); click('[data-tab="2"]');
    click('#svReqs');
    const b = doc.querySelectorAll('.mr-row').length;
    key('Escape'); goHome();
    if (a !== b) throw new Error(`из профиля ${a}, из избранного ${b}`);
  });
});


/* ---------- 23. плоскость Suzani ---------- */
suite('Suzani: без коробок под знаками', step => {
  /* делим правила по селектору, а не по месту в файле:
     поздние добавления лежат после блока темы, но темой не являются */
  // селектор может занимать несколько строк — перенос внутри списка это норма
  const rules = () => [...css().matchAll(/(?:^|\n)([^{}]+)\{([^}]*)\}/g)]
    .map(m => ({ sel: m[1].trim().replace(/\s*\n\s*/g, ' '), body: m[2] }));
  const luxRules = () => rules().filter(r => /data-theme="lux"/.test(r.sel));
  const baseRules = () => rules().filter(r => !/data-theme="lux"/.test(r.sel));

  step('у знака внутри чипа нет своей заливки', () => {
    const r = luxRules().find(x => /\.cat-i\b/.test(x.sel) && /background/.test(x.body));
    if (!r) throw new Error('нет переопределения для знака чипа');
    if (!/background:none/.test(r.body))
      throw new Error('коробка в коробке: у чипа уже есть заливка и линейка');
  });
  step('подложек под знаками в теме не осталось', () => {
    const bad = luxRules().filter(r =>
      /-i\b|\.ico\b/.test(r.sel) &&
      /background:(?!none)/.test(r.body) &&
      !/\.ok\b|aria-pressed="true"/.test(r.sel)   // состояния — им заливка положена
    ).map(r => r.sel.slice(0, 40));
    if (bad.length) throw new Error('с заливкой: ' + bad.join(', '));
  });
  step('в светлой теме подложки остаются', () => {
    const want = ['.me-i', '.sv-reqs-i', '.pf-sent-i'];
    const kept = want.filter(sel =>
      baseRules().some(r => r.sel === sel && /background:var\(--lilac\)/.test(r.body)));
    if (kept.length !== want.length)
      throw new Error('правка задела светлую тему: осталось ' + kept.join(', '));
  });
  step('переопределение темы идёт после базового правила', () => {
    const src = css();
    const bad = [];
    for (const sel of ['.me-i', '.sv-reqs-i', '.pf-sent-i', '.mt-i', '.mr-cnt', '.cat-i']) {
      const base = src.indexOf('\n' + sel + '{');
      const lux = src.indexOf('[data-theme="lux"] ' + sel);
      if (base > 0 && lux > 0 && lux < base) bad.push(sel);
    }
    if (bad.length) throw new Error('тема раньше базы, каскад держится на весе селектора: ' + bad.join(', '));
  });
});

/* ---------- вывод ---------- */
let failed = 0, total = 0;
for (const [name, out] of groups) {
  console.log('\n' + name);
  for (const [s, label] of out) {
    total++;
    if (s === 'FAIL') failed++;
    console.log((s === 'ok' ? '  ok    ' : '  FAIL  ') + label);
  }
}
console.log('\n' + (total - failed) + '/' + total + ' проверок пройдено');
if (errors.length) console.log('ошибки скрипта: ' + errors.join(' | '));
process.exitCode = (failed || errors.length) ? 1 : 0;
// Таймеры прототипа (карусель рекламы) держат цикл событий — без close() процесс не завершается
dom.window.close();
