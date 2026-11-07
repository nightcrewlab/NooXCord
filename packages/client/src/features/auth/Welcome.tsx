import type { ReactNode } from "react";
import { t } from "../../i18n";
import s from "./welcome.module.css";

import logoUrl from "../../assets/logo.svg";

/** Two-column brand layout shared by host picker and auth screens. */
export function Welcome({ children }: { children: ReactNode }) {
  return (
    <div className={s.page}>
      <div className={s.brand}>
        <img className={s.logo} src={logoUrl} alt="" />
        <h1 className={s.wordmark}>NooX<span>Cord</span></h1>
        <p className={s.tagline}>{t("app.tagline")}</p>
        <div className={s.by}>NooXRii</div>
      </div>
      <div className={s.side}>
        <div className={s.card}>{children}</div>
      </div>
    </div>
  );
}

export { s as welcomeStyles };
