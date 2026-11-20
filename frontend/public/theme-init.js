(function () {
  try {
    var saved = localStorage.getItem('admin:theme');
    var dark = saved === 'dark' || ((saved === null || saved === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch {
    /* storage unavailable: keep the default theme */
  }
})();
