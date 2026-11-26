import * as db from './db.js';
import { parseLyrics, activeLine, youtubeId, youtubeList } from './lrc.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = s => !isFinite(s) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const PLAY = '<svg viewBox="0 0 24 24" class="fill"><path d="M7 4v16l13-8z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" class="fill"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
const MORE = '<svg viewBox="0 0 24 24" class="fill"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
const ytUrl = v => `https://www.youtube.com/watch?v=${v}`;
// 곡 하나, 믹스(list=RD…), 재생목록(list=PL…) 모두의 원래 주소
const trackUrl = t => !t.listId ? ytUrl(t.videoId) : t.videoId ? `${ytUrl(t.videoId)}&list=${t.listId}` : `https://www.youtube.com/playlist?list=${t.listId}`;

// iOS 홈 화면 아이콘·잠금 화면 기본 이미지는 PNG가 필요해서 icon.svg를 그려 만든다.
let iconPng = 'icon.svg';
{
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    c.getContext('2d').drawImage(img, 0, 0, 512, 512);
    iconPng = c.toDataURL('image/png'); $('#touchIcon').href = iconPng;
  };
  img.src = 'icon.svg';
}

let tracks = new Map(), playlists = [], covers = new Map();
let tab = 'library', filter = 'all', query = '', openPlaylist = null;

// ---------- 데이터 ----------
async function loadAll() {
  for (const t of await db.all('tracks')) tracks.set(t.id, t);
  playlists = (await db.all('playlists')).sort((a, b) => a.createdAt - b.createdAt);
  await Promise.all([...tracks.values()].map(loadCover));
}
async function loadCover(t) {
  if (t.type === 'youtube' && !t.hasCover) return t.videoId ? covers.set(t.id, `https://i.ytimg.com/vi/${t.videoId}/hqdefault.jpg`) : covers.delete(t.id);
  const b = await db.get('blobs', 'cover:' + t.id);
  if (covers.has(t.id) && covers.get(t.id).startsWith('blob:')) URL.revokeObjectURL(covers.get(t.id));
  b ? covers.set(t.id, URL.createObjectURL(b)) : covers.delete(t.id);
}
const cover = t => covers.get(t.id) || 'icon.svg';
async function saveTrack(t) { tracks.set(t.id, t); await db.put('tracks', t); }
async function savePlaylist(p) { await db.put('playlists', p); }

function readTags(file) {
  return new Promise(res => window.jsmediatags
    ? window.jsmediatags.read(file, { onSuccess: r => res(r.tags || {}), onError: () => res({}) })
    : res({}));
}

// 가사 태그: ID3 USLT, ID3 TXXX(LYRICS/UNSYNCEDLYRICS/SYNCEDLYRICS), MP4 ©lyr
function tagLyrics(tags) {
  if (tags.lyrics?.lyrics) return tags.lyrics.lyrics;
  if (typeof tags.lyrics === 'string') return tags.lyrics;
  const txxx = [].concat(tags.TXXX || []).map(f => f.data).find(d => /^((un)?(synced)?lyrics|uslt)$/i.test(d?.user_description || ''));
  return txxx?.data || '';
}

async function addFiles(files) {
  let n = 0, skipped = 0;
  for (const f of files) {
    // shortcut: 파일 이름+크기로 중복 판단, 내용 해시는 안 봄 — 오판이 생기면 SHA-256으로 바꿀 것
    if ([...tracks.values()].some(t => t.name === f.name && t.size === f.size)) { skipped++; continue; }
    toast(`가져오는 중… ${f.name}`);
    const tags = await readTags(f);
    const id = db.uid();
    const lyr = tagLyrics(tags);
    const t = {
      id, type: 'file', name: f.name, size: f.size,
      title: tags.title || f.name.replace(/\.[^.]+$/, ''), artist: tags.artist || '', album: tags.album || '',
      lyrics: lyr || '', fav: false, plays: 0, addedAt: Date.now(),
    };
    await db.put('blobs', f, 'audio:' + id);
    if (tags.picture?.data) {
      await db.put('blobs', new Blob([new Uint8Array(tags.picture.data)], { type: tags.picture.format || 'image/jpeg' }), 'cover:' + id);
    }
    await saveTrack(t); await loadCover(t); n++;
  }
  toast(`${n}곡 추가${skipped ? ` · 중복 ${skipped}곡 건너뜀` : ''}`);
  render();
}

async function fetchJson(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(r.status); return r.json();
}
const haveVideo = vid => [...tracks.values()].some(t => t.videoId === vid && !t.listId);

async function addYouTube(url, meta = {}, quiet = false) {
  const vid = youtubeId(url), list = youtubeList(url);
  if (!quiet && list) return addYouTubeList(list, vid);
  if (!vid) return quiet ? null : toast('YouTube 주소가 아니에요');
  if (haveVideo(vid)) return quiet ? null : toast('이미 추가된 곡이에요');
  for (const u of meta.title ? [] : [`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(ytUrl(vid))}`,
    `https://noembed.com/embed?url=${encodeURIComponent(ytUrl(vid))}`]) {
    try { meta = await fetchJson(u); if (meta.title) break; } catch { /* 다음 방법 시도 */ }
  }
  const t = {
    id: db.uid(), type: 'youtube', videoId: vid, title: meta.title || `YouTube ${vid}`, artist: meta.author_name || '',
    album: '', lyrics: '', fav: false, plays: 0, addedAt: Date.now(),
  };
  await saveTrack(t); await loadCover(t);
  if (!quiet) { toast(meta.title ? `추가: ${meta.title}` : '제목을 못 가져왔어요. 편집에서 입력하세요'); render(); }
  return t;
}

