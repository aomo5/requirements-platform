// Shared state identity for canvas and requirement links. HTML is parsed without executing it.
const statesCache = new WeakMap();
export function pageStates(page) {
  if (!page || typeof page.html !== "string" || !page.html.includes("design-workbench-states")) return [];
  const cached = statesCache.get(page);
  if (cached?.html === page.html && cached.route === page.route && cached.height === page.height && cached.width === page.width) return cached.states;
  let states = [];
  try {
    const document = new DOMParser().parseFromString(page.html, "text/html");
    const manifest = JSON.parse(document.querySelector('script#design-workbench-states[type="application/json"]').textContent);
    const group = manifest.version === 1 && Array.isArray(manifest.pages) ? manifest.pages.find((item) => item.route === (page.route || "")) : null;
    if (Array.isArray(group?.states) && group.states.length <= 200) {
      const ids = new Set(), routes = new Set();
      states = group.states.filter((item) => {
        if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 100
          || typeof item.route !== "string" || !item.route.startsWith("#") || item.route.length > 500 || ids.has(item.id) || routes.has(item.route)) return false;
        ids.add(item.id); routes.add(item.route); return true;
      }).map((item) => ({ id: item.id, name: item.name, route: item.route,
        trigger: typeof item.trigger === "string" ? item.trigger.slice(0,200) : "",
        width: Number.isInteger(item.width) && item.width >= 240 && item.width <= 2560 ? item.width : page.width,
        height: Number.isInteger(item.height) && item.height >= 200 && item.height <= 6000 ? item.height : page.height }));
    }
  } catch { /* Imported prototypes without a valid state manifest remain ordinary pages. */ }
  statesCache.set(page, { html: page.html, route: page.route, height: page.height, width: page.width, states });
  return states;
}

export function stateLabel(page, route = "") {
  const declared = page && pageStates(page).find(item => item.route === route);
  return declared?.name || (route === (page?.route || "") ? "默认状态" : route || "默认状态");
}
