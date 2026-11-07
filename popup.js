const DEFAULTS = {
  autoStart: true,
  voice: '',
  rate: 1.1,
  duckSpeaking: 0.15,
  duckGap: 0.4,
  dubVolume: 1,
  showSubs: false,
};
const VI = /^vi([-_]|$)/i;
const $ = (id) => document.getElementById(id);
const fmt = {
  rate: (v) => '×' + Number(v).toFixed(2),
  duckSpeaking: (v) => Math.round(v * 100) + '%',
  duckGap: (v) => Math.round(v * 100) + '%',
  dubVolume: (v) => Math.round(v * 100) + '%',
};
let settings = { ...DEFAULTS };

const save = (k, v) => { settings[k] = v; chrome.storage.sync.set({ [k]: v }); };

function viVoices() {
  return speechSynthesis.getVoices().filter((v) => VI.test(v.lang));
}

function fillVoices() {
  const sel = $('voice');
  sel.textContent = '';
  const add = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  const vs = viVoices();
  const best = vs.find((v) => /natural|online/i.test(v.name));
  add('', 'Tự động' + (best ? ' (' + best.name.replace(/^Microsoft\s+/, '').replace(/\s+-.*$/, '') + ')' : ' (Hoài My - Tự nhiên)'));
  add('ms-hoaimy', 'Microsoft Hoài My (Tự nhiên - Nữ)');
  add('ms-namminh', 'Microsoft Nam Minh (Tự nhiên - Nam)');
  vs.forEach((v) => {
    if (!/hoaimy|namminh/i.test(v.name)) {
      add(v.name, v.name);
    }
  });
  add('google', 'Google Dịch (Dự phòng)');
  sel.value = settings.voice;
  if (sel.value !== settings.voice) sel.value = '';
}

function render() {
  $('autoStart').checked = settings.autoStart;
  $('showSubs').checked = settings.showSubs;
  for (const k of Object.keys(fmt)) {
    $(k).value = settings[k];
    $(k + 'Val').textContent = fmt[k](settings[k]);
  }
  fillVoices();
}

chrome.storage.sync.get(DEFAULTS, (s) => { settings = { ...DEFAULTS, ...s }; render(); });
speechSynthesis.addEventListener('voiceschanged', fillVoices);

['autoStart', 'showSubs'].forEach((k) => $(k).addEventListener('change', (e) => save(k, e.target.checked)));
Object.keys(fmt).forEach((k) => $(k).addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $(k + 'Val').textContent = fmt[k](v);
  save(k, v);
}));
$('voice').addEventListener('change', (e) => save('voice', e.target.value));

$('test').addEventListener('click', () => {
  const text = 'Xin chào, đây là giọng lồng tiếng Việt cho video YouTube của bạn.';
  const vs = viVoices();
  const vSetting = settings.voice;

  // 1. Giọng cụ thể của trình duyệt/Windows được chọn rõ ràng
  if (vSetting && vSetting !== 'google' && vSetting !== 'ms-hoaimy' && vSetting !== 'ms-namminh') {
    const voice = vs.find((v) => v.name === vSetting);
    if (voice) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice; u.lang = voice.lang; u.rate = settings.rate; u.volume = settings.dubVolume;
      speechSynthesis.speak(u);
      return;
    }
  }

  // 2. Chế độ Tự động trên Edge có sẵn giọng WebSpeech Natural
  if (!vSetting) {
    const naturalVoice = vs.find((v) => /natural|online/i.test(v.name));
    if (naturalVoice) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = naturalVoice; u.lang = naturalVoice.lang; u.rate = settings.rate; u.volume = settings.dubVolume;
      speechSynthesis.speak(u);
      return;
    }
  }

  // 3. Giọng tự nhiên Microsoft (dùng được trên Chrome & Edge) hoặc Google
  speechSynthesis.cancel();
  chrome.runtime.sendMessage({ type: 'tts', text, voice: vSetting }, (r) => {
    if (!r || !r.ok) return;
    const a = new Audio('data:audio/mpeg;base64,' + r.result);
    a.playbackRate = settings.rate;
    a.volume = settings.dubVolume;
    a.play();
  });
});

function showStatus(r) {
  const btn = $('toggle');
  if (!r || !r.videoId) {
    btn.disabled = true;
    btn.className = 'off';
    btn.textContent = 'Bật lồng tiếng video này';
    $('status').textContent = 'Mở một video YouTube để dùng.';
    return;
  }
  btn.disabled = false;
  btn.className = r.active ? '' : 'off';
  btn.textContent = r.active ? 'Tắt lồng tiếng' : 'Bật lồng tiếng video này';
  $('status').textContent = !r.active ? 'Đang tắt.'
    : r.loading ? 'Đang lấy phụ đề và dịch…'
    : `Đang lồng tiếng ${r.count} câu · ${r.voice}`;
}

let tabId = null;
function query(type) {
  if (tabId == null) return showStatus(null);
  chrome.tabs.sendMessage(tabId, { type }, (r) => {
    if (chrome.runtime.lastError) return showStatus(null);
    showStatus(r);
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  tabId = tabs[0] ? tabs[0].id : null;
  query('status');
  setInterval(() => query('status'), 1000);
});
$('toggle').addEventListener('click', () => query('toggle'));
