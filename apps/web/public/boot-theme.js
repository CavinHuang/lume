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
    var isCustomPalette = /^custom:[a-z0-9][a-z0-9-]{0,47}$/.test(palette || '')
    if (palette !== 'mint' && palette !== 'iris' && palette !== 'clay' && palette !== 'ocean' && palette !== 'sakura' && palette !== 'ember' && palette !== 'mono' && palette !== 'lavender' && palette !== 'olive' && !isCustomPalette) {
      palette = 'mint'
    }
    if (isCustomPalette) {
      var customTheme = JSON.parse(localStorage.getItem('lume:custom-theme-cache') || 'null')
      if (customTheme && customTheme.id === palette) {
        document.documentElement.dataset.themePalette = 'custom'
        document.documentElement.dataset.customThemeId = palette
        ;['light', 'dark'].forEach(function (themeMode) {
          ;['background', 'surface', 'text', 'muted', 'accent'].forEach(function (token) {
            document.documentElement.style.setProperty('--lume-custom-' + themeMode + '-' + token, customTheme[themeMode][token])
          })
        })
      } else {
        localStorage.setItem('lume:theme-palette', 'mint')
        document.documentElement.dataset.themePalette = 'mint'
      }
    } else {
      document.documentElement.dataset.themePalette = palette
    }
  } catch (e) {
    /* ignore */
  }
})()
