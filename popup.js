const DEFAULTS = {
  autoStart: true,
  skipVietnamese: true,
  voice: '',
  pitch: 0,
  rate: 1.1,
  duckSpeaking: 0.15,
  duckGap: 0.4,
  dubVolume: 1,
  showSubs: false,
  smartFilter: true,
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

const save = (k, v) => {
  settings[k] = v;
  chrome.storage.sync.set({ [k]: v });
};

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

  add('', 'Microsoft Hoài My (Tự nhiên - Nữ)');
  add('ms-namminh', 'Microsoft Nam Minh (Tự nhiên - Nam)');

  const vs = viVoices();
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
  $('skipVietnamese').checked = settings.skipVietnamese;
  $('smartFilter').checked = settings.smartFilter;
  $('showSubs').checked = settings.showSubs;
  $('pitch').value = String(settings.pitch ?? 0);

  for (const k of Object.keys(fmt)) {
    if ($(k) && $(k + 'Val')) {
      $(k).value = settings[k];
      $(k + 'Val').textContent = fmt[k](settings[k]);
    }
  }
  fillVoices();
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  settings = { ...DEFAULTS, ...s };
  render();
});
speechSynthesis.addEventListener('voiceschanged', fillVoices);

['autoStart', 'skipVietnamese', 'smartFilter', 'showSubs'].forEach((k) => {
  if ($(k)) $(k).addEventListener('change', (e) => save(k, e.target.checked));
});

Object.keys(fmt).forEach((k) => {
  if ($(k)) {
    $(k).addEventListener('input', (e) => {
      const v = Number(e.target.value);
      $(k + 'Val').textContent = fmt[k](v);
      save(k, v);
    });
  }
});

$('voice').addEventListener('change', (e) => save('voice', e.target.value));
$('pitch').addEventListener('change', (e) => save('pitch', Number(e.target.value)));

let testAudio = null;
$('test').addEventListener('click', () => {
  const text = 'Xin chào, đây là giọng lồng tiếng Việt chuẩn cho video YouTube của bạn.';
  const btn = $('test');
  btn.textContent = '⏳ Đang tải...';

  if (testAudio) {
    testAudio.pause();
    testAudio = null;
  }

  chrome.runtime.sendMessage({
    type: 'tts',
    text,
    voice: settings.voice,
    rate: settings.rate,
    pitch: settings.pitch
  }, (r) => {
    btn.textContent = '▶ Nghe thử giọng';
    if (!r || !r.ok) {
      alert('Không phát được âm thanh: ' + ((r && r.error) || 'Lỗi kết nối'));
      return;
    }
    const a = new Audio('data:audio/mpeg;base64,' + r.result);
    a.playbackRate = 1.0;
    a.volume = settings.dubVolume;
    testAudio = a;
    a.play().catch(() => {});
  });
});

function findActiveTab(callback) {
  // 1. Thử query với lastFocusedWindow: true (tương thích cả Chrome và Edge)
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (tabs && tabs.length && tabs[0].id) {
      return callback(tabs[0]);
    }
    // 2. Thử query với currentWindow: true (fallback)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs2) => {
      if (tabs2 && tabs2.length && tabs2[0].id) {
        return callback(tabs2[0]);
      }
      // 3. Fallback: tìm tab active bất kỳ đang mở YouTube
      chrome.tabs.query({ active: true }, (tabs3) => {
        const yt = (tabs3 || []).find((t) => t.url && t.url.includes('youtube.com'));
        callback(yt || (tabs3 && tabs3[0]) || null);
      });
    });
  });
}

let activeTabId = null;

function query(type) {
  findActiveTab((tab) => {
    if (!tab || !tab.id) {
      showStatus(null);
      return;
    }
    activeTabId = tab.id;
    chrome.tabs.sendMessage(activeTabId, { type }, (r) => {
      if (chrome.runtime.lastError) {
        showStatus(null);
        return;
      }
      showStatus(r);
    });
  });
}

