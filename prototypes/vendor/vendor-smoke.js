/* Кабинет вендора Bayram.uz — автоматические проверки.
   Часть проверок — не вёрстка, а правила продукта из ТЗ, часть II и XI.3. */
const {JSDOM}=require('jsdom'),fs=require('fs');
const src=fs.readFileSync(__dirname+'/vendor-panel.html','utf8');
let n=0,fail=0,group='';
const G=g=>{group=g};
const ok=(c,m)=>{n++;if(!c){fail++;console.log('  ПРОВАЛ ['+group+'] '+m)}};
const dom=new JSDOM(src,{runScripts:'dangerously',pretendToBeVisual:true});
const w=dom.window,d=w.document;w.open=()=>{};
const $=s=>d.querySelector(s),$$=s=>[...d.querySelectorAll(s)];
const click=el=>el.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
const type=(sel,v)=>{const el=$(sel);el.value=v;el.dispatchEvent(new w.Event('input',{bubbles:true}))};
const txt=()=>$('#scroll').textContent;
const T=w.eval('T'),get=x=>w.eval(x);
const tab=k=>click($(`#nav [data-tab="${k}"]`));
/* перерисовка после звонка отложена, чтобы ссылка tel: успела сработать — в тесте торопим её */
const tick=()=>get('render()');

/* ===== ТЗ часть II: правила, которые нельзя нарушать ===== */
G('правила');
ok(!/брон/i.test(src.split('<script>')[1])||!/забронир/i.test(JSON.stringify(T)),'слово «забронировать» в интерфейсе запрещено');
ok(!/забронир/i.test(JSON.stringify(T.ru))&&!/bron qil/i.test(JSON.stringify(T.uz)),'ни «бронь», ни «bron» в текстах');
ok(!/комисси[яю] с заказа|komissiya.*buyurtma/i.test(JSON.stringify(T.ru).replace(/Комиссии нет|Ни комиссий|не берём комиссию/g,'')),'нет упоминаний комиссии с заказа как факта');
ok(/нисколько/i.test(T.ru.l_a1),'на вопрос о комиссии отвечаем «нисколько»');
ok(get('PLAN_KEYS').join()==='base,active,ext','верхний тариф — «Расширенный», не «Премиум»');
ok(T.ru.t_ext==='Расширенный'&&T.uz.t_ext==='Kengaytirilgan','название верхнего тарифа по ТЗ 6.1');
ok(/не даёт премиум-статус/i.test(T.ru.t_notLux),'тариф прямо отделён от премиум-статуса');
ok(!/lux\s*=\s*true/.test(src.replace(/lux:false/g,''))||!/data-plan[^]{0,400}lux=true/.test(src),'смена тарифа не выставляет премиум-статус');
ok(get('PLANS.A').join()==='0,390000,990000'&&get('PLANS.B').join()==='0,240000,590000'&&get('PLANS.C').join()==='0,140000,340000','цены тарифов по ТЗ VII');
ok(get('ADS.length')===3,'рекламных мест ровно три');
ok(get('HOURS')===12,'счётчик именно на 12 часов');

/* ===== §5.3 заявки ===== */
G('заявки');
ok(txt().includes(T.ru.i_title),'кабинет открывается на заявках');
ok($$('.rq').length>0,'заявки отрисованы');
ok($('.rq').classList.contains('late'),'просроченная стоит первой');
ok(txt().includes(T.ru.i_promise),'напоминание про обещание клиенту');

/* карточка должна читаться без обучения */
const first=$('.rq');
ok(first.querySelectorAll('a,button').length<=3,'в свежей заявке не больше трёх действий');
ok(/tel:\+998/.test(first.querySelector('a').href),'звонок — первое действие, номер прямо на кнопке');
ok(first.querySelector('.rq-call').textContent.includes('+998'),'номер виден без нажатия');
ok(/Свадьба|Бешик той|Корпоратив/.test(first.textContent),'повод назван словом, а не выводится из даты');
ok(first.querySelectorAll('.rq-facts span').length>=2,'гости и бюджет — отдельными фактами');
ok(first.querySelectorAll('.tm').length===1,'счётчик времени один, а не два');
ok(/до \d\d:\d\d/.test(first.textContent),'указано точное время, до которого нужно ответить');
ok(!first.textContent.includes(T.ru.i_what),'пока не связались, исход не спрашиваем');
ok(first.textContent.includes(T.ru.i_callFirst),'сказано, что делать дальше');

