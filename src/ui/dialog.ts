/**
 * Вопросы и сообщения прямо на странице (вместо confirm/alert): во встроенных браузерах и приложениях
 * системные окна бывают отключены — confirm() молча отвечает «нет», и, например, книга не скачивается.
 */
const h = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function open(text: string, buttons: { label: string; value: boolean; accent?: boolean }[]): Promise<boolean> {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'ui-dialog';
    box.innerHTML = `<div class="ui-dialog-card" role="dialog" aria-modal="true"><div class="ui-dialog-text">${h(text).replace(/\n/g, '<br>')}</div>
      <div class="ui-dialog-btns">${buttons.map((b, i) => `<button type="button" class="btn ${b.accent ? 'accent' : 'ghost'}" data-i="${i}">${h(b.label)}</button>`).join('')}</div></div>`;
    const done = (v: boolean) => { box.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(buttons.find((b) => b.accent)?.value ?? true); }
    };
    box.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-i]') as HTMLElement | null;
      if (b) done(buttons[Number(b.dataset.i)].value);
      else if (e.target === box) done(false);
    });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(box);
    (box.querySelector('.btn.accent') as HTMLElement | null)?.focus();
  });
}

/** Вопрос «да / нет». */
export const ask = (text: string, yes = 'Да', no = 'Отмена'): Promise<boolean> => open(text, [{ label: no, value: false }, { label: yes, value: true, accent: true }]);
/** Сообщение с кнопкой «Понятно». */
export const tell = (text: string): void => { void open(text, [{ label: 'Понятно', value: true, accent: true }]); };
