const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const adminMode = params.get('admin') === '1';
const room = params.get('room') === 'B' ? 'B' : 'A';
const API = location.hostname.endsWith('github.io') ? 'https://tcsshcsc-attendance.yichengc869.workers.dev' : '';
const tokenKey = adminMode ? 'attendance_admin' : 'attendance_student';
const authHeaders = () => sessionStorage.getItem(tokenKey) ? {Authorization:'Bearer '+sessionStorage.getItem(tokenKey)} : {};
let state = null, me = null, adminLoggedIn = false, selected = null, refreshing = false;
const time = value => new Date(value).toLocaleString('zh-TW', { timeZone:'Asia/Taipei', hour12:false });
const text = (id, value) => { $(id).textContent = value; };
function notice(message, success = false) { text('notice', message); $('notice').classList.toggle('success', success); $('notice').hidden = !message; }
async function api(path, body) {
  const response = await fetch(API+path, { method: body === undefined ? 'GET' : 'POST', headers: { ...authHeaders(), ...(body === undefined ? {} : { 'Content-Type':'application/json', 'X-Requested-With':'attendance' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || '連線失敗。'), { status: response.status });
  if (result.token) sessionStorage.setItem(tokenKey, result.token);
  return result;
}
async function task(button, action, errorId) {
  button.disabled = true;
  try { await action(); }
  catch (error) { if (errorId) text(errorId, error.message); else notice(error.message); }
  finally { button.disabled = false; }
}
function signedInUI() {
  $('google-login').hidden = !!me;
  $('student-logout').hidden = !me;
  text('login-title', me ? '已登入' : '學生登入');
  text('login-description', me ? me.email : '限 @stu.tcssh.tc.edu.tw');
  if (me?.checkin) {
    const c = me.checkin;
    text('login-title', '已完成點名');
    text('login-description', `${me.email} · ${c.room} 班 ${String(c.seat).padStart(2,'0')} 號座位 · ${c.class_name} ${c.student_number} 號`);
  }
}
function render() {
  const seats = state?.seats.filter(s => s.room === room) || Array.from({ length:48 }, (_, i) => ({room,seat:i+1,unknown:true}));
  const checkins = state?.checkins?.filter(c => c.room === room) || [];
  const grid = $('seat-grid'); grid.replaceChildren();
  for (let row = 0; row < 8; row++) {
    const label = document.createElement('span'); label.className = 'row-label'; label.textContent = String(row+1).padStart(2,'0'); grid.append(label);
    for (const seat of seats.slice(row*6,row*6+6)) {
      const checkin = checkins.find(c => c.seat === seat.seat);
      const occupied = !!(seat.occupied || checkin);
      const status = seat.unknown ? '連線中' : seat.blocked ? '停用座位' : occupied ? '已報到' : '未報到';
      const button = document.createElement('button'); button.className = `seat ${seat.blocked?'blocked':occupied?'occupied':''}`;
      if (me?.checkin?.room === room && me.checkin.seat === seat.seat) button.classList.add('mine');
      button.textContent = String(seat.seat).padStart(2,'0');
      button.setAttribute('aria-label', `${room} 班 ${seat.seat} 號，${status}`);
      button.title = adminMode && checkin ? `${checkin.class_name} ${checkin.student_number} 號` : status;
      button.disabled = !!seat.unknown || (adminMode ? !adminLoggedIn : !me || seat.blocked || occupied || !!me?.checkin);
      button.onclick = () => {
        if (adminMode && occupied) { notice(`${room} 班 ${seat.seat} 號：${checkin.class_name} ${checkin.student_number} 號，${checkin.email}`); return; }
        if (!adminMode && !me) { notice('請先登入 Google 帳號，再選擇座位。'); $('google-login').focus(); return; }
        selected = {...seat,roundId:state.round.id};
        text('dialog-title', `${room} 班 · ${String(seat.seat).padStart(2,'0')} 號座位`);
        text('dialog-description', adminMode ? seat.blocked ? '將這個座位恢復為可供學員報到。' : '將這個座位標示為灰燈，學員將無法選取。' : '請填寫學校班級與班級座號。確認後每場限報到一次。');
        $('student-fields').hidden = adminMode;
        $('class-name').required = !adminMode; $('student-number').required = !adminMode;
        text('confirm-seat', adminMode ? seat.blocked ? '恢復使用' : '設為停用座位' : '確認報到 →');
        text('dialog-error',''); $('seat-dialog').showModal();
      };
      grid.append(button);
    }
  }
  if (!state) return;
  const occupied = seats.filter(s => s.occupied || checkins.some(c => c.seat === s.seat)).length;
  text('occupied-count',occupied);
  if (adminMode) {
    $('records-body').replaceChildren();
    for (const c of checkins) {
      const tr = document.createElement('tr');
      for (const value of [`${room}-${String(c.seat).padStart(2,'0')}`,c.class_name,c.student_number,c.email,time(c.checked_in_at)]) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      $('records-body').append(tr);
    }
    $('no-records').hidden = checkins.length > 0;
  }
}
async function refresh(silent = false) {
  if (refreshing || (adminMode && !adminLoggedIn)) return;
  refreshing = true;
  try {
    const newState = await api(adminMode ? '/api/admin/state' : '/api/state');
    if (!adminMode) {
      try { me = await api('/api/me'); } catch (error) { if ([401,403].includes(error.status)) me = null; else throw error; }
      signedInUI();
    }
    const changedRound = state && state.round.id !== newState.round.id;
    state = newState; render();
    if (changedRound) { notice('新的點名場次已開始，請確認本次座位。'); if (adminMode) await loadHistory(); }
    text('sync-text',`更新於 ${new Date().toLocaleTimeString('zh-TW',{hour12:false})}`); $('sync-dot').classList.add('live');
  } catch (error) {
    text('sync-text','連線中斷 · 請重新整理'); $('sync-dot').classList.remove('live');
    if (!silent || !state) notice(error.message);
    if (error.status === 401 && adminMode) adminUI(false);
  } finally { refreshing = false; }
}
function adminUI(loggedIn) {
  adminLoggedIn = loggedIn; $('admin-login-panel').hidden = loggedIn; $('workspace').hidden = !loggedIn;
  $('admin-actions').hidden = !loggedIn; $('records').hidden = !loggedIn;
  if (!loggedIn) { state = null; $('records-body').replaceChildren(); }
}
async function loadHistory() {
  const rows = await api('/api/admin/history'); $('history').replaceChildren();
  for (const r of rows) { const option = document.createElement('option'); option.value = r.id; option.textContent = `第 ${r.id} 場 · ${time(r.started_at)}`; $('history').append(option); }
}
async function initGoogle(clientId) {
  if (!clientId) { $('google-login').disabled = true; text('google-login','Google 登入設定中'); notice('Google 登入尚未設定完成，暫時無法報到。'); return; }
  const { nonce } = await api('/api/auth/nonce');
  await new Promise((resolve,reject) => {
    if (window.google?.accounts) return resolve();
    const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.onload = resolve; script.onerror = () => reject(new Error('Google 登入載入失敗，請重新整理。')); document.head.append(script);
  });
  window.google.accounts.id.initialize({ client_id:clientId, nonce, auto_select:false, callback: async result => {
    await task($('google-login'), async () => { await api('/api/auth/google',{credential:result.credential,nonce}); notice('已登入，請選位。',true); await refresh(); });
  } });
  $('google-login').replaceChildren();
  window.google.accounts.id.renderButton($('google-login'), { type:'standard',theme:'outline',size:'large',text:'signin_with',locale:'zh_TW',width:230 });
  $('google-login').classList.add('google-button');
}
$('seat-form').onsubmit = event => { event.preventDefault(); task($('confirm-seat'), async () => {
  text('dialog-error','');
  if (adminMode) await api('/api/admin/seat',{room,seat:selected.seat,blocked:!selected.blocked});
  else await api('/api/checkin',{room,seat:selected.seat,roundId:selected.roundId,className:$('class-name').value,studentNumber:Number($('student-number').value)});
  $('seat-dialog').close(); notice(adminMode ? '座位設定已更新。' : '已完成點名。',true); await refresh();
}, 'dialog-error'); };
$('admin-form').onsubmit = event => { event.preventDefault(); task(event.submitter, async () => {
  text('admin-error',''); const form = new FormData(event.currentTarget);
  await api('/api/admin/login',{username:form.get('username'),password:form.get('password')}); $('admin-form').elements.password.value='';
  adminUI(true); notice(''); await refresh(); await loadHistory();
}, 'admin-error'); };
$('student-logout').onclick = event => task(event.currentTarget,async () => { await api('/api/auth/logout',{}); sessionStorage.removeItem(tokenKey); window.google?.accounts.id.disableAutoSelect(); location.reload(); });
$('admin-logout').onclick = event => task(event.currentTarget,async () => { await api('/api/admin/logout',{}); sessionStorage.removeItem(tokenKey); adminUI(false); notice('已登出管理員。'); });
$('refresh').onclick = () => refresh();
$('new-round').onclick = () => { text('round-error',''); $('round-dialog').dataset.roundId = state.round.id; $('round-dialog').showModal(); };
$('round-form').onsubmit = event => { event.preventDefault(); task(event.submitter, async () => { await api('/api/admin/round',{roundId:Number($('round-dialog').dataset.roundId)}); $('round-dialog').close(); await refresh(); await loadHistory(); notice('兩班已重設，可以開始本次點名。歷史紀錄與停用座位已保留。',true); }, 'round-error'); };
$('export').onclick = event => task(event.currentTarget, async () => {
  const response = await fetch(API+`/api/admin/export?round=${encodeURIComponent($('history').value)}`,{headers:authHeaders()});
  if (!response.ok) throw new Error((await response.json()).error || '匯出失敗。');
  const blob = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href=blob; a.download=`attendance-${$('history').value}.csv`; a.click(); setTimeout(()=>URL.revokeObjectURL(blob),1000);
});
for (const button of document.querySelectorAll('.close')) button.onclick = () => button.closest('dialog').close();
text('today',new Date().toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'long',day:'numeric',weekday:'long'}));
text('count-room',room); text('room-letter',room); text('room-title',`${room} 班座位圖`);
$(`room-${room.toLowerCase()}`).classList.add('active');
$(adminMode?'admin-link':'student-link').classList.add('active');
if (adminMode) {
  text('eyebrow','CLUB ATTENDANCE / 管理中心'); text('heading','管理員後台'); text('subtitle','');
  $('login-card').hidden=true; $('guide').hidden=true; $('room-a').href='?admin=1&room=A'; $('room-b').href='?admin=1&room=B';
  text('seat-help','點選紅燈座位可停用，灰燈可恢復使用；綠燈可查看學員資料。');
  adminUI(false);
  if (sessionStorage.getItem(tokenKey)) $('admin-login-panel').hidden=true;
  try { state=await api('/api/admin/state'); adminUI(true); render(); await loadHistory(); await refresh(); } catch(error) { adminUI(false); if(error.status===401) sessionStorage.removeItem(tokenKey); else notice(error.message); }
} else {
  render();
  try { const config=await api('/api/config'); await refresh(); if (!me) await initGoogle(config.googleClientId); } catch(error) { notice(error.message); }
}
$('refresh').hidden = !adminMode;