// 믹스·재생목록 링크: 들어 있는 곡을 하나씩 따로 추가하고, 이미 있는 곡은 건너뛴다
async function addYouTubeList(list, firstVid) {
  toast('목록 불러오는 중…');
  let ids;
  try { ids = await listVideoIds(list); } catch { return toast('목록을 불러오지 못했어요. 비공개 목록이거나 연결이 불안정해요'); }
  ids = [...new Set(firstVid ? [firstVid, ...ids] : ids)];
  const todo = ids.filter(v => !haveVideo(v));
  const meta = await titlesFromApi(todo);
  for (let i = 0; i < todo.length; i += 5) {
    await Promise.all(todo.slice(i, i + 5).map(v => addYouTube(ytUrl(v), meta[v], true)));
    toast(`추가 중… ${Math.min(i + 5, todo.length)}/${todo.length}`);
  }
  const skipped = ids.length - todo.length;
  toast(`${todo.length}곡 추가${skipped ? ` · 이미 있는 ${skipped}곡 건너뜀` : ''}`);
  render();
  return true;
}

// API 키가 있으면 제목을 한 번에(50곡당 1회) 가져온다. 없으면 곡마다 oEmbed로.
async function titlesFromApi(ids) {
  const out = {};
  if (!ytKey()) return out;
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const j = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids.slice(i, i + 50).join(',')}&key=${encodeURIComponent(ytKey())}`);
      for (const v of j.items || []) out[v.id] = { title: v.snippet.title, author_name: v.snippet.channelTitle };
    } catch { /* oEmbed로 대신 */ }
  }
  return out;
}

// ---------- YouTube 검색 ----------
// API 키는 공개 저장소에 넣지 않고 이 기기에만 저장한다.
const ytKey = () => { try { return localStorage.getItem('ytKey') || ''; } catch { return ''; } };
const decode = s => new DOMParser().parseFromString(s, 'text/html').documentElement.textContent;
let ytResults = [];

async function searchYouTube(q) {
  if (!ytKey()) { window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, '_blank'); return; }
  const box = $('#ytResults'); box.innerHTML = '<div class="empty">검색 중…</div>';
  try {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=15&q=${encodeURIComponent(q)}&key=${encodeURIComponent(ytKey())}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.errors?.[0]?.reason === 'quotaExceeded' ? '오늘 검색 한도를 다 썼어요. 내일 다시 쓸 수 있어요' : `검색 실패: ${j.error.message}`);
    ytResults = j.items.map(i => ({ vid: i.id.videoId, title: decode(i.snippet.title), artist: decode(i.snippet.channelTitle), thumb: i.snippet.thumbnails?.medium?.url }));
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message.startsWith('검색') || e.message.startsWith('오늘') ? e.message : '인터넷 연결을 확인하세요')}</div>`; return; }
  renderYtResults();
}
function renderYtResults() {
  const have = new Set([...tracks.values()].filter(t => !t.listId).map(t => t.videoId));
  $('#ytResults').innerHTML = ytResults.length ? `<ul class="list">${ytResults.map((r, i) => `<li class="item">
      <img class="art yt-thumb" src="${esc(r.thumb || 'icon.svg')}" alt="">
      <div class="grow"><div class="t">${esc(r.title)}</div><div class="s">${esc(r.artist)}</div></div>
      ${have.has(r.vid) ? '<span class="end">✓ 추가됨</span>' : `<button class="btn primary sm" data-act="ytAdd" data-i="${i}">추가</button>`}</li>`).join('')}</ul>`
    : '<div class="empty">검색 결과가 없어요</div>';
}

async function deleteTrack(id) {
  const t = tracks.get(id);
  if (!await ask(`"${t.title}"을(를) 삭제할까요?`, { ok: '삭제', danger: true })) return;
  if (player.cur() === id) { eng.pause(); audio.removeAttribute('src'); }
  player.queue = player.queue.filter(q => q !== id);
  tracks.delete(id);
  await Promise.all([db.del('tracks', id), db.del('blobs', 'audio:' + id), db.del('blobs', 'cover:' + id)]);
  for (const p of playlists) if (p.trackIds.includes(id)) { p.trackIds = p.trackIds.filter(x => x !== id); await savePlaylist(p); }
  closeSheet(); render(); renderPlayer();
}

// ---------- 화면 ----------
function visible(list) {
  const q = query.trim().toLowerCase();
  return list.filter(t => t && (filter === 'all' || (filter === 'fav' ? t.fav : t.type === filter)) &&
    (!q || [t.title, t.artist, t.album, t.lyrics].some(v => v && v.toLowerCase().includes(q))));
}

function itemHtml(t, extra = '') {
  const badge = t.type === 'file' ? '<span class="chip file">FILE</span>'
    : `<span class="chip yt">${t.listId ? (t.listId.startsWith('RD') ? 'MIX' : '목록') : 'YT'}</span>`;
  const end = t.lyrics ? '가사' : '';
  return `<li class="item ${player.cur() === t.id ? 'playing' : ''}" data-id="${t.id}">
    <img class="art" src="${esc(cover(t))}" alt="" loading="lazy">
    <div class="grow" data-act="open"><div class="t">${t.fav ? '♥ ' : ''}${esc(t.title)}</div><div class="s">${badge}${esc(t.artist)}</div></div>
    <span class="end">${end}</span>${extra}
    <button class="icon" data-act="more" aria-label="더보기">${MORE}</button></li>`;
}

