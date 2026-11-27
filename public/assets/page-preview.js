import {createPageId} from './design-model.js';
import {previewNavigationConfig, resolvePreviewTarget, savedPreviewHtml, savedPreviewUrl} from './preview-navigation.mjs';

const status = document.getElementById('previewStatus');
let frame = document.getElementById('pagePreviewFrame');
let navigation, frameToken = '', generation = 0;

async function readJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw Object.assign(new Error(data?.error || '预览加载失败'), {status: response.status});
  return data;
}

function displayPage(page, html) {
  if (typeof html !== 'string' || typeof page?.name !== 'string' || !Number.isInteger(page.width) || page.width < 1 || !Number.isInteger(page.height) || page.height < 1) {
    throw new Error('画板内容不可用');
  }
  document.title = `${page.name} · 页面预览`;
  // A fresh frame keeps history entries for board changes in the top-level viewer.
  const nextFrame = frame.cloneNode(false);
  nextFrame.title = page.name;
  nextFrame.width = page.width;
  nextFrame.height = page.height;
  nextFrame.srcdoc = html;
  nextFrame.hidden = false;
  frame.replaceWith(nextFrame);
  frame = nextFrame;
  status.hidden = true;
}

async function loadSavedPage() {
  const params = new URLSearchParams(location.search);
  const path = params.get('path'), id = params.get('id'), query = params.get('query') || '';
  const request = ++generation;
  frameToken = '';
  frame.hidden = true;
  status.hidden = false;
  status.textContent = '正在加载预览…';
  try {
    if (!path || !id) throw new Error('预览链接缺少画板信息');
    const [{page}, {entry}] = await Promise.all([
      readJson(`/api/design/page?${new URLSearchParams({path, id})}`),
      readJson(`/api/entry?${new URLSearchParams({path})}`),
    ]);
    if (request !== generation) return;
    if (!page || page.status === 'planned' || typeof page.html !== 'string') throw new Error('画板内容不可用');
    navigation = previewNavigationConfig(entry);
    frameToken = createPageId();
    displayPage(page, savedPreviewHtml(page, navigation, query, frameToken));
  } catch (error) {
    if (request !== generation) return;
    if (error.status === 401) location.replace(`/login?${new URLSearchParams({returnTo: location.pathname + location.search})}`);
    else status.textContent = error.message || '预览加载失败';
  }
}

async function loadSnapshot(snapshot) {
  try {
    const url = new URL(snapshot);
    if (url.protocol !== 'blob:' || url.origin !== location.origin) throw new Error('预览链接无效');
    const page = await readJson(url);
    displayPage(page, page.html);
  } catch {
    status.textContent = '当前画板预览已失效，请从画布重新打开。';
  }
}

const snapshot = new URLSearchParams(location.hash.slice(1)).get('snapshot');
if (snapshot) {
  void loadSnapshot(snapshot);
} else {
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== frame.contentWindow || !frameToken || message?.channel !== 'prototype-navigation-v1' || message.token !== frameToken) return;
    const target = resolvePreviewTarget(message.href, navigation);
    if (!target) return;
    history.pushState(null, '', savedPreviewUrl(navigation.entryPath, target.id, target.query));
    void loadSavedPage();
  });
  window.addEventListener('popstate', loadSavedPage);
  void loadSavedPage();
}
