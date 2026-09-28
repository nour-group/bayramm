const T = {
  uz: { tagline: "Toshkentdagi bayramlar uchun pudratchilar", soon: "Tez orada" },
  ru: { tagline: "Подрядчики на праздники в Ташкенте", soon: "Скоро запуск" },
} as const;

export function App() {
  return (
    <main className="shell">
      <h1 className="brand">Bayramm</h1>
      <p className="line">{T.uz.tagline}</p>
      <p className="line muted">{T.ru.tagline}</p>
      <span className="badge">
        {T.uz.soon} · {T.ru.soon}
      </span>
    </main>
  );
}
