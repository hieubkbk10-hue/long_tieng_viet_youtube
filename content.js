(() => {
  'use strict';
  if (window.__ltvContent) return;
  window.__ltvContent = true;

  const DEFAULTS = {
    autoStart: true,
    skipVietnamese: true, // Tự nhận diện và bỏ qua video tiếng Việt
    voice: '',          // '' = tự chọn giọng hay nhất (Hoài My), 'ms-namminh', 'google'
    pitch: 0,           // Cao độ: -8 (Trầm ấm), 0 (Chuẩn), +5 (Thanh thoát)
    rate: 1.1,
    duckSpeaking: 0.15, // âm gốc khi đang đọc
    duckGap: 0.4,       // âm gốc lúc nghỉ giữa các câu
    dubVolume: 1,
    showSubs: false,
    smartFilter: true,  // Bỏ qua nhạc và tiếng động không lời
  };
  const CACHE_PREFIX = 'ltv1:';
  const CUSTOM_PREFIX = 'ltvai:';
  const PROMPT_DICH_HAY = `Bạn là biên dịch phim chuyên nghiệp (Việt Nam). Dịch kịch bản video sau sang TIẾNG VIỆT thật hay, tự nhiên như người Việt nói, đúng ngữ cảnh và thuật ngữ chuyên ngành.

QUY TẮC BẮT BUỘC:
1. Giữ NGUYÊN số dòng và thứ tự dòng — mỗi dòng gốc = đúng 1 dòng dịch. Không gộp, không tách, không thêm, không bớt dòng.
2. Mỗi dòng dịch phải NGẮN GỌN, độ dài tương đương câu gốc để khi đọc lên khớp nhịp video (không dư/thiếu từ gây lệch tiếng).
3. Từ chuyên ngành, tên riêng, thuật ngữ công nghệ: giữ nguyên tiếng Anh nếu người Việt hay dùng (ví dụ: AI, workflow, API, software), chỉ Việt hóa khi có từ tiếng Việt phổ biến hơn. Không dịch word-by-word gây ngô nghê.
4. Văn nói tự nhiên, cảm xúc, hợp ngữ cảnh (hài thì hài, nghiêm túc thì nghiêm túc). Bỏ từ đệm thừa.
5. Chỉ trả về ĐÚNG các dòng dịch, mỗi dòng một câu, không đánh số, không timestamp, không giải thích.`;

  // Tách bản dán từ AI thành mảng câu, chấp nhận:文本 thuần mỗi dòng 1 câu,
  // SRT, VTT (bỏ timestamp/đánh số, chỉ lấy chữ theo thứ tự).
  function parseCustomScript(raw) {
    const text = String(raw || '').replace(/\r/g, '').trim();
    if (!text) return [];
    const blocks = text.split(/\n\s*\n/);
    const looksTimed = blocks.slice(0, 3).some((b) =>
      /^\s*(?:WEBVTT|\d+\s*\n)?\s*\d{2}:\d{2}(?::\d{2})?[\s.,]*-->/.test(b));
    if (looksTimed) {
      const out = [];
      for (const b of blocks) {
        const lines = b.split('\n').map((s) => s.trim()).filter(Boolean);
        const body = lines.filter((l) =>
          !/^\d+$/.test(l) &&
          !/^\d{2}:\d{2}(?::\d{2})?[\s.,]*-->/.test(l) &&
          !/^WEBVTT/i.test(l) &&
          !/^(NOTE|STYLE|REGION)/i.test(l));
        const joined = body.join(' ').trim();
        if (joined) out.push(joined);
      }
      if (out.length) return out;
    }
    return text.split('\n').map((l) => String(l || '')
      .replace(/^[\s>#"'\-–*•]+/, '')
      .replace(/^\d{1,4}\s*[.)\]:|\-–]+\s*/, '')
      .replace(/^\[\s*\d{1,2}:\d{2}(?::\d{2})?\s*\]\s*/, '')
      .replace(/^\(\s*\d{1,2}:\d{2}(?::\d{2})?\s*\)\s*/, '')
      .trim()).filter((l) => l.length > 0);
  }

  // Ép chữ của AI vào đúng khung giờ gốc: phân phối theo THỜI LƯỢNG từng câu
  // (câu dài được chia nhiều chữ hơn, câu ngắn ít chữ) nên nhịp đọc khớp video.
  // Nếu số dòng dán ≈ số câu gốc (±15%): map 1-1 giữ nguyên nhịp tác giả.
  // Lệch nhiều: gom nguyên dòng theo trọng số thời lượng; quá lệch thì reflow
  // theo từ với ngân sách ký tự = thời lượng × tốc độ đọc để không bị nói nhanh.
  function applyCustomToBase(base, lines) {
    const N = base.length, M = lines.length;
    if (!N || !M) return base;
    if (N === M) return base.map((c, i) => ({ ...c, text: lines[i] }));
    if (M >= N * 0.85 && M <= N * 1.15) {
      // Gần bằng nhau: nội suy thứ tự, ưu tiên giữ câu tròn
      return base.map((c, i) => {
        const j = Math.round((i * (M - 1)) / Math.max(1, N - 1));
        return { ...c, text: lines[clamp(j, 0, M - 1)] };
      });
    }
    const durs = base.map((c) => Math.max(0.6, c.end - c.start));
    const totalDur = durs.reduce((a, b) => a + b, 0) || N;
    const totalChars = lines.join(' ').length || 1;
    const CPS_TARGET = 15; // ký tự/giây tiếng Việt ở tốc độ chuẩn
    const CPS_MAX = 30;    // trần khi đọc nhanh ×2
    if (M > N) {
      // Nhiều dòng dán hơn câu gốc: gom nguyên dòng theo tỉ trọng thời lượng
      const out = [];
      let li = 0;
      const charsPerSec = totalChars / totalDur;
      for (let i = 0; i < N; i++) {
        const want = Math.max(1, Math.round((durs[i] / totalDur) * M));
        let take = 0, chars = 0;
        const budget = durs[i] * CPS_MAX;
        while (li + take < M && take < want) { chars += lines[li + take].length + 1; take++; }
        while (li + take < M && chars < durs[i] * Math.min(CPS_MAX, charsPerSec * 1.4) && chars + lines[li + take].length < budget * 1.2) {
          chars += lines[li + take].length + 1; take++;
        }
        if (i === N - 1) take = M - li; // câu cuối gom hết phần dư
        const t = lines.slice(li, li + Math.max(1, take)).join(' ').trim();
        li += Math.max(1, take);
        out.push({ ...base[i], text: t || lines[Math.min(M - 1, li - 1)] });
        if (li >= M) {
          for (let j = i + 1; j < N; j++) out.push({ ...base[j], text: '' });
          break;
        }
      }
      return out.filter((c) => c.text);
    }
    // Ít dòng dán hơn câu gốc: reflow theo từ, mỗi câu nhận đúng ngân sách nói được
    const words = lines.join(' ').split(/\s+/).filter(Boolean);
    let wi = 0;
    return base.map((c, i) => {
      const budget = Math.max(8, Math.floor(durs[i] * CPS_TARGET * 1.35));
      let t = '';
      while (wi < words.length) {
        const w = words[wi];
        if ((t + ' ' + w).trim().length > budget && t) break;
        t = (t + ' ' + w).trim();
        wi++;
        if (/[.!?…:;]$/.test(w)) break; // ngắt ở dấu câu cho tròn nhịp
      }
      if (!t && wi < words.length) { t = words[wi++]; } // từ đơn quá dài vẫn lấy
      if (i === N - 1 && wi < words.length) t = (t + ' ' + words.slice(wi).join(' ')).trim();
      return { ...c, text: t };
    }).filter((c) => c.text);
  }

  async function customGet(id) {
    try {
      const r = await chrome.storage.local.get(CUSTOM_PREFIX + id);
      const v = r[CUSTOM_PREFIX + id];
      return (v && v.raw) || '';
    } catch { return ''; }
  }
  const VI = /^vi([-_]|$)/i;
  const NOISE_PATTERN = /^(?:\[.*?\]|\(.*?\)|[♪♫\s\-_.,!?]+)$/i;
  const MUSIC_WORDS = /^(?:music|applause|laughter|cheering|gasp|sigh|chuckle|tiếng nhạc|âm nhạc|vỗ tay|tiếng cười|nhạc)$/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const cancelled = new Error('cancelled');

  let S = { ...DEFAULTS };
  const st = {
    videoId: null, active: false, loading: false, loadToken: 0,
    isVietnamese: false,
    cues: [], nextIdx: 0,
    speaking: false, speakToken: 0, speakDeadline: 0,
    video: null, base: null, factor: 1, lastSetVol: -1,
    cps: { web: 15, google: 14 },
  };

  // ---------- Giao tiếp với trang (MAIN world) ----------
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
      setTimeout(() => { window.removeEventListener('message', h); resolve(null); }, 1500);
    });
  }

  // Đảm bảo inject.js chạy trong Main world ở cả Chrome và Edge
  function ensureInjected() {
    if (document.getElementById('ltv-injected-script')) return;
    try {
      const s = document.createElement('script');
      s.id = 'ltv-injected-script';
      s.src = chrome.runtime.getURL('inject.js');
      (document.head || document.documentElement).appendChild(s);
    } catch {}
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

  // ---------- Tự động nhận diện video tiếng Việt (4 lớp) ----------
  async function checkIsVietnamese(videoId, cachedInfo) {
    try {
      let info = cachedInfo;
      if (!info) {
        for (let i = 0; i < 4; i++) {
          const r = await pageCall('getTracks');
          if (r && (!videoId || r.videoId === videoId || !r.videoId)) {
            info = r;
            break;
          }
          await sleep(150);
        }
      }

      if (!info) {
        const title = document.title || '';
        const viChars = (title.match(/[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/gi) || []).length;
        return viChars >= 3;
      }

      // Lớp 1: Ngôn ngữ âm thanh gốc (defaultAudioLanguage)
      if (info.defaultAudioLanguage && /^vi/i.test(info.defaultAudioLanguage)) {
        return true;
      }

      // Lớp 2: Có phụ đề nhận diện giọng nói tự động (ASR) bằng tiếng Việt
      const tracks = info.tracks || [];
      if (tracks.some((t) => t.kind === 'asr' && /^vi/i.test(t.languageCode))) {
        return true;
      }

      // Lớp 3: Chỉ có phụ đề tiếng Việt (toàn bộ tracks đều là tiếng Việt)
      if (tracks.length > 0 && tracks.every((t) => /^vi/i.test(t.languageCode))) {
        return true;
      }

      // Lớp 4: Tiêu đề video có nhiều dấu tiếng Việt đặc trưng
      const title = info.title || document.title || '';
      const viChars = (title.match(/[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/gi) || []).length;
      if (viChars >= 3) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
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

  async function captureUrl(videoId) {
    const get = () => pageCall('getCaptured', { videoId });
    let url = await get();
    if (url && url.includes('pot=')) return url;
    const btn = document.querySelector('#movie_player .ytp-subtitles-button') ||
      document.querySelector('.ytp-subtitles-button');
    if (!btn) return url;
    const wasOn = btn.getAttribute('aria-pressed') === 'true';
    btn.click();
    if (wasOn) { await sleep(300); btn.click(); }
    for (let i = 0; i < 20; i++) {
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
      const rawText = ev.segs.map((s) => s.utf8 || '').join('').trim();
      if (!rawText) continue;

      const cleanSound = rawText.replace(/[\[\]\(\)♪♫]/g, '').trim();
      const isNoise = !cleanSound || MUSIC_WORDS.test(cleanSound) || NOISE_PATTERN.test(rawText);
      if (isNoise && S.smartFilter) {
        continue;
      }

      const text = rawText
        .replace(/\n/g, ' ')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\([^\)]*\)/g, '')
        .replace(/[♪♫]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || text.length < 2) continue;

      const start = (ev.tStartMs || 0) / 1000;
      out.push({ start, end: start + (ev.dDurationMs || 2000) / 1000, text });
    }
    out.sort((a, b) => a.start - b.start);
    for (let i = 0; i < out.length - 1; i++) if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start;
    return out.filter((c, i) => i === 0 || c.text !== out[i - 1].text);
  }

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
    const customRaw = await customGet(videoId);
    const customLines = parseCustomScript(customRaw);
    const customHash = customLines.length ? String(customLines.join('\n').length) + ':' + customLines.length : '';
    const cached = await cacheGet(videoId);
    if (cached && !customLines.length && !cached.custom) return cached.cues || cached;
    if (cached && cached.custom && customLines.length && cached.hash === customHash) {
      st.customActive = true;
      return cached.cues;
    }
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
        const vi = await fetchEvents(url, 'vi');
        if (!vi) throw new Error('Không dịch được phụ đề: ' + e.message);
        cues = mergeCues(parseEvents(vi), isAsr);
      }
    }
    if (!cues.length) throw new Error('Phụ đề trống.');
    if (customLines.length) {
      const mapped = applyCustomToBase(cues, customLines);
      if (!mapped.length) throw new Error('Kịch bản dán vào trống.');
      st.customActive = true;
      try {
        await chrome.storage.local.set({ [CACHE_PREFIX + videoId]: { t: Date.now(), cues: mapped, custom: true, hash: customHash } });
      } catch {}
      const basePlain = cues.map((c) => c.text).join('\n');
      try {
        await chrome.storage.local.set({ ['ltvorig:' + videoId]: { t: Date.now(), text: basePlain } });
      } catch {}
      return mapped;
    }
    st.customActive = false;
    cacheSet(videoId, cues);
    return cues;
  }

  async function cacheGet(id) {
    try {
      const k = CACHE_PREFIX + id;
      const r = await chrome.storage.local.get(k);
      return r[k] || null;
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
    if (!S.voice || S.voice === 'ms-hoaimy' || S.voice === 'ms-namminh' || S.voice === 'google') {
      return null;
    }
    return voices.find((x) => x.name === S.voice) || null;
  }

  function currentVoiceName() {
    const v = pickVoice();
    if (v) return v.name.replace(/^Microsoft\s+/, '').replace(/\s+-.*$/, '');
    if (S.voice === 'ms-namminh') return 'Nam Minh (Tự nhiên)';
    if (S.voice === 'google') return 'Google Dịch (dự phòng)';
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
      this.cur = u;
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
    chunks(text, rate = 1, pitch = 0) {
      const roundedRate = Math.round(rate * 10) / 10;
      const key = `${text}::${S.voice}::${roundedRate}::${pitch}`;
      if (!this.cache.has(key)) {
        const p = Promise.all(splitText(text, 250).map((c) => bg({
          type: 'tts',
          text: c,
          voice: S.voice,
          rate: roundedRate,
          pitch
        }).then(b64ToUrl)));
        p.catch(() => this.cache.delete(key));
        this.cache.set(key, p);
      }
      return this.cache.get(key);
    },
    prefetch(text, rate = 1, pitch = 0) { this.chunks(text, rate, pitch).catch(() => {}); },
    async speak(text, rate, volume, onStart, onEnd) {
      const id = ++this.playId;
      try {
        const urls = await this.chunks(text, rate, S.pitch || 0);
        for (let i = 0; i < urls.length && id === this.playId; i++) {
          await new Promise((res) => {
            const a = new Audio(urls[i]);
            a.preservesPitch = true;
            a.playbackRate = 1.0;
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
    const playbackRate = v.playbackRate || 1;
    const avail = Math.max(0.7, (until - Math.max(t, cue.start)) / playbackRate);
    const voice = pickVoice();
    const kind = voice ? 'web' : 'google';

    const need = cue.text.length / st.cps[kind] / avail;
    const rate = clamp(Math.max(S.rate * playbackRate, need), 0.5, 2.0);
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
      AudioTTS.speak(cue.text, rate, S.dubVolume, onStart, onEnd);
      for (let k = 1; k <= 2; k++) {
        if (st.cues[idx + k]) AudioTTS.prefetch(st.cues[idx + k].text, rate, S.pitch || 0);
      }
    }
  }

  function stopSpeech() {
    st.speakToken++;
    st.speaking = false;
    WebSpeech.stop();
    AudioTTS.stop();
    setSub('');
  }

  // ---------- Âm lượng gốc (Smooth Audio Ducking) ----------
  function applyVol() {
    const v = st.video;
    if (!v || st.base == null) return;
    const want = clamp(st.base * st.factor, 0, 1);
    if (Math.abs(v.volume - want) > 0.003) {
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
      if (Math.abs(v.volume - st.lastSetVol) < 0.003) return;
      st.base = v.volume;
      st.lastSetVol = -1;
      applyVol();
    });
  }

  const currentVideoId = () => {
    if (location.pathname === '/watch') {
      return new URLSearchParams(location.search).get('v');
    }
    const m = location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  };

  const getVideo = () => {
    return document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('ytd-shorts video.html5-main-video') ||
      document.querySelector('#shorts-player video') ||
      document.querySelector('video.html5-main-video') ||
      document.querySelector('video');
  };

  function tick() {
    ensureInjected();
    ensureButton();
    const vid = currentVideoId();
    if (vid !== st.videoId) {
      onVideoChange(vid);
    }
    if (!st.active) return;
    const v = getVideo();
    if (!v) return;
    if (v !== st.video) { restoreVolume(); attachVideo(v); st.base = v.volume; }
    if (st.base == null) st.base = v.volume;
    if (!st.cues.length) return;

    const ad = !!document.querySelector('#movie_player.ad-showing');
    if (ad && st.speaking) stopSpeech();

    const target = ad ? 1 : st.speaking ? S.duckSpeaking : S.duckGap;
    const step = target < st.factor ? 0.08 : 0.03;
    st.factor += clamp(target - st.factor, -step, step);
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
    if (t > c.end + 1) { st.nextIdx = Math.max(i + 1, findIdx(t)); return; }
    st.nextIdx = i + 1;
    speakCue(i);
  }

  // ---------- Bật / tắt ----------
  async function onVideoChange(vid) {
    stop(true);
    st.videoId = vid;
    st.isVietnamese = false;
    st.customActive = false;
    st.cues = [];
    st.nextIdx = 0;
    st.loadToken++;
    AudioTTS.clear();
    updateButton();
    if (!vid) return;

    if (S.skipVietnamese) {
      const isVi = await checkIsVietnamese(vid);
      if (isVi) {
        st.isVietnamese = true;
        updateButton();
        toast('Video gốc là tiếng Việt — Đã tự động tắt lồng tiếng.', 3500);
        return;
      }
    }

    if (S.autoStart) start();
  }

  async function start() {
    const vid = st.videoId || currentVideoId();
    if (!vid) { toast('Hãy mở một video YouTube trước.'); return; }
    st.videoId = vid;
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
      if (!pickVoice()) cues.slice(st.nextIdx, st.nextIdx + 2).forEach((c) => AudioTTS.prefetch(c.text, S.rate, S.pitch || 0));
      toast(`Lồng tiếng Việt: BẬT (${cues.length} câu${st.customActive ? ' — bản AI' : ''})`);
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

  // ---------- Giao diện trên trình phát & Quick Control Popup ----------
  let quickPopupEl = null;

  function ensureQuickPopup() {
    if (quickPopupEl) return quickPopupEl;
    const qp = document.createElement('div');
    qp.className = 'ltv-quick-popup';
    qp.innerHTML = `
      <div class="ltv-qp-header">
        <span class="ltv-qp-title"><span class="ltv-flag">★</span> Cài đặt lồng tiếng</span>
        <button type="button" class="ltv-qp-close" title="Đóng">&times;</button>
      </div>
      <div class="ltv-qp-body">
        <div class="ltv-qp-row">
          <label>Âm lượng lồng tiếng</label>
          <span class="ltv-qp-val" id="ltv-qp-vol-val">${Math.round(S.dubVolume * 100)}%</span>
        </div>
        <input type="range" id="ltv-qp-vol" min="0.2" max="1" step="0.05" value="${S.dubVolume}">

        <div class="ltv-qp-row">
          <label>Giọng đọc</label>
        </div>
        <select id="ltv-qp-voice">
          <option value="" ${!S.voice ? 'selected' : ''}>Hoài My (Tự nhiên - Nữ)</option>
          <option value="ms-namminh" ${S.voice === 'ms-namminh' ? 'selected' : ''}>Nam Minh (Tự nhiên - Nam)</option>
          <option value="google" ${S.voice === 'google' ? 'selected' : ''}>Google Dịch (Dự phòng)</option>
        </select>

        <div class="ltv-qp-row">
          <label>Tone giọng (Pitch)</label>
        </div>
        <select id="ltv-qp-pitch">
          <option value="-8" ${S.pitch === -8 ? 'selected' : ''}>Trầm ấm (-8Hz)</option>
          <option value="0" ${!S.pitch ? 'selected' : ''}>Chuẩn (0Hz)</option>
          <option value="5" ${S.pitch === 5 ? 'selected' : ''}>Thanh thoát (+5Hz)</option>
        </select>

        <hr class="ltv-qp-divider">
        <label class="ltv-qp-check">
          <input type="checkbox" id="ltv-qp-skipvi" ${S.skipVietnamese ? 'checked' : ''}> Tự bỏ qua video tiếng Việt
        </label>
        <label class="ltv-qp-check">
          <input type="checkbox" id="ltv-qp-filter" ${S.smartFilter ? 'checked' : ''}> Lọc nhạc và tiếng động không lời
        </label>
        <label class="ltv-qp-check">
          <input type="checkbox" id="ltv-qp-subs" ${S.showSubs ? 'checked' : ''}> Hiện phụ đề tiếng Việt
        </label>

        <hr class="ltv-qp-divider">
        <div class="ltv-qp-row">
          <label>Kịch bản AI riêng <span id="ltv-qp-ai-badge" class="ltv-qp-badge" style="display:none">AI</span></label>
        </div>
        <div class="ltv-qp-hint">Bấm <b>Lấy prompt + sub gốc</b> → dán vào Gemini/ChatGPT → dán kết quả xuống dưới → <b>Dùng bản AI</b>.</div>
        <div class="ltv-qp-btnrow">
          <button type="button" id="ltv-qp-prompt">Lấy prompt + sub gốc</button>
          <button type="button" id="ltv-qp-clear">Xóa bản AI</button>
        </div>
        <textarea id="ltv-qp-script" rows="5" placeholder="Dán bản dịch AI vào đây (mỗi dòng 1 câu, hoặc SRT/VTT đều được)…"></textarea>
        <button type="button" id="ltv-qp-apply" class="ltv-qp-primary">Dùng bản AI này lồng tiếng</button>
        <div class="ltv-qp-status" id="ltv-qp-ai-status"></div>
      </div>
    `;

    document.body.appendChild(qp);
    quickPopupEl = qp;

    qp.querySelector('.ltv-qp-close').addEventListener('click', (e) => {
      e.stopPropagation();
      qp.classList.remove('show');
    });

    const vol = qp.querySelector('#ltv-qp-vol');
    vol.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      qp.querySelector('#ltv-qp-vol-val').textContent = Math.round(v * 100) + '%';
      S.dubVolume = v;
      chrome.storage.sync.set({ dubVolume: v });
    });

    const voice = qp.querySelector('#ltv-qp-voice');
    voice.addEventListener('change', (e) => {
      S.voice = e.target.value;
      chrome.storage.sync.set({ voice: e.target.value });
      AudioTTS.clear();
      updateButton();
    });

    const pitch = qp.querySelector('#ltv-qp-pitch');
    pitch.addEventListener('change', (e) => {
      const pt = Number(e.target.value);
      S.pitch = pt;
      chrome.storage.sync.set({ pitch: pt });
      AudioTTS.clear();
    });

    const skipVi = qp.querySelector('#ltv-qp-skipvi');
    skipVi.addEventListener('change', (e) => {
      S.skipVietnamese = e.target.checked;
      chrome.storage.sync.set({ skipVietnamese: e.target.checked });
    });

    const filter = qp.querySelector('#ltv-qp-filter');
    filter.addEventListener('change', (e) => {
      S.smartFilter = e.target.checked;
      chrome.storage.sync.set({ smartFilter: e.target.checked });
    });

    const subs = qp.querySelector('#ltv-qp-subs');
    subs.addEventListener('change', (e) => {
      S.showSubs = e.target.checked;
      chrome.storage.sync.set({ showSubs: e.target.checked });
      if (!S.showSubs) setSub('');
    });

    const aiBox = qp.querySelector('#ltv-qp-script');
    const aiStatus = qp.querySelector('#ltv-qp-ai-status');
    const aiBadge = qp.querySelector('#ltv-qp-ai-badge');
    const aiSay = (t) => { if (aiStatus) aiStatus.textContent = t || ''; };
    const refreshBadge = () => {
      customGet(st.videoId || currentVideoId() || '').then((raw) => {
        if (aiBadge) aiBadge.style.display = raw ? '' : 'none';
      }).catch(() => {});
    };

    qp.querySelector('#ltv-qp-prompt').addEventListener('click', async (e) => {
      e.stopPropagation();
      aiSay('Đang lấy sub gốc…');
      try {
        const vid = st.videoId || currentVideoId();
        if (!vid) { aiSay('Hãy mở một video trước.'); return; }
        let orig = '';
        try {
          const o = await chrome.storage.local.get('ltvorig:' + vid);
          orig = (o['ltvorig:' + vid] && o['ltvorig:' + vid].text) || '';
        } catch {}
        if (!orig) {
          if (st.cues.length && !st.customActive) orig = st.cues.map((c) => c.text).join('\n');
          else {
            status('Đang lấy sub gốc…');
            const cues = await loadCues(vid, st.loadToken);
            orig = cues.map((c) => c.text).join('\n');
            st.cues = cues; st.customActive = false;
          }
        }
        const full = PROMPT_DICH_HAY + '\n\n--- KỊCH BẢN GỐC (' + orig.split('\n').length + ' dòng) ---\n' + orig;
        await navigator.clipboard.writeText(full).catch(async () => {
          const ta = document.createElement('textarea');
          ta.value = full; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove();
        });
        aiSay('Đã copy prompt + ' + orig.split('\n').length + ' dòng sub gốc. Dán vào Gemini/AI rồi dán kết quả xuống dưới.');
        toast('Đã copy prompt + sub gốc — dán vào Gemini/AI nhé.');
      } catch (err) { aiSay('Lỗi: ' + (err.message || err)); }
    });

    qp.querySelector('#ltv-qp-clear').addEventListener('click', async (e) => {
      e.stopPropagation();
      const vid = st.videoId || currentVideoId();
      if (!vid) return;
      await chrome.storage.local.remove([CUSTOM_PREFIX + vid, CACHE_PREFIX + vid]);
      if (aiBox) aiBox.value = '';
      st.cues = []; st.customActive = false; st.loadToken++;
      AudioTTS.clear(); stop(true);
      aiSay('Đã xóa bản AI. Bật lại để dùng bản dịch tự động.');
      refreshBadge();
    });

    qp.querySelector('#ltv-qp-apply').addEventListener('click', async (e) => {
      e.stopPropagation();
      const vid = st.videoId || currentVideoId();
      const lines = parseCustomScript(aiBox ? aiBox.value : '');
      if (!vid) { aiSay('Hãy mở một video trước.'); return; }
      if (!lines.length) { aiSay('Ô dán đang trống — hãy dán bản dịch AI vào.'); return; }
      aiSay('Đã nhận ' + lines.length + ' dòng. Đang ép vào đúng nhịp video…');
      try {
        await chrome.storage.local.set({ [CUSTOM_PREFIX + vid]: { t: Date.now(), raw: aiBox.value } });
        await chrome.storage.local.remove(CACHE_PREFIX + vid);
        st.cues = []; st.loadToken++;
        AudioTTS.clear(); stop(true); refreshBadge();
        await start();
        aiSay('Đang lồng bằng bản AI (' + lines.length + ' dòng).');
      } catch (err) { aiSay('Lỗi: ' + (err.message || err)); }
    });

    qp.addEventListener('click', (e) => e.stopPropagation());
    qp.querySelector('#ltv-qp-script').addEventListener('click', (e) => e.stopPropagation());

    document.addEventListener('click', (e) => {
      if (!qp.contains(e.target) && !e.target.closest('.ltv-btn')) {
        qp.classList.remove('show');
      }
    });

    return qp;
  }

  function toggleQuickPopup(btnEl) {
    const qp = ensureQuickPopup();
    if (qp.classList.contains('show')) {
      qp.classList.remove('show');
      return;
    }
    {
      const vid = st.videoId || currentVideoId() || '';
      const box = qp.querySelector('#ltv-qp-script');
      const badge = qp.querySelector('#ltv-qp-ai-badge');
      const say = qp.querySelector('#ltv-qp-ai-status');
      if (say) say.textContent = '';
      if (box && vid) {
        customGet(vid).then((raw) => {
          if (document.activeElement !== box) box.value = raw || '';
          if (badge) badge.style.display = raw ? '' : 'none';
        }).catch(() => {});
      }
    }

    const rect = btnEl.getBoundingClientRect();
    qp.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    qp.style.right = (window.innerWidth - rect.right) + 'px';
    qp.classList.add('show');
  }

  function ensureButton() {
    const ctr = document.querySelector('#movie_player .ytp-right-controls') ||
      document.querySelector('.ytp-right-controls') ||
      document.querySelector('.ytp-chrome-controls .ytp-right-controls') ||
      document.querySelector('#player-control-container .ytp-right-controls');
    if (!ctr || ctr.querySelector('.ltv-btn')) return;

    const b = document.createElement('button');
    b.className = 'ytp-button ltv-btn';
    b.title = 'Lồng tiếng Việt (Alt+V) - Bấm biểu tượng ⚙ để cài đặt nhanh';

    const pill = document.createElement('span');
    pill.className = 'ltv-pill';
    pill.textContent = 'VI';
    b.appendChild(pill);

    const gear = document.createElement('span');
    gear.className = 'ltv-gear';
    gear.title = 'Cài đặt lồng tiếng';
    gear.innerHTML = '⚙';
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleQuickPopup(b);
    });
    b.appendChild(gear);

    b.addEventListener('click', (e) => {
      if (e.target.classList.contains('ltv-gear')) return;
      e.stopPropagation();
      toggle();
    });

    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleQuickPopup(b);
    });

    ctr.prepend(b);
    updateButton();
  }

  function updateButton() {
    const b = document.querySelector('.ltv-btn');
    if (!b) return;
    const pill = b.querySelector('.ltv-pill');

    b.classList.toggle('on', st.active && !st.loading);
    b.classList.toggle('loading', st.active && st.loading);
    b.classList.toggle('is-vi', !!st.isVietnamese && !st.active);

    if (st.isVietnamese && !st.active) {
      if (pill) pill.textContent = 'VI Gốc';
      b.title = 'Video gốc là tiếng Việt (Tự động bỏ qua — bấm để bật thủ công)';
    } else {
      if (pill) pill.textContent = 'VI';
      b.title = 'Lồng tiếng Việt (Alt+V) — Bấm ⚙ để mở cài đặt nhanh';
    }
  }

  function playerEl() {
    return document.getElementById('movie_player') ||
      document.querySelector('.html5-video-player') ||
      document.body;
  }

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

  async function clearCustomScript(vid) {
    if (!vid) return { ok: false, error: 'Hãy mở một video trước.' };
    await chrome.storage.local.remove([CUSTOM_PREFIX + vid, CACHE_PREFIX + vid]);
    st.cues = []; st.customActive = false; st.loadToken++;
    AudioTTS.clear(); stop(true);
    return { ok: true };
  }

  async function getOrigText(vid) {
    if (!vid) return { text: '', count: 0 };
    try {
      const o = await chrome.storage.local.get('ltvorig:' + vid);
      const t = (o['ltvorig:' + vid] && o['ltvorig:' + vid].text) || '';
      if (t) return { text: t, count: t.split('\n').length };
    } catch {}
    if (st.cues.length && !st.customActive) {
      return { text: st.cues.map((c) => c.text).join('\n'), count: st.cues.length };
    }
    return { text: '', count: 0 };
  }

  function getPromptFull(orig, count) {
    return PROMPT_DICH_HAY + '\n\n--- KỊCH BẢN GỐC (' + count + ' dòng) ---\n' + orig;
  }

  async function setCustomScript(vid, raw) {
    if (!vid) return { ok: false, error: 'Hãy mở một video trước.' };
    const lines = parseCustomScript(raw);
    if (!lines.length) return { ok: false, error: 'Bản dán đang trống.' };
    await chrome.storage.local.set({ [CUSTOM_PREFIX + vid]: { t: Date.now(), raw } });
    await chrome.storage.local.remove(CACHE_PREFIX + vid);
    st.cues = []; st.loadToken++;
    AudioTTS.clear(); stop(true);
    await start();
    return { ok: true, count: lines.length };
  }

  chrome.runtime.onMessage.addListener((m, _s, send) => {
    const currentVid = currentVideoId();
    if (currentVid) st.videoId = currentVid;
    if (m.type === 'toggle') toggle();
    if (m.type === 'getPrompt') {
      getOrigText(st.videoId || currentVideoId()).then((r) => send({ prompt: PROMPT_DICH_HAY, orig: r.text, count: r.count, hasCustom: !!st.customActive }));
      return true;
    }
    if (m.type === 'setCustom') {
      setCustomScript(st.videoId || currentVideoId(), m.raw || '').then((r) => send(r));
      return true;
    }
    if (m.type === 'clearCustom') {
      clearCustomScript(st.videoId || currentVideoId()).then((r) => send(r));
      return true;
    }
    if (m.type === 'toggle' || m.type === 'status') {
      send({
        videoId: st.videoId || currentVid,
        active: st.active,
        loading: st.loading,
        isVietnamese: st.isVietnamese,
        count: st.cues.length,
        custom: !!st.customActive,
        voice: currentVoiceName() + (st.customActive ? ' · bản AI' : '')
      });
    }
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'sync') return;
    for (const k in ch) S[k] = ch[k].newValue;
    if (ch.voice || ch.pitch !== undefined) AudioTTS.clear();
    if (!S.showSubs) setSub('');
    updateButton();
  });

  // Khởi động tức thì, không bị chặn bởi storage sync
  ensureInjected();
  ensureButton();
  tick();
  setInterval(tick, 100);

  // Lắng nghe các sự kiện điều hướng của YouTube (SPA)
  window.addEventListener('DOMContentLoaded', () => {
    ensureInjected();
    ensureButton();
  });
  window.addEventListener('load', () => {
    ensureInjected();
    ensureButton();
  });
  window.addEventListener('yt-navigate-finish', () => {
    ensureInjected();
    ensureButton();
    const vid = currentVideoId();
    if (vid !== st.videoId) onVideoChange(vid);
  });

  // Tải cài đặt lưu trữ ngầm
  chrome.storage.sync.get(DEFAULTS, (v) => {
    if (v) S = { ...DEFAULTS, ...v };
    updateButton();
  });
})();