function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#search').hidden = tab === 'add';
  const v = $('#view');
  if (tab === 'library') {
    $('#viewTitle').textContent = '라이브러리';
    const list = visible([...tracks.values()].sort((a, b) => b.addedAt - a.addedAt));
    v.innerHTML = `<div class="chips">${[['all', '전체'], ['file', '음원'], ['youtube', 'YouTube'], ['fav', '♥ 즐겨찾기']]
      .map(([k, l]) => `<button data-filter="${k}" class="${filter === k ? 'on' : ''}">${l}</button>`).join('')}</div>` +
      (list.length ? `<ul class="list" data-src="library">${list.map(t => itemHtml(t)).join('')}</ul>`
        : `<div class="empty">${tracks.size ? '검색 결과가 없어요' : '아직 곡이 없어요.<br>아래 <b>추가</b> 탭에서 음원 파일이나 YouTube 링크를 넣어 보세요.'}</div>`);
  } else if (tab === 'playlists' && openPlaylist) {
    const p = playlists.find(x => x.id === openPlaylist);
    if (!p) { openPlaylist = null; return render(); }
    $('#viewTitle').textContent = p.name;
    const list = visible(p.trackIds.map(id => tracks.get(id)));
    v.innerHTML = `<div class="pl-actions">
        <button class="btn" data-act="back">← 목록</button>
        <button class="btn primary" data-act="playAll">재생</button>
        <button class="btn" data-act="shuffleAll">셔플</button>
        <button class="btn" data-act="plMenu">${MORE}</button></div>` +
      (list.length ? `<ul class="list" data-src="pl">${list.map(t => itemHtml(t,
        `<span class="mv"><button data-act="up" aria-label="위로">▲</button><button data-act="down" aria-label="아래로">▼</button></span>`)).join('')}</ul>`
        : '<div class="empty">곡이 없어요. 곡의 ⋯ 메뉴에서 이 플레이리스트에 추가하세요.</div>');
  } else if (tab === 'playlists') {
    $('#viewTitle').textContent = '플레이리스트';
    v.innerHTML = `<button class="btn" data-act="newPl" style="margin:12px 0">＋ 새 플레이리스트</button>
      <ul class="list">${playlists.map(p => {
        const first = tracks.get(p.trackIds[0]);
        return `<li class="item" data-pl="${p.id}"><img class="art" src="${first ? esc(cover(first)) : 'icon.svg'}" alt="">
          <div class="grow"><div class="t">${esc(p.name)}</div><div class="s">${p.trackIds.length}곡</div></div><span class="end">›</span></li>`;
      }).join('')}</ul>${playlists.length ? '' : '<div class="empty">플레이리스트가 없어요</div>'}`;
  } else {
    $('#viewTitle').textContent = '추가';
    v.innerHTML = `
      <div class="card"><h2>음원 파일</h2>
        <button class="btn primary" data-act="pickFiles">파일 선택 (MP3 · M4A · FLAC · WAV)</button>
        <p>파일 안의 제목·아티스트·앨범 커버·가사를 자동으로 읽어요. 파일은 이 기기 안에만 저장돼요.</p></div>
      <div class="card"><h2>YouTube 검색</h2>
        <form class="form-row" id="ytSearch"><input name="q" type="search" placeholder="노래 제목, 가수" required><button class="btn primary">검색</button></form>
        ${ytKey() ? '' : '<p>API 키가 없어서 검색은 YouTube에서 열려요. 링크를 복사해 와서 아래 <b>붙여넣기로 추가</b>를 누르세요.</p>'}
        <div id="ytResults"></div>
        <details class="keybox"><summary>${ytKey() ? '✓ 앱 안 검색 켜짐 · API 키 변경' : '앱 안에서 검색하기 (API 키 설정)'}</summary>
          <p>1. Safari로 console.cloud.google.com 접속 → 프로젝트 만들기<br>2. "YouTube Data API v3" 검색 → 사용 설정<br>
          3. 사용자 인증 정보 → API 키 만들기 → 키 복사<br>4. 아래에 붙여넣고 저장 (이 기기에만 저장돼요)<br>무료로 하루 약 100번 검색할 수 있어요.</p>
          <form class="form-row" id="ytKeyForm"><input name="key" placeholder="API 키" value="${esc(ytKey())}" autocomplete="off"><button class="btn">저장</button></form></details></div>
      <div class="card"><h2>YouTube 링크</h2>
        <form class="form-row" id="ytForm"><input name="url" type="url" inputmode="url" placeholder="곡·믹스·재생목록 링크" required><button class="btn primary">추가</button></form>
        <button class="btn" data-act="paste" style="margin-top:8px">📋 붙여넣기로 추가</button>
        <p>곡 링크뿐 아니라 <b>믹스·재생목록</b> 링크도 돼요. YouTube에서 믹스를 열고 공유 → 링크 복사 후 붙여넣으세요.</p>
        <p>YouTube 곡은 누르면 Brave에서 열려요. Brave에서 공유 → <b>Playlist에 추가</b>하면 광고 없이 화면을 꺼도 들을 수 있어요.</p></div>
      <div class="card"><h2>저장 공간</h2><p id="storage">확인 중…</p></div>
      <div class="card"><h2>앱처럼 쓰기</h2><p>Safari에서 공유 버튼 → <b>홈 화면에 추가</b>를 누르면 주소창 없이 앱처럼 열려요. 홈 화면에서 연 앱과 Safari 탭은 저장 공간이 따로라, 한쪽에서만 쓰세요.</p></div>`;
    showStorage();
    if (ytResults.length) renderYtResults();
  }
}

