import { Fragment, type ReactNode } from "react";
import { platform } from "../platform";

/**
 * Tiny, safe Markdown subset → React nodes (never innerHTML):
 * ```code block```, `inline code`, **bold**, *italic* / _italic_, ~~strike~~, ||spoiler||, links, > quote.
 */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\|\|[^|\n]+\|\|)|(\*[^*\n]+\*)|(\b_[^_\n]+_\b)|(https?:\/\/[^\s<>"'`]+)/g;

function openLink(e: React.MouseEvent, href: string) {
  e.preventDefault();
  platform.openExternal(href);
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<s key={k}>{inline(tok.slice(2, -2), k)}</s>);
    else if (m[4]) out.push(<Spoiler key={k}>{inline(tok.slice(2, -2), k)}</Spoiler>);
    else if (m[5] || m[6]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    else if (m[7]) {
      const href = tok.replace(/[),.!?;:]+$/, "");
      out.push(
        <a key={k} href={href} onClick={(e) => openLink(e, href)} rel="noreferrer noopener" target="_blank">
          {href}
        </a>,
      );
      if (href.length < tok.length) out.push(tok.slice(href.length));
    }
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Spoiler({ children }: { children: ReactNode }) {
  return (
    <span className="md-spoiler" tabIndex={0} onClick={(e) => e.currentTarget.classList.add("revealed")} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.classList.add("revealed")}>
      {children}
    </span>
  );
}

export function renderMarkdown(src: string): ReactNode {
  const parts = src.split(/```(?:[a-zA-Z0-9_+-]*\n)?([\s\S]*?)```/g);
  return parts.map((part, pi) => {
    if (pi % 2 === 1) return <pre key={pi} className="md-pre"><code>{part.replace(/\n$/, "")}</code></pre>;
    const lines = part.split("\n");
    return (
      <Fragment key={pi}>
        {lines.map((line, li) => {
          const k = `${pi}-${li}`;
          const br = li < lines.length - 1 ? <br /> : null;
          if (line.startsWith("> ")) return <blockquote key={k} className="md-quote">{inline(line.slice(2), k)}</blockquote>;
          return <Fragment key={k}>{inline(line, k)}{br}</Fragment>;
        })}
      </Fragment>
    );
  });
}
