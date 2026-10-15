/* Тест-векторы поиска — одни для TS (search.test.ts) и базы (pgTAP: блок в
   supabase/tests/32_catalog_search.test.sql собирает sql.ts; тест API сверяет, что блок не
   устарел). Так searchNorm и app.search_norm не разойдутся. */

/** Текст → результат searchNorm / app.search_norm */
export const NORM_VECTORS: readonly (readonly [input: string, normalized: string])[] = [
  ["Яккасарай", "yakkasaray"],
  ["Шайхантахур", "shayxantaxur"],
  ["кортеж", "kortej"],
  ["КОРТЕЖ", "kortej"],
  ["Toʻyxona", "toyxona"],
  ["to'yxona", "toyxona"],
  ["toyxona", "toyxona"],
  ["To`yxona", "toyxona"],
  ["To’yxona", "toyxona"],
  ["To‘yxona", "toyxona"],
  ["To´yxona", "toyxona"],
  ["Тўйхона", "toyxona"],
  ["Ўрда Қасри", "orda qasri"],
  ["Ғунча", "guncha"],
  ["Ҳовли", "hovli"],
  ["Gʻuncha", "guncha"],
  ["maʼno", "mano"],
  ["Объезд", "obezd"],
  ["Щука", "shuka"],
  ["Цех", "tsex"],
  ["Ёлка", "yolka"],
  ["Юнусабад", "yunusabad"],
  ["Чиланзар", "chilanzar"],
  ["Мирзо-Улугбек", "mirzo ulugbek"],
  ["Mirzo Ulugʻbek", "mirzo ulugbek"],
  ["Мерседес S-class", "mersedes s class"],
  ["Café Élite", "cafe elite"],
  ["  Grand   Hall #2  ", "grand hall 2"],
  ["love-story!!!", "love story"],
  ["★★★", ""],
  ["", ""],
];

/** Пары, где запрос (первое) подходит тексту (второе) — сравнение pg_trgm после нормализации */
export const MATCH_VECTORS: readonly (readonly [query: string, text: string])[] = [
  ["Яккасарай", "Yakkasaroy"],
  ["Шайхантахур", "Shayxontohur"],
  ["кортеж", "Kortej"],
  ["kartej", "Kortej"],
  ["versl", "Versal"],
  ["kor", "Kortej"],
  ["toʻyxona", "Toyxona Versal"],
  ["mercedes", "Mercedes-Benz S-Class"],
];

/** Пары, где запрос не подходит тексту */
export const MISMATCH_VECTORS: readonly (readonly [query: string, text: string])[] = [
  ["zal", "ZAGS"],
  ["versal", "Vesna"],
  ["kortej mercedes", "Kortej"],
];