async function showStorage() {
  const el = $('#storage'); if (!el || !navigator.storage?.estimate) return el && (el.textContent = '확인할 수 없어요');
  const persisted = await navigator.storage.persisted?.();
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const gb = n => (n / 1e9).toFixed(2) + ' GB';
  el.innerHTML = `${tracks.size}곡 · 사용 ${gb(usage)} / 가능 ${gb(quota)}<br>${persisted ? '✓ 자동 삭제되지 않도록 보호됨' : '⚠ 기기 공간이 부족하면 iOS가 지울 수 있어요. 홈 화면에 추가해서 쓰면 더 안전해요.'}`;
}

// ---------- 시트 ----------
function openSheet(html, bind) {
  $('#sheet').innerHTML = html; $('#sheet').hidden = $('#dim').hidden = false;
  $('#sheet').onclick = e => { const b = e.target.closest('[data-s]'); if (b) bind(b.dataset.s, b); };
}
let askResolve = null;
function closeSheet() { $('#sheet').hidden = $('#dim').hidden = true; askResolve?.(null); askResolve = null; }

// prompt()/confirm() 대신 쓰는 시트 (임베드된 화면에서는 브라우저 팝업이 막힘)
function ask(title, { input, value = '', ok = '확인', danger = false } = {}) {
  return new Promise(res => {
    openSheet(`<h3>${esc(title)}</h3>${input ? `<input id="askInput" value="${esc(value)}" placeholder="${esc(input)}">` : ''}
      <div class="pl-actions" style="margin-top:14px"><button class="btn" data-s="no">취소</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-s="yes">${esc(ok)}</button></div>`,
    act => { const v = input ? $('#askInput').value.trim() : true; askResolve = null; closeSheet(); res(act === 'yes' && v ? v : null); });
    askResolve = res;
    $('#askInput')?.focus();
  });
}
$('#dim').onclick = closeSheet;

function trackSheet(id) {
  const t = tracks.get(id), yt = t.type === 'youtube';
  openSheet(`<div class="head"><img class="art" src="${esc(cover(t))}" alt=""><div class="grow"><div class="t">${esc(t.title)}</div>
      <div class="s">${yt ? '<span class="chip yt">YOUTUBE</span>' : '<span class="chip file">FILE</span>'}${esc(t.artist)}</div></div></div>
    <button class="btn primary" data-s="play">재생</button>
    ${yt ? `<button class="btn brave" data-s="brave" style="margin-top:8px">Brave로 열기 (화면 꺼도 재생)</button>` : ''}
    <button class="opt" data-s="addPl">＋ 플레이리스트에 추가</button>
    <button class="opt" data-s="fav">${t.fav ? '♥ 즐겨찾기 해제' : '♡ 즐겨찾기'}</button>
    <button class="opt" data-s="edit">✎ 정보 · 가사 편집</button>
    ${yt ? '<button class="opt" data-s="ytapp">YouTube 앱에서 열기</button><button class="opt" data-s="copy">링크 복사</button>' : ''}
    ${openPlaylist ? '<button class="opt" data-s="rmPl">이 플레이리스트에서 빼기</button>' : ''}
    <button class="opt danger" data-s="del">삭제</button>
    ${yt ? '<div class="tip"><b>백그라운드로 들으려면</b> Brave에서 공유 → Playlist에 추가 후 재생하세요.</div>' : ''}`,
  async act => {
    if (act === 'brave') openBrave(t);
    else if (act === 'play') { closeSheet(); playFromView(id); }
    else if (act === 'addPl') pickPlaylist(id);
    else if (act === 'fav') { t.fav = !t.fav; await saveTrack(t); closeSheet(); render(); renderPlayer(); }
    else if (act === 'edit') { closeSheet(); editTrack(id); }
    else if (act === 'ytapp') location.href = trackUrl(t);
    else if (act === 'copy') { await navigator.clipboard?.writeText(trackUrl(t)); toast('링크를 복사했어요'); closeSheet(); }
    else if (act === 'rmPl') { const p = playlists.find(x => x.id === openPlaylist); p.trackIds = p.trackIds.filter(x => x !== id); await savePlaylist(p); closeSheet(); render(); }
    else if (act === 'del') deleteTrack(id);
  });
}

function openBrave(t) {
  t.plays++; saveTrack(t);
  // Brave iOS URL 스킴. Brave가 없으면 아무 일도 일어나지 않아서 잠시 뒤 안내한다.
  location.href = `brave://open-url?url=${encodeURIComponent(trackUrl(t))}`;
  setTimeout(() => { if (document.visibilityState === 'visible') toast('Brave가 열리지 않으면 "YouTube 앱에서 열기"나 링크 복사를 쓰세요'); }, 1500);
}

function pickPlaylist(id) {
  openSheet(`<h3>플레이리스트에 추가</h3><button class="opt" data-s="new">＋ 새 플레이리스트</button>` +
    playlists.map(p => `<button class="opt" data-s="pl" data-id="${p.id}">${esc(p.name)} <span class="s">${p.trackIds.includes(id) ? '· 이미 있음' : ''}</span></button>`).join(''),
  async (act, b) => {
    let p = act === 'new' ? await newPlaylist() : playlists.find(x => x.id === b.dataset.id);
    if (!p) return;
    if (!p.trackIds.includes(id)) { p.trackIds.push(id); await savePlaylist(p); }
    toast(`"${p.name}"에 추가했어요`); closeSheet(); render();
  });
}

async function newPlaylist() {
  const name = await ask('새 플레이리스트', { input: '플레이리스트 이름', ok: '만들기' }); if (!name) return null;
  const p = { id: db.uid(), name, trackIds: [], createdAt: Date.now() };
  playlists.push(p); await savePlaylist(p); render(); return p;
}

