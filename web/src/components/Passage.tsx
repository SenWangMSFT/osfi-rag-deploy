import { Image as ImageIcon } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { rehypeMark } from '../lib/rehypeMark';

// Passages are document text: their HTML (tables) is parsed, then sanitized before rendering.
const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'caption'],
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), 'alt', 'title'],
  },
};

const components: Components = {
  // Content Understanding writes chart and photo descriptions as ![](figures/N "description").
  img: ({ title, alt }) => <FigureNote text={title || alt || ''} />,
  table: ({ children }) => (
    <div className="not-prose my-3 overflow-x-auto rounded-lg bg-white ring-1 ring-slate-200">
      <table>{children}</table>
    </div>
  ),
  a: ({ children }) => <span>{children}</span>,
};

function FigureNote({ text }: { text: string }) {
  return (
    <span className="not-prose my-3 flex gap-2.5 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600 ring-1 ring-inset ring-slate-200">
      <ImageIcon className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" />
      <span>
        <span className="font-medium text-slate-700">Figure, described by AI: </span>
        {text || 'No description.'}
      </span>
    </span>
  );
}

export function Passage({ markdown, figures }: { markdown: string; figures: readonly string[] }) {
  const container = useRef<HTMLDivElement>(null);
  const rehypePlugins = useMemo<Options['rehypePlugins']>(
    () => [rehypeRaw, [rehypeSanitize, schema], rehypeMark(figures)],
    [figures],
  );

  // Bring the first highlighted figure into view; long tables otherwise hide it below the fold.
  useEffect(() => {
    container.current?.querySelector('mark')?.scrollIntoView({ block: 'center' });
  }, [markdown, figures]);

  return (
    <div
      ref={container}
      className="passage prose prose-sm prose-slate max-w-none text-slate-700 prose-p:my-2 prose-p:leading-6"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
