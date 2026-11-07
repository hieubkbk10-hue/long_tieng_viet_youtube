// Dịch (Google Dịch, miễn phí, không cần API key) và giọng đọc tiếng Việt:
// - Giọng đọc tự nhiên Microsoft Azure Neural TTS (Hoài My & Nam Minh) dùng được trên cả Chrome & Edge
// - Giọng đọc Google TTS (dự phòng khi mất kết nối tới Microsoft)
const TL = 'vi';
const MS_KEY_B64 = 'oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==';

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  const job = msg.type === 'translate' ? translate(msg.texts)
    : msg.type === 'tts' ? tts(msg.text, msg.voice)
    : null;
  if (!job) return false;
  job.then(
    (result) => send({ ok: true, result }),
    (err) => send({ ok: false, error: String((err && err.message) || err) })
  );
  return true;
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function gtx(q) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + TL +
    '&dt=t&q=' + encodeURIComponent(q);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      return (data[0] || []).map((p) => p[0] || '').join('');
    }
    if (attempt >= 2 || (r.status !== 429 && r.status < 500)) throw new Error('Google Dịch lỗi HTTP ' + r.status);
    await wait(1000 * (attempt + 1));
  }
}

async function translate(texts) {
  const lines = (await gtx(texts.join('\n'))).split('\n').map((s) => s.trim());
  if (lines.length === texts.length) return lines;
  // Số dòng trả về lệch -> dịch từng câu
  const out = [];
  for (const t of texts) out.push((await gtx(t)).trim());
  return out;
}

// ---------- Chuyển đổi Base64 và Byte ----------
function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function bytesToB64(buf) {
  const u8 = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ---------- Microsoft Neural TTS (Hoài My & Nam Minh tự nhiên) ----------
async function signMsRequest(urlStr) {
  const url = urlStr.split('://')[1];
  const encodedUrl = encodeURIComponent(url);
  const uuidStr = crypto.randomUUID().replace(/-/g, '');
  const formattedDate = new Date().toUTCString().replace(/GMT/, '').trim() + ' GMT';
  const formattedDateLower = formattedDate.toLowerCase();

  const strToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDateLower}${uuidStr}`.toLowerCase();
  const dataBytes = new TextEncoder().encode(strToSign);
  const keyBytes = b64ToBytes(MS_KEY_B64);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
  const signature = bytesToB64(sigBuffer);

  return `MSTranslatorAndroidApp::${signature}::${formattedDateLower}::${uuidStr}`;
}

let cachedEndpoint = null;
let endpointExpiry = 0;

async function getMsEndpoint() {
  const now = Date.now();
  if (cachedEndpoint && now < endpointExpiry) {
    return cachedEndpoint;
  }

  const endpointUrl = 'https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0';
  const clientId = crypto.randomUUID().replace(/-/g, '');
  const signature = await signMsRequest(endpointUrl);

  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Accept-Language': 'vi-VN',
      'X-ClientVersion': '4.0.530a 5fe1dc6c',
      'X-UserId': '0f04d16a175c411e',
      'X-HomeGeographicRegion': 'vi-VN-VN',
      'X-ClientTraceId': clientId,
      'X-MT-Signature': signature,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': '0'
    }
  });

  if (!response.ok) {
    throw new Error('MS Endpoint lỗi HTTP ' + response.status);
  }

  const data = await response.json();
  cachedEndpoint = data;
  endpointExpiry = now + 10 * 60 * 1000; // Lưu token 10 phút
  return data;
}

function getSsml(text, voiceName) {
  const escapedText = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'>` +
    `<voice name='${voiceName}'>` +
    `<prosody rate='+0%' pitch='+0Hz' volume='+0%'>${escapedText}</prosody>` +
    `</voice></speak>`;
}

async function synthesizeMsTts(text, voiceName) {
  const endpoint = await getMsEndpoint();
  const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml = getSsml(text, voiceName);

  let response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': endpoint.t,
      'Content-Type': 'application/ssml+xml',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
    },
    body: ssml
  });

  if (!response.ok && response.status === 401) {
    // Token hết hạn, làm mới lại 1 lần
    cachedEndpoint = null;
    endpointExpiry = 0;
    const ep2 = await getMsEndpoint();
    response = await fetch(`https://${ep2.r}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Authorization': ep2.t,
        'Content-Type': 'application/ssml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
      },
      body: ssml
    });
  }

  if (!response.ok) {
    throw new Error('MS TTS lỗi HTTP ' + response.status);
  }

  const buf = await response.arrayBuffer();
  return bytesToB64(buf);
}

// ---------- Giọng đọc Google TTS (dự phòng) ----------
async function googleTts(text) {
  const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' + TL +
    '&q=' + encodeURIComponent(text);
  const r = await fetch(url);
  if (!r.ok) throw new Error('Google TTS lỗi HTTP ' + r.status);
  const buf = await r.arrayBuffer();
  return bytesToB64(buf);
}

// ---------- Hàm điều phối TTS ----------
async function tts(text, voice) {
  if (voice === 'google') {
    return googleTts(text);
  }

  const msVoice = voice === 'ms-namminh' ? 'vi-VN-NamMinhNeural' : 'vi-VN-HoaiMyNeural';
  try {
    return await synthesizeMsTts(text, msVoice);
  } catch (err) {
    console.warn('MS Natural TTS lỗi, chuyển sang Google TTS dự phòng:', err);
    return await googleTts(text);
  }
}
