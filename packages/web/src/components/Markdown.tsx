import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MdComponents = ComponentProps<typeof ReactMarkdown>['components'];

/**
 * Markdown for Leon's chat messages. XSS-safe by construction:
 * react-markdown renders a React element tree (never innerHTML) and raw
 * HTML in the source is ignored by default — do NOT add rehype-raw.
 */
const components: MdComponents = {
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-txt">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-4">{children}</ol>,
  li: ({ children }) => <li className="marker:text-faint">{children}</li>,
  code: ({ children, className }) =>
    className ? (
      // block code (```lang) — className carries language-*
      <code className={`${className} block`}>{children}</code>
    ) : (
      <code className="border border-line bg-bg px-1 py-px font-mono text-[11px] text-txt">
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre className="my-1.5 overflow-x-auto border border-line bg-bg p-2 font-mono text-[11px] leading-relaxed text-dim">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-line-strong pl-2 text-dim">{children}</blockquote>
  ),
  h1: ({ children }) => <p className="mt-2 mb-1 text-[13px] font-semibold text-txt">{children}</p>,
  h2: ({ children }) => <p className="mt-2 mb-1 text-[13px] font-semibold text-txt">{children}</p>,
  h3: ({ children }) => <p className="mt-2 mb-1 font-semibold text-txt">{children}</p>,
  hr: () => <hr className="my-2 border-line" />,
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="border-collapse font-mono text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line bg-raise px-2 py-0.5 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-line px-2 py-0.5">{children}</td>,
  input: (props) => <input {...props} disabled className="mr-1 accent-current" />, // GFM task lists
};

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}
