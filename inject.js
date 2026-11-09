// Chạy trong trang YouTube (MAIN world):
// - bắt URL phụ đề mà trình phát tự tải (có token "pot" mà YouTube bắt buộc)
// - đọc danh sách phụ đề và thông tin ngôn ngữ video hiện tại
(() => {
  if (window.__ltvInjected) return;
  window.__ltvInjected = true;

  // videoId -> URL phụ đề, ưu tiên URL có token "pot"
  const caps = new Map();
  const report = (url) => {
    try {
      const u = String(url || '');
      if (!u.includes('/api/timedtext')) return;
      const full = new URL(u, location.href);
      const v = full.searchParams.get('v');
      if (!v || (caps.has(v) && !full.searchParams.has('pot'))) return;
      caps.set(v, full.href);
    } catch {}
  };

  const findCaptured = (v) => {
    try {
      performance.getEntriesByType('resource').forEach((e) => {
        if (e.name.includes('/api/timedtext')) report(e.name);
      });
    } catch {}
    return caps.get(v) || null;
  };

  const origFetch = window.fetch;
  window.fetch = function (input) {
    try { report(typeof input === 'string' ? input : input && input.url); } catch {}
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    report(url);
    return origOpen.apply(this, arguments);
  };

  function getPlayerResponse() {
    try {
      const p = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
      if (p && typeof p.getPlayerResponse === 'function') {
        const res = p.getPlayerResponse();
        if (res) return res;
      }
    } catch {}
    if (window.ytInitialPlayerResponse) {
      return window.ytInitialPlayerResponse;
    }
    return null;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'ltv-content') return;

    if (e.data.type === 'ping') {
      window.postMessage({ source: 'ltv-page', type: 'pong', id: e.data.id }, '*');
      return;
    }

    if (e.data.type === 'getCaptured') {
      window.postMessage({ source: 'ltv-page', type: 'captured', id: e.data.id, payload: findCaptured(e.data.videoId) }, '*');
      return;
    }

    if (e.data.type === 'getTracks') {
      let payload = null;
      try {
        const r = getPlayerResponse();
        if (r) {
          const list = (r.captions && r.captions.playerCaptionsTracklistRenderer &&
            r.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
          
          const defaultAudioLang = (r.videoDetails && r.videoDetails.defaultAudioLanguage) ||
            (r.microformat && r.microformat.playerMicroformatRenderer &&
             r.microformat.playerMicroformatRenderer.defaultAudioLanguage) || '';

          payload = {
            videoId: (r.videoDetails && r.videoDetails.videoId) || null,
            title: (r.videoDetails && r.videoDetails.title) || '',
            author: (r.videoDetails && r.videoDetails.author) || '',
            defaultAudioLanguage: defaultAudioLang,
            tracks: list.map((t) => ({
              baseUrl: t.baseUrl,
              languageCode: t.languageCode || '',
              kind: t.kind || '',
              vssId: t.vssId || '',
              name: (t.name && t.name.simpleText) || '',
            })),
          };
        }
      } catch {}
      window.postMessage({ source: 'ltv-page', type: 'tracks', id: e.data.id, payload }, '*');
    }
  });
})();
