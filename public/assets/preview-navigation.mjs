// Keep prototype navigation inside the authenticated host; sandbox frames never receive credentials.
export function resolvePreviewTarget(href, {origin, entryPath, pages, sources=[]}) {
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/preview/') || url.search.length > 8192) return null;
    const source = decodeURIComponent(url.pathname.slice('/preview/'.length));
    if (!source.startsWith(entryPath + '/')) return null;
    const id = decodeURIComponent(url.hash.slice(1));
    const page = pages.find(page => page.id === id && (page.source === source || !page.source && sources.includes(source)));
    return page ? {id, query:url.search.slice(1)} : null;
  } catch { return null; }
}

export function previewBridgeScript(config, query, token) {
  const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
  return `window.__workbenchPreviewSearch=${json(query)};window.workbenchNavigate=(href)=>{const config=${json(config)};if(!(${resolvePreviewTarget.toString()})(href,config))return false;parent.postMessage({channel:'prototype-navigation-v1',token:${json(token)},href:String(href)},config.origin);return true};`;
}

export function previewNavigationConfig(entry) {
  return {
    origin: location.origin,
    entryPath: entry.path,
    pages: (entry.design?.pages || []).filter(page => page.status !== 'planned').map(({id, source}) => ({id, source})),
    sources: (entry.prototypes || []).map(item => item.path),
  };
}

export function savedPreviewHtml(page, config, query, token) {
  const doc = new DOMParser().parseFromString(page.html, 'text/html');
  doc.querySelectorAll("base,meta[http-equiv='refresh' i]").forEach(node => node.remove());
  const root = page.source?.startsWith(`${config.entryPath}/`)
    ? page.source.slice(0, page.source.lastIndexOf('/') + 1)
    : `${config.entryPath}/原型设计/`;
  const base = doc.createElement('base');
  base.href = `${config.origin}/preview/${root.split('/').map(encodeURIComponent).join('/')}`;
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none';";
  const navigation = doc.createElement('script');
  navigation.textContent = previewBridgeScript(config, query, token);
  doc.head.prepend(policy, base, navigation);
  if (page.route?.startsWith('#')) {
    const route = doc.createElement('script');
    route.textContent = `location.replace(location.href.split('#')[0] + ${JSON.stringify(page.route).replace(/</g, '\\u003c')});`;
    base.after(route);
  }
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

export const previewWindowPath = '/assets/page-preview.html';

export function savedPreviewUrl(path, id, query = '') {
  const params = new URLSearchParams({path, id});
  if (query) params.set('query', query);
  return `${previewWindowPath}?${params}`;
}
