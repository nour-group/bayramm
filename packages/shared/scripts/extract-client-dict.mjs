/* Перенос словаря T из прототипа клиента в src/i18n/ru.ts и src/i18n/uz.ts.

   Запуск из корня:  pnpm --filter @bayramm/shared extract:dict
   (сам скрипт, затем biome check --write по двум сгенерированным файлам).
   Нужен Node ≥ 22.18: uz-apostrophe.ts подключается напрямую, типы Node снимает сам.
   jsdom берётся из зависимостей прототипа — своей зависимости у пакета нет.

   Что делает:
   1. Загружает prototypes/client/index.html в jsdom и забирает объект T
      через дописанный в конец страницы скрипт (прототип не меняется).
   2. Строки и массивы переносит как есть. Функции разбирает по исходнику:
      конкатенация и шаблоны → шаблонная строка TS с типизированными параметрами (FN_PARAMS).
   3. Применяет правки текста из REWRITES: запрещённые слова и метка «Реклама»; русский
      текст приводит к глоссарию клиента (src/i18n/glossary.ts): «вендор» → «исполнитель».
   4. Узбекский текст пропускает через normalizeUz (написание апострофов ждёт подтверждения).
   5. HTML внутри строк (<p>, <p class="warn">, <ul><li>, <b>) переводит в блоки rich.ts.
   6. Падает, если что-то не сошлось: правка не нашла текст, у функции нет описания
      параметров, выражение незнакомое, осталась разметка или запрещённое слово. */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { GLOSSARY_FORBIDDEN, glossaryRu } from "../src/i18n/glossary.ts";
import { normalizeUz } from "../src/i18n/uz-apostrophe.ts";

const PROTOTYPE = new URL("../../../prototypes/client/index.html", import.meta.url);
/** Начало секции текстов приложения в ru.ts и uz.ts (см. appSection) */
const APP_MARKER = "  // ── тексты приложения";
const OUT_DIR = new URL("../src/i18n/", import.meta.url);
const requireFromPrototype = createRequire(
  new URL("../../../prototypes/client/package.json", import.meta.url),
);
const { JSDOM, VirtualConsole } = requireFromPrototype("jsdom");

/* Типы параметров функций-ключей. Имена — как в прототипе; если прототип поменяет
   сигнатуру, скрипт упадёт, а не угадает тип. */
const FN_PARAMS = {
  mrLeft: { n: "number" },
  srFound: { n: "number" },
  srNoneP: { q: "string" },
  svShareMsg: { n: "number" },
  cmpSel: { n: "number" },
  svDelMsg: { n: "number" },
  mtAdded: { n: "string" },
  mtSaved: { n: "number" },
  calFreeN: { n: "number" },
  calBusyN: { n: "number" },
  permWho: { n: "string" },
  pickDate: { d: "string" },
  pfCopy: { n: "string" },
  pfCall: { n: "string" },
  go: { n: "number" },
  people: { n: "number" },
  guestsShort: { n: "number" },
  found: { f: "number", t: "number" },
  req: { n: "string" },
};

/* Правки текста. from/to для узбекского можно писать с прямым апострофом:
   обе стороны проходят через normalizeUz. Каждая правка обязана найти свой текст. */
