/* Похожесть строк — как pg_trgm (similarity, word_similarity, strict_word_similarity), для
   текста после searchNorm ([a-z0-9 ]). Нужна там, где базы нет: демо-API клиента и подсказки
   разделов и районов у API. Порт алгоритма pg_trgm (trgm_op.c: generate_trgm_only,
   iterate_word_similarity), числа — float4, как у базы.

   Триграммы слова: «  w», « wo», …, «rd » — два пробела слева и один справа; у строки — триграммы
   всех слов по порядку. similarity — доля общих в объединении множеств; word_similarity — лучшая
   такая доля между запросом и непрерывным отрезком триграмм текста (strict — отрезок от начала до
   конца слов). */

interface Trigram {
  readonly trg: string;
  /** Первая триграмма слова */
  readonly left: boolean;
  /** Последняя триграмма слова */
  readonly right: boolean;
}

function trigrams(text: string): Trigram[] {
  const out: Trigram[] = [];
  for (const word of text.split(" ")) {
    if (word === "") continue;
    const padded = `  ${word} `;
    const last = padded.length - 3;
    for (let i = 0; i <= last; i++)
      out.push({ trg: padded.slice(i, i + 3), left: i === 0, right: i === last });
  }
  return out;
}

/** count / (len1 + len2 − count) в float4 — CALCSML из pg_trgm */
const calc = (count: number, len1: number, len2: number) => Math.fround(count / (len1 + len2 - count));

/** similarity(a, b): общие триграммы / все различные триграммы обеих строк */
export function similarity(a: string, b: string): number {
  const set1 = new Set(trigrams(a).map((t) => t.trg));
  const set2 = new Set(trigrams(b).map((t) => t.trg));
  if (set1.size === 0 || set2.size === 0) return 0;
  let count = 0;
  for (const trg of set1) if (set2.has(trg)) count++;
  return calc(count, set1.size, set2.size);
}

/**
 * word_similarity(query, text), strict — strict_word_similarity: наибольшая похожесть запроса на
 * непрерывный отрезок триграмм текста (у strict — от начала одного слова до конца другого)
 */
export function wordSimilarity(query: string, text: string, strict = false): number {
  const first = new Set(trigrams(query).map((t) => t.trg));
  const second = trigrams(text);
  if (first.size === 0 || second.length === 0) return 0;

  // Номер триграммы в объединении и есть ли она в запросе
  const index = new Map<string, number>();
  const found: boolean[] = [];
  for (const trg of first) {
    index.set(trg, found.length);
    found.push(true);
  }
  const at = second.map((t) => {
    let j = index.get(t.trg);
    if (j === undefined) {
      j = found.length;
      index.set(t.trg, j);
      found.push(false);
    }
    return j;
  });
  const ulen1 = first.size;
  const lastpos = new Array<number>(found.length).fill(-1);
  let ulen2 = 0;
  let count = 0;
  let upper = -1;
  let lower = strict ? 0 : -1;
  let best = 0;

  for (let i = 0; i < second.length; i++) {
    const trg = at[i] as number;
    if (lower >= 0 || found[trg]) {
      if ((lastpos[trg] as number) < 0) {
        ulen2++;
        if (found[trg]) count++;
      }
      lastpos[trg] = i;
    }
    if (!(strict ? (second[i] as Trigram).right : found[trg])) continue;

    upper = i;
    if (lower === -1) {
      lower = i;
      ulen2 = 1;
    }
    let current = calc(count, ulen1, ulen2);
    // Можно ли сдвинуть начало отрезка и стать похожее
    let tmpCount = count;
    let tmpUlen2 = ulen2;
    const prevLower = lower;
    for (let tmpLower = lower; tmpLower <= upper; tmpLower++) {
      if (!strict || (second[tmpLower] as Trigram).left) {
        const candidate = calc(tmpCount, ulen1, tmpUlen2);
        if (candidate > current) {
          current = candidate;
          ulen2 = tmpUlen2;
          lower = tmpLower;
          count = tmpCount;
        }
      }
      const tmpTrg = at[tmpLower] as number;
      if (lastpos[tmpTrg] === tmpLower) {
        tmpUlen2--;
        if (found[tmpTrg]) tmpCount--;
      }
    }
    best = Math.max(best, current);
    for (let tmpLower = prevLower; tmpLower < lower; tmpLower++) {
      const tmpTrg = at[tmpLower] as number;
      if (lastpos[tmpTrg] === tmpLower) lastpos[tmpTrg] = -1;
    }
  }
  return best;
}
