(() => {
  'use strict';
  if (window.__ltvContent) return;
  window.__ltvContent = true;

  const DEFAULTS = {
    autoStart: true,
    voice: '',          // '' = tự chọn giọng hay nhất, 'google' = Google Dịch, còn lại = tên giọng
    rate: 1.1,
    duckSpeaking: 0.15, // âm gốc khi đang đọc
    duckGap: 0.4,       // âm gốc lúc nghỉ giữa các câu
    dubVolume: 1,
    showSubs: false,
  };
  const CACHE_PREFIX = 'ltv1:';
  const VI = /^vi([-_]|$)/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const cancelled = new Error('cancelled');

  let S = { ...DEFAULTS };
  const st = {
    videoId: null, active: false, loading: false, loadToken: 0,
    cues: [], nextIdx: 0,
    speaking: false, speakToken: 0, speakDeadline: 0,
    video: null, base: null, factor: 1, lastSetVol: -1,
    cps: { web: 15, google: 14 }, // ký tự/giây ở tốc độ 1, tự hiệu chỉnh
  };

  // ---------- Giao tiếp với trang ----------
  function pageCall(type, extra) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const h = (e) => {
        if (e.source !== window || !e.data || e.data.source !== 'ltv-page' || e.data.id !== id) return;
        window.removeEventListener('message', h);
        resolve(e.data.payload);
      };
      window.addEventListener('message', h);
      window.postMessage({ source: 'ltv-content', type, id, ...extra }, '*');
      setTimeout(() => { window.removeEventListener('message', h); resolve(null); }, 2000);
    });
  }

  function bg(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!r || !r.ok) return reject(new Error((r && r.error) || 'Lỗi không rõ'));
          resolve(r.result);
        });
      } catch (err) { reject(err); }
    });
  }

  // ---------- Lấy & dịch phụ đề ----------
  function pickTrack(tracks) {
    const manual = tracks.filter((t) => t.kind !== 'asr');
    return manual.find((t) => VI.test(t.languageCode)) ||
      manual.find((t) => /^en/i.test(t.languageCode)) ||
      manual[0] || tracks[0];
  }

  async function fetchEvents(url, tlang) {
    try {
      const u = new URL(url, location.href);
      u.searchParams.set('fmt', 'json3');
      if (tlang) u.searchParams.set('tlang', tlang); else u.searchParams.delete('tlang');
      const r = await fetch(u.href, { credentials: 'include' });
      if (!r.ok) return null;
      const txt = await r.text();
      if (!txt.trim()) return null;
      const ev = (JSON.parse(txt).events || []).filter((e) => e.segs);
      return ev.length ? ev : null;
    } catch { return null; }
  }

  function adaptUrl(url, track) {
    const u = new URL(url);
    u.searchParams.set('lang', track.languageCode);
    if (track.kind) u.searchParams.set('kind', track.kind); else u.searchParams.delete('kind');
    u.searchParams.delete('tlang');
    return u.href;
  }

  // YouTube giờ yêu cầu token trong URL phụ đề: bật CC thoáng qua để trình phát tự tải, rồi mượn URL đó.
  async function captureUrl(videoId) {
    const get = () => pageCall('getCaptured', { videoId });
    let url = await get();
    if (url && url.includes('pot=')) return url;
    const btn = document.querySelector('#movie_player .ytp-subtitles-button');
    if (!btn) return url;
    const wasOn = btn.getAttribute('aria-pressed') === 'true';
    btn.click();
    if (wasOn) { await sleep(300); btn.click(); }
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      url = await get();
      if (url && url.includes('pot=')) break;
    }
    if (!wasOn && btn.getAttribute('aria-pressed') === 'true') btn.click();
    return url;
  }

  function parseEvents(events) {
    const out = [];
    for (const ev of events) {
      const text = ev.segs.map((s) => s.utf8 || '').join('')
        .replace(/\n/g, ' ')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/[♪♫]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      const start = (ev.tStartMs || 0) / 1000;
      out.push({ start, end: start + (ev.dDurationMs || 2000) / 1000, text });
    }
    out.sort((a, b) => a.start - b.start);
    for (let i = 0; i < out.length - 1; i++) if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start;
    return out.filter((c, i) => i === 0 || c.text !== out[i - 1].text);
  }

  // Gộp các mảnh phụ đề thành câu hoàn chỉnh để dịch tự nhiên và đọc liền mạch
  function mergeCues(cues, isAsr) {
    const maxChars = isAsr ? 140 : 200, maxDur = isAsr ? 7 : 10, maxGap = isAsr ? 0.9 : 1.2;
    const out = [];
    let cur = null;
    for (const c of cues) {
      if (cur && c.start - cur.end <= maxGap && cur.text.length + c.text.length <= maxChars &&
          c.end - cur.start <= maxDur && !/[.!?…]["')\]]?$/.test(cur.text)) {
        cur.text += ' ' + c.text;
        cur.end = c.end;
      } else {
        if (cur) out.push(cur);
        cur = { ...c };
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  async function runPool(items, n, fn) {
    let i = 0;
    const worker = async () => { while (i < items.length) await fn(items[i++]); };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  }

  async function translateCues(cues, token) {
    const texts = cues.map((c) => c.text);
    const batches = [];
    let cur = [], len = 0;
    texts.forEach((t, i) => {
      const L = encodeURIComponent(t).length + 3;
      if (cur.length && len + L > 5000) { batches.push(cur); cur = []; len = 0; }
      cur.push(i); len += L;
    });
    if (cur.length) batches.push(cur);
    const out = new Array(texts.length);
    let done = 0;
    await runPool(batches, 3, async (b) => {
      const res = await bg({ type: 'translate', texts: b.map((i) => texts[i]) });
      if (token !== st.loadToken) throw cancelled;
      b.forEach((i, k) => { out[i] = res[k]; });
      done++;
      status(`Đang dịch sang tiếng Việt… ${Math.round((done / batches.length) * 100)}%`);
    });
    return cues.map((c, i) => ({ ...c, text: out[i] || '' })).filter((c) => c.text);
  }

  async function loadCues(videoId, token) {
    const cached = await cacheGet(videoId);
    if (cached) return cached;
    status('Đang lấy phụ đề…');
    let info = null;
    for (let i = 0; i < 25 && token === st.loadToken; i++) {
      const r = await pageCall('getTracks');
      if (r && r.videoId === videoId) { info = r; break; }
      await sleep(300);
    }
    if (token !== st.loadToken) throw cancelled;
    if (!info) throw new Error('Không đọc được thông tin video.');
    if (!info.tracks.length) throw new Error('Video này không có phụ đề nên chưa lồng tiếng được.');

    const track = pickTrack(info.tracks);
    const isAsr = track.kind === 'asr';
    let url = track.baseUrl;
    let events = null;
    const early = await pageCall('getCaptured', { videoId });
    if (early && early.includes('pot=')) { url = adaptUrl(early, track); events = await fetchEvents(url); }
    if (!events) { url = track.baseUrl; events = await fetchEvents(url); }
    if (!events) {
      status('Đang kích hoạt phụ đề…');
      const cap = await captureUrl(videoId);
      if (cap) {
        url = adaptUrl(cap, track);
        events = await fetchEvents(url);
        if (!events) { url = cap; events = await fetchEvents(url); }
      }
    }
    if (token !== st.loadToken) throw cancelled;
    if (!events) throw new Error('Không tải được phụ đề của video.');

    let cues;
    if (VI.test(track.languageCode)) {
      cues = mergeCues(parseEvents(events), isAsr);
    } else {
      status('Đang dịch sang tiếng Việt…');
      try {
        cues = await translateCues(mergeCues(parseEvents(events), isAsr), token);
      } catch (e) {
        if (e === cancelled) throw e;
        // Dự phòng: bản dịch tự động của chính YouTube
        const vi = await fetchEvents(url, 'vi');
        if (!vi) throw new Error('Không dịch được phụ đề: ' + e.message);
        cues = mergeCues(parseEvents(vi), isAsr);
      }
    }
    if (!cues.length) throw new Error('Phụ đề trống.');
    cacheSet(videoId, cues);
    return cues;
  }

  async function cacheGet(id) {
    try {
      const k = CACHE_PREFIX + id;
      const r = await chrome.storage.local.get(k);
      return (r[k] && r[k].cues) || null;
    } catch { return null; }
  }

  async function cacheSet(id, cues) {
    try {
      await chrome.storage.local.set({ [CACHE_PREFIX + id]: { t: Date.now(), cues } });
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX)).sort((a, b) => all[b].t - all[a].t);
      if (keys.length > 40) await chrome.storage.local.remove(keys.slice(40));
    } catch {}
  }

  // ---------- Giọng đọc ----------
  let voices = [];
  const loadVoices = () => { voices = speechSynthesis.getVoices().filter((v) => VI.test(v.lang)); };
  loadVoices();
  speechSynthesis.addEventListener('voiceschanged', loadVoices);

  function pickVoice() {
    if (S.voice === 'google' || S.voice === 'ms-hoaimy' || S.voice === 'ms-namminh') return null;
    if (S.voice) {
      const v = voices.find((x) => x.name === S.voice);
      if (v) return v;
    }
    // Edge có giọng "Natural" (HoaiMy, NamMinh) rất tự nhiên trong WebSpeech
    const edgeNatural = voices.find((v) => /natural|online/i.test(v.name));
    if (edgeNatural) return edgeNatural;
    // Trên Chrome không có giọng Natural trong WebSpeech -> trả về null để dùng MS Neural TTS qua background
    return null;
  }

  function currentVoiceName() {
    const v = pickVoice();
    if (v) return v.name.replace(/^Microsoft\s+/, '').replace(/\s+-.*$/, '');
    if (S.voice === 'ms-namminh') return 'Nam Minh (Tự nhiên)';
    if (S.voice === 'google') return 'Google Dịch (online)';
    return 'Hoài My (Tự nhiên)';
  }

  let blockedWarned = false;
  function warnBlocked() {
    if (blockedWarned) return;
    blockedWarned = true;
    toast('Trình duyệt chặn âm thanh — bấm vào video một lần để nghe lồng tiếng.', 5000);
  }

  const WebSpeech = {
    cur: null,
    speak(text, rate, voice, volume, onStart, onEnd) {
      if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = voice.lang || 'vi-VN';
      u.voice = voice;
      u.rate = rate;
      u.volume = volume;
      let done = false;
      const fin = () => { if (!done) { done = true; onEnd(); } };
      u.onstart = onStart;
      u.onend = fin;
      u.onerror = (e) => { if (e.error === 'not-allowed') warnBlocked(); fin(); };
      this.cur = u; // giữ tham chiếu, tránh lỗi Chrome dọn rác giữa chừng
      speechSynthesis.speak(u);
    },
    stop() { this.cur = null; speechSynthesis.cancel(); },
  };

  function splitText(text, max) {
    const out = [];
    let rest = text.trim();
    while (rest.length > max) {
      const head = rest.slice(0, max);
      let cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '), head.lastIndexOf(', '));
      if (cut < max * 0.3) cut = head.lastIndexOf(' ');
      if (cut <= 0) cut = max - 1;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  function b64ToUrl(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([u8], { type: 'audio/mpeg' }));
  }

  const AudioTTS = {
    cache: new Map(), audio: null, playId: 0, release: null,
    chunks(text) {
      const key = `${text}::${S.voice}`;
      if (!this.cache.has(key)) {
        const p = Promise.all(splitText(text, 250).map((c) => bg({ type: 'tts', text: c, voice: S.voice }).then(b64ToUrl)));
        p.catch(() => this.cache.delete(key));
        this.cache.set(key, p);
      }
      return this.cache.get(key);
    },
    prefetch(text) { this.chunks(text).catch(() => {}); },
    async speak(text, rate, volume, onStart, onEnd) {
      const id = ++this.playId;
      try {
        const urls = await this.chunks(text);
        for (let i = 0; i < urls.length && id === this.playId; i++) {
          await new Promise((res) => {
            const a = new Audio(urls[i]);
            a.preservesPitch = true;
            a.playbackRate = rate;
            a.volume = volume;
            this.audio = a;
            this.release = res;
            a.onended = a.onerror = () => res();
            a.play().then(() => { if (i === 0) onStart(); }).catch((err) => {
              if (err && err.name === 'NotAllowedError') warnBlocked();
              res();
            });
          });
        }
      } catch {}
      if (id === this.playId) onEnd();
    },
    stop() {
      this.playId++;
      if (this.audio) this.audio.pause();
      this.audio = null;
      if (this.release) this.release();
      this.release = null;
    },
    clear() {
      this.stop();
      for (const p of this.cache.values()) p.then((us) => us.forEach((u) => URL.revokeObjectURL(u))).catch(() => {});
      this.cache.clear();
    },
  };
  const GoogleTTS = AudioTTS; // alias cho code hiện tại

  // ---------- Đồng bộ lời đọc với video ----------
  function findIdx(t) {
    const c = st.cues;
    for (let i = 0; i < c.length; i++) if (c[i].end > t + 0.3) return i;
    return c.length;
  }

  function speakCue(idx) {
    const cue = st.cues[idx], v = st.video;
    const t = v.currentTime;
    const next = st.cues[idx + 1];
    const until = next ? next.start : cue.end + 2;
    const avail = Math.max(0.7, (until - Math.max(t, cue.start)) / (v.playbackRate || 1));
    const voice = pickVoice();
    const kind = voice ? 'web' : 'google';
    // Đọc nhanh hơn nếu câu dài so với khoảng thời gian có sẵn
    const need = cue.text.length / st.cps[kind] / avail;
    const rate = clamp(Math.max(S.rate, need), 0.5, 2);
    const token = ++st.speakToken;
    st.speaking = true;
    st.speakDeadline = performance.now() + (cue.text.length / st.cps[kind] / rate) * 2500 + 6000;
    let startedAt = 0;
    setSub(cue.text);
    const onStart = () => { if (token === st.speakToken) startedAt = performance.now(); };
    const onEnd = () => {
      if (token !== st.speakToken) return;
      st.speaking = false;
      setSub('');
      if (startedAt && cue.text.length > 15) {
        const dur = (performance.now() - startedAt) / 1000;
        if (dur > 0.5) st.cps[kind] = clamp(st.cps[kind] * 0.8 + (cue.text.length / (dur * rate)) * 0.2, 8, 30);
      }
    };
    if (voice) {
      WebSpeech.speak(cue.text, rate, voice, S.dubVolume, onStart, onEnd);
    } else {
      GoogleTTS.speak(cue.text, rate, S.dubVolume, onStart, onEnd);
      for (let k = 1; k <= 2; k++) if (st.cues[idx + k]) GoogleTTS.prefetch(st.cues[idx + k].text);
    }
  }

  function stopSpeech() {
    st.speakToken++;
    st.speaking = false;
    WebSpeech.stop();
    GoogleTTS.stop();
    setSub('');
  }

  // ---------- Âm lượng gốc ----------
  function applyVol() {
    const v = st.video;
    if (!v || st.base == null) return;
    const want = clamp(st.base * st.factor, 0, 1);
    if (Math.abs(v.volume - want) > 0.004) {
      st.lastSetVol = want;
      v.volume = want;
    }
  }

  function restoreVolume() {
    if (st.video && st.base != null) {
      st.lastSetVol = st.base;
      st.video.volume = st.base;
    }
    st.base = null;
    st.factor = 1;
  }

  function attachVideo(v) {
    st.video = v;
    if (v.__ltv) return;
    v.__ltv = true;
    v.addEventListener('seeked', () => {
      if (!st.active) return;
      stopSpeech();
      st.nextIdx = findIdx(v.currentTime);
    });
    v.addEventListener('pause', () => {
      if (!st.active || !st.speaking) return;
      stopSpeech();
      st.nextIdx = findIdx(v.currentTime);
    });
    v.addEventListener('volumechange', () => {
      if (!st.active || st.base == null) return;
      if (Math.abs(v.volume - st.lastSetVol) < 0.003) return; // do mình chỉnh
      st.base = v.volume; // người dùng chỉnh âm lượng
      st.lastSetVol = -1;
      applyVol();
    });
  }

  const getVideo = () => document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video.html5-main-video');
  const currentVideoId = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);

  function tick() {
    ensureButton();
    const vid = currentVideoId();
    if (vid !== st.videoId) onVideoChange(vid);
    if (!st.active) return;
    const v = getVideo();
    if (!v) return;
    if (v !== st.video) { restoreVolume(); attachVideo(v); st.base = v.volume; }
    if (st.base == null) st.base = v.volume;
    if (!st.cues.length) return;

    const ad = !!document.querySelector('#movie_player.ad-showing');
    if (ad && st.speaking) stopSpeech();
    const target = ad ? 1 : st.speaking ? S.duckSpeaking : S.duckGap;
    st.factor += clamp(target - st.factor, -0.12, 0.04); // giảm nhanh, trả lại từ từ
    applyVol();
    if (ad || v.paused || v.seeking || v.ended) return;

    if (st.speaking) {
      if (performance.now() > st.speakDeadline) stopSpeech();
      return;
    }
    const i = st.nextIdx;
    const c = st.cues[i];
    if (!c) return;
    const t = v.currentTime;
    if (c.start > t + 0.1) return;
    if (t > c.end + 1) { st.nextIdx = Math.max(i + 1, findIdx(t)); return; } // bị trễ quá -> nhảy tới câu hiện tại
    st.nextIdx = i + 1;
    speakCue(i);
  }

  // ---------- Bật / tắt ----------
  function onVideoChange(vid) {
    stop(true);
    st.videoId = vid;
    st.cues = [];
    st.nextIdx = 0;
    st.loadToken++;
    GoogleTTS.clear();
    if (vid && S.autoStart) start();
  }

  async function start() {
    const vid = st.videoId;
    if (!vid) { toast('Hãy mở một video YouTube trước.'); return; }
    st.active = true;
    blockedWarned = false;
    const v = getVideo();
    if (v) { attachVideo(v); st.base = v.volume; st.factor = 1; }
    updateButton();
    if (st.cues.length) {
      if (v) st.nextIdx = findIdx(v.currentTime);
      toast('Lồng tiếng Việt: BẬT');
      return;
    }
    if (st.loading) return;
    const token = ++st.loadToken;
    st.loading = true;
    updateButton();
    try {
      const cues = await loadCues(vid, token);
      if (token !== st.loadToken) return;
      st.cues = cues;
      const vv = getVideo();
      st.nextIdx = vv ? findIdx(vv.currentTime) : 0;
      if (!pickVoice()) cues.slice(st.nextIdx, st.nextIdx + 2).forEach((c) => GoogleTTS.prefetch(c.text));
      toast(`Lồng tiếng Việt: BẬT (${cues.length} câu)`);
    } catch (e) {
      if (e === cancelled || token !== st.loadToken) return;
      toast(e.message, 6000);
      stop(true);
    } finally {
      if (token === st.loadToken) { st.loading = false; updateButton(); }
    }
  }

  function stop(silent) {
    const was = st.active;
    st.active = false;
    stopSpeech();
    restoreVolume();
    updateButton();
    if (was && !silent) toast('Lồng tiếng Việt: TẮT');
  }

  function toggle() {
    if (st.active) stop(); else start();
  }

  // ---------- Giao diện trên trình phát ----------
  function ensureButton() {
    const ctr = document.querySelector('#movie_player .ytp-right-controls');
    if (!ctr || ctr.querySelector('.ltv-btn')) return;
    const b = document.createElement('button');
    b.className = 'ytp-button ltv-btn';
    b.title = 'Lồng tiếng Việt (Alt+V)';
    const pill = document.createElement('span');
    pill.className = 'ltv-pill';
    pill.textContent = 'VI';
    b.appendChild(pill);
    b.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    ctr.prepend(b);
    updateButton();
  }

  function updateButton() {
    const b = document.querySelector('.ltv-btn');
    if (!b) return;
    b.classList.toggle('on', st.active && !st.loading);
    b.classList.toggle('loading', st.active && st.loading);
  }

  function playerEl() { return document.getElementById('movie_player'); }

  let toastTimer = 0;
  function toast(msg, ms = 2500) {
    const p = playerEl();
    if (!p) return;
    let el = p.querySelector('.ltv-toast');
    if (!el) { el = document.createElement('div'); el.className = 'ltv-toast'; p.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  const status = (msg) => toast(msg, 0);

  function setSub(text) {
    const p = playerEl();
    if (!p) return;
    let el = p.querySelector('.ltv-sub');
    if (!el) { el = document.createElement('div'); el.className = 'ltv-sub'; p.appendChild(el); }
    el.textContent = S.showSubs ? text : '';
    el.classList.toggle('show', !!(S.showSubs && text));
  }

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.code !== 'KeyV' || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    toggle();
  }, true);

  chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (m.type === 'toggle') toggle();
    if (m.type === 'toggle' || m.type === 'status') {
      send({ videoId: st.videoId, active: st.active, loading: st.loading, count: st.cues.length, voice: currentVoiceName() });
    }
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'sync') return;
    for (const k in ch) S[k] = ch[k].newValue;
    if (ch.voice) AudioTTS.clear();
    if (!S.showSubs) setSub('');
  });

  chrome.storage.sync.get(DEFAULTS, (v) => {
    S = { ...DEFAULTS, ...v };
    setInterval(tick, 100);
  });
})();
