// Progressive enhancement: show this deployment's own origin in the base URL and the examples.
// Without JavaScript the page keeps the literal placeholder "https://<this host>".
const { protocol, origin } = window.location;
if (protocol === 'https:' || protocol === 'http:') {
  for (const el of document.querySelectorAll('[data-origin]')) el.textContent = origin;
}
