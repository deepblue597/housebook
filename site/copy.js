// Copy buttons for the install steps. Where the Clipboard API is missing or refused, the
// commands are selected instead, so Ctrl+C or a long press copies them.
for (const button of document.querySelectorAll('.copy')) {
  const code = button.parentElement.querySelector('code');
  const label = button.textContent;
  const name = button.getAttribute('aria-label');
  const say = (text) => {
    button.textContent = text;
    button.setAttribute('aria-label', text);
    setTimeout(() => {
      button.textContent = label;
      button.setAttribute('aria-label', name);
    }, 2000);
  };
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    say('Selected');
  };
  button.addEventListener('click', () => {
    if (!navigator.clipboard) return select();
    navigator.clipboard.writeText(code.textContent).then(() => say('Copied'), select);
  });
}
