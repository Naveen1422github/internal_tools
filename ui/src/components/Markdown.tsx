import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

/**
 * Renders collab entry bodies (description) as markdown.
 *
 * Two things this has to do that a bare <ReactMarkdown> does not:
 *
 * 1. ESCAPE tag-like prose. ~15% of entry bodies contain things like
 *    `<app-report-preview>`, `Promise<void>`, `<task-id>`, `<parameter name="refs">`.
 *    Markdown reads those as raw HTML. react-markdown v9 has HTML disabled by
 *    default, which does not escape them -- it DROPS them. A tag at the start of
 *    a line is worse: it opens a CommonMark "HTML block" that swallows every
 *    following line until the next blank line. See escapeProseSegment below.
 *
 * 2. STYLE the output. Tailwind Preflight zeroes heading sizes, paragraph
 *    margins and list bullets, and @tailwindcss/typography (the `prose` plugin)
 *    is NOT installed in this project. Without the `components` map below,
 *    rendered markdown looks worse than the raw text it replaced.
 *
 * remark-breaks is deliberate: the existing entry bodies were authored against
 * a `whitespace-pre-wrap` renderer, so every newline is intentional. Without it
 * CommonMark collapses single newlines to spaces and reflows every paragraph.
 *
 * See collab E-502 for the full measurement this design is based on.
 */

// ---------------------------------------------------------------------------
// Preprocessing
// ---------------------------------------------------------------------------

