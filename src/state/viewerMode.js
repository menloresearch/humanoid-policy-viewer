// True for the Cloudflare Pages / static-hosted build (vite build --mode
// static, VITE_VIEWER_MODE=static). There is no dev-server middleware behind
// a static host, so anything under /api/* is unreachable there: stores and
// components must branch on this instead of hitting those endpoints.
export const STATIC = import.meta.env.VITE_VIEWER_MODE === 'static';
