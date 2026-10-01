/* Кабинет открыли в браузере без сессии: коротко — что это за кабинет (заявки, 12 часов на
   ответ, календарь, карточка) и как в него попасть, затем вход через хаб на сайте Bayramm.
   Регистрации нет: площадки подключает команда, она же заводит номер партнёра. Если номер
   уже у менеджера — бот привяжет Telegram (кнопка «Я партнёр»), и кабинет откроется в нём.

   Тексты — без чисел о площадке и партнёрах: показывать нечего, придумывать нельзя.
   Вход по телефону упоминаем, только если он в окружении включён. На телефоне вход — сразу
   под заголовком (кто уже партнёр, не листает), на компьютере — карточкой справа. */

import { BotLink, usePhoneSignIn } from "./Gate";
import type { TextKey } from "./i18n";
import { Icon, type IconName } from "./icons";
import { Heading, type ScreenProps } from "./ui";

const POINTS: readonly (readonly [IconName, TextKey, TextKey])[] = [
  ["requests", "welcomeRequests", "welcomeRequestsText"],
  ["clock", "welcome12h", "welcome12hText"],
  ["calendar", "welcomeCalendar", "welcomeCalendarText"],
  ["hall", "welcomeCard", "welcomeCardText"],
];

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
        <h3 className="welcome-subtitle">{t.welcomeAccess}</h3>
        <p className="note">{t.welcomeAccessText}</p>
        <BotLink t={t} primary={false} />
        <p className="note">{t.welcomeAccessNew}</p>
      </section>

      <ul className="welcome-points">
        {POINTS.map(([icon, title, text]) => (
          <li key={title}>
            <span className="welcome-icon">
              <Icon name={icon} size={20} />
            </span>
            <span className="welcome-point">
              <strong className="welcome-point-title">{t[title]}</strong>
              <span>{t[text]}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
