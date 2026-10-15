import { tablesToBullets } from "./table";

export function escapeTelegramHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Telegram's HTML entity subset; all unrecognized markdown becomes escaped literal text. */
export function renderTelegramHtml(markdown: string): string {
  const stash = new Stash();
  const converted = tablesToBullets(markdown.replaceAll("\uE000", ""))
    .replace(FENCED_BLOCK, (block) => {
      const boundary = block.indexOf("\n");
      const lang = boundary < 0 ? "" : block.slice(3, boundary);
      const body = boundary < 0 ? block.slice(3, -3) : block.slice(boundary + 1, -3);
      return stash.keep(`<pre><code${lang === "" ? "" : ` class="language-${escapeTelegramHtml(lang)}"`}>${escapeTelegramHtml(body)}</code></pre>`);
    })
    .replace(INLINE_CODE, (code) => stash.keep(`<code>${escapeTelegramHtml(code.slice(1, -1))}</code>`))
    .replace(LINK, (_, label: string, url: string) => stash.keep(`<a href="${escapeTelegramHtml(url)}">${escapeTelegramHtml(label)}</a>`))
    .replace(HEADER, (_, title: string) => stash.keep(`<b>${escapeTelegramHtml(title.replace(BOLD, "$1"))}</b>`))
    .replace(BOLD, (_, body: string) => stash.keep(`<b>${escapeTelegramHtml(body)}</b>`))
    .replace(ITALIC, (_, body: string) => stash.keep(`<i>${escapeTelegramHtml(body)}</i>`));
  return stash.restore(escapeTelegramHtml(converted));
}

const FENCED_BLOCK = /```[^\n]*\n[\s\S]*?```|```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;
const LINK = /\[([^\]]+)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/g;
const HEADER = /^#{1,6}\s+(.+)$/gm;
const BOLD = /\*\*([^\n*]+)\*\*/g;
const ITALIC = /\*([^\n*]+)\*/g;
const PLACEHOLDER = /\uE000(\d+)\uE000/g;

class Stash {
  private readonly values: string[] = [];

  keep(value: string): string {
    this.values.push(value);
    return `\uE000${this.values.length - 1}\uE000`;
  }

  /** Placeholders nest (a bold span may hold a link token): resolve inside out. */
  restore(text: string): string {
    let out = text;
    while (out.includes("\uE000")) {
      out = out.replace(PLACEHOLDER, (_, index: string) => this.values[Number(index)] ?? "");
    }
    return out;
  }
}