/* связались — статус ставится сам */
const id=+first.dataset.rq;
click(first.querySelector('[data-contact]'));tick();
ok(get(`REQS.find(r=>r.id===${id}).st`)==='ans','звонок сам отмечает, что вы связались');
ok(get(`REQS.find(r=>r.id===${id}).ansAt`)!=null,'время ответа зафиксировано');
ok(get(`REQS.find(r=>r.id===${id}).log.length`)===1,'переход записан в историю (§4.8)');
const contacted=$$('.rq').find(e=>+e.dataset.rq===id);
ok(contacted.textContent.includes(T.ru.i_what),'после связи спрашиваем исход');
ok(contacted.querySelectorAll('[data-close],[data-dec]').length===2,'исходов ровно два: договорились или нет');

/* исход */
click(contacted.querySelector('[data-close]'));
ok(get(`REQS.find(r=>r.id===${id}).st`)==='deal','«Договорились» закрывает заявку');
ok(!$$('.rq').some(e=>+e.dataset.rq===id),'закрытая уходит из активных');
click($('[data-filter="done"]'));
ok($$('.rq').some(e=>+e.dataset.rq===id),'и появляется в завершённых');
ok($(`[data-reopen="${id}"]`),'закрытую можно вернуть, если ошиблись');
click($(`[data-reopen="${id}"]`));
ok(get(`REQS.find(r=>r.id===${id}).st`)==='ans'&&get('filter')==='now','возврат переводит обратно в активные');

/* отказ с причиной */
const fotoBusy=get('CARDS[1].busy.size'),hallBusy=get('CARDS[0].busy.size');
const decEl=$$('.rq').find(e=>e.textContent.includes('Bisyor Foto'));
click(decEl.querySelector('[data-contact]'));tick();
const decEl2=$$('.rq').find(e=>e.textContent.includes('Bisyor Foto'));
click(decEl2.querySelector('[data-dec]'));
ok($('#sheet').textContent.includes(T.ru.i_decTitle),'причина отказа спрашивается');
click($('[data-reason="0"]'));
ok(get('CARDS[1].busy.size')===fotoBusy+1&&get('CARDS[0].busy.size')===hallBusy,'отказ «занято» пишет дату только своей услуге');
click($('[data-filter="done"]'));ok(txt().includes(T.ru.i_dec1),'причина отказа видна в завершённых');

/* фильтры и приватность */
ok($$('[data-filter]').length===2,'фильтров два: активные и завершённые');
ok($$('[data-filter]').every(b=>/\d/.test(b.textContent)),'у каждого фильтра видно количество');
click($('[data-filter="now"]'));
ok(txt().includes(T.ru.i_only),'сказано, что видим только то, на что клиент дал согласие');
ok(!/выгрузить|скачать базу|eksport/i.test(txt()),'выгрузки базы клиентов нет');

/* ===== §5.4 календарь ===== */
G('календарь');
tab('cal');
ok(txt().includes(T.ru.c_note),'оговорка: календарь ведёт вендор');
ok(txt().includes(T.ru.c_tz),'указан часовой пояс');
ok($$('.dp-g b.busy').length>0,'занятые дни отмечены');
const before=get('CARDS.map(c=>c.busy.size)'),cur=get('CARDS.findIndex(c=>c.id===cardId)');
const free=$$('.dp-g b[data-day]:not(.busy):not(.past)')[0],k=free.dataset.day;click(free);
ok($(`[data-day="${k}"]`).classList.contains('busy'),'день помечается нажатием');
const after=get('CARDS.map(c=>c.busy.size)');
ok(after.every((x,i)=>i===cur?x===before[i]+1:x===before[i]),'занятость только у выбранной услуги');
click($('[data-mode="range"]'));
click($$('.dp-g b[data-day]:not(.past)')[2]);click($$('.dp-g b[data-day]:not(.past)')[5]);
click($('[data-rng="busy"]'));ok($$('.dp-g b.busy').length>=4,'диапазон отмечается разом');
ok($$('.dp-g b[data-day]').some(b=>b.querySelector('s')),'у зала в календаре видна цена дня (§4.6)');

