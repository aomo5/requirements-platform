const paths = {
  gateway:'<path d="M5 4h14l4 8-4 8H5l-4-8Z M12 7v10M7 12h10"/>',
  input:'<path d="M3 5h18v14H3l5-7Z"/>',
  event:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  output:'<path d="M3 5h12l6 7-6 7H3Z"/>',
  frame:'<path d="M5 3v18M19 3v18M3 5h18M3 19h18"/>',
  play:'<path d="m8 5 11 7-11 7Z"/>',
  link:'<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  expand:'<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
  collapse:'<path d="M4 9h5V4m11 5h-5V4M9 20v-5H4m11 5v-5h5"/>',
  select:'<path d="m5 3 14 10-7 1-3 7Z"/>',
  hand:'<path d="M8 12V6a2 2 0 0 1 4 0v5-6a2 2 0 0 1 4 0v7-4a2 2 0 0 1 4 0v7c0 4-3 6-7 6-3 0-4-2-6-4l-3-4c-1-2 1-3 2-2l2 1Z"/>',
  grid:'<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  upload:'<path d="M12 16V3m-4 4 4-4 4 4M4 16v5h16v-5"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  code:'<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
  history:'<path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7m2-4v5l3 2"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  refresh:'<path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6m-4 9a9 9 0 0 0 15 2l3-3m0 6v-6h-6"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:'<path d="m3 3 18 18M10 5a12 12 0 0 1 12 7 16 16 0 0 1-3 4M6 6a19 19 0 0 0-4 6s4 7 10 7c2 0 4-.6 5-1.6M10 10a3 3 0 0 0 4 4"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  back:'<path d="m10 5-7 7 7 7M3 12h18"/>',
  previous:'<path d="m15 5-7 7 7 7"/>',
  next:'<path d="m9 5 7 7-7 7"/>',
  up:'<path d="m5 15 7-7 7 7"/>',
  note:'<path d="M14 3H4v18h16V9Z"/><path d="M14 3v6h6M8 13h8m-8 4h5"/>',
  documentCheck:'<path d="M14 3H4v18h16V9Z"/><path d="M14 3v6h6m-12 5 3 3 5-5"/>',
  documentEmpty:'<path d="M14 3H4v18h16V9Z"/><path d="M14 3v6h6"/>',
  edit:'<path d="m14 5 5 5M4 20l5-1L21 7a3.5 3.5 0 0 0-5-5L4 14Z"/>',
  target:'<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
  undo:'<path d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12"/>',
  redo:'<path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>',
  minus:'<path d="M5 12h14"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01"/>',
  settings:'<path d="M3 7h3m6 0h9M3 17h9m6 0h3"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  external:'<path d="M14 3h7v7m0-7L10 14M10 4H4v16h16v-6"/>',
  archive:'<path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6"/>',
  unarchive:'<path d="M4 8h16v12H4zM3 4h18v4H3zM9 15l3-3 3 3m-3-3v6"/>',
  unlink:'<path d="m4 4 16 16M8 16l-1 1a4 4 0 0 1-6-6l4-4m11 1 1-1a4 4 0 0 1 6 6l-4 4M4 1v3H1m22 20v-3h-3"/>',
  sidebar:'<path d="M4 4h16v16H4zM9 4v16m6-12-3 4 3 4"/>',
  sidebarOpen:'<path d="M4 4h16v16H4zM9 4v16m4-12 3 4-3 4"/>',
  outline:'<path d="M4 5h16M4 10h4m4 0h8M4 15h4m4 0h8M4 20h4m4 0h8"/>',
  start:'<circle cx="12" cy="12" r="8"/>',
  step:'<rect x="3" y="6" width="18" height="12" rx="2"/>',
  decision:'<path d="m12 3 9 9-9 9-9-9Z"/>',
  end:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>',
  connect:'<path d="M5 19 19 5M9 5h10v10"/>',
};