function showStatus(r) {
  const btn = $('toggle');
  if (!r) {
    btn.disabled = false;
    btn.className = 'off';
    btn.textContent = 'Bật lồng tiếng video này';
    $('status').textContent = 'Chưa kết nối tới video (F5 lại trang YouTube nếu vừa cài lại extension).';
    return;
  }
  if (!r.videoId) {
    btn.disabled = false;
    btn.className = 'off';
    btn.textContent = 'Bật lồng tiếng video này';
    $('status').textContent = 'Mở một video YouTube để dùng.';
    return;
  }

  btn.disabled = false;
  btn.className = r.active ? '' : 'off';

  if (r.active) {
    btn.textContent = 'Tắt lồng tiếng';
    $('status').textContent = r.loading
      ? 'Đang lấy phụ đề và dịch…'
      : `Đang lồng tiếng ${r.count} câu · ${r.voice}`;
  } else {
    btn.textContent = r.isVietnamese ? 'Bật lồng tiếng thủ công' : 'Bật lồng tiếng video này';
    $('status').textContent = r.isVietnamese
      ? 'Video gốc là tiếng Việt (Tự động bỏ qua).'
      : 'Đang tắt.';
  }
}

query('status');
setInterval(() => query('status'), 1000);
$('toggle').addEventListener('click', () => query('toggle'));

const aiSay = (t) => { if ($('aiStatus')) $('aiStatus').textContent = t || ''; };

function sendToTab(msg, cb) {
  findActiveTab((tab) => {
    if (!tab || !tab.id) { aiSay('Mở một video YouTube để dùng.'); return; }
    chrome.tabs.sendMessage(tab.id, msg, (r) => {
      if (chrome.runtime.lastError) { aiSay('Chưa kết nối tới video (F5 lại trang).'); return; }
      cb && cb(r);
    });
  });
}

if ($('getPrompt')) $('getPrompt').addEventListener('click', () => {
  aiSay('Đang lấy sub gốc…');
  sendToTab({ type: 'getPrompt' }, (r) => {
    if (!r || !r.orig) { aiSay('Video chưa có phụ đề để lấy (bật lồng tiếng 1 lần trước).'); return; }
    const full = r.prompt + '\n\n--- KỊCH BẢN GỐC (' + r.count + ' dòng) ---\n' + r.orig;
    navigator.clipboard.writeText(full).then(() => {
      aiSay('Đã copy prompt + ' + r.count + ' dòng sub gốc. Dán vào Gemini/AI rồi dán kết quả vào ô dưới.');
    }).catch(() => aiSay('Không copy được, thử lại.'));
  });
});

if ($('useAi')) $('useAi').addEventListener('click', () => {
  const raw = $('aiScript') ? $('aiScript').value : '';
  if (!raw.trim()) { aiSay('Ô dán đang trống — hãy dán bản dịch AI vào.'); return; }
  aiSay('Đang ép vào đúng nhịp video…');
  sendToTab({ type: 'setCustom', raw }, (r) => {
    if (r && r.ok) {
      aiSay('Đang lồng bằng bản AI (' + r.count + ' dòng).');
      if ($('aiBadge')) $('aiBadge').style.display = '';
      query('status');
    } else aiSay('Lỗi: ' + ((r && r.error) || 'không rõ'));
  });
});

if ($('clearAi')) $('clearAi').addEventListener('click', () => {
  sendToTab({ type: 'clearCustom' }, (r) => {
    if (r && r.ok) {
      if ($('aiScript')) $('aiScript').value = '';
      if ($('aiBadge')) $('aiBadge').style.display = 'none';
      aiSay('Đã xóa bản AI. Bật lại để dùng bản dịch tự động.');
      query('status');
    } else aiSay('Lỗi: ' + ((r && r.error) || 'không rõ'));
  });
});