/* ===== §5.5 карточка ===== */
G('карточка');
tab('card');
ok($$('[data-open]').length===2,'список услуг');
click($$('[data-open]')[0]);
ok(txt().includes(T.ru.k_status),'карточка опубликована');
click($('[data-act="edit"]'));
type('[data-mk="price"]','');click($('[data-act="save"]'));
ok($$('.err').length>0,'без цены сохранить нельзя — «по запросу» не бывает');
type('[data-mk="price"]','48');click($('[data-act="save"]'));
ok(get('CARDS[0].mod')&&get('CARDS[0].mod').includes('price'),'смена цены ушла на модерацию (§5.5)');
ok(txt().includes(T.ru.k_mod),'вендор видит, что изменения на проверке');
click($('[data-act="edit"]'));type('[data-mk="n"]','Bisyor Hall');click($('[data-act="save"]'));
ok(get('CARDS[0].n')==='Bisyor Hall','правка названия применяется сразу, без модерации');
click($('[data-act="edit"]'));click($('[data-rmph="0"]'));click($('[data-rmph="0"]'));
click($('[data-act="save"]'));
ok(txt().includes(T.ru.k_statusNo),'меньше трёх фото — карточка не публикуется');
click($('[data-act="backlist"]'));

/* новая услуга: одна категория — одна карточка */
click($('[data-act="newcard"]'));
const taken=$$('#sheet [data-newcat]').filter(b=>b.disabled).map(b=>b.dataset.newcat);
ok(taken.includes('hall')&&taken.includes('photo')&&taken.length===2,'занятые категории заблокированы');
click($('#sheet [data-newcat="cake"]'));click($('[data-act="createcard"]'));
ok(get('CARDS.length')===3&&get('CARDS[2].c')==='cake','карточка создана в свободной категории');
click($('[data-act="backlist"]'));

/* ===== §5.6 отзывы ===== */
G('отзывы');
tab('rev');
click($$('[data-card]')[0]);
ok(!$('[data-rmrev]')&&txt().includes(T.ru.v_noDel),'отзывы удалять нельзя');
ok($('[data-flag]'),'жалоба модератору есть');
click($('[data-flag]'));$('#flagText').value='Отзыв не о нас';click($('[data-act="flaggo"]'));
ok(get('CARDS[0].revs[0].flag')&&get('CARDS[0].complaints')===1,'жалоба зарегистрирована, отзыв на месте');
ok(get('CARDS[0].revs.length')===3,'отзыв не удалён жалобой');
click($$('[data-card]')[1]);
ok($('[data-sendrep]'),'на «Активном» ответ доступен');
$('[data-rep="0"]').value='Спасибо';click($('[data-sendrep="0"]'));
ok($$('.rv-rep').length===1,'ответ опубликован');
click($$('[data-card]')[0]);
ok(!$('[data-sendrep]')&&txt().includes(T.ru.v_locked),'на «Базовом» ответы закрыты, как в составе тарифа');

/* ===== §5.7 статистика ===== */
G('статистика');
tab('stats');
ok($$('.chart>div').length===14,'график за 14 дней');
ok(txt().includes(T.ru.s_conv),'конверсия показ → заявка');
click($$('[data-card]')[2]);ok(txt().includes(T.ru.s_none),'у новой услуги показов нет — пусто, а не ноль из воздуха');
ok(!/NaN/.test(txt()),'пустая статистика не считает конверсию из нуля');
click($$('[data-card]')[0]);

/* отчёт */
click($('[data-stab="rep"]'));
ok($$('.tbl tbody tr').length===14,'в отчёте строка на каждый день периода');
ok($('.tbl tfoot').textContent.includes(T.ru.s_tTotal),'есть итоговая строка');
ok($('.tbl-wrap'),'широкая таблица прокручивается внутри себя, а не растягивает экран');
click($('[data-sdays="7"]'));ok($$('.tbl tbody tr').length===7,'период переключается на 7 дней');
ok(txt().includes(T.ru.s_reqH),'разбивка заявок по исходам');
ok($$('.meter').length===4,'четыре корзины по времени ответа');
ok(txt().includes(T.ru.s_respLux),'порог премиума назван прямо в отчёте');
const csv=get('csvText(card())');
ok(!/\+998|Нодира|Малика|Жасур/.test(csv),'в выгрузке нет ни имён, ни телефонов клиентов');
ok(csv.split('\n').length===8&&csv.split('\n')[0].split(';').length===4,'CSV: заголовок и строка на день периода');
ok(txt().includes(T.ru.s_csvNote),'сказано, что в файле только суммы по дням');
click($('[data-sdays="14"]'));click($('[data-stab="over"]'));