export const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || paths.note}</svg>`;

let tooltip = null, owner = null, pending = null, hoverTimer = 0, leaveTimer = 0;
function hideTooltip() {
  clearTimeout(hoverTimer); clearTimeout(leaveTimer); pending = null;
  if (tooltip) {
    if (tooltip.matches(':popover-open')) tooltip.hidePopover();
    tooltip.hidden = true;
    if (owner) {
      const ids = (owner.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== tooltip.id);
      if (ids.length) owner.setAttribute('aria-describedby', ids.join(' ')); else owner.removeAttribute('aria-describedby');
    }
  }
  owner = null;
}
function showTooltip(button) {
  if (!button?.isConnected || !button.getClientRects().length || button.closest('[hidden]')) return hideTooltip();
  hideTooltip();
  if (!tooltip) {
    tooltip = document.createElement('div'); tooltip.id = 'wb-control-tooltip'; tooltip.className = 'wb-icon-tooltip'; tooltip.setAttribute('role','tooltip');
    if ('showPopover' in tooltip) tooltip.setAttribute('popover','manual');
    tooltip.addEventListener('pointerenter', () => clearTimeout(leaveTimer));
    tooltip.addEventListener('pointerleave', hideTooltip);
  }
  // Popover escapes clipped panels; the dialog host keeps it within the active modal.
  const host = button.closest('dialog[open]') || document.body;
  if (tooltip.parentElement !== host) host.append(tooltip);
  owner = button; tooltip.textContent = button.dataset.tooltip || button.getAttribute('aria-label'); tooltip.hidden = false;
  if (tooltip.hasAttribute('popover')) tooltip.showPopover();
  button.setAttribute('aria-describedby', [button.getAttribute('aria-describedby'), tooltip.id].filter(Boolean).join(' '));
  const rect = button.getBoundingClientRect(), box = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8,Math.min(innerWidth-box.width-8,rect.left+(rect.width-box.width)/2))}px`;
  tooltip.style.top = `${rect.bottom+box.height+12<innerHeight ? rect.bottom+8 : Math.max(8,rect.top-box.height-8)}px`;
}
document.addEventListener('pointerover', event => {
  if (event.pointerType === 'touch' || tooltip?.contains(event.target)) return;
  const button = event.target.closest?.('[data-tooltip]');
  if (button === owner) { clearTimeout(leaveTimer); return; }
  if (button === pending) return;
  hideTooltip();
  if (button) { pending = button; hoverTimer = setTimeout(() => showTooltip(button), 300); }
});
document.addEventListener('pointerout', event => {
  const button = owner || pending;
  if (button && !button.contains(event.relatedTarget)) { clearTimeout(hoverTimer); pending = null; leaveTimer = setTimeout(hideTooltip, 100); }
});
document.addEventListener('focusin', event => {
  if (!event.target.matches?.(':focus-visible')) return;
  const hint = event.target.closest?.('[data-tooltip]') || event.target.querySelector?.('[data-tooltip][data-tooltip-on-focus]');
  if (hint) showTooltip(hint);
});
document.addEventListener('focusout', hideTooltip);
document.addEventListener('pointerdown', hideTooltip);
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
document.addEventListener('scroll', hideTooltip, true);
document.addEventListener('close', hideTooltip, true);
window.addEventListener('resize', hideTooltip);

export function controlHint(button, label, shortcut = '') {
  if (!button) return;
  button.setAttribute('aria-label',label); button.dataset.tooltip = shortcut ? `${label} · ${shortcut}` : label;
  button.removeAttribute('title');
  if (owner === button) showTooltip(button);
}

export function iconButton(button, name, label, shortcut = '') {
  if (!button) return;
  button.classList.add('wb-icon-button'); button.classList.remove('full', 'text-button');
  if (button.dataset.icon !== name || !button.querySelector('svg')) { button.innerHTML = icon(name); button.dataset.icon = name; }
  controlHint(button, label, shortcut);
}

export function iconButtons(root, definitions) {
  for (const [id,name,label,shortcut] of definitions) iconButton(root.querySelector(`#${id}`),name,label,shortcut);
}

export function statusIndicator(element, name, label, detail = '') {
  if (!element) return;
  element.classList.add('wb-status-indicator');
  element.hidden = !label;
  element.innerHTML = label ? icon(name) : '';
  controlHint(element, label, detail);
}
