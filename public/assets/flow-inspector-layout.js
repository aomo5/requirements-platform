import { iconButton } from './workbench-icons.js';

// Local presentation preference; never enters the flow model or its undo history.
export function installFlowInspectorLayout() {
  const panel = document.getElementById('flowInspectorPanel');
  const handle = document.getElementById('flowInspectorResize');
  const toggle = document.getElementById('flowInspectorToggle');
  const workbench = panel.closest('.workbench');
  const storageKey = 'requirementsPortal.flowInspectorLayout.v1';
  const minimum = 264, defaultWidth = 320;
  let preferredWidth = defaultWidth, collapsed = false, gesture = null;
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (Number.isFinite(stored.width)) preferredWidth = Math.max(minimum, Math.min(640, stored.width));
    collapsed = stored.collapsed === true;
  } catch {}

  function maximum() {
    const leftWidth = workbench.querySelector('.left-panel').getBoundingClientRect().width;
    return Math.max(minimum, Math.min(640, workbench.clientWidth - leftWidth - 320));
  }
  function render() {
    const width = Math.max(minimum, Math.min(maximum(), preferredWidth));
    document.body.style.setProperty('--right-panel-width', `${collapsed ? 0 : width}px`);
    panel.hidden = collapsed;
    handle.hidden = collapsed;
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(Math.round(maximum())));
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
    handle.setAttribute('aria-valuetext', `${Math.round(width)} 像素`);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    iconButton(toggle, collapsed ? 'sidebarOpen' : 'sidebar', collapsed ? '展开属性面板' : '收起属性面板');
    return width;
  }
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify({ width: preferredWidth, collapsed })); } catch {}
  }
  function finish(cancel = false) {
    if (!gesture) return;
    const previous = gesture;
    gesture = null;
    if (cancel) preferredWidth = previous.preferredWidth;
    else preferredWidth = Number(handle.getAttribute('aria-valuenow'));
    document.body.classList.remove('flow-inspector-resizing');
    if (handle.hasPointerCapture(previous.pointerId)) handle.releasePointerCapture(previous.pointerId);
    render();
    if (!cancel) persist();
  }

  toggle.addEventListener('click', () => {
    finish(true);
    collapsed = !collapsed;
    render();
    persist();
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || collapsed || gesture) return;
    event.preventDefault();
    event.stopPropagation();
    gesture = { pointerId: event.pointerId, startX: event.clientX, width: render(), preferredWidth };
    handle.setPointerCapture(event.pointerId);
    handle.focus({ preventScroll: true });
    document.body.classList.add('flow-inspector-resizing');
  });
  handle.addEventListener('pointermove', event => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    preferredWidth = Math.max(minimum, Math.min(maximum(), gesture.width + gesture.startX - event.clientX));
    render();
  });
  handle.addEventListener('pointerup', event => { if (event.pointerId === gesture?.pointerId) finish(); });
  for (const name of ['pointercancel', 'lostpointercapture']) handle.addEventListener(name, () => finish(true));
  handle.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || gesture) return;
    event.preventDefault();
    event.stopPropagation();
    const width = Number(handle.getAttribute('aria-valuenow'));
    preferredWidth = event.key === 'Home' ? minimum : event.key === 'End' ? maximum() : Math.max(minimum, Math.min(maximum(), width + (event.key === 'ArrowLeft' ? 10 : -10)));
    render();
    persist();
  });
  handle.addEventListener('dblclick', () => { finish(true); preferredWidth = defaultWidth; render(); persist(); });
  document.addEventListener('keydown', event => {
    if (gesture && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(true); }
  }, true);
  window.addEventListener('blur', () => finish(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(true); });
  window.addEventListener('resize', () => { finish(true); render(); });
  new ResizeObserver(() => render()).observe(workbench.querySelector('.left-panel'));
  render();
}