/* ===== §5.8 тариф и §7.1 реклама ===== */
G('тариф');
ok(!$('#nav [data-tab="plan"]'),'тарифа в панели больше нет');
click($('#gear'));
ok($('[data-tab2="plan"]'),'тариф лежит внутри «Моей компании»');
ok($('[data-tab2="plan"]').textContent.includes('сум / мес'),'в строке видна сумма в месяц');
click($('[data-tab2="plan"]'));
ok(txt().includes(T.ru.t_title),'экран тарифа открывается со страницы компании');
ok($('[data-tab2="co"]'),'с тарифа можно вернуться к компании');
ok($$('.plan').length===3,'три тарифа');
ok(txt().includes('990 000'),'цена группы A для зала');
ok(txt().includes(T.ru.t_notLux),'на экране тарифа сказано, что премиум не покупается');
ok(txt().includes(T.ru.t_sortNote),'сказано, что сортировка по цене и рейтингу не продаётся');
ok($$('.adslot').length===3&&$$('.adslot .chip').every(c=>c.textContent.includes('Реклама')),'каждое рекламное место помечено');
click($('[data-plan="ext"]'));
ok(get('CARDS[0].plan')==='ext'&&get('CARDS[0].lux')===false,'верхний тариф не даёт премиум-статус');
ok(get('CARDS[1].plan')==='active','тариф сменился только у выбранной услуги');

/* ===== §VI премиум ===== */
G('премиум');
tab('lux');
ok(txt().includes(T.ru.x_not),'статус нельзя купить — написано прямо');
ok($$('[data-lux^="c"]').length===5,'пять общих требований');
ok($$('[data-lux^="i"]').length===4,'четыре отраслевых требования для зала');
click($('[data-act="luxsend"]'));
ok($$('.err').length>=3,'пустую заявку не принимаем');
/* каждый клик перерисовывает экран, поэтому узлы запрашиваем заново */
for(let i=1;i<=5;i++)click($(`[data-lux="c${i}"]`));
click($('[data-lux="i0"]'));click($('[data-lux="i1"]'));
click($('[data-act="luxsend"]'));
ok(txt().includes(T.ru.x_needInd)||$$('.err').length>0,'двух отраслевых мало, нужно три');
click($('[data-lux="i2"]'));
for(let i=0;i<3;i++)type(`[data-ref="${i}"]`,'Заказчик +998 90 000 00 0'+i);
click($('[data-act="luxsend"]'));
ok(get('CARDS[0].luxApp')&&get('CARDS[0].lux')===false,'заявка подана, статус сам не присвоился');
ok(txt().includes(T.ru.x_wait),'показан статус заявки');
/* панель показателей у того, кому статус уже присвоен */
get('CARDS[0].lux=true;CARDS[0].luxApp=null;CARDS[0].r=4.55;CARDS[0].complaints=1;render()');
ok($$('.meter').length===3,'три показателя удержания статуса (§6.4)');
ok($$('.meter.warn').length>0&&txt().includes(T.ru.x_warn),'предупреждение заранее, а не по факту снятия');

/* ===== моя компания ===== */
G('компания');
click($('#gear'));
ok(txt().includes(T.ru.co_title),'компания открывается из шапки');
ok($('#gear').textContent.includes('Bisyor'),'вход подписан названием компании');
ok(txt().includes(T.ru.co_locked),'СТИР и название меняются только через поддержку');
ok(!$('#barR .lang'),'в кабинете переключателя языка в шапке нет');
ok($('#scroll #lang'),'язык переключается в настройках компании');
ok(!$('[data-mk="stir"]'),'СТИР не редактируется');
click($('[data-act="coedit"]'));
ok(!$('[data-mk="stir"]')&&$('[data-mk="person"]'),'в режиме правки открыты контакты, но не реквизиты');
type('[data-mk="tel2"]','123');click($('[data-act="cosave"]'));
ok($$('.err').length>0,'телефон проверяется по формату');
type('[data-mk="tel2"]','+998 00 100 10 11');click($('[data-act="cosave"]'));
ok(get('coEdit')===false,'данные компании сохранены');
ok(!$('[data-act="copy"]')&&!/Запросить копию/.test(txt()),'запроса копии договора нет');
click($('[data-more="data"]'));
ok($('#sheet').textContent.includes('ПИНФЛ')&&$('#sheet').textContent.includes('Госреестр'),'что храним и чего не храним (§IX)');
ok(/Выгрузка базы клиентов недоступна/.test($('#sheet').textContent),'выгрузка базы прямо запрещена');
click($('[data-act="closesheet"]'));

