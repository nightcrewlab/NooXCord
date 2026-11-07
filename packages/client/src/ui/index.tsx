import {
  createContext, forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@nooxcord/icons";
import type { PublicUser } from "@nooxcord/shared";
import { t } from "../i18n";
import { colorFor, initials } from "../lib/format";
import { useStore } from "../state/store";
import s from "./ui.module.css";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---------- Button ----------
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "small" | "normal";
  block?: boolean;
  loading?: boolean;
  icon?: IconName;
}
export function Button({ variant = "secondary", size = "normal", block, loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button className={cx(s.btn, s[variant], size === "small" && s.small, block && s.block, className)} disabled={disabled || loading} {...rest}>
      {loading ? <span className={s.spinner} /> : icon && <Icon name={icon} size={18} />}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  size?: number;
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ icon, label, size = 20, className, ...rest }, ref) {
  return (
    <button ref={ref} className={cx(s.iconBtn, className)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
});

// ---------- Field ----------
interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
}
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, hint, error, id, ...rest }, ref) {
  const fid = id ?? `f-${label.replace(/\W+/g, "-")}`;
  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={fid}>{label}</label>
      <input ref={ref} id={fid} className={s.input} aria-invalid={!!error} {...rest} />
      {error ? <span className={s.error}>{error}</span> : hint && <span className={s.hint}>{hint}</span>}
    </div>
  );
});

export const uiClass = s;

// ---------- Modal ----------
interface ModalProps {
  title?: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  medium?: boolean;
}
export function Modal({ title, description, onClose, children, footer, wide, medium }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const first = ref.current?.querySelector<HTMLElement>("input, textarea, select, button:not([data-close])");
    first?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className={s.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={cx(s.modal, wide && s.modalWide, medium && s.modalMedium)} role="dialog" aria-modal="true">
        {wide ? children : (
          <>
            {(title || description) && (
              <div className={s.modalHead}>
                <div style={{ flex: 1 }}>
                  {title && <h2 className={s.modalTitle}>{title}</h2>}
                  {description && <p className={s.modalDesc}>{description}</p>}
                </div>
                <IconButton icon="close" label={t("common.close")} onClick={onClose} data-close />
              </div>
            )}
            {children && <div className={s.modalBody}>{children}</div>}
            {footer && <div className={s.modalFoot}>{footer}</div>}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Confirm (promise based) ----------
interface ConfirmOpts { title: string; body?: string; confirm?: string; danger?: boolean }
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const done = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <Modal
          title={state.title}
          description={state.body}
          onClose={() => done(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => done(false)}>{t("common.cancel")}</Button>
              <Button variant={state.danger ? "danger" : "primary"} onClick={() => done(true)}>{state.confirm ?? t("common.confirm")}</Button>
            </>
          }
        />
      )}
    </ConfirmCtx.Provider>
  );
}

// ---------- Avatar ----------
const STATUS_COLOR: Record<string, string> = { online: "var(--nx-speaking)", idle: "var(--nx-warn)", dnd: "var(--nx-live)" };

export function Avatar({ user, size = 36, presence = false, ring }: { user: Pick<PublicUser, "id" | "nickname" | "avatar"> & Partial<PublicUser>; size?: number; presence?: boolean; ring?: string }) {
  const http = useStore((st) => st.http);
  const src = http?.url(user.avatar);
  const [broken, setBroken] = useState(false);
  const dot = Math.max(10, Math.round(size * 0.32));
  const pColor = user.online ? STATUS_COLOR[user.status ?? "online"] ?? STATUS_COLOR.online : "var(--nx-text-3)";
  return (
    <span className={s.avatar} style={{ width: size, height: size, background: src && !broken ? "var(--nx-bg-3)" : colorFor(user.id), fontSize: size * 0.38, boxShadow: ring ? `0 0 0 2px var(--nx-bg-1), 0 0 0 4px ${ring}` : undefined }}>
      {src && !broken ? <img src={src} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} /> : initials(user.nickname)}
      {presence && <span className={s.presence} style={{ width: dot, height: dot, background: pColor }} aria-label={user.online ? t("status.online") : t("members.offline")} />}
    </span>
  );
}

// ---------- Context menu ----------
export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect?: () => void;
  danger?: boolean;
  checked?: boolean;
  separator?: boolean;
  disabled?: boolean;
  keepOpen?: boolean;
}
interface MenuState { x: number; y: number; items: MenuItem[] }
const MenuCtx = createContext<(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) => void>(() => {});
export const useMenu = () => useContext(MenuCtx);

export function MenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const open = useCallback((e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) => {
    e.preventDefault?.();
    if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - r.width - 8);
    const y = Math.min(menu.y, window.innerHeight - r.height - 8);
    ref.current.style.left = `${Math.max(8, x)}px`;
    ref.current.style.top = `${Math.max(8, y)}px`;
    ref.current.querySelector<HTMLElement>("button")?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && setMenu(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", () => setMenu(null), { once: true });
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  }, [menu]);
  return (
    <MenuCtx.Provider value={open}>
      {children}
      {menu &&
        createPortal(
          <div ref={ref} className={s.menu} role="menu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
            {menu.items.map((it, i) =>
              it.separator ? <div key={i} className={s.menuSep} /> : (
                <button
                  key={i}
                  role="menuitem"
                  className={cx(s.menuItem, it.danger && s.dangerItem)}
                  disabled={it.disabled}
                  onClick={() => {
                    if (!it.keepOpen) setMenu(null);
                    it.onSelect?.();
                  }}
                >
                  {it.icon && <Icon name={it.icon} size={18} />}
                  <span>{it.label}</span>
                  {it.checked !== undefined && <span className={s.menuCheck}>{it.checked && <Icon name="check" size={16} />}</span>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </MenuCtx.Provider>
  );
}

// ---------- Toasts ----------
export function Toasts() {
  const toasts = useStore((st) => st.toasts);
  return (
    <div className={s.toasts} role="status" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={cx(s.toast, x.kind === "error" && s.toastError)}>
          <Icon name={x.kind === "error" ? "alert" : "check"} size={16} />
          {x.text}
        </div>
      ))}
    </div>
  );
}

export function Spinner() {
  return <span className={s.spinner} aria-label={t("common.loading")} />;
}

export { cx };