function playlistMenu() {
  const p = playlists.find(x => x.id === openPlaylist);
  openSheet(`<h3>${esc(p.name)}</h3><button class="opt" data-s="rename">이름 바꾸기</button><button class="opt danger" data-s="del">플레이리스트 삭제 (곡은 남아요)</button>`,
    async act => {
      if (act === 'rename') { const n = await ask('이름 바꾸기', { input: '새 이름', value: p.name, ok: '저장' }); if (n) { p.name = n; await savePlaylist(p); } }
      else if (await ask(`"${p.name}" 플레이리스트를 삭제할까요?`, { ok: '삭제', danger: true })) { playlists = playlists.filter(x => x !== p); await db.del('playlists', p.id); openPlaylist = null; }
      render();
    });
}

// ---------- 편집 ----------
function editTrack(id) {
  const t = tracks.get(id), f = $('#editForm'), dlg = $('#editor');
  f.title.value = t.title; f.artist.value = t.artist; f.album.value = t.album; f.lyrics.value = t.lyrics || '';
  f.cover.value = f.lrc.value = '';
  f.lrc.onchange = async () => { if (f.lrc.files[0]) f.lyrics.value = await f.lrc.files[0].text(); };
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'save') return;
    Object.assign(t, { title: f.title.value.trim() || t.title, artist: f.artist.value.trim(), album: f.album.value.trim(), lyrics: f.lyrics.value });
    if (f.cover.files[0]) { await db.put('blobs', f.cover.files[0], 'cover:' + t.id); t.hasCover = true; }
    await saveTrack(t); await loadCover(t);
    render(); if (player.cur() === id) { lyr = parseLyrics(t.lyrics); renderPlayer(); setMeta(t); }
    toast('저장했어요');
  };
  dlg.returnValue = ''; dlg.showModal();
}

// ---------- 플레이어 ----------
const audio = new Audio();
audio.preload = 'auto';
const player = { queue: [], order: null, qi: -1, shuffle: false, repeat: 'off', src: '라이브러리', cur() { return this.queue[this.qi]; } };
let lyr = { synced: false, lines: [] }, lastLine = -2, sleepAt = 0, stopAfterTrack = false, audioUrl = null;

function playFromView(id) {
  const ul = document.querySelector('.list[data-src]');
  const ids = ul ? [...ul.querySelectorAll('[data-id]')].map(li => li.dataset.id) : [id];
  const p = playlists.find(x => x.id === openPlaylist);
  playList(ids, id, tab === 'playlists' && p ? p.name : '라이브러리');
}

function playList(ids, startId, src, shuffle = player.shuffle) {
  const files = ids.filter(i => tracks.has(i));
  if (!files.length) return toast('재생할 곡이 없어요');
  player.src = src; player.order = files.slice(); player.shuffle = shuffle;
  player.queue = files.slice();
  player.qi = Math.max(0, player.queue.indexOf(startId));
  if (shuffle) shuffleQueue(startId ?? player.queue[Math.floor(Math.random() * player.queue.length)]);
  loadTrack(true);
}

function shuffleQueue(firstId) {
  const rest = player.order.filter(i => i !== firstId);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  player.queue = [firstId, ...rest]; player.qi = 0;
}

// ---------- 재생 엔진: 음원 파일은 <audio>, YouTube는 공식 iframe 플레이어 ----------
let ytApiP = null, ytP = null, yt = null, ytTimer = 0;
const ytApi = () => ytApiP ||= new Promise((res, rej) => {
  window.onYouTubeIframeAPIReady = res;
  const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api';
  s.onerror = () => { ytApiP = null; toast('YouTube 플레이어를 불러오지 못했어요. 인터넷 연결을 확인하세요'); rej(new Error('yt api')); };
  document.head.append(s);
});

// 화면 밖 임시 플레이어에 목록을 올려서 곡 ID 목록만 읽고 버린다 (재생 중인 곡은 그대로)
function listVideoIds(list) {
  return ytApi().then(() => new Promise((res, rej) => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px;height:200px';
    document.body.append(el);
    let p, poll, timer;
    const finish = ids => {
      clearInterval(poll); clearTimeout(timer);
      try { p.destroy(); } catch { /* 이미 정리됨 */ }
      el.remove(); ids?.length ? res(ids) : rej(new Error('empty'));
    };
    p = new YT.Player(el, { width: 200, height: 200, events: {
      onReady: () => p.cuePlaylist({ list, listType: 'playlist' }),
      onError: () => finish(null),
    } });
    poll = setInterval(() => { const ids = p.getPlaylist?.(); if (ids?.length) finish(ids); }, 300);
    timer = setTimeout(() => finish(null), 15000);
  }));
}

