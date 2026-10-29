const status = document.querySelector('.copy-status');
let statusTimer;

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {}
  }
  const buffer = document.createElement('textarea');
  buffer.value = text;
  buffer.className = 'copy-buffer';
  buffer.setAttribute('aria-label', 'Text to copy');
  document.body.append(buffer);
  buffer.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    buffer.remove();
  }
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copy);
    if (!code) return;
    try {
      await copyText(code.textContent);
      status.textContent = 'Example copied.';
    } catch {
      status.textContent = 'Copy unavailable. Select the example and copy it manually.';
    }
    button.focus({ preventScroll: true });
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.textContent = ''; }, 5000);
  });
}
