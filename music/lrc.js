// LRC("[mm:ss.xx]가사") 또는 일반 텍스트 가사를 줄 배열로 바꾼다.
export function parseLyrics(text) {
  if (!text || !text.trim()) return { synced: false, lines: [] };
  const lines = [];
  const tag = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  for (const raw of text.split(/\r?\n/)) {
    const times = [...raw.matchAll(tag)].map(m => +m[1] * 60 + parseFloat(m[2].replace(':', '.')));
    const body = raw.replace(tag, '').trim();
    if (times.length) times.forEach(t => lines.push({ t, text: body }));
    else if (!/^\[[a-z]+:.*\]$/i.test(raw.trim())) lines.push({ t: null, text: raw.trim() }); // [ar:..] 같은 메타 줄은 버림
  }
  const synced = lines.some(l => l.t !== null);
  if (synced) return { synced, lines: lines.filter(l => l.t !== null).sort((a, b) => a.t - b.t) };
  return { synced, lines };
}

// 현재 시간에 해당하는 줄 번호. 첫 줄 전이면 -1.
export function activeLine(lines, time) {
  let i = -1;
  for (let k = 0; k < lines.length && lines[k].t <= time; k++) i = k;
  return i;
}

// YouTube 재생목록·믹스 ID (list=PL…, RD…). 없으면 null.
export function youtubeList(url) {
  const m = String(url).match(/[?&]list=([\w-]+)/);
  return m && /youtu/.test(url) ? m[1] : null;
}

// YouTube 주소에서 영상 ID를 뽑는다. 못 찾으면 null.
export function youtubeId(url) {
  const m = String(url).trim().match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/);
  return m ? m[1] : null;
}
