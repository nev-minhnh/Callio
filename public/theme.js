// Apply the saved theme before first paint (kept external so the CSP needs no inline script).
try {
  var t = JSON.parse(localStorage.getItem("quire.theme") || '"system"');
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
