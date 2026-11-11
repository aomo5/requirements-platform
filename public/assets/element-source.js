import { createPageId } from './design-model.js';
// Source documents are parsed without executing scripts. Only the selected
// text node or inline declaration is changed; descendants and fixed IDs survive.
export const elementAttribute = 'data-wb-element';
export const styleFields = [
  ['font-size','字号','14px'], ['font-weight','字重','400'], ['line-height','行高','1.5'],
  ['color','文字颜色','#202124'], ['text-align','对齐','left'],
  ['background-color','填充','transparent'], ['border-color','边框颜色','#dddddd'],
  ['border-width','边框宽度','1px'], ['border-style','边框样式','solid'], ['border-radius','圆角','8px'],
  ['padding-top','上内边距','16px'], ['padding-right','右内边距','16px'],
  ['padding-bottom','下内边距','16px'], ['padding-left','左内边距','16px'],
  ['gap','内容间距','12px'], ['width','宽度','auto'], ['height','高度','auto'],
];
const properties = new Set(styleFields.map(([key]) => key));
const forbidden = /^(SCRIPT|STYLE|HEAD|META|LINK|BASE|TITLE|NOSCRIPT|TEMPLATE|HTML|BODY)$/;
export function prepareElementSource(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html'), used = new Set();
  for (const node of doc.querySelectorAll('*')) {
    let id = node.getAttribute(elementAttribute);
    if (!/^el-[a-f0-9-]{36}$/.test(id || '') || used.has(id)) {
      id = `el-${createPageId()}`; node.setAttribute(elementAttribute, id);
    }
    used.add(id);
  }
  const get = id => doc.querySelector(`[${elementAttribute}="${/^el-[a-f0-9-]{36}$/.test(id || '') ? id : ''}"]`);
  const textSlots = node => Array.from(node?.childNodes || []).flatMap((child, index) => child.nodeType === 3 && child.nodeValue.trim() ? [{ index, text: child.nodeValue }] : []);
  const serialize = () => `${html.match(/<!doctype\b[^>]*>/i)?.[0] || '<!doctype html>'}\n${doc.documentElement.outerHTML}`;
  return {
    get, serialize,
    records: () => Array.from(doc.body.querySelectorAll(`[${elementAttribute}]`)).filter(n => !forbidden.test(n.tagName)).map(node => ({
      id: node.getAttribute(elementAttribute), tag: node.tagName.toLowerCase(), texts: textSlots(node),
    })),
    describe(id) { const node = get(id); if (!node || forbidden.test(node.tagName)) return null;
      return { id, tag: node.tagName.toLowerCase(), texts: textSlots(node), styles: Object.fromEntries(styleFields.map(([key]) => [key, node.style.getPropertyValue(key)])) }; },
    text(id, index, expected, value) {
      const node = get(id), child = node?.childNodes[index];
      if (!node || forbidden.test(node.tagName) || child?.nodeType !== 3 || child.nodeValue !== expected) throw new Error('文字来源已变化，请重新选择元素');
      if (typeof value !== 'string' || value.length > 10000) throw new Error('文字最多 10000 个字符');
      if (value === expected) return false;
      // nodeValue escapes literal markup on serialization, leaving child tags intact.
      child.nodeValue = value; return true;
    },
    style(id, property, value) {
      const node = get(id); if (!node || forbidden.test(node.tagName) || !properties.has(property)) throw new Error('该样式暂不支持编辑');
      value = String(value).trim();
      if (value && (/url\s*\(|[;{}<>]/i.test(value) || !CSS.supports(property, value))) throw new Error('请输入有效样式，例如 16px、1.5 或 #2563eb');
      if (node.style.getPropertyValue(property) === value && (!value || node.style.getPropertyPriority(property) === 'important')) return false;
      if (value) node.style.setProperty(property, value, 'important'); else node.style.removeProperty(property);
      return true;
    },
  };
}