function ytPlayer() {
  return ytP ||= ytApi().then(() => new Promise(res => {
    const p = new YT.Player('ytFrame', {
      width: '100%', height: '100%', playerVars: { playsinline: 1, rel: 0 },
      events: {
        onReady: () => { yt = p; res(p); },
        onStateChange: e => { if (e.data === 0 && isYt() && !listHasMore()) next(true); if (e.data === 1) showListVideo(); syncPlayState(); },
        onError: () => toast('이 영상은 앱 안에서 재생할 수 없어요. ⋯ 메뉴에서 Brave로 여세요'),
      },
    });
  }));
}
const isYt = () => tracks.get(player.cur())?.type === 'youtube';
// 믹스·재생목록 재생 중: 목록 안의 다음/이전 곡은 YouTube 플레이어가 넘긴다
const inList = () => !!(yt && isYt() && tracks.get(player.cur()).listId);
const listHasMore = () => inList() && yt.getPlaylistIndex() < (yt.getPlaylist()?.length || 0) - 1;
function showListVideo() {
  const d = inList() && yt.getVideoData?.(), t = tracks.get(player.cur());
  if (!d?.title) return;
  $('#pTitle').textContent = $('#pTitle2').textContent = $('#miniTitle').textContent = d.title;
  $('#pArtist').textContent = $('#pArtist2').textContent = `${d.author} · ${t.title}`;
  setMeta({ id: t.id, title: d.title, artist: d.author, album: t.title });
}
const eng = {
  paused: () => isYt() ? !yt || ![1, 3].includes(yt.getPlayerState()) : audio.paused,
  time: () => isYt() ? yt?.getCurrentTime?.() || 0 : audio.currentTime,
  dur: () => isYt() ? yt?.getDuration?.() || 0 : audio.duration,
  seek: s => isYt() ? yt?.seekTo(s, true) : (audio.currentTime = s),
  play: () => isYt() ? yt?.playVideo() : audio.play(),
  pause: () => isYt() ? yt?.pauseVideo() : audio.pause(),
};

async function loadTrack(autoplay, startAt = 0) {
  const t = tracks.get(player.cur()); if (!t) return;
  clearInterval(ytTimer);
  if (t.type === 'youtube') {
    audio.pause();
    lyr = parseLyrics(t.lyrics); lastLine = -2;
    if (autoplay) $('#player').hidden = false; // 영상이 화면에 보여야 재생된다
    setMeta(t); renderPlayer(); render(); saveState();
    const p = await ytPlayer();
    if (player.cur() !== t.id) return; // 기다리는 사이 다른 곡으로 바뀜
    // shortcut: 믹스·재생목록은 목록 안 몇 번째 곡이었는지는 복원하지 않고 처음부터 — 필요하면 getPlaylistIndex 저장
    if (t.listId) p[autoplay ? 'loadPlaylist' : 'cuePlaylist']({ list: t.listId, listType: 'playlist', startSeconds: startAt });
    else autoplay ? p.loadVideoById(t.videoId, startAt) : p.cueVideoById(t.videoId, startAt);
    if (autoplay) { t.plays++; saveTrack(t); }
    ytTimer = setInterval(tick, 250);
    return;
  }
  yt?.pauseVideo();
  const blob = await db.get('blobs', 'audio:' + t.id);
  if (!blob) { toast('파일을 찾을 수 없어요'); return; }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audio.src = audioUrl = URL.createObjectURL(blob);
  if (startAt) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
  lyr = parseLyrics(t.lyrics); lastLine = -2;
  setMeta(t); renderPlayer(); render(); saveState();
  if (autoplay) {
    try { await audio.play(); t.plays++; saveTrack(t); } catch { /* 사용자 동작 없이 자동재생이 막힌 경우 */ }
  }
}

function next(auto = false) {
  if (!player.queue.length) return;
  if (!auto && listHasMore()) return yt.nextVideo();
  if (auto && stopAfterTrack) { stopAfterTrack = false; return; }
  if (auto && player.repeat === 'one') { eng.seek(0); eng.play(); return; }
  if (player.qi + 1 >= player.queue.length) {
    if (player.repeat !== 'all' && auto) return;
    player.qi = 0;
  } else player.qi++;
  loadTrack(true);
}
function prev() {
  if (inList() && eng.time() <= 3 && yt.getPlaylistIndex() > 0) return yt.previousVideo();
  if (eng.time() > 3 || player.qi === 0) { eng.seek(0); return; }
  player.qi--; loadTrack(true);
}
const toggle = () => !player.cur() ? null : eng.paused() ? eng.play() : eng.pause();

function setMeta(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album || player.src,
    artwork: covers.has(t.id) ? [{ src: covers.get(t.id), sizes: '512x512' }] : [{ src: iconPng, sizes: '512x512', type: 'image/png' }],
  });
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession, h = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* 지원 안 하는 동작 */ } };
  h('play', () => eng.play()); h('pause', () => eng.pause());
  h('previoustrack', prev); h('nexttrack', () => next());
  h('seekto', d => eng.seek(d.seekTime));
  // 10초 건너뛰기를 등록하면 iOS 잠금 화면이 이전/다음 곡 대신 ±10초 버튼을 보여 준다
  h('seekbackward', null); h('seekforward', null);
}

function renderPlayer() {
  const t = tracks.get(player.cur());
  $('#mini').hidden = !t;
  if (!t) { $('#player').hidden = true; return; }
  const c = cover(t);
  $('#miniArt').src = $('#bigArt').src = $('#smallArt').src = c;
  $('#bigArt').hidden = t.type === 'youtube'; $('#ytBox').hidden = $('#ytNote').hidden = t.type !== 'youtube';
  $('#playerBg').style.backgroundImage = `url("${c}")`;
  $('#miniTitle').textContent = $('#pTitle').textContent = $('#pTitle2').textContent = t.title;
  $('#pArtist').textContent = [t.artist, t.album].filter(Boolean).join(' · ');
  $('#pArtist2').textContent = t.artist;
  $('#playerSrc').textContent = player.src;
  $('#pFav').textContent = t.fav ? '♥' : '♡'; $('#pFav').classList.toggle('on', t.fav);
  $('#shuffle').classList.toggle('on', player.shuffle);
  $('#repeat').classList.toggle('on', player.repeat !== 'off'); $('#repeat').classList.toggle('one', player.repeat === 'one');
  const lines = $('#lines');
  lines.className = 'lines ' + (lyr.synced ? 'synced' : 'plain');
  lines.innerHTML = lyr.lines.length ? lyr.lines.map((l, i) => `<p data-i="${i}">${esc(l.text) || '♪'}</p>`).join('')
    : '<div class="none">가사가 없어요<br><br><button class="pill" data-act="editLyrics">✎ 가사 입력하기</button></div>';
  lastLine = -2; syncPlayState(); tick(); showListVideo();
}

