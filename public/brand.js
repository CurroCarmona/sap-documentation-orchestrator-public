/* Brand hydration — reads client_name from /api/config and replaces CLIENT placeholder */
(function () {
  var DEFAULT_PALETTE = {
    black: '#111111', dark: '#1C1C1C', mid: '#4A4A4A', muted: '#8C8680',
    border: '#D8D4CE', bg: '#F7F5F2', white: '#FFFFFF', gold: '#B8924A',
    gold_lite: '#D4AA6A', cream: '#EDE9E3'
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

  window.__bbpGetApiOrigin = getApiOrigin;
  window.__bbpApiUrl = apiUrl;

  document.addEventListener('DOMContentLoaded', function () {
    fetch(apiUrl('/api/config'))
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (!cfg) return;
        var name = cfg.client_name || 'PUIG';
        document.title = document.title.replace(/CLIENT/g, name);
      })
      .catch(function () {});
  });
})();
