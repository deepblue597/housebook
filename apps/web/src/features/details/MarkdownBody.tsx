/**
 * Note body as Markdown (react-markdown, loaded lazily). No raw HTML is ever rendered; links
 * and images go through the scheme allowlist (DESIGN 15.13); `[[wikilinks]]` become links when
 * they resolve to an item or attachment, plain text otherwise.
 */
import type { MouseEvent, ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isWebUrl, safeHref } from '../../domain/urls';
import { type Wikilink, splitWikilinks, wikilinkLabel } from '../../domain/wikilinks';

export interface ResolvedLink {
  href: string;
  /** Inline image (an attachment embed). */
  image?: boolean;
}

export interface MarkdownBodyProps {
  body: string;
  resolve: (link: Wikilink) => ResolvedLink | null;
  /** In-app navigation for `/i/<id>` links. */
  onNavigate: (href: string) => void;
}

// Minimal mdast shapes, enough for the wikilink transform.
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  children?: MdNode[];
}

const SKIP = new Set(['link', 'linkReference', 'inlineCode', 'code', 'image']);

function remarkWikilinks(resolve: MarkdownBodyProps['resolve']) {
  const transform = (node: MdNode) => {
    if (!node.children || SKIP.has(node.type)) return;
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== 'text' || !child.value?.includes('[[')) {
        transform(child);
        return [child];
      }
      return splitWikilinks(child.value).map((seg): MdNode => {
        if (seg.kind === 'text') return { type: 'text', value: seg.text };
        const label = wikilinkLabel(seg.link);
        const hit = resolve(seg.link);
        if (!hit) return { type: 'text', value: label };
        if (hit.image && seg.link.embed) return { type: 'image', url: hit.href, alt: label };
        return { type: 'link', url: hit.href, children: [{ type: 'text', value: label }] };
      });
    });
  };
  return () => (tree: MdNode) => transform(tree);
}

const isAttachmentUrl = (src: string) => src.startsWith('/api/items/');

export default function MarkdownBody({ body, resolve, onNavigate }: MarkdownBodyProps) {
  const components: Components = {
    // The panel title is the h2; the note's own headings sit below it.
    h1: ({ children }) => <h3>{children}</h3>,
    h2: ({ children }) => <h3>{children}</h3>,
    h3: ({ children }) => <h4>{children}</h4>,
    h4: ({ children }) => <h4>{children}</h4>,
    h5: ({ children }) => <h4>{children}</h4>,
    h6: ({ children }) => <h4>{children}</h4>,
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>;
      if (href.startsWith('/i/')) {
        const go = (e: MouseEvent) => {
          e.preventDefault();
          onNavigate(href);
        };
        return (
          <a href={href} onClick={go}>
            {children}
          </a>
        );
      }
      return isWebUrl(href) ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ) : (
        <a href={href} rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    // Only attachments are shown inline; remote images would leak the visit to third parties.
    img: ({ src, alt }) => {
      const url = typeof src === 'string' ? src : '';
      if (url && isAttachmentUrl(url)) return <img src={url} alt={alt ?? ''} loading="lazy" />;
      const label: ReactNode = alt || 'image';
      return url ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ) : (
        <span>{label}</span>
      );
    },
  };

  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkWikilinks(resolve)]}
      skipHtml
      urlTransform={(url) => safeHref(url) ?? ''}
      components={components}
    >
      {body}
    </Markdown>
  );
}