const REWRITES = [
  // «Заявка, не бронь» (CLAUDE.md): корень «брон»/«bron» и «band qil» в словаре запрещены,
  // в том числе в отрицаниях. Замена — «не закрепляет место», как уже сказано в sentWarn/req.
  ...["note", "rqNote", "pfBarNote"].flatMap((key) => [
    { key, lang: "ru", from: "Заявка не бронирует место.", to: "Заявка не закрепляет место." },
    { key, lang: "uz", from: "So'rov joyni band qilmaydi.", to: "So'rov joyni biriktirmaydi." },
  ]),
  ...["meA2", "i_book_h"].flatMap((key) => [
    { key, lang: "ru", from: "Почему мы не бронируем", to: "Как работает заявка" },
    { key, lang: "uz", from: "Nega bron qilmaymiz", to: "So'rov qanday ishlaydi" },
  ]),
  { key: "meA2s", lang: "ru", from: "Чем заявка отличается от брони", to: "Почему дату подтверждает вендор" },
  {
    key: "meA2s",
    lang: "uz",
    from: "So'rov brondan nimasi bilan farq qiladi",
    to: "Nega sanani hamkor tasdiqlaydi",
  },
  {
    key: "i_book_b",
    lang: "ru",
    from: "Мы поисковик, а не сервис бронирования.",
    to: "Мы поисковик: помогаем найти вендора и связаться с ним.",
  },
  { key: "i_book_b", lang: "ru", from: "а не бронь.", to: "а не гарантия даты." },
  {
    key: "i_book_b",
    lang: "uz",
    from: "Biz qidiruv tizimimiz, bron xizmati emas.",
    to: "Biz qidiruv tizimimiz: hamkorni topish va u bilan bog'lanishga yordam beramiz.",
  },
  {
    key: "i_book_b",
    lang: "uz",
    from: "suhbat boshlanishi, bron emas.",
    to: "suhbat boshlanishi, sana kafolati emas.",
  },
  // Глоссарий клиента (src/i18n/glossary.ts): у кого заказывают — «исполнитель», не «подрядчик»
  {
    key: "mrEmpty",
    lang: "ru",
    from: "Найдите подрядчика и отправьте первую.",
    to: "Выберите исполнителя в каталоге и отправьте первую.",
  },
  // «Реклама помечена» (CLAUDE.md): оплаченный блок и тексты о нём называют его «Реклама»,
  // как и узбекское «Reklama».
  { key: "promo", lang: "ru", from: "Продвижение", to: "Реклама" },
  { key: "sortDef", lang: "ru", from: "продвижение помечено", to: "реклама помечена" },
  {
    key: "sortNote",
    lang: "ru",
    from: "Платное продвижение поднимает только в порядке по умолчанию.",
    to: "Реклама поднимается выше только в порядке по умолчанию.",
  },
  // Юридический статус оператора в интерфейсе не озвучиваем: тексты утверждает юрист
  {
    key: "meCo",
    lang: "ru",
    from: "Реквизиты появятся после регистрации юрлица",
    to: "Реквизиты компании будут опубликованы здесь",
  },
  {
    key: "meCo",
    lang: "uz",
    from: "Rekvizitlar yuridik shaxs ro'yxatdan o'tgach paydo bo'ladi",
    to: "Kompaniya rekvizitlari shu yerda e'lon qilinadi",
  },
  {
    key: "i_d1_b",
    lang: "ru",
    from: "Полный текст будет опубликован до запуска и зарегистрирован вместе с базой в Госреестре.",
    to: "Полный текст будет опубликован до запуска.",
  },
  {
    key: "i_d1_b",
    lang: "uz",
    from: "To'liq matn ishga tushirishdan oldin e'lon qilinadi va baza bilan birga Davlat reyestrida ro'yxatdan o'tkaziladi.",
    to: "To'liq matn ishga tushirishdan oldin e'lon qilinadi.",
  },
];

// Запрещённое в итоговом тексте. Проверяется и тестом i18n.test.ts.
const FORBIDDEN = { ru: [/брон/i, /продвижен/i], uz: [/bron/i, /band\s+qil/i] };

/* ---------- 1. словарь из прототипа ---------- */

function loadDictionary() {
  const html = readFileSync(PROTOTYPE, "utf8");
  const end = html.lastIndexOf("</body>");
  if (end < 0) throw new Error("в прототипе нет </body>");
  const probe = "<script>window.__BAYRAMM_T__ = T;</script>";
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e.message.split("\n")[0]));
  const dom = new JSDOM(html.slice(0, end) + probe + html.slice(end), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const T = dom.window.__BAYRAMM_T__;
  if (!T?.ru || !T?.uz) throw new Error(`T не найден в прототипе: ${errors.join("; ")}`);
  // Ключи, строки и исходники функций копируем до закрытия окна
  const out = {};
  for (const lang of ["ru", "uz"]) {
    out[lang] = {};
    for (const [key, value] of Object.entries(T[lang])) {
      if (typeof value === "string") out[lang][key] = { kind: "string", value };
      else if (typeof value === "function") out[lang][key] = { kind: "fn", source: value.toString() };
      else if (Array.isArray(value) && value.every((v) => typeof v === "string"))
        out[lang][key] = { kind: "array", value: [...value] };
      else throw new Error(`${lang}.${key}: неизвестный вид значения`);
    }
  }
  dom.window.close();
  return out;
}

/* ---------- 2. разбор функций ---------- */

// Раскрывает escape-последовательности JS-строки без eval
function unescapeJs(s) {
  const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    if (e.length > 1 && e[0] === "u")
      return String.fromCodePoint(parseInt(e[1] === "{" ? e.slice(2, -1) : e.slice(1), 16));
    if (e.length > 1 && e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    return simple[e] ?? e;
  });
}

