import { iconButton } from './workbench-icons.js';

export function createEntryUI({ button, getModules, getModule, beforeCreate, onCreated, onOpened = () => {} }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'entry-create-dialog';
  dialog.setAttribute('aria-labelledby', 'entryCreateTitle');
  dialog.innerHTML = `<form>
    <div class="dialog-heading"><h2 id="entryCreateTitle">新增需求</h2><button type="button" data-close>关闭</button></div>
    <div class="entry-create-fields">
      <label for="entryCreateModule">所属模块</label><select id="entryCreateModule" name="module" required></select>
      <label for="entryCreateName">需求名称</label><input id="entryCreateName" name="name" maxlength="80" required autocomplete="off">
      <label for="entryCreateContent">需求内容</label><textarea id="entryCreateContent" name="content" maxlength="12000" rows="7" required></textarea>
    </div>
    <p class="entry-create-error" role="alert"></p>
    <div class="dialog-actions"><button class="button" type="button" data-close>取消</button><button class="button primary button-primary" type="submit">创建</button></div>
  </form>`;
  document.body.append(dialog);
  iconButton(dialog.querySelector('.dialog-heading button'), 'close', '关闭');
  const form = dialog.querySelector('form'), module = form.elements.module;
  const error = dialog.querySelector('[role=alert]'), submit = form.querySelector('[type=submit]');
  let busy = false, created = null;
  function close() { if (!busy) { dialog.close(); button.focus(); } }
  button.addEventListener('click', () => {
    if (busy) return;
    const previous = module.value;
    module.replaceChildren(...getModules().map(item => new Option(item.module, item.module)));
    module.value = previous || getModule() || module.options[0]?.value || '';
    if (!module.value && module.options.length) module.selectedIndex = 0;
    error.textContent = '';
    dialog.showModal(); form.elements.name.focus();
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.querySelectorAll('[data-close]').forEach(control => control.addEventListener('click', close));
  form.addEventListener('input', () => { error.textContent = ''; form.elements.name.setCustomValidity(''); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    busy = true; error.textContent = '';
    for (const control of dialog.querySelectorAll('button')) control.disabled = true;
    for (const control of dialog.querySelectorAll('input,textarea,select')) control.disabled = true;
    submit.textContent = created ? '正在打开…' : '正在创建…';
    try {
      if (!created) {
        if (!await beforeCreate()) throw new Error('当前修改尚未保存，请先完成保存后重试。');
        const response = await fetch('/api/entries', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Design-Client': 'workbench-v1' },
          body: JSON.stringify({ module: module.value, name: form.elements.name.value, content: form.elements.content.value }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '需求创建失败，请重试');
        created = result.entry;
      }
      await onCreated(created);
      created = null; form.reset(); module.value = ''; dialog.close(); onOpened();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      busy = false;
      for (const control of dialog.querySelectorAll('button,input,textarea,select')) control.disabled = false;
      if (created) for (const control of dialog.querySelectorAll('input,textarea,select')) control.disabled = true;
      submit.textContent = created ? '打开已创建需求' : '创建';
    }
  });
}