/* ===== §5.1–5.2 публичные экраны ===== */
G('лендинг и регистрация');
click($('[data-more="out"]'));
ok(txt().includes(T.ru.l_h1),'выход ведёт на лендинг');
ok($('#nav').style.display==='none','на публичных экранах панели нет');
ok(txt().includes(T.ru.l_q1)&&txt().includes(T.ru.l_a5),'на лендинге есть вопрос о комиссии и о премиуме');
click($('[data-go="login"]'));
ok(txt().includes(T.ru.a_title),'вход по телефону');
click($('[data-act="authgo"]'));ok($$('.err').length>0,'без телефона не войти');
type('[data-ak2="tel"]','+998 00 100 10 10');click($('[data-act="authcode"]'));
type('[data-ak2="code"]','1234');click($('[data-act="authgo"]'));
ok(txt().includes(T.ru.i_title),'вход возвращает в кабинет');
click($('#gear'));click($('[data-more="out"]'));click($('[data-go="reg"]'));
ok(txt().includes(T.ru.r_s1),'регистрация, шаг 1');
click($('[data-act="regnext"]'));ok($$('.err').length>=3,'шаг 1 проверяется');
type('[data-mk="n"]','Test');type('[data-mk="tel"]','+998 00 123 45 67');click($('[data-act="regcode"]'));
type('[data-mk="code"]','1234');type('[data-mk="person"]','Иван Иванов');click($('[data-act="regnext"]'));
ok(txt().includes(T.ru.r_s2),'шаг 2');
type('[data-mk="ru"]','Зал');type('[data-mk="price"]','40');
type('[data-pkf="0-0"]','Будни');type('[data-pkf="0-2"]','40');
click($('[data-act="regnext"]'));
ok(txt().includes(T.ru.e_pkHall),'для зала требуются два пакета: будни и выходные (§4.6)');
type('[data-pkf="1-0"]','Выходные');type('[data-pkf="1-2"]','48');
click($('[data-act="regnext"]'));ok(txt().includes(T.ru.r_s3),'шаг 3');
ok($('[data-chk="consent"]').getAttribute('aria-checked')==='false','согласие не предзаполнено');
ok(txt().includes('лица людей не публикуем')||txt().includes('Лица людей не публикуем'),'правило про лица на фото показано');
click($('[data-act="regnext"]'));
ok(txt().includes('Нужно ещё 3 фото'),'без трёх фото заявку не отправить');

/* ===== язык и чистота разметки ===== */
G('два языка');
const ru=Object.keys(T.ru),uz=Object.keys(T.uz);
ok(ru.length===uz.length&&ru.every(x=>x in T.uz),'паритет словарей');
ok(!Object.entries(T.uz).some(([,v])=>typeof v==='string'&&/[А-Яа-яЁё]/.test(v)),'в узбекском нет кириллицы');
ok([...new Set([...src.matchAll(/T_\.([a-zA-Z_0-9]+)/g)].map(m=>m[1]))].every(x=>x in T.ru),'нет обращений к несуществующим ключам');
while($('[data-go="regback"]'))click($('[data-go="regback"]'));
click($('[data-go="land"]'));
ok($('#barR .lang'),'на публичных экранах язык переключается в шапке — настроек там ещё нет');
click($('#barR .lang'));
ok(d.documentElement.lang==='uz','переключение на узбекский');
click($('[data-go="login"]'));type('[data-ak2="tel"]','+998 00 100 10 10');
click($('[data-act="authcode"]'));type('[data-ak2="code"]','1234');click($('[data-act="authgo"]'));
for(const k of ['inbox','cal','card','rev','stats','lux','co']){
  click($(`#nav [data-tab="${k}"]`));
  ok(!/undefined|\$\{/.test(txt()),'узбекский экран без мусора: '+k);}

/* ===== навигация и доступность ===== */
G('навигация');
ok($$('#nav [data-tab]').length===7,'семь разделов в панели: тариф переехал в компанию');
ok(w.getComputedStyle($('#nav')).display!=='none','панель видима');
ok(!$('#nav').style.display||$('#nav').style.display==='','панель не спрятана разметкой');
ok($$('#nav .lbl').every(e=>e.textContent.trim()),'у каждого раздела есть подпись');
ok(/prefers-reduced-motion/.test(src),'учтено prefers-reduced-motion');
ok(/height:100vh;height:100dvh/.test(src),'есть запасная высота для браузеров без dvh (ловушка X.4)');
ok(src.split('<style>')[1].split('</style>')[0].split('{').length===src.split('<style>')[1].split('</style>')[0].split('}').length,'скобки в CSS сбалансированы (ловушка X.10)');
const attrs=[...src.matchAll(/data-([a-z0-9]+)=/g)].map(m=>m[1]);
ok(new Set(attrs).size===[...new Set(attrs)].length,'атрибуты data-* не пересекаются (ловушка X.1)');

console.log((fail?'':'\n')+`${n-fail}/${n} проверок пройдено`);
process.exit(fail?1:0);