type Segment = { code: boolean; text: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(``[^`]*``|`[^`\n]+`)/g;

/**
 * Splits source into code segments (fenced blocks and inline spans) and prose
 * segments. Escaping must skip code, because inside a code span `&lt;` renders
 * literally as those four characters rather than as `<`.
 *
 * Fences are found with a line-state scan rather than a regex alternation: an
 * unpaired backtick in prose can otherwise pair with a fence's backticks and
 * desynchronise every segment after it, which would escape the inside of a code
 * block. Inline spans are only matched within the non-fenced runs.
 */
function segment(src: string): Segment[] {
  const out: Segment[] = [];
  const pushProse = (text: string) => {
    if (!text) return;
    let last = 0;
    let m: RegExpExecArray | null;
    INLINE_CODE.lastIndex = 0;
    while ((m = INLINE_CODE.exec(text)) !== null) {
      if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
      out.push({ code: true, text: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ code: false, text: text.slice(last) });
  };

  // Keep each line's own newline attached so joining is lossless by construction
  // (re-adding '\n' overshoots when the body's last line is a closing fence).
  const lines = src.split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l));
  let buf: string[] = [];
  let fenceMarker: string | null = null;

  for (const line of lines) {
    const m = FENCE.exec(line);
    if (fenceMarker === null) {
      if (m) {
        pushProse(buf.join(''));
        buf = [line];
        fenceMarker = m[1][0]; // ` or ~
      } else {
        buf.push(line);
      }
    } else {
      buf.push(line);
      // A closing fence uses the same character and no trailing info string.
      if (m && m[1][0] === fenceMarker && line.slice(m[0].length).trim() === '') {
        out.push({ code: true, text: buf.join('') });
        buf = [];
        fenceMarker = null;
      }
    }
  }

  const tail = buf.join('');
  if (fenceMarker !== null) out.push({ code: true, text: tail }); // unterminated fence
  else pushProse(tail);

  return out;
}

/**
 * Escape `<` in a PROSE segment so tag-like text survives to the reader.
 *
 * Policy: NARROW -- escape `<` only when followed by a letter, `/` or `!`, which
 * is what CommonMark actually parses as a tag (or comment/declaration). This
 * leaves arithmetic and comparisons alone, so `a < b`, `<= 200 chars` and
 * `<800 tokens` keep reading naturally.
 *
 * The alternative is BLANKET -- escape every `<`. That can never lose content,
 * but it also permanently rules out ever writing intentional HTML in an entry
 * body. To switch, replace the pattern below with /</g.
 *
 * Either way this must run on prose only: the caller guarantees this segment
 * contains no code fences or inline code spans.
 */
function escapeProseSegment(text: string): string {
  return text.replace(/<(?=[A-Za-z/!])/g, '&lt;');
}

export function preprocess(src: string): string {
  return segment(src)
    .map((s) => (s.code ? s.text : escapeProseSegment(s.text)))
    .join('');
}

// ---------------------------------------------------------------------------
// Element styling (stands in for @tailwindcss/typography, which is not installed)
// ---------------------------------------------------------------------------

// react-markdown v9 hands every component a `node` prop (the mdast node). It is
// not a valid DOM attribute, so it is destructured away in each component below
// rather than spread onto the element.
type WithNode<T extends ElementType> = ComponentPropsWithoutRef<T> & { node?: unknown };

const components = {
  p: ({ node: _n, ...p }: WithNode<'p'>) => <p className="mb-3 last:mb-0" {...p} />,

  ul: ({ node: _n, ...p }: WithNode<'ul'>) => (
    <ul className="list-disc pl-5 mb-3 last:mb-0 space-y-1" {...p} />
  ),
  ol: ({ node: _n, ...p }: WithNode<'ol'>) => (
    <ol className="list-decimal pl-5 mb-3 last:mb-0 space-y-1" {...p} />
  ),
  li: ({ node: _n, ...p }: WithNode<'li'>) => <li className="pl-1" {...p} />,

  h1: ({ node: _n, ...p }: WithNode<'h1'>) => (
    <h1 className="text-base font-bold mt-4 mb-2 first:mt-0" {...p} />
  ),
  h2: ({ node: _n, ...p }: WithNode<'h2'>) => (
    <h2 className="text-sm font-bold mt-4 mb-2 first:mt-0" {...p} />
  ),
  h3: ({ node: _n, ...p }: WithNode<'h3'>) => (
    <h3 className="text-sm font-semibold mt-3 mb-1.5 first:mt-0" {...p} />
  ),
  h4: ({ node: _n, ...p }: WithNode<'h4'>) => (
    <h4
      className="text-xs font-semibold uppercase tracking-wide text-gray-500 mt-3 mb-1 first:mt-0"
      {...p}
    />
  ),

  strong: ({ node: _n, ...p }: WithNode<'strong'>) => <strong className="font-semibold" {...p} />,
  em: ({ node: _n, ...p }: WithNode<'em'>) => <em className="italic" {...p} />,

  // Inline code. Fenced blocks reset this via the `pre` arbitrary variants below.
  code: ({ node: _n, ...p }: WithNode<'code'>) => (
    <code
      className="font-mono text-[0.85em] px-1 py-0.5 rounded bg-gray-200/70 dark:bg-gray-800 text-gray-800 dark:text-gray-200"
      {...p}
    />
  ),
  pre: ({ node: _n, ...p }: WithNode<'pre'>) => (
    <pre
      className="mb-3 last:mb-0 p-3 rounded bg-gray-100 dark:bg-gray-900 overflow-x-auto text-xs font-mono
                 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[inherit]"
      {...p}
    />
  ),

  a: ({ node: _n, ...p }: WithNode<'a'>) => (
    <a
      className="text-blue-600 dark:text-blue-400 hover:underline break-all"
      target="_blank"
      rel="noopener noreferrer"
      {...p}
    />
  ),

  blockquote: ({ node: _n, ...p }: WithNode<'blockquote'>) => (
    <blockquote
      className="border-l-2 border-gray-300 dark:border-gray-700 pl-3 italic text-gray-600 dark:text-gray-400 mb-3 last:mb-0"
      {...p}
    />
  ),
  hr: ({ node: _n, ...p }: WithNode<'hr'>) => (
    <hr className="my-4 border-gray-200 dark:border-gray-800" {...p} />
  ),

  // GFM tables. The wrapper keeps wide tables from blowing out the drawer.
  table: ({ node: _n, ...p }: WithNode<'table'>) => (
    <div className="overflow-x-auto mb-3 last:mb-0">
      <table className="text-xs border-collapse w-full" {...p} />
    </div>
  ),
  th: ({ node: _n, ...p }: WithNode<'th'>) => (
    <th
      className="border border-gray-200 dark:border-gray-800 px-2 py-1 text-left font-semibold bg-gray-50 dark:bg-gray-900"
      {...p}
    />
  ),
  td: ({ node: _n, ...p }: WithNode<'td'>) => (
    <td className="border border-gray-200 dark:border-gray-800 px-2 py-1 align-top" {...p} />
  ),
};

const plugins = [remarkGfm, remarkBreaks];

// ---------------------------------------------------------------------------

export default function Markdown({
  children,
  className = '',
}: {
  children: string;
  className?: string;
}): ReactNode {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {preprocess(children)}
      </ReactMarkdown>
    </div>
  );
}