function syncPlayState() {
  const paused = eng.paused(), icon = paused ? PLAY : PAUSE;
  $('#toggle').innerHTML = icon; $('#miniToggle').innerHTML = icon.replace('class="fill"', 'class="fill" style="color:#fff"');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
}

let lastSave = 0;
function tick() {
  const d = eng.dur(), c = eng.time();
  if (!$('#seek').dragging) $('#seek').value = d ? (c / d) * 100 : 0;
  $('#cur').textContent = fmt(c); $('#dur').textContent = '-' + fmt((d || 0) - c);
  $('#miniProg').style.width = d ? (c / d) * 100 + '%' : 0;
  if (sleepAt && Date.now() >= sleepAt) { sleepAt = 0; eng.pause(); toast('취침 예약으로 정지했어요'); }
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveState(); }
  // 가사 강조
  const i = lyr.synced ? activeLine(lyr.lines, c + 0.2) : -1;
  if (i !== lastLine) {
    lastLine = i;
    const ps = $('#lines').querySelectorAll('p');
    ps.forEach((p, k) => { p.classList.toggle('on', k === i); p.classList.toggle('past', k < i); });
    if (i >= 0 && $('#player').classList.contains('lyrics') && !$('#player').hidden) ps[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
    const cur = lyr.synced ? lyr.lines[i] : null, nxt = lyr.synced ? lyr.lines[i + 1] : null;
    $('#miniLine').textContent = cur?.text || tracks.get(player.cur())?.artist || '';
    $('#lyPrev').innerHTML = !lyr.lines.length ? '<p>가사 없음 · 눌러서 입력</p>'
      : lyr.synced ? `<p class="on">${esc(cur?.text || '♪')}</p><p>${esc(nxt?.text || '')}</p>`
        : lyr.lines.slice(0, 2).map(l => `<p>${esc(l.text)}</p>`).join('');
  }
}

function saveState() {
  try {
    localStorage.setItem('player', JSON.stringify({ queue: player.queue, order: player.order, qi: player.qi, t: eng.time(),
      shuffle: player.shuffle, repeat: player.repeat, src: player.src }));
  } catch { /* 저장 못해도 재생에는 지장 없음 */ }
}
async function restoreState() {
  let s; try { s = JSON.parse(localStorage.getItem('player')); } catch { return; }
  if (!s?.queue?.length) return;
  Object.assign(player, { queue: s.queue.filter(i => tracks.has(i)), order: (s.order || s.queue).filter(i => tracks.has(i)),
    qi: s.qi, shuffle: !!s.shuffle, repeat: s.repeat || 'off', src: s.src || '라이브러리' });
  if (player.qi >= player.queue.length) player.qi = 0;
  if (player.queue.length) await loadTrack(false, s.t || 0);
}

audio.addEventListener('timeupdate', tick);
audio.addEventListener('play', syncPlayState);
audio.addEventListener('pause', () => { syncPlayState(); saveState(); });
audio.addEventListener('ended', () => { if (!isYt()) next(true); });
audio.addEventListener('loadedmetadata', tick);

function sleepSheet() {
  const left = sleepAt ? Math.ceil((sleepAt - Date.now()) / 60000) : 0;
  openSheet(`<h3>취침 예약 ${left > 0 ? `· ${left}분 남음` : stopAfterTrack ? '· 이 곡 끝나면' : ''}</h3>` +
    [15, 30, 45, 60, 90].map(m => `<button class="opt" data-s="${m}">${m}분 뒤</button>`).join('') +
    `<button class="opt" data-s="end">이 곡 끝나면</button><button class="opt danger" data-s="off">끄기</button>`,
  act => {
    sleepAt = 0; stopAfterTrack = false;
    if (act === 'end') stopAfterTrack = true; else if (act !== 'off') sleepAt = Date.now() + act * 60000;
    toast(act === 'off' ? '취침 예약을 껐어요' : '취침 예약을 설정했어요'); closeSheet();
  });
}

function queueSheet() {
  openSheet(`<h3>대기열 · ${esc(player.src)}</h3><ul class="list">` + player.queue.map((id, i) => {
    const t = tracks.get(id); return t ? `<li class="item ${i === player.qi ? 'playing' : ''}" data-s="go" data-i="${i}"><img class="art" src="${esc(cover(t))}" alt="">
      <div class="grow"><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist)}</div></div></li>` : '';
  }).join('') + '</ul>', (_, b) => { player.qi = +b.dataset.i; loadTrack(true); closeSheet(); });
  $('#sheet .playing')?.scrollIntoView({ block: 'center' });
}

