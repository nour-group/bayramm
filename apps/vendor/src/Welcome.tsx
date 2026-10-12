/* Кабинет открыли в браузере без сессии: что это за кабинет — одной строкой — и вход через хаб
   на сайте Bayramm. Регистрации нет: площадки подключает команда, она же заводит номер
   партнёра; нет доступа — менеджер подключит (одна строка), а у кого номер уже у менеджера,
   тому бот привяжет Telegram (кнопка «Я партнёр»), и кабинет откроется в нём. Остального
   рассказа нет: приглашённый партнёр его знает.

   Тексты — без чисел о площадке и партнёрах: показывать нечего, придумывать нельзя.
   Вход по телефону упоминаем, только если он в окружении включён. На телефоне вход — сразу
   под заголовком (кто уже партнёр, не листает), на компьютере — карточкой справа. */

import { BotLink, usePhoneSignIn } from "./Gate";
import { Heading, type ScreenProps } from "./ui";

interface WelcomeProps extends Pick<ScreenProps, "t" | "headingRef"> {
  /** Войти через хаб входа на сайте */
  readonly onSignIn: () => void;
}

export function Welcome({ t, headingRef, onSignIn }: WelcomeProps) {
  const phone = usePhoneSignIn(true);
  return (
    <section className="welcome" aria-labelledby="page-title">
      <div className="welcome-intro">
        <Heading headingRef={headingRef}>{t.welcomeTitle}</Heading>
        <p className="lead">{t.welcomeLead}</p>
      </div>

      <section className="panel welcome-signin" aria-labelledby="signin-title">
        <h2 className="section-title" id="signin-title">
          {t.gateOutsideTitle}
        </h2>
        <p className="lead">{phone ? t.gateOutsideText : t.gateOutsideTextTelegram}</p>
        <button type="button" className="btn btn-primary btn-wide" onClick={onSignIn}>
          {t.signIn}
        </button>
        <BotLink t={t} primary={false} />
        <p className="note">{t.welcomeNoAccess}</p>
      </section>
    </section>
  );
}
