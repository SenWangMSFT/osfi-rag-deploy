import type { Element, ElementContent, Root, Text } from 'hast';
import { figurePattern } from './answer';

/** Rehype plugin: wraps the given figures in <mark> so the numbers the answer quotes stand out. */
export function rehypeMark(figures: readonly string[]) {
  const pattern = figurePattern(figures, 'g');
  return () => (tree: Root) => {
    if (pattern) markChildren(tree, pattern);
  };
}

function markChildren(parent: Root | Element, pattern: RegExp): void {
  const children: ElementContent[] = [];
  for (const child of parent.children as ElementContent[]) {
    if (child.type === 'text') {
      children.push(...split(child, pattern));
      continue;
    }
    if (child.type === 'element' && child.tagName !== 'code' && child.tagName !== 'pre') markChildren(child, pattern);
    children.push(child);
  }
  (parent as Element).children = children;
}

function split(node: Text, pattern: RegExp): ElementContent[] {
  const parts: ElementContent[] = [];
  let last = 0;
  for (const match of node.value.matchAll(pattern)) {
    if (match.index > last) parts.push({ type: 'text', value: node.value.slice(last, match.index) });
    parts.push({ type: 'element', tagName: 'mark', properties: {}, children: [{ type: 'text', value: match[0] }] });
    last = match.index + match[0].length;
  }
  if (last === 0) return [node];
  if (last < node.value.length) parts.push({ type: 'text', value: node.value.slice(last) });
  return parts;
}