// ---------- 이벤트 ----------
document.querySelector('.tabs').onclick = e => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  if (tab === b.dataset.tab) openPlaylist = null;
  tab = b.dataset.tab; render(); scrollTo(0, 0);
};
$('#search').oninput = e => { query = e.target.value; render(); };
$('#view').onclick = async e => {
  const a = e.target.closest('[data-act],[data-filter],[data-pl]'); if (!a) return;
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (a.dataset.filter) { filter = a.dataset.filter; return render(); }
  if (a.dataset.pl) { openPlaylist = a.dataset.pl; render(); return scrollTo(0, 0); }
  const p = playlists.find(x => x.id === openPlaylist);
  switch (a.dataset.act) {
    case 'open': return playFromView(id);
    case 'more': return trackSheet(id);
    case 'pickFiles': return $('#fileInput').click();
    case 'newPl': return newPlaylist();
    case 'back': openPlaylist = null; return render();
    case 'playAll': return playList(p.trackIds, null, p.name, false);
    case 'shuffleAll': return playList(p.trackIds, null, p.name, true);
    case 'plMenu': return playlistMenu();
    case 'ytAdd': { const r = ytResults[+a.dataset.i]; a.disabled = true; return addYouTube(ytUrl(r.vid), { title: r.title, author_name: r.artist }); }
    case 'paste': {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch { return toast('붙여넣기를 허용하지 않았어요. 링크 칸에 직접 붙여넣으세요'); }
      return youtubeId(text) ? addYouTube(text) : toast('복사한 내용이 YouTube 링크가 아니에요');
    }
    case 'up': case 'down': {
      const i = p.trackIds.indexOf(id), j = i + (a.dataset.act === 'up' ? -1 : 1);
      if (j < 0 || j >= p.trackIds.length) return;
      [p.trackIds[i], p.trackIds[j]] = [p.trackIds[j], p.trackIds[i]];
      await savePlaylist(p); return render();
    }
  }
};
$('#view').addEventListener('submit', async e => {
  const f = e.target;
  if (f.id === 'ytSearch') { e.preventDefault(); f.q.blur(); return searchYouTube(f.q.value.trim()); }
  if (f.id === 'ytKeyForm') {
    e.preventDefault();
    try { localStorage.setItem('ytKey', f.key.value.trim()); } catch { return toast('저장하지 못했어요'); }
    toast(f.key.value.trim() ? '저장했어요. 이제 앱 안에서 검색돼요' : 'API 키를 지웠어요'); return render();
  }
  if (e.target.id !== 'ytForm') return;
  e.preventDefault();
  const btn = e.target.querySelector('button'); btn.disabled = true;
  try { if (await addYouTube(e.target.url.value)) e.target.reset(); } finally { btn.disabled = false; }
});
$('#fileInput').onchange = async e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) { await addFiles(fs); navigator.storage?.persist?.(); } };

$('#miniOpen').onclick = $('#miniArt').onclick = () => { $('#player').hidden = false; lastLine = -2; tick(); };
$('#miniToggle').onclick = toggle;
$('#playerClose').onclick = () => { $('#player').hidden = true; };
$('#toggle').onclick = toggle;
$('#next').onclick = () => next();
$('#prev').onclick = prev;
$('#shuffle').onclick = () => {
  if (!player.order) return;
  player.shuffle = !player.shuffle;
  const cur = player.cur();
  if (player.shuffle) shuffleQueue(cur); else { player.queue = player.order.slice(); player.qi = player.queue.indexOf(cur); }
  renderPlayer(); saveState();
};
$('#repeat').onclick = () => {
  player.repeat = { off: 'all', all: 'one', one: 'off' }[player.repeat];
  toast({ off: '반복 끔', all: '전체 반복', one: '한 곡 반복' }[player.repeat]); renderPlayer(); saveState();
};
const seek = $('#seek');
seek.oninput = () => { seek.dragging = true; $('#cur').textContent = fmt((seek.value / 100) * (eng.dur() || 0)); };
seek.onchange = () => { seek.dragging = false; if (eng.dur()) eng.seek((seek.value / 100) * eng.dur()); };
$('#pFav').onclick = async () => { const t = tracks.get(player.cur()); t.fav = !t.fav; await saveTrack(t); renderPlayer(); render(); };
const setPv = v => { $('#player').classList.toggle('lyrics', v === 'lyrics'); document.querySelectorAll('[data-pv]').forEach(b => b.classList.toggle('on', b.dataset.pv === v)); lastLine = -2; tick(); };
document.querySelectorAll('[data-pv]').forEach(b => { b.onclick = () => setPv(b.dataset.pv); });
$('#lyPrev').onclick = () => setPv('lyrics');
$('#lines').onclick = e => {
  if (e.target.closest('[data-act="editLyrics"]')) return editTrack(player.cur());
  const p = e.target.closest('p[data-i]'); if (!p || !lyr.synced) return;
  eng.seek(lyr.lines[+p.dataset.i].t); if (eng.paused()) eng.play();
};
$('#lyricsEdit').onclick = () => editTrack(player.cur());
$('#sleepBtn').onclick = sleepSheet;
$('#queueBtn').onclick = queueSheet;

// 아래로 쓸어내려 닫기 (가사 스크롤·재생바·영상 위에서는 무시)
function swipeDown(el, close, ignore) {
  let y0 = null;
  el.addEventListener('touchstart', e => { y0 = ignore(e) ? null : e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', e => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 70) close(); y0 = null; });
}
swipeDown($('#player'), () => { $('#player').hidden = true; }, e => e.target.closest('.lines, .controls, #ytBox'));
swipeDown($('#sheet'), closeSheet, e => $('#sheet').scrollTop > 0 || e.target.closest('input, textarea, #ytResults'));

// 썸네일을 못 불러오면(오프라인 등) 기본 아이콘으로
document.addEventListener('error', e => { const i = e.target; if (i.tagName === 'IMG' && !i.src.endsWith('icon.svg')) i.src = 'icon.svg'; }, true);

let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

await loadAll();
render();
await restoreState();
renderPlayer();
