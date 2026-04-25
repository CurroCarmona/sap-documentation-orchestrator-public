/* Brand hydration — reads client_name from /api/config and replaces CLIENT placeholder */
(function () {
  var DEFAULT_PALETTE = {
    black: '#111111',
    dark: '#1C1C1C',
    mid: '#4A4A4A',
    muted: '#8C8680',
    border: '#D8D4CE',
    bg: '#F7F5F2',
    white: '#FFFFFF',
    gold: '#B8924A',
    gold_lite: '#D4AA6A',
    cream: '#EDE9E3'
  };

  function getApiOrigin() {
    var params = new URLSearchParams(window.location.search);
    var fromQuery = (params.get('api') || '').trim();
    if (fromQuery) return fromQuery.replace(/\/$/, '');
    var fromStorage = (localStorage.getItem('bbp_api_origin') || '').trim();
    if (fromStorage) return fromStorage.replace(/\/$/, '');
    if (window.location.protocol === 'file:') return 'http://localhost:3000';
    return '';
  }

  function apiUrl(endpoint) {
    var origin = getApiOrigin();
    return origin ? origin + endpoint : endpoint;
  }

  // Shared helpers for all apps/pages.
  window.__bbpGetApiOrigin = getApiOrigin;
  window.__bbpApiUrl = apiUrl;

  // Route relative backend calls through configured API origin transparently.
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      if (typeof input === 'string' && input.indexOf('/api/') === 0) {
        return nativeFetch(apiUrl(input), init);
      }
      return nativeFetch(input, init);
    };
  }

  function applyPalette(palette) {
    var p = Object.assign({}, DEFAULT_PALETTE, palette || {});
    var root = document.documentElement;
    root.style.setProperty('--puig-black', p.black);
    root.style.setProperty('--puig-dark', p.dark);
    root.style.setProperty('--puig-mid', p.mid);
    root.style.setProperty('--puig-muted', p.muted);
    root.style.setProperty('--puig-border', p.border);
    root.style.setProperty('--puig-bg', p.bg);
    root.style.setProperty('--puig-white', p.white);
    root.style.setProperty('--puig-gold', p.gold);
    root.style.setProperty('--puig-gold-lt', p.gold_lite);
    root.style.setProperty('--puig-cream', p.cream);
  }

  function defaultCoreLineColors(clientName, palette) {
    var name = String(clientName || '').toUpperCase();
    if (name.indexOf('ACCENTURE') !== -1) {
      return [palette.gold, palette.black, palette.gold, palette.mid, palette.gold];
    }
    if (name.indexOf('PUIG') !== -1) {
      return ['#5a7a8c', palette.gold, '#4a7a5a', '#7b5a3f', palette.black];
    }
    return [palette.gold_lite, palette.gold, palette.dark, palette.mid, palette.black];
  }

  function applyCoreLineColors(colors, clientName, palette) {
    var root = document.documentElement;
    var source = Array.isArray(colors) && colors.length ? colors : defaultCoreLineColors(clientName, palette);
    for (var i = 0; i < 5; i++) {
      root.style.setProperty('--brand-core-line-' + (i + 1), source[i] || source[source.length - 1] || palette.gold);
    }
  }

  function defaultChartColors(clientName, palette) {
    var name = String(clientName || '').toUpperCase();
    if (name.indexOf('ACCENTURE') !== -1) {
      return [
        palette.gold, palette.black, '#6B6B6B', '#8A8A8A', '#B0B0B0', '#D0D0D0', '#F2F2F2'
      ];
    }
    if (name.indexOf('PUIG') !== -1) {
      return [
        '#B8924A', '#1A1A1A', '#D4AA6A', '#4A4A4A', '#8C8680',
        '#2d8a56', '#4a8eb8', '#b85a4a', '#6a4ab8', '#b84a8e',
        '#4ab8a0', '#b8a04a', '#5a7a8c', '#8c5a6a', '#6a8c5a'
      ];
    }
    return [
      palette.gold, palette.black, palette.gold_lite, palette.mid, palette.muted,
      '#2d8a56', '#4a8eb8', '#b85a4a', '#6a4ab8', '#b84a8e',
      '#4ab8a0', '#b8a04a', '#5a7a8c', '#8c5a6a', '#6a8c5a'
    ];
  }

  function applyChartColors(chartColors, clientName, palette) {
    var colors = Array.isArray(chartColors) && chartColors.length ? chartColors : defaultChartColors(clientName, palette);
    window.__BRAND_THEME = window.__BRAND_THEME || {};
    window.__BRAND_THEME.chartColors = colors;
  }

  function applyBrand(name) {
    if (!name) return;
    // Page title
    document.title = document.title.replace(/CLIENT/g, name);
    // Header brand spans
    document.querySelectorAll('.brand-puig').forEach(function (el) {
      if (el.textContent.includes('CLIENT')) {
        el.textContent = el.textContent.replace(/CLIENT/g, name);
      }
    });
    // Footer spans
    document.querySelectorAll('.site-footer span, footer span').forEach(function (el) {
      if (el.textContent.includes('CLIENT')) {
        el.textContent = el.textContent.replace(/CLIENT/g, name);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    fetch(apiUrl('/api/config'))
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (!cfg) return;
        var clientName = cfg.client_name || 'PUIG';
        var palette = Object.assign({}, DEFAULT_PALETTE, cfg.brand_palette || {});
        applyBrand(clientName);
        applyPalette(palette);
        applyCoreLineColors(cfg.core_app_line_colors || null, clientName, palette);
        applyChartColors(cfg.brand_chart_colors || null, clientName, palette);
        window.dispatchEvent(new CustomEvent('brand:applied', { detail: { client_name: clientName } }));
      })
      .catch(function () { /* keep CLIENT if backend unreachable */ });
  });
})();
