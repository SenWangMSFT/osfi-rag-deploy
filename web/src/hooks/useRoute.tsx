import { useCallback, useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import type { AnswerMode } from '../types';

export type Route = { page: 'workspace' } | { page: 'spec'; mode: AnswerMode };

export function parseRoute(pathname: string): Route {
  const match = pathname.match(/^\/how-it-works\/(direct|agent)\/?$/);
  return match ? { page: 'spec', mode: match[1] as AnswerMode } : { page: 'workspace' };
}

/** History-API routing for the two pages; web/server.mjs and Vite serve index.html for these paths. */
export function useRoute(): [Route, (path: string) => void] {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const navigate = useCallback((path: string) => {
    if (path !== window.location.pathname) window.history.pushState(null, '', path);
    setRoute(parseRoute(path));
  }, []);
  return [route, navigate];
}

interface RouteLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  onNavigate: (path: string) => void;
}

/** In-app link that still opens in a new tab with a modifier key or middle click. */
export function RouteLink({ href, onNavigate, onClick, ...props }: RouteLinkProps) {
  return (
    <a
      href={href}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onNavigate(href);
      }}
      {...props}
    />
  );
}
