/* Кабинет открыли в браузере без сессии: что это за кабинет — одной строкой — и вход через хаб
   на сайте Bayramm. Регистрации нет: площадки подключает команда, она же заводит номер
   партнёра. Будущему партнёру — «Стать партнёром»: написать команде в Telegram или позвонить
   (контакт команды — настройка панели, TeamContact.tsx); контакт не указан — одна строка «менеджер
   подключит». У кого номер уже у менеджера, тому бот привяжет Telegram (кнопка «Я партнёр»), и
   кабинет откроется в нём. Остального рассказа нет: приглашённый партнёр его знает.

   Тексты — без чисел о площадке и партнёрах: показывать нечего, придумывать нельзя.
   Вход по телефону упоминаем, только если он в окружении включён. На телефоне вход — сразу
   под заголовком (кто уже партнёр, не листает), на компьютере — карточкой справа. */

import { BotLink, usePhoneSignIn } from "./Gate";
import { TeamContactLinks, useTeamContact } from "./TeamContact";
import { Heading, type ScreenProps } from "./ui";

interface WelcomeProps extends Pick<ScreenProps, "t" | "headingRef"> {
  /** Войти через хаб входа на сайте */
  readonly onSignIn: () => void;
}

export function Welcome({ t, headingRef, onSignIn }: WelcomeProps) {
  const phone = usePhoneSignIn(true);
  const team = useTeamContact();
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
        {team ? null : <p className="note">{t.welcomeNoAccess}</p>}
      </section>

      {team ? (
        <section className="panel welcome-join" aria-labelledby="join-title">
          <h2 className="section-title" id="join-title">
            {t.welcomeJoinTitle}
          </h2>
          <p className="lead">{t.welcomeJoinText}</p>
          <TeamContactLinks t={t} team={team} />
        </section>
      ) : null}
    </section>
  );
}
