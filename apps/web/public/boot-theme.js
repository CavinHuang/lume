// Apply theme before first paint. Keep this aligned with src/lib/theme-mode.ts.
;(function () {
  try {
    var mode = localStorage.getItem('lume:theme-mode')
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') mode = 'system'
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    if (mode === 'dark' || (mode === 'system' && prefersDark)) {
      document.documentElement.classList.add('dark')
    }
    var palette = localStorage.getItem('lume:theme-palette')
    if (palette !== 'mint' && palette !== 'iris' && palette !== 'clay' && palette !== 'ocean' && palette !== 'sakura' && palette !== 'ember' && palette !== 'mono' && palette !== 'lavender' && palette !== 'olive') {
      palette = 'mint'
    }
    document.documentElement.dataset.themePalette = palette
  } catch (e) {
    /* ignore */
  }
})()