// Индекс закрывающей кавычки строки, начинающейся в i (для ' и ")
function skipQuoted(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === q) return j;
  }
  throw new Error(`незакрытая строка: ${src}`);
}

// Индекс закрывающего ` шаблона, начинающегося в i (подстановки ${…} пропускаются целиком)
function skipTemplate(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "`") return j;
    else if (src[j] === "$" && src[j + 1] === "{") j = skipBraces(src, j + 1);
  }
  throw new Error(`незакрытый шаблон: ${src}`);
}

function skipBraces(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "'" || c === '"') j = skipQuoted(src, j);
    else if (c === "`") j = skipTemplate(src, j);
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j;
  }
  throw new Error(`незакрытая скобка: ${src}`);
}

// Делит выражение по «+» верхнего уровня
function splitPlus(src) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"') i = skipQuoted(src, i);
    else if (c === "`") i = skipTemplate(src, i);
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "+" && depth === 0) {
      parts.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(src.slice(start).trim());
  return parts;
}

// Сегменты шаблонной строки: текст и выражения ${…}
function templateSegments(tpl) {
  const segs = [];
  let text = "";
  for (let i = 1; i < tpl.length - 1; i++) {
    if (tpl[i] === "\\") {
      text += tpl.slice(i, i + 2);
      i++;
    } else if (tpl[i] === "$" && tpl[i + 1] === "{") {
      const close = skipBraces(tpl, i + 1);
      segs.push({ text: unescapeJs(text) }, { expr: tpl.slice(i + 2, close).trim() });
      text = "";
      i = close;
    } else text += tpl[i];
  }
  segs.push({ text: unescapeJs(text) });
  return segs;
}

// Выражение из прототипа → выражение TS. Разрешены только параметр и plural(параметр, 'a', 'b', 'c')
function translateExpr(expr, params, where) {
  if (params.includes(expr)) return { code: expr, usesPlural: false };
  const m = expr.match(
    /^plural\(\s*(\w+)\s*,\s*('[^'\\]*'|"[^"\\]*")\s*,\s*('[^'\\]*'|"[^"\\]*")\s*,\s*('[^'\\]*'|"[^"\\]*")\s*\)$/,
  );
  if (m && params.includes(m[1])) {
    // Формы склонения — тоже текст: глоссарий (русские слова в узбекском не встречаются)
    const forms = [m[2], m[3], m[4]].map((lit) => JSON.stringify(glossaryRu(lit.slice(1, -1))));
    return { code: `ruPlural(${m[1]}, ${forms.join(", ")})`, usesPlural: true };
  }
  throw new Error(`${where}: незнакомое выражение «${expr}»`);
}

function parseFunction(source, where) {
  const m = source.match(/^\s*(?:\(([^)]*)\)|(\w+))\s*=>\s*([\s\S]+)$/);
  if (!m) throw new Error(`${where}: не стрелочная функция: ${source}`);
  const params = (m[1] ?? m[2])
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const segs = [];
  for (const operand of splitPlus(m[3].trim())) {
    const first = operand[0];
    if ((first === "'" || first === '"') && skipQuoted(operand, 0) === operand.length - 1)
      segs.push({ text: unescapeJs(operand.slice(1, -1)) });
    else if (first === "`" && skipTemplate(operand, 0) === operand.length - 1)
      segs.push(...templateSegments(operand));
    else segs.push({ expr: operand });
  }
  return { params, segs };
}

/* ---------- 3–5. текст: правки, апострофы, разметка ---------- */

// Место выражения в тексте функции. Символы из частной области Unicode: разбор HTML их
// сохраняет (NUL, например, выбросил бы) и в текстах прототипа их нет.
const HOLE = (i) => `\uE000${i}\uE001`;
const HOLE_RE = /\uE000(\d+)\uE001/g;
const HAS_HOLE = /\uE000\d+\uE001/;
const used = new Set();

function rewrite(key, lang, text) {
  let out = text;
  for (const [i, r] of REWRITES.entries()) {
    if (r.key !== key || r.lang !== lang) continue;
    const from = lang === "uz" ? normalizeUz(r.from) : r.from;
    const to = lang === "uz" ? normalizeUz(r.to) : r.to;
    const at = out.indexOf(from);
    if (at < 0 || out.indexOf(from, at + 1) >= 0)
      throw new Error(`${lang}.${key}: правка «${r.from}» не нашла текст ровно один раз`);
    out = out.slice(0, at) + to + out.slice(at + from.length);
    used.add(i);
  }
  return out;
}

