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
