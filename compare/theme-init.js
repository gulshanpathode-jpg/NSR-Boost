// Match the side panel's theme (shared extension origin). Light is the
// default; the panel's Config -> Appearance switch writes this key.
try {
  if (localStorage.getItem('sf-theme') === 'dark')
    document.documentElement.setAttribute('data-theme', 'dark');
} catch (e) { /* storage blocked; fall back to light */ }