// Правки, апострофы, глоссарий и проверка запретов для одного куска текста
function prepare(key, lang, text) {
  const rewritten = rewrite(key, lang, lang === "uz" ? normalizeUz(text) : text);
  const out = lang === "ru" ? glossaryRu(rewritten) : rewritten;
  const plain = out.replace(/<[^>]+>/g, " ");
  for (const re of [...FORBIDDEN[lang], ...GLOSSARY_FORBIDDEN[lang]])
    if (re.test(plain)) throw new Error(`${lang}.${key}: запрещено ${re} — «${plain}»`);
  return out;
}

// Строка с дырами под выражения → код TS: строковый литерал или шаблонная строка
function textCode(text, exprs) {
  if (!HAS_HOLE.test(text)) return JSON.stringify(text);
  // Текст целиком из одного выражения — само выражение (типы сверит tsc)
  const whole = text.match(/^\uE000(\d+)\uE001$/);
  if (whole) return exprs[Number(whole[1])];
  const escaped = text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return `\`${escaped.replace(HOLE_RE, (_, i) => `\${${exprs[Number(i)]}}`)}\``;
}

const hasMarkup = (text) => /<\/?[a-z][^>]*>|&[a-z#][a-z0-9]*;/i.test(text);

// Фрагменты строки (текстовые узлы и <b>) → список кода Inline
function inlineCodes(nodes, exprs, where, helpers) {
  const codes = [];
  for (const node of nodes) {
    if (node.nodeType === 3) {
      // Дыры внутри текста превращаются в отдельные фрагменты: "текст", выражение, "текст"
      const text = node.textContent;
      let last = 0;
      for (const m of text.matchAll(HOLE_RE)) {
        if (m.index > last) codes.push(JSON.stringify(text.slice(last, m.index)));
        codes.push(exprs[Number(m[1])]);
        last = m.index + m[0].length;
      }
      if (last < text.length) codes.push(JSON.stringify(text.slice(last)));
    } else if (node.nodeType === 1 && (node.tagName === "B" || node.tagName === "STRONG")) {
      if (node.children.length) throw new Error(`${where}: вложенная разметка в <b>`);
      helpers.add("strong");
      codes.push(`strong(${textCode(node.textContent, exprs)})`);
    } else throw new Error(`${where}: неожиданный узел ${node.nodeName}`);
  }
  return codes;
}

// Разбор HTML без исполнения скриптов (JSDOM.fragment не запускает код страницы)
const fragment = (html) => [...JSDOM.fragment(html).childNodes];

// HTML-строка из прототипа → массив блоков rich.ts
function blocksCode(html, where, helpers) {
  const blocks = [];
  for (const node of fragment(html)) {
    if (node.nodeType === 3 && !node.textContent.trim()) continue;
    if (node.nodeType !== 1) throw new Error(`${where}: текст вне блока`);
    if (node.tagName === "P") {
      const fn = node.classList.contains("warn") ? "warn" : "p";
      if (node.classList.length > (fn === "warn" ? 1 : 0))
        throw new Error(`${where}: неизвестный класс абзаца`);
      helpers.add(fn);
      blocks.push(`${fn}(${inlineCodes(node.childNodes, [], where, helpers).join(", ")})`);
    } else if (node.tagName === "UL") {
      const items = [...node.children].map((li) => {
        if (li.tagName !== "LI" || li.children.length) throw new Error(`${where}: в списке не простой <li>`);
        return JSON.stringify(li.textContent);
      });
      helpers.add("list");
      blocks.push(`list(${items.join(", ")})`);
    } else throw new Error(`${where}: неожиданный блок <${node.tagName.toLowerCase()}>`);
  }
  return `[${blocks.join(", ")}]`;
}

/* ---------- сборка файла ---------- */

function valueCode(entry, key, lang, helpers) {
  const where = `${lang}.${key}`;
  if (entry.kind === "array")
    return `[${entry.value.map((v) => JSON.stringify(prepare(key, lang, v))).join(", ")}]`;
  if (entry.kind === "string") {
    const text = prepare(key, lang, entry.value);
    return hasMarkup(text) ? blocksCode(text, where, helpers) : JSON.stringify(text);
  }
  const types = FN_PARAMS[key];
  const { params, segs } = parseFunction(entry.source, where);
  if (!types || Object.keys(types).join() !== params.join())
    throw new Error(`${where}: параметры (${params}) не совпадают с FN_PARAMS`);
  const exprs = [];
  let template = "";
  for (const seg of segs) {
    if ("text" in seg) template += seg.text;
    else {
      const { code, usesPlural } = translateExpr(seg.expr, params, where);
      if (usesPlural) helpers.add("ruPlural");
      template += HOLE(exprs.length);
      exprs.push(code);
    }
  }
  const text = prepare(key, lang, template);
  const signature = params.map((p) => `${p}: ${types[p]}`).join(", ");
  if (!hasMarkup(text)) return `(${signature}) => ${textCode(text, exprs)}`;
  // Разметка в функции (pickDate) → массив фрагментов Inline
  helpers.add("Inline");
  const codes = inlineCodes(fragment(text), exprs, where, helpers);
  return `(${signature}): Inline[] => [${codes.join(", ")}]`;
}

function header(lang) {
  const what = lang === "ru" ? "Русский" : "Узбекский (латиница)";
  return `/* ${what} словарь клиентского приложения.

   Ключи до строки «${APP_MARKER.trim()}» СГЕНЕРИРОВАНЫ scripts/extract-client-dict.mjs
   из prototypes/client/index.html (объект T): их правьте не здесь, а таблицей REWRITES
   в скрипте и перезапускайте: pnpm --filter @bayramm/shared extract:dict.
   Ключи после неё — тексты приложения, которых в прототипе нет: правятся здесь руками,
   перенос сохраняет их как есть. Новый ключ — в оба языка, в том же порядке. */
`;
}

/* Хвост словаря после APP_MARKER — тексты приложения. Переносим как есть: скрипт их
   не порождает и не проверяет (это делают тип Dict и i18n.test.ts) */
function appSection(lang) {
  let source;
  try {
    source = readFileSync(new URL(`${lang}.ts`, OUT_DIR), "utf8");
  } catch {
    return "";
  }
  const start = source.indexOf(APP_MARKER);
  if (start < 0) return "";
  const end = source.lastIndexOf("\n};");
  if (end < start) throw new Error(`${lang}.ts: после секции приложения нет закрывающей «};»`);
  return `${source.slice(start, end)}\n`;
}

function renderFile(lang, dict, keys) {
  const helpers = new Set();
  const lines = keys.map((key) => `  ${key}: ${valueCode(dict[lang][key], key, lang, helpers)},`);
  const imports = [];
  if (helpers.has("ruPlural")) imports.push(`import { ruPlural } from "./plural";`);
  const rich = ["list", "p", "strong", "warn"].filter((h) => helpers.has(h));
  const richTypes = helpers.has("Inline") ? ["type Inline"] : [];
  if (rich.length || richTypes.length)
    imports.push(`import { ${[...richTypes, ...rich].join(", ")} } from "./rich";`);
  if (lang === "uz") imports.unshift(`import type { Dict } from "./dict";`);
  const decl = lang === "ru" ? "export const ru = {" : "export const uz: Dict = {";
  return `${header(lang)}\n${imports.join("\n")}\n\n${decl}\n${lines.join("\n")}\n${appSection(lang)}};\n`;
}

/* ---------- запуск ---------- */

const dict = loadDictionary();
const keys = Object.keys(dict.ru);
if (keys.join() !== Object.keys(dict.uz).join())
  throw new Error("набор или порядок ключей ru и uz в прототипе различается");

const files = { ru: renderFile("ru", dict, keys), uz: renderFile("uz", dict, keys) };
const unused = REWRITES.filter((_, i) => !used.has(i));
if (unused.length)
  throw new Error(`правки не применились: ${unused.map((r) => `${r.lang}.${r.key}`).join(", ")}`);
for (const [lang, source] of Object.entries(files)) {
  const leftover = source.match(/<\/?[a-z]+[^>]*>/i);
  if (leftover) throw new Error(`${lang}: осталась разметка ${leftover[0]}`);
  writeFileSync(new URL(`${lang}.ts`, OUT_DIR), source);
}

const fnCount = keys.filter((k) => dict.ru[k].kind === "fn").length;
console.log(`словарь: ${keys.length} ключей в каждом языке, из них функций ${fnCount}; правок ${used.size}`);
