const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { createGame, startNewRound, processPlayCard, drawFromDeck, processDrawAndPlay } = require('./gameLogic');
const {
  getStats, updateTotalPoints, incrementGamesPlayed, getLeaderboard,
  getAllStats, resetAllStats, getSummaryStats, resetPlayerStats,
  banUUID, unbanUUID, isBanned, getBannedList,
  recordCardPlay, recordGameStart, getCardUsageStats, getHourlyActivity, getTypeStats,
} = require('./playerStats');
const { decideBotMove, decideDrawnCardChoice, SKILL_KEYS } = require('./botAi');
const { logAudit, isSuspiciousBurst, recordAction, clearAction } = require('./audit');

const app = express();
const httpServer = createServer(app);
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : [/^http:\/\/localhost:\d+$/, /^http:\/\/192\.168\.\d+\.\d+:\d+$/, /^http:\/\/10\.\d+\.\d+\.\d+:\d+$/];
const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), rooms: rooms.size, queue: matchQueue.length });
});

// ─── 管理者用ダッシュボード ───────────────────────────────────────
// トークン: process.env.ADMIN_TOKEN (未設定時は常に404)
// 失敗時は 404 を返してエンドポイントの存在自体を隠す
// ?t=<token> または X-Admin-Token ヘッダで認証
// ?format=html で HTML テーブル (10秒ごと自動更新) を返す
function isAdminRequest(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.query.t || req.headers['x-admin-token'];
  if (!provided) return false;
  // タイミング攻撃を避けるため長さ一致 + 安全比較
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function readAuditTail(maxLines = 30) {
  try {
    const fs = require('fs');
    const path = require('path');
    const dataDir = process.env.DATA_DIR || __dirname;
    const logFile = process.env.AUDIT_LOG_PATH || path.join(dataDir, 'audit.log');
    if (!fs.existsSync(logFile)) return [];
    const stat = fs.statSync(logFile);
    // 末尾のみ読む: 最大64KBまで (軽量化)
    const readSize = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(logFile, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n').filter(Boolean);
    return lines.slice(-maxLines).reverse().map(l => {
      try { return JSON.parse(l); } catch { return { ts: null, raw: l }; }
    });
  } catch (err) {
    return [{ error: String(err) }];
  }
}

function buildAdminSnapshot() {
  const playerList = getAllStats();
  const summary = getSummaryStats();
  const auditTail = readAuditTail(30);
  const bannedList = getBannedList();
  const cardUsage = getCardUsageStats();
  const hourly = getHourlyActivity(24);
  const typeStats = getTypeStats();
  const roomList = [];
  for (const room of rooms.values()) {
    const curIdx = room.currentPlayerIndex;
    const ageSec = room.createdAt ? Math.round((Date.now() - room.createdAt) / 1000) : null;
    roomList.push({
      id: room.id,
      status: room.status,
      roundCount: room.roundCount || 0,
      isMatchmaking: !!room.isMatchmaking,
      currentTotal: room.currentTotal ?? null,
      currentPlayerName: (room.status === 'playing' && room.players[curIdx]) ? room.players[curIdx].name : null,
      ageSec,
      players: room.players.map((p, i) => ({
        name: p.name,
        isBot: !!p.isBot,
        lost: !!p.lost,
        disconnected: !!p.disconnected,
        isCurrent: i === curIdx && room.status === 'playing',
      })),
    });
  }
  const mem = process.memoryUsage();
  return {
    timestamp: new Date().toISOString(),
    server: {
      uptimeSec: Math.round(process.uptime()),
      connectedSockets: io.engine.clientsCount,
      totalRooms: rooms.size,
      matchQueueCount: matchQueue.length,
      memoryRssMB: Math.round(mem.rss / 1024 / 1024),
      memoryHeapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    },
    summary,
    matchQueue: matchQueue.map(p => ({ name: p.name, uuidPrefix: p.uuid ? p.uuid.slice(0, 8) : null })),
    rooms: roomList,
    players: playerList,
    bannedList,
    cardUsage,
    hourly,
    typeStats,
    auditTail,
  };
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAdminHtml(snapshot, token) {
  const { server: srv, summary, matchQueue: queue, rooms: roomList, players, bannedList, cardUsage, hourly, typeStats, auditTail } = snapshot;
  const tokenEnc = encodeURIComponent(token);
  const fmtAge = (sec) => {
    if (sec == null) return '-';
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm' + (sec % 60 > 0 ? ' ' + (sec % 60) + 's' : '');
    return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
  };
  const roomRows = roomList.map(r => `
    <tr>
      <td>${escapeHtml(r.id)}</td>
      <td>${escapeHtml(r.status)}${r.isMatchmaking ? ' <span class="tag">match</span>' : ''}</td>
      <td>${r.roundCount}</td>
      <td>${r.currentTotal ?? '-'}</td>
      <td>${escapeHtml(fmtAge(r.ageSec))}</td>
      <td>${r.players.map(p => `${p.isCurrent ? '▶ ' : ''}${escapeHtml(p.name)}${p.isBot ? '🤖' : ''}${p.lost ? '💀' : ''}${p.disconnected ? '🔌' : ''}`).join(', ')}</td>
      <td><button class="act danger" data-action="close-room" data-roomid="${escapeHtml(r.id)}">強制終了</button></td>
    </tr>`).join('');
  const queueRows = queue.length
    ? queue.map(p => `<li>${escapeHtml(p.name)}${p.uuidPrefix ? ` <code>${escapeHtml(p.uuidPrefix)}…</code>` : ''}</li>`).join('')
    : '<li class="dim">待機中なし</li>';
  const playerRows = players.map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(p.name)}</td>
      <td><code>${escapeHtml((p.uuid || '').slice(0, 8))}…</code></td>
      <td>${p.totalPoints >= 0 ? '+' : ''}${p.totalPoints}</td>
      <td>${p.gamesPlayed}</td>
      <td>${p.lastSeen ? escapeHtml(p.lastSeen).slice(0, 19).replace('T', ' ') : '-'}</td>
      <td>
        <button class="act" data-action="reset-player" data-uuid="${escapeHtml(p.uuid || '')}" data-name="${escapeHtml(p.name)}">リセット</button>
        <button class="act danger" data-action="ban" data-uuid="${escapeHtml(p.uuid || '')}" data-name="${escapeHtml(p.name)}">BAN</button>
      </td>
    </tr>`).join('');
  const bannedRows = bannedList.map(b => `
    <tr>
      <td><code>${escapeHtml((b.uuid || '').slice(0, 8))}…</code></td>
      <td>${escapeHtml(b.lastName || '-')}</td>
      <td>${escapeHtml(b.reason || '-')}</td>
      <td>${b.bannedAt ? escapeHtml(b.bannedAt).slice(0, 19).replace('T', ' ') : '-'}</td>
      <td>
        <button class="act" data-action="unban" data-uuid="${escapeHtml(b.uuid || '')}">解除</button>
      </td>
    </tr>`).join('');
  return `<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Hit101 Admin</title>
<meta http-equiv="refresh" content="10;url=/admin/stats?t=${tokenEnc}&format=html">
<style>
  body { font-family: -apple-system, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 16px; font-size: 13px; }
  h1 { color: #facc15; margin: 0 0 4px; font-size: 18px; }
  h2 { color: #fbbf24; margin: 18px 0 6px; font-size: 14px; border-bottom: 1px solid #334155; padding-bottom: 4px; }
  .sub { color: #94a3b8; font-size: 11px; margin-bottom: 12px; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
  .stat { background: #1e293b; padding: 8px 12px; border-radius: 6px; }
  .stat b { color: #facc15; font-size: 16px; display: block; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; background: #1e293b; border-radius: 6px; overflow: hidden; }
  th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #334155; }
  th { background: #334155; color: #facc15; font-size: 11px; text-transform: uppercase; }
  tr:last-child td { border-bottom: none; }
  code { background: #334155; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
  .tag { background: #7c3aed; color: #fff; padding: 1px 5px; border-radius: 3px; font-size: 10px; }
  .dim { color: #64748b; }
  ul { margin: 4px 0; padding-left: 20px; }
  button.act { background: #475569; color: #e2e8f0; border: none; padding: 3px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; margin: 0 2px; }
  button.act:hover { background: #64748b; }
  button.act.danger { background: #991b1b; }
  button.act.danger:hover { background: #b91c1c; }
  .hourly { display: flex; gap: 2px; align-items: flex-end; background: #1e293b; padding: 10px; border-radius: 6px; height: 120px; }
  .hourly .bar { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; position: relative; height: 100%; font-size: 9px; color: #94a3b8; }
  .hourly .bar .fill { width: 100%; background: linear-gradient(180deg, #facc15, #eab308); border-radius: 2px 2px 0 0; min-height: 1px; transition: height 0.3s; }
  .hourly .bar .lbl { position: absolute; bottom: 18px; font-size: 9px; color: #e2e8f0; }
  .hourly .bar .hr { margin-top: 2px; font-size: 9px; }
</style>
</head><body>
<h1>🎴 Hit101 管理ダッシュボード</h1>
<p class="sub">更新: ${escapeHtml(snapshot.timestamp)} · 10秒ごと自動更新</p>

<h2>リアルタイム</h2>
<div class="stats">
  <div class="stat"><b>${fmtAge(srv.uptimeSec)}</b>稼働時間</div>
  <div class="stat"><b>${srv.connectedSockets}</b>接続中</div>
  <div class="stat"><b>${srv.totalRooms}</b>ルーム</div>
  <div class="stat"><b>${srv.matchQueueCount}</b>マッチ待機</div>
  <div class="stat"><b>${srv.memoryRssMB}MB</b>メモリ(RSS)</div>
  <div class="stat"><b>${srv.memoryHeapUsedMB}MB</b>ヒープ使用</div>
</div>

<h2>累計・アクティビティ</h2>
<div class="stats">
  <div class="stat"><b>${summary.totalPlayers}</b>登録プレイヤー</div>
  <div class="stat"><b>${summary.active1d}</b>24h アクティブ</div>
  <div class="stat"><b>${summary.active7d}</b>7日 アクティブ</div>
  <div class="stat"><b>${summary.totalPlayerGames}</b>総プレイヤー試合数</div>
</div>

<h2>進行中ルーム (${roomList.length})</h2>
${roomList.length ? `<table>
<thead><tr><th>ID</th><th>状態</th><th>ラウンド</th><th>合計</th><th>経過</th><th>プレイヤー (▶=現在手番)</th><th>操作</th></tr></thead>
<tbody>${roomRows}</tbody>
</table>` : '<p class="dim">ルームなし</p>'}

<h2>マッチング待機 (${queue.length})</h2>
<ul>${queueRows}</ul>

<h2>全プレイヤーランキング (${players.length})</h2>
<table>
<thead><tr><th>#</th><th>名前</th><th>UUID</th><th>累計pt</th><th>試合数</th><th>最終プレイ</th><th>操作</th></tr></thead>
<tbody>${playerRows || '<tr><td colspan="7" class="dim">データなし</td></tr>'}</tbody>
</table>

<h2>BAN中 (${bannedList.length})</h2>
${bannedList.length ? `<table>
<thead><tr><th>UUID</th><th>最終名</th><th>理由</th><th>BAN日時</th><th>操作</th></tr></thead>
<tbody>${bannedRows}</tbody>
</table>` : '<p class="dim">BANされたアカウントなし</p>'}

<h2>カード使用統計</h2>
${cardUsage.length ? `<table>
<thead><tr><th>ランク</th><th>使用回数</th><th>101達成</th><th>バースト</th><th>Joker100</th><th>101率</th><th>バースト率</th></tr></thead>
<tbody>${cardUsage.map(c => {
    const hit101Rate = c.plays > 0 ? ((c.hit101 + c.joker100) / c.plays * 100).toFixed(1) : '0.0';
    const burstRate = c.plays > 0 ? (c.burst / c.plays * 100).toFixed(1) : '0.0';
    return `<tr>
      <td><code>${escapeHtml(c.rank)}</code></td>
      <td>${c.plays}</td>
      <td>${c.hit101}</td>
      <td>${c.burst}</td>
      <td>${c.joker100}</td>
      <td>${hit101Rate}%</td>
      <td>${burstRate}%</td>
    </tr>`;
  }).join('')}</tbody>
</table>` : '<p class="dim">データなし</p>'}

<h2>Bot vs 人間 統計</h2>
<table>
<thead><tr><th>種別</th><th>カード使用</th><th>101/Joker勝ち</th><th>バースト</th><th>勝率</th><th>バースト率</th></tr></thead>
<tbody>${['human', 'bot'].map(t => {
    const s = typeStats[t] || { wins: 0, bursts: 0, cardPlays: 0 };
    const winRate = s.cardPlays > 0 ? (s.wins / s.cardPlays * 100).toFixed(1) : '0.0';
    const burstRate = s.cardPlays > 0 ? (s.bursts / s.cardPlays * 100).toFixed(1) : '0.0';
    return `<tr>
      <td>${t === 'bot' ? '🤖 Bot' : '👤 人間'}</td>
      <td>${s.cardPlays}</td>
      <td>${s.wins}</td>
      <td>${s.bursts}</td>
      <td>${winRate}%</td>
      <td>${burstRate}%</td>
    </tr>`;
  }).join('')}</tbody>
</table>

<h2>時間帯別アクティビティ (過去24h UTC)</h2>
<div class="hourly">${(() => {
    const maxPlays = Math.max(1, ...hourly.map(h => h.cardPlays));
    return hourly.map(h => {
      const heightPct = (h.cardPlays / maxPlays * 100).toFixed(0);
      const label = h.hour.slice(11); // 'HH'
      const title = `${h.hour} — ${h.cardPlays}プレイ / ${h.gameStarts}ゲーム開始`;
      return `<div class="bar" title="${escapeHtml(title)}">
        <div class="fill" style="height:${heightPct}%"></div>
        <span class="lbl">${h.cardPlays || ''}</span>
        <span class="hr">${label}</span>
      </div>`;
    }).join('');
  })()}</div>

<h2>監査ログ (最新${auditTail.length}件)</h2>
${auditTail.length ? `<table>
<thead><tr><th>時刻</th><th>種別</th><th>詳細</th></tr></thead>
<tbody>${auditTail.map(e => {
    if (e.error) return `<tr><td colspan="3" class="dim">読み込みエラー: ${escapeHtml(e.error)}</td></tr>`;
    if (e.raw) return `<tr><td class="dim">-</td><td class="dim">-</td><td class="dim">${escapeHtml(e.raw)}</td></tr>`;
    const ts = e.ts ? String(e.ts).slice(0, 19).replace('T', ' ') : '-';
    const type = e.type || '-';
    const rest = { ...e };
    delete rest.ts; delete rest.type;
    const detail = Object.entries(rest).map(([k, v]) => `<code>${escapeHtml(k)}</code>=${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}`).join(' ');
    return `<tr><td>${escapeHtml(ts)}</td><td><code>${escapeHtml(type)}</code></td><td>${detail}</td></tr>`;
  }).join('')}</tbody>
</table>` : '<p class="dim">ログなし</p>'}

<script>
const TOKEN = ${JSON.stringify(token)};
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.act');
  if (!btn) return;
  const action = btn.dataset.action;
  // ルーム強制終了 (UUID不要、roomId必須)
  if (action === 'close-room') {
    const roomId = btn.dataset.roomid;
    if (!roomId) return;
    if (!confirm('ルーム ' + roomId + ' を強制終了しますか？ 全プレイヤーがロビーに戻ります')) return;
    btn.disabled = true;
    try {
      const r = await fetch('/admin/close-room?t=' + encodeURIComponent(TOKEN) + '&roomId=' + encodeURIComponent(roomId), { method: 'POST' });
      const j = await r.json();
      if (j.success) location.reload();
      else alert('失敗: ' + (j.error || 'unknown'));
    } catch (err) { alert('エラー: ' + err); }
    btn.disabled = false;
    return;
  }
  const uuid = btn.dataset.uuid;
  const name = btn.dataset.name || '';
  if (!uuid) return;
  let endpoint, msg;
  if (action === 'reset-player') { endpoint = '/admin/reset-player'; msg = name + ' の統計をリセットしますか？'; }
  else if (action === 'ban') {
    endpoint = '/admin/ban';
    const reason = prompt(name + ' をBANします。理由（任意）:');
    if (reason === null) return;
    btn.disabled = true;
    try {
      const r = await fetch(endpoint + '?t=' + encodeURIComponent(TOKEN) + '&uuid=' + encodeURIComponent(uuid) + '&reason=' + encodeURIComponent(reason || ''), { method: 'POST' });
      const j = await r.json();
      if (j.success) location.reload();
      else alert('失敗: ' + (j.error || 'unknown'));
    } catch (err) { alert('エラー: ' + err); }
    btn.disabled = false;
    return;
  }
  else if (action === 'unban') { endpoint = '/admin/unban'; msg = 'このアカウントのBANを解除しますか？'; }
  else return;
  if (!confirm(msg)) return;
  btn.disabled = true;
  try {
    const r = await fetch(endpoint + '?t=' + encodeURIComponent(TOKEN) + '&uuid=' + encodeURIComponent(uuid), { method: 'POST' });
    const j = await r.json();
    if (j.success) location.reload();
    else alert('失敗: ' + (j.error || 'unknown'));
  } catch (err) { alert('エラー: ' + err); }
  btn.disabled = false;
});
</script>
</body></html>`;
}

app.get('/admin/stats', (req, res) => {
  if (!isAdminRequest(req)) return res.status(404).send('Not Found');
  const snapshot = buildAdminSnapshot();
  if (req.query.format === 'html') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.type('html').send(renderAdminHtml(snapshot, req.query.t));
  } else {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.json(snapshot);
  }
});

// 管理者用: プレイヤー統計リセット
// POST /admin/reset?t=<token>&confirm=yes&mode=all|monthly
app.post('/admin/reset', express.json({ limit: '1kb' }), (req, res) => {
  if (!isAdminRequest(req)) return res.status(404).send('Not Found');
  if (req.query.confirm !== 'yes') {
    return res.status(400).json({ error: 'confirm=yes required' });
  }
  const mode = req.query.mode === 'monthly' ? 'monthly' : 'all';
  const result = resetAllStats(mode);
  console.log(`[admin] stats reset mode=${mode} total=${result.totalDeleted} monthly=${result.monthlyDeleted}`);
  logAudit('admin-reset', { mode, ...result });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, mode, ...result });
});

// 管理者用: 個別プレイヤー統計リセット
// POST /admin/reset-player?t=<token>&uuid=<uuid>
app.post('/admin/reset-player', (req, res) => {
  if (!isAdminRequest(req)) return res.status(404).send('Not Found');
  const uuid = String(req.query.uuid || '');
  if (!isValidUUID(uuid)) return res.status(400).json({ error: 'invalid uuid' });
  const result = resetPlayerStats(uuid);
  console.log(`[admin] reset-player uuid=${uuid.slice(0, 8)} total=${result.totalDeleted} monthly=${result.monthlyDeleted}`);
  logAudit('admin-reset-player', { uuid: uuid.slice(0, 8), ...result });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, uuid, ...result });
});

// 管理者用: BAN
// POST /admin/ban?t=<token>&uuid=<uuid>&reason=<reason>
app.post('/admin/ban', (req, res) => {
  if (!isAdminRequest(req)) return res.status(404).send('Not Found');
  const uuid = String(req.query.uuid || '');
  if (!isValidUUID(uuid)) return res.status(400).json({ error: 'invalid uuid' });
  const reason = String(req.query.reason || '').slice(0, 200);
  const existing = getStats(uuid);
  banUUID(uuid, reason || null, existing?.name || null);
  // 進行中の接続があれば切断
  for (const [sid, sock] of io.sockets.sockets) {
    if (sock.data?.matchUUID === uuid || sock.data?.uuid === uuid) {
      sock.disconnect(true);
      console.log(`[admin] banned active socket ${sid}`);
    }
  }
  console.log(`[admin] ban uuid=${uuid.slice(0, 8)} reason="${reason}"`);
  logAudit('admin-ban', { uuid: uuid.slice(0, 8), reason });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, uuid, reason });
});

// 管理者用: ルーム強制終了
// POST /admin/close-room?t=<token>&roomId=<id>
app.post('/admin/close-room', (req, res) => {
  if (!isAdminRequest(req)) return res.status(404).send('Not Found');
  const roomId = String(req.query.roomId || '').toUpperCase();
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: 'room not found' });
  // プレイヤー全員にロビーへ戻る通知
  for (const p of room.players) {
    if (!p.isBot && !p.disconnected) {
      const sock = io.sockets.sockets.get(p.id);
      if (sock) {
        if (room.isMatchmaking) {
          sock.emit('return-to-matchmaking', { playerName: p.name });
        } else {
          sock.emit('return-to-lobby');
        }
        sock.data.roomId = null;
      }
    }
  }
  // 関連タイマー解放
  clearTurnTimer(roomId);
  if (botTimers.has(roomId)) { clearTimeout(botTimers.get(roomId)); botTimers.delete(roomId); }
  if (voteTimers.has(roomId)) { clearTimeout(voteTimers.get(roomId)); voteTimers.delete(roomId); }
  for (const p of room.players) {
    const timerKey = `${roomId}:${p.name}`;
    if (disconnectTimers.has(timerKey)) {
      clearTimeout(disconnectTimers.get(timerKey));
      disconnectTimers.delete(timerKey);
    }
  }
  rooms.delete(roomId);
  console.log(`[admin] close-room ${roomId}`);
  logAudit('admin-close-room', { roomId, players: room.players.map(p => p.name) });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, roomId });
});

// 管理者用: BAN解除
// POST /admin/unban?t=<token>&uuid=<uuid>
app.post('/admin/unban', (req, res) => {
  if (!isAdminRequest(req)) return res.status(404).send('Not Found');
  const uuid = String(req.query.uuid || '');
  if (!isValidUUID(uuid)) return res.status(400).json({ error: 'invalid uuid' });
  const removed = unbanUUID(uuid);
  console.log(`[admin] unban uuid=${uuid.slice(0, 8)} removed=${removed}`);
  logAudit('admin-unban', { uuid: uuid.slice(0, 8), removed });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, uuid, removed });
});

const rooms = new Map();
const voteTimers = new Map(); // roomId → 投票タイムアウトタイマー
const botTimers = new Map(); // roomId → Bot ターン遅延タイマー
const turnTimers = new Map(); // roomId → 人間プレイヤーのターン時間切れタイマー
const uuidSockets = new Map(); // uuid → Set<socketId> (多重接続検知)
const matchQueue = []; // マッチメイキング待機キュー
const matchReady = new Set(); // 準備完了のソケットID
let matchCountdownTimer = null;
let matchCountdownStartTime = null;
let matchCountdownSeconds = null;

// キュー人数に応じたカウントダウン秒数 (人数が少ないほど長く待って4人目を募る)
function getCountdownSecondsForQueue(size) {
  if (size >= MATCH_SIZE) return 5;   // 満員(4人): 即開始感覚
  if (size === 3) return 10;
  return 15;                           // 2人: 最長、追加参加の余地を残す
}
// 切断タイマー管理: `${roomId}:${playerName}` -> timer
const disconnectTimers = new Map();
// ターン自動進行タイマー (リロード復帰のため短い猶予を与える): `${roomId}:${playerName}` -> timer
const turnAdvanceTimers = new Map();
const TURN_ADVANCE_GRACE_MS = 5000;

const MATCH_SIZE = 4;

// ─── 名前バリデーション ────────────────────────────────────────
function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\x00-\x1F\x7F]/g, '').trim(); // 制御文字除去・前後空白削除
}

function validateName(name) {
  const clean = sanitizeName(name);
  if (!clean) return { ok: false, error: '名前を入力してください' };
  if (clean.length > 20) return { ok: false, error: '名前は20文字以内にしてください' };
  return { ok: true, name: clean };
}

// ─── UUID バリデーション ──────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(uuid) {
  return typeof uuid === 'string' && UUID_RE.test(uuid);
}

// ─── レート制限: ソケットID → 最終アクション時刻 ────────────────
const socketLastAction = new Map(); // socketId -> number (timestamp)

function isRateLimited(socketId, limitMs = 300) {
  const now = Date.now();
  const last = socketLastAction.get(socketId) ?? 0;
  if (now - last < limitMs) return true;
  socketLastAction.set(socketId, now);
  return false;
}

// 迷惑行為対策: uuid -> { abortCount, bannedUntil }
const matchAbuse = new Map();

function checkMatchBan(uuid) {
  if (!uuid) return null;
  const entry = matchAbuse.get(uuid);
  if (!entry?.bannedUntil) return null;
  const remaining = Math.ceil((entry.bannedUntil - Date.now()) / 1000);
  if (remaining > 0) return remaining;
  entry.bannedUntil = null;
  return null;
}

function recordMatchAbort(uuid) {
  if (!uuid) return;
  const entry = matchAbuse.get(uuid) || { abortCount: 0, bannedUntil: null };
  entry.abortCount = (entry.abortCount || 0) + 1;
  console.log(`[matchmaking] 妨害記録: ${uuid.slice(0, 8)}... (${entry.abortCount}回目)`);
  if (entry.abortCount >= 3) {
    entry.bannedUntil = Date.now() + 60_000;
    entry.abortCount = 0;
    console.log(`[matchmaking] 迷惑行為BAN: ${uuid.slice(0, 8)}... (60秒)`);
  }
  matchAbuse.set(uuid, entry);
}

// カウントダウン中に1人抜けた後、残りで継続できるか確認して処理
function handleCountdownAfterLeave() {
  if (!matchCountdownStartTime) return; // カウントダウン中でなければ何もしない
  if (matchQueue.length >= 2 && matchReady.size >= matchQueue.length) {
    // 全員まだready → カウントダウン継続
    broadcastMatchmakingState();
  } else {
    // readyでない人がいる → カウントダウンキャンセル
    cancelMatchCountdown();
    broadcastMatchmakingState();
  }
}

const RECONNECT_TIMEOUT_MS = 60000; // 60秒以内に再接続しないと脱落
const ROOM_CLEANUP_DELAY_MS = 10 * 60 * 1000; // ゲーム終了から10分後にルーム削除
const VOTE_TIMEOUT_MS = 30 * 1000; // 最初の投票から30秒でタイムアウト
const TURN_TIMEOUT_MS = 20 * 1000; // 各ターン20秒で時間切れ → 自動ドロー

// ゲーム終了後のルーム自動削除
function scheduleRoomCleanup(roomId) {
  setTimeout(() => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      // ルームに紐づく切断タイマーをすべてクリア
      if (room) {
        for (const p of room.players) {
          const timerKey = `${roomId}:${p.name}`;
          if (disconnectTimers.has(timerKey)) {
            clearTimeout(disconnectTimers.get(timerKey));
            disconnectTimers.delete(timerKey);
          }
        }
      }
      rooms.delete(roomId);
      if (botTimers.has(roomId)) { clearTimeout(botTimers.get(roomId)); botTimers.delete(roomId); }
      if (voteTimers.has(roomId)) { clearTimeout(voteTimers.get(roomId)); voteTimers.delete(roomId); }
      clearTurnTimer(roomId);
      console.log(`[cleanup] ルーム削除: ${roomId}`);
    }
  }, ROOM_CLEANUP_DELAY_MS);
}

function genRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function publicState(room, viewerId) {
  return {
    roomId: room.id,
    hostId: room.hostId,
    status: room.status,
    currentTotal: room.currentTotal,
    currentPlayerIndex: room.currentPlayerIndex,
    direction: room.direction,
    lastPlayedCard: room.lastPlayedCard,
    deckCount: room.deck.length,
    points: room.points,
    roundResult: room.roundResult,
    roundCount: room.roundCount || 0,
    votes: room.votes || {},
    voteDeadline: room.voteDeadline ?? null,
    isMatchmaking: !!room.isMatchmaking,
    cumulativeStats: room.isMatchmaking ? (room.cumulativeStats || {}) : null,
    turnDeadline: room.turnDeadline ?? null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      skill: p.skill,
      handCount: p.hand.length,
      hand: p.id === viewerId ? p.hand : null,
      lost: p.lost,
      disconnected: p.disconnected,
      isBot: !!p.isBot
    }))
  };
}

function broadcastToRoom(room) {
  scheduleTurnTimer(room);
  room.players.forEach(p => {
    if (!p.disconnected && !p.isBot) {
      io.to(p.id).emit('game-update', publicState(room, p.id));
    }
  });
  scheduleBotTurnIfNeeded(room);
  scheduleBotVotesIfNeeded(room);
}

// 直近にプレイされたカード1枚を統計に記録 (処理の直後に呼ぶ)
function trackLastCardPlay(room) {
  if (!room || !room.lastPlayedCard) return;
  const card = room.lastPlayedCard;
  const player = room.players.find(p => p.name === card.playerName);
  if (!player) return;
  const scenario = card.scenario || null; // endRound時に設定される
  try { recordCardPlay(card.rank, scenario, !!player.isBot); } catch (err) { console.error('[stats] recordCardPlay:', err); }
}

// ─── ターンタイマー ─────────────────────────────────────────
function clearTurnTimer(roomId) {
  const t = turnTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    turnTimers.delete(roomId);
  }
}

function scheduleTurnTimer(room) {
  // ゲーム進行中でなければタイマー不要
  if (room.status !== 'playing') {
    clearTurnTimer(room.id);
    room.turnDeadline = null;
    room.turnPlayerId = null;
    return;
  }
  const current = room.players[room.currentPlayerIndex];
  // Bot・脱落・切断中はタイマー不要 (Bot は自動プレイ、切断中は別機構で進行)
  if (!current || current.isBot || current.lost || current.disconnected) {
    clearTurnTimer(room.id);
    room.turnDeadline = null;
    room.turnPlayerId = null;
    return;
  }
  // 同じプレイヤーのターン継続中 (例: カードを引いて選択中) は既存タイマーを維持
  if (room.turnPlayerId === current.id && turnTimers.has(room.id)) {
    return;
  }
  // 新規 or プレイヤー交代 → 再設定
  clearTurnTimer(room.id);
  room.turnPlayerId = current.id;
  room.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
  const timer = setTimeout(() => autoDrawOnTimeout(room), TURN_TIMEOUT_MS);
  turnTimers.set(room.id, timer);
}

function autoDrawOnTimeout(room) {
  turnTimers.delete(room.id);
  if (room.status !== 'playing') return;
  const player = room.players[room.currentPlayerIndex];
  if (!player || player.isBot || player.lost || player.disconnected) return;

  try {
    if (room.pendingDrawnCard) {
      // すでにカードを引いて選択待ち → スマート選択で確定
      const choice = decideDrawnCardChoice(room.pendingDrawnCard, room.currentTotal);
      processDrawAndPlay(room, player.id, choice);
    } else {
      const result = drawFromDeck(room, player.id);
      if (result.success) {
        if (!result.needsChoice) {
          processDrawAndPlay(room, player.id, null);
        } else {
          const choice = decideDrawnCardChoice(result.card, room.currentTotal);
          processDrawAndPlay(room, player.id, choice);
        }
      }
    }
    trackLastCardPlay(room); applyRoundEndStats(room);
    room.turnDeadline = null;
    room.turnPlayerId = null;
    broadcastToRoom(room);
    logAudit('turn-timeout', { roomId: room.id, playerId: player.id, playerName: player.name });
    console.log(`[turn-timeout] ${room.id} ${player.name} 自動ドロー`);
  } catch (err) {
    console.error(`[turn-timeout] エラー(${room.id}):`, err);
  }
}

// ─── Bot ────────────────────────────────────────────────────────
function scheduleBotTurnIfNeeded(room) {
  if (room.status !== 'playing') return;
  const current = room.players[room.currentPlayerIndex];
  if (!current?.isBot || current.lost) return;
  if (botTimers.has(room.id)) return;
  const timer = setTimeout(() => {
    botTimers.delete(room.id);
    doBotTurn(room.id);
  }, 1500);
  botTimers.set(room.id, timer);
}

function scheduleBotVotesIfNeeded(room) {
  if (room.status !== 'roundEnd') return;
  const pending = room.players.filter(p => p.isBot && !p.lost && room.votes[p.name] !== 'continue');
  if (pending.length === 0) return;
  setTimeout(() => {
    if (room.status !== 'roundEnd') return;
    pending.forEach(p => { room.votes[p.name] = 'continue'; });
    const activePlayers = room.players.filter(p => !p.disconnected && !p.lost);
    const allVoted = activePlayers.every(p => room.votes[p.name] !== null);
    if (allVoted) { resolveVotes(room); } else { broadcastToRoom(room); }
  }, 800);
}

function doBotTurn(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'playing') return;
  const player = room.players[room.currentPlayerIndex];
  if (!player?.isBot || player.lost) return;

  try {
    if (room.pendingDrawnCard) {
      const choice = decideDrawnCardChoice(room.pendingDrawnCard, room.currentTotal, player.skill);
      processDrawAndPlay(room, player.id, choice);
    } else {
      const activePlayers = room.players.filter(p => !p.lost);
      const move = decideBotMove(player.hand, room.currentTotal, activePlayers.length, player.skill);
      if (move.action === 'play') {
        processPlayCard(room, player.id, move.cardId, move.choice);
      } else {
        const draw = drawFromDeck(room, player.id);
        if (draw.success) {
          if (!draw.needsChoice) {
            processDrawAndPlay(room, player.id, null);
          } else {
            const choice = decideDrawnCardChoice(draw.card, room.currentTotal, player.skill);
            processDrawAndPlay(room, player.id, choice);
          }
        }
      }
    }
    trackLastCardPlay(room); applyRoundEndStats(room);
    broadcastToRoom(room);
  } catch (err) {
    console.error(`[bot] エラー(${roomId}):`, err);
  }
}

function genBotName(room) {
  const used = new Set(room.players.map(p => p.name));
  for (let i = 1; i <= 99; i++) {
    const name = `Bot ${i}`;
    if (!used.has(name)) return name;
  }
  return `Bot ${Math.floor(Math.random() * 1000)}`;
}

function broadcastMatchmakingState() {
  const players = matchQueue.map(p => ({
    name: p.name,
    stats: p.uuid ? getStats(p.uuid) : null,
  }));
  matchQueue.forEach(p => {
    io.to(p.id).emit('matchmaking-update', {
      count: matchQueue.length,
      readyCount: matchReady.size,
      countdownStartedAt: matchCountdownStartTime,
      countdownSeconds: matchCountdownSeconds,
      players,
    });
  });
}

function cancelMatchCountdown() {
  if (matchCountdownTimer) {
    clearTimeout(matchCountdownTimer);
    matchCountdownTimer = null;
  }
  matchCountdownStartTime = null; // タイマーの有無に関わらず常にリセット
  matchCountdownSeconds = null;
}

function startMatchCountdown() {
  cancelMatchCountdown(); // 既存タイマーを必ずリセットしてから新規開始
  matchCountdownStartTime = Date.now();
  matchCountdownSeconds = getCountdownSecondsForQueue(matchQueue.length);
  console.log(`[countdown] 開始 queue=${matchQueue.length} seconds=${matchCountdownSeconds}`);
  broadcastMatchmakingState();
  matchCountdownTimer = setTimeout(() => {
    matchCountdownTimer = null;
    matchCountdownStartTime = null;
    matchCountdownSeconds = null;
    if (matchQueue.length >= 2 && matchReady.size >= matchQueue.length) {
      const matched = matchQueue.splice(0, matchQueue.length);
      matchReady.clear();
      const roomId = genRoomId();
      const gameState = createGame(matched.map(p => ({ id: p.id, name: p.name })));
      // アバターをプレイヤーオブジェクトに反映 (マッチメイキングルーム用)
      gameState.players.forEach((p) => {
        const m = matched.find((mm) => mm.name === p.name);
        if (m) p.avatar = m.avatar || '🃏';
      });
      const uuidMap = {};
      const cumulativeStats = {};
      matched.forEach(p => {
        uuidMap[p.name] = p.uuid;
        const s = p.uuid ? getStats(p.uuid) : null;
        cumulativeStats[p.name] = s ? { totalPoints: s.totalPoints, gamesPlayed: s.gamesPlayed } : { totalPoints: 0, gamesPlayed: 0 };
      });
      const room = {
        id: roomId, hostId: matched[0].id, status: 'playing',
        createdAt: Date.now(),
        ...gameState, votes: {}, roundCount: 1,
        isMatchmaking: true, uuidMap, cumulativeStats, voteDeadline: null,
      };
      rooms.set(roomId, room);
      matched.forEach(p => {
        const sock = io.sockets.sockets.get(p.id);
        if (!sock) return;
        sock.join(roomId);
        sock.data.roomId = roomId;
        sock.data.playerName = p.name;
        sock.data.inMatchmaking = false;
        io.to(p.id).emit('matchmaking-matched', { roomId, state: publicState(room, p.id) });
      });
      try { recordGameStart(); } catch (err) { console.error('[stats] recordGameStart:', err); }
      console.log(`マッチング成立 (手動開始): ${roomId}`);
    }
  }, matchCountdownSeconds * 1000);
}

// 重複なし gamesPlayed カウント（退出・自動終了・投票終了の全パスで使用）
function recordGamesPlayedOnce(room, playerName) {
  if (!room.isMatchmaking) return;
  if (!room._recordedPlayers) room._recordedPlayers = new Set();
  if (room._recordedPlayers.has(playerName)) return;
  room._recordedPlayers.add(playerName);
  const uuid = room.uuidMap?.[playerName];
  if (uuid) incrementGamesPlayed(uuid, playerName);
}

// ゲーム終了時に全プレイヤーのgamesPlayedを記録
function finalizeGamePlayed(room) {
  room.players.forEach(p => recordGamesPlayedOnce(room, p.name));
}

// 投票を解決する（全員投票 or タイムアウト時に呼ばれる）
function resolveVotes(room) {
  // タイマーをクリア
  if (voteTimers.has(room.id)) {
    clearTimeout(voteTimers.get(room.id));
    voteTimers.delete(room.id);
  }
  room.voteDeadline = null;

  const activePlayers = room.players.filter(p => !p.disconnected && !p.lost);
  const continuePlayers = activePlayers.filter(p => room.votes[p.name] === 'continue');
  const leavePlayers   = activePlayers.filter(p => room.votes[p.name] !== 'continue'); // quit or 未投票

  if (leavePlayers.length === 0) {
    // 全員続ける → 次のラウンド開始
    startNewRound(room);
    broadcastToRoom(room);
    return;
  }

  // ルームを終了状態にする（UUID重複チェックでブロックされないようにする）
  room.status = 'ended';
  finalizeGamePlayed(room);

  // やめる/未投票のプレイヤーにロビー戻りを通知してルームから除外
  for (const p of leavePlayers) {
    const sock = io.sockets.sockets.get(p.id);
    if (sock) {
      sock.emit('return-to-lobby');
      sock.leave(room.id);
    }
  }

  // 続けるプレイヤーはマッチメイキングキューへ
  for (const p of continuePlayers) {
    const sock = io.sockets.sockets.get(p.id);
    if (sock) {
      sock.emit('return-to-matchmaking', { playerName: p.name });
      sock.leave(room.id);
    }
  }
  console.log(`[vote] ${continuePlayers.length}人をマッチメイキングへ, ${leavePlayers.length}人はロビーへ: ${room.id}`);
  scheduleRoomCleanup(room.id);
}

// プレイヤー脱落後に残り人数・投票状況を確認して自動終了/ラウンド進行
function checkAfterPlayerLost(room) {
  const activePlayers = room.players.filter(p => !p.disconnected && !p.lost);
  const activeHumans = activePlayers.filter(p => !p.isBot);

  // 人間プレイヤーがいなくなったら即終了（Botだけ残っても意味がない）
  if (activeHumans.length === 0 && (room.status === 'playing' || room.status === 'roundEnd')) {
    if (voteTimers.has(room.id)) {
      clearTimeout(voteTimers.get(room.id));
      voteTimers.delete(room.id);
    }
    if (botTimers.has(room.id)) {
      clearTimeout(botTimers.get(room.id));
      botTimers.delete(room.id);
    }
    room.status = 'ended';
    finalizeGamePlayed(room);
    scheduleRoomCleanup(room.id);
    console.log(`[game] 人間プレイヤー不在のため終了: ${room.id}`);
    return;
  }

  if (activePlayers.length <= 1) {
    if (room.status === 'playing' || room.status === 'roundEnd') {
      // 投票タイマーもクリア
      if (voteTimers.has(room.id)) {
        clearTimeout(voteTimers.get(room.id));
        voteTimers.delete(room.id);
      }
      room.status = 'ended';
      finalizeGamePlayed(room);
      scheduleRoomCleanup(room.id);
      console.log(`[game] 残り1人以下のため自動終了: ${room.id}`);
    }
    return;
  }

  // roundEnd中は全員投票済みか確認
  if (room.status === 'roundEnd') {
    const allVoted = activePlayers.every(p => room.votes[p.name] !== null);
    if (allVoted) {
      resolveVotes(room);
    }
  }
}

// 退出・タイムアウトペナルティ (-2pt) を適用して脱落処理
function applyLeavePenalty(room, player) {
  const playerName = player.name;

  // -2pt ペナルティ
  room.points[playerName] = (room.points[playerName] || 0) - 2;

  // ランダムマッチは累計にも即時反映
  if (room.isMatchmaking) {
    const uuid = room.uuidMap?.[playerName];
    if (uuid) {
      const updated = updateTotalPoints(uuid, playerName, -2);
      if (updated) room.cumulativeStats[playerName] = { totalPoints: updated.totalPoints, gamesPlayed: updated.gamesPlayed };
    }
  }

  // 脱落処理
  player.lost = true;
  player.disconnected = false;
  if (player.hand) { room.discardPile.push(...player.hand); player.hand = []; }

  // 切断タイマーのクリア
  const timerKey = `${room.id}:${playerName}`;
  if (disconnectTimers.has(timerKey)) {
    clearTimeout(disconnectTimers.get(timerKey));
    disconnectTimers.delete(timerKey);
  }

  // 退出者のgamesPlayedを即時記録（自動終了時の二重カウントはrecordGamesPlayedOnceで防止）
  recordGamesPlayedOnce(room, playerName);

  advanceTurnIfNeeded(room, player);
  checkAfterPlayerLost(room);
}

// 切断プレイヤーを脱落扱いにする（ペナルティあり）
function handlePlayerTimeout(room, playerName) {
  const player = room.players.find(p => p.name === playerName);
  if (!player || !player.disconnected) return;

  console.log(`[game] タイムアウト脱落: ${playerName} (ペナルティ -2pt)`);
  applyLeavePenalty(room, player);
  broadcastToRoom(room);
}

function advanceTurnIfNeeded(room, lostPlayer) {
  if (room.status !== 'playing') return;
  if (room.players[room.currentPlayerIndex]?.name !== lostPlayer.name) return;

  const n = room.players.length;
  let next = (room.currentPlayerIndex + 1) % n;
  let tried = 0;
  while (room.players[next].lost && tried < n) {
    next = (next + 1) % n;
    tried++;
  }
  room.currentPlayerIndex = next;
}

// ラウンド終了時に累計ポイントを即時反映
function applyRoundEndStats(room) {
  if (!room.isMatchmaking || room.status !== 'roundEnd' || !room.roundResult) return;
  for (const { playerName, change } of room.roundResult.pointChanges) {
    const uuid = room.uuidMap?.[playerName];
    if (!uuid) {
      console.log(`[stats] UUID未設定のためスキップ: ${playerName}`);
      continue;
    }
    const updated = updateTotalPoints(uuid, playerName, change);
    if (updated) {
      room.cumulativeStats[playerName] = { totalPoints: updated.totalPoints, gamesPlayed: updated.gamesPlayed };
      console.log(`[stats] ${playerName}: ${change >= 0 ? '+' : ''}${change} → 累計${updated.totalPoints}pt`);
    }
  }
}

io.on('connection', (socket) => {
  console.log('接続:', socket.id);

  socket.on('create-room', ({ playerName, uuid, avatar }, cb) => {
    const v = validateName(playerName);
    if (!v.ok) return cb({ success: false, error: v.error });
    if (uuid && !isValidUUID(uuid)) return cb({ success: false, error: '無効なアカウント情報です' });
    if (uuid && isBanned(uuid)) return cb({ success: false, error: 'このアカウントはご利用いただけません' });
    const name = v.name;
    const safeAvatar = (typeof avatar === 'string' && avatar.length <= 4) ? avatar : '🃏';
    const roomId = genRoomId();
    const room = {
      id: roomId,
      hostId: socket.id,
      status: 'waiting',
      createdAt: Date.now(),
      players: [{ id: socket.id, name, avatar: safeAvatar, hand: [], lost: false, disconnected: false }],
      deck: [], discardPile: [],
      currentTotal: 0, currentPlayerIndex: 0, direction: 1,
      previousPlayerName: null, lastPlayedCard: null, pendingDrawnCard: null,
      points: { [name]: 0 },
      roundResult: null, roundCount: 0, votes: {}, voteDeadline: null,
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = name;
    socket.data.uuid = uuid;
    cb({ success: true, roomId, state: publicState(room, socket.id) });
  });

  socket.on('join-room', ({ roomId, playerName, uuid, avatar }, cb) => {
    if (typeof roomId !== 'string' || !/^[A-Z0-9]{4,8}$/i.test(roomId)) return cb({ success: false, error: '無効なルームIDです' });
    roomId = roomId.toUpperCase();
    const v = validateName(playerName);
    if (!v.ok) return cb({ success: false, error: v.error });
    if (uuid && !isValidUUID(uuid)) return cb({ success: false, error: '無効なアカウント情報です' });
    if (uuid && isBanned(uuid)) return cb({ success: false, error: 'このアカウントはご利用いただけません' });
    const name = v.name;
    const safeAvatar = (typeof avatar === 'string' && avatar.length <= 4) ? avatar : '🃏';
    const room = rooms.get(roomId);
    if (!room) return cb({ success: false, error: 'ルームが見つかりません' });
    if (room.status !== 'waiting') return cb({ success: false, error: 'ゲームはすでに開始されています' });

    // 同名プレイヤーが切断中なら席を引き継ぐ (共有リンクから別タブで入り直すケース)
    const existing = room.players.find(p => p.name === name);
    if (existing) {
      if (!existing.disconnected) {
        return cb({ success: false, error: 'その名前はすでに使われています' });
      }
      const timerKey = `${roomId}:${name}`;
      if (disconnectTimers.has(timerKey)) {
        clearTimeout(disconnectTimers.get(timerKey));
        disconnectTimers.delete(timerKey);
      }
      const oldId = existing.id;
      existing.id = socket.id;
      existing.disconnected = false;
      if (avatar) existing.avatar = safeAvatar;
      if (room.hostId === oldId) room.hostId = socket.id;
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerName = name;
      socket.data.uuid = uuid;
      broadcastToRoom(room);
      console.log(`席を引き継ぎ: ${name} (${roomId})`);
      return cb({ success: true, roomId, state: publicState(room, socket.id) });
    }

    if (room.players.length >= 6) return cb({ success: false, error: 'ルームが満員です（最大6人）' });
    room.players.push({ id: socket.id, name, avatar: safeAvatar, hand: [], lost: false, disconnected: false });
    room.points[name] = 0;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = name;
    socket.data.uuid = uuid;
    broadcastToRoom(room);
    cb({ success: true, roomId, state: publicState(room, socket.id) });
  });

  // リロード後の再接続
  socket.on('reconnect-game', ({ roomId, playerName }, cb) => {
    const v = validateName(playerName);
    if (!v.ok) return cb({ success: false, error: v.error });
    playerName = v.name;

    const room = rooms.get(roomId);
    if (!room) return cb({ success: false, error: 'ルームが見つかりません' });

    const player = room.players.find(p => p.name === playerName);
    if (!player) return cb({ success: false, error: 'プレイヤーが見つかりません' });
    if (player.lost) return cb({ success: false, error: 'すでに脱落しています' });

    // 切断タイマー & ターン進行タイマーをキャンセル
    const timerKey = `${roomId}:${playerName}`;
    if (disconnectTimers.has(timerKey)) {
      clearTimeout(disconnectTimers.get(timerKey));
      disconnectTimers.delete(timerKey);
    }
    if (turnAdvanceTimers.has(timerKey)) {
      clearTimeout(turnAdvanceTimers.get(timerKey));
      turnAdvanceTimers.delete(timerKey);
    }

    // ソケットIDを更新
    const oldId = player.id;
    player.id = socket.id;
    player.disconnected = false;
    if (room.hostId === oldId) room.hostId = socket.id;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;

    broadcastToRoom(room);
    cb({ success: true, roomId, state: publicState(room, socket.id) });
    console.log(`再接続: ${playerName} (${roomId})`);
  });

  socket.on('join-matchmaking', ({ playerName, uuid, avatar }, cb) => {
    // 名前バリデーション
    const v = validateName(playerName);
    if (!v.ok) return cb?.({ success: false, error: v.error });
    const name = v.name;

    // すでにキューにいる場合は無視
    // すでにキューにいる場合は一度削除して再登録（return-to-matchmaking後の重複対策）
    const existingIdx = matchQueue.findIndex(p => p.id === socket.id);
    if (existingIdx !== -1) matchQueue.splice(existingIdx, 1);

    // UUID フォーマット検証
    if (uuid && !isValidUUID(uuid)) return cb?.({ success: false, error: '無効なアカウント情報です。ページを再読み込みしてください' });

    // 管理者BAN (永続)
    if (uuid && isBanned(uuid)) return cb?.({ success: false, error: 'このアカウントはご利用いただけません' });

    // 迷惑行為BAN (一時)
    const banLeft = checkMatchBan(uuid);
    if (banLeft) return cb?.({ success: false, error: `迷惑行為のため${banLeft}秒間マッチングを利用できません` });

    // 満員(4人)でカウントダウン中は参加不可 (それ未満なら受け入れる)
    if (matchCountdownStartTime && matchQueue.length >= MATCH_SIZE) {
      return cb?.({ success: false, error: 'まもなくゲームが始まります。少し待ってから参加してください' });
    }

    // 多重接続検知: 同じUUIDが既にマッチキューまたはゲーム中の場合
    if (uuid) {
      const existingInQueue = matchQueue.find(p => p.uuid === uuid);
      if (existingInQueue) {
        logAudit('uuid-multi-queue', { uuid: uuid.slice(0, 8), socketId: socket.id, existing: existingInQueue.id });
        return cb?.({ success: false, error: '同じアカウントは同時にマッチできません' });
      }
      // 進行中のルームでまだアクティブ(非lost・非disconnected)な場合のみブロック
      let inGame = null;
      for (const room of rooms.values()) {
        if (!room.isMatchmaking || !room.uuidMap) continue;
        if (room.status !== 'playing' && room.status !== 'roundEnd') continue;
        for (const [n, u] of Object.entries(room.uuidMap)) {
          if (u !== uuid) continue;
          const player = room.players.find(p => p.name === n);
          if (player && !player.lost && !player.disconnected) {
            inGame = { roomId: room.id, name: n };
          }
          break;
        }
        if (inGame) break;
      }
      if (inGame) {
        logAudit('uuid-already-ingame', { uuid: uuid.slice(0, 8), socketId: socket.id, roomId: inGame.roomId });
        return cb?.({ success: false, error: '既に別の端末でプレイ中です' });
      }
    }
    const safeAvatar = (typeof avatar === 'string' && avatar.length <= 4) ? avatar : '🃏';
    matchQueue.push({ id: socket.id, name, uuid: uuid || null, avatar: safeAvatar });
    console.log(`[matchmaking] 参加: ${name} (uuid: ${uuid ? uuid.slice(0, 8) + '...' : 'なし'})`);
    socket.data.inMatchmaking = true;
    socket.data.uuid = uuid;
    socket.data.avatar = safeAvatar;
    socket.data.playerName = name;
    socket.data.matchUUID = uuid || null;

    // 新規参加者がいるのでカウントダウンをキャンセルして通知
    cancelMatchCountdown();
    broadcastMatchmakingState();
    cb?.({ success: true, count: matchQueue.length });

    // 4人揃ったら5秒カウントダウン後にゲーム開始
    if (matchQueue.length >= MATCH_SIZE) {
      matchQueue.forEach(p => matchReady.add(p.id));
      startMatchCountdown();
      console.log(`マッチング満員: カウントダウン開始`);
    }
  });

  socket.on('ready-matchmaking', (cb) => {
    if (!matchQueue.find(p => p.id === socket.id)) return cb?.({ success: false, error: 'マッチングに参加していません' });
    matchReady.add(socket.id);
    broadcastMatchmakingState();
    // カウントダウン中は再起動しない（スパム連打でリセットされるのを防ぐ）
    if (!matchCountdownStartTime && matchQueue.length >= 2 && matchReady.size >= matchQueue.length) {
      startMatchCountdown();
    }
    cb?.({ success: true });
  });

  socket.on('unready-matchmaking', (cb) => {
    // カウントダウン中はunready不可
    if (matchCountdownStartTime) {
      return cb?.({ success: false, error: 'カウントダウン中は準備を取り消せません' });
    }
    matchReady.delete(socket.id);
    cancelMatchCountdown();
    broadcastMatchmakingState();
    cb?.({ success: true });
  });

  socket.on('leave-matchmaking', (cb) => {
    const idx = matchQueue.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      const wasInCountdown = !!matchCountdownStartTime;
      const player = matchQueue[idx];
      matchQueue.splice(idx, 1);
      matchReady.delete(socket.id);
      socket.data.inMatchmaking = false;
      if (wasInCountdown) {
        recordMatchAbort(player.uuid);
        handleCountdownAfterLeave();
      } else {
        cancelMatchCountdown();
        broadcastMatchmakingState();
      }
    }
    cb?.({ success: true });
  });

  socket.on('leave-game', (cb) => {
    cb?.(); // 即座にack
    const roomId = socket.data?.roomId;
    const playerName = socket.data?.playerName;
    if (!roomId || !playerName) return;

    const room = rooms.get(roomId);
    if (!room) return;
    if (room.status !== 'playing' && room.status !== 'roundEnd') return;

    const player = room.players.find(p => p.name === playerName);
    if (!player || player.lost) return;

    console.log(`[game] 退出: ${playerName} (ペナルティ -2pt)`);
    applyLeavePenalty(room, player);
    broadcastToRoom(room);

    socket.data.roomId = null;
    socket.data.playerName = null;
  });

  socket.on('add-bot', ({ roomId, skill }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ success: false, error: 'ルームが見つかりません' });
    if (room.isMatchmaking) return cb?.({ success: false, error: 'マッチング中はBotを追加できません' });
    if (room.hostId !== socket.id) return cb?.({ success: false, error: 'ホストのみBotを追加できます' });
    if (room.status !== 'waiting') return cb?.({ success: false, error: '待機中のみ追加できます' });
    if (room.players.length >= 6) return cb?.({ success: false, error: 'ルームが満員です' });
    const safeSkill = SKILL_KEYS.includes(skill) ? skill : 'intermediate';
    const name = genBotName(room);
    const id = `bot:${roomId}:${Date.now()}:${Math.floor(Math.random() * 1000)}`;
    room.players.push({ id, name, hand: [], lost: false, disconnected: false, isBot: true, skill: safeSkill });
    room.points[name] = 0;
    broadcastToRoom(room);
    cb?.({ success: true });
  });

  socket.on('remove-bot', ({ roomId, botName }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ success: false, error: 'ルームが見つかりません' });
    if (room.hostId !== socket.id) return cb?.({ success: false, error: 'ホストのみ操作できます' });
    if (room.status !== 'waiting') return cb?.({ success: false, error: '待機中のみ操作できます' });
    const idx = room.players.findIndex(p => p.isBot && p.name === botName);
    if (idx === -1) return cb?.({ success: false, error: 'Botが見つかりません' });
    room.players.splice(idx, 1);
    delete room.points[botName];
    broadcastToRoom(room);
    cb?.({ success: true });
  });

  socket.on('start-game', ({ roomId }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ success: false, error: 'ルームが見つかりません' });
    if (room.hostId !== socket.id) return cb?.({ success: false, error: 'ホストのみゲームを開始できます' });
    if (room.players.length < 2) return cb?.({ success: false, error: '2人以上必要です' });

    const gameState = createGame(room.players);
    Object.assign(room, gameState, { status: 'playing' });
    try { recordGameStart(); } catch (err) { console.error('[stats] recordGameStart:', err); }
    broadcastToRoom(room);
    cb?.({ success: true });
  });

  socket.on('vote', ({ roomId, vote }, cb) => {
    if (isRateLimited(socket.id, 200)) return cb?.({ success: false, error: '操作が早すぎます' });
    const room = rooms.get(roomId);
    if (!room || room.status !== 'roundEnd') return cb?.({ success: false, error: 'ラウンド終了中ではありません' });

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.lost) return cb?.({ success: false, error: 'プレイヤーが見つかりません' });

    room.votes[player.name] = vote; // 'continue' or 'quit'

    const activePlayers = room.players.filter(p => !p.disconnected && !p.lost);

    // 初めての投票 → 30秒カウントダウン開始
    const votedCount = activePlayers.filter(p => room.votes[p.name] !== null).length;
    if (votedCount === 1 && !voteTimers.has(room.id)) {
      const deadline = Date.now() + VOTE_TIMEOUT_MS;
      room.voteDeadline = deadline;
      const timer = setTimeout(() => {
        voteTimers.delete(room.id);
        if (room.status === 'roundEnd') resolveVotes(room);
      }, VOTE_TIMEOUT_MS);
      voteTimers.set(room.id, timer);
    }

    // 全員投票済み → ブロードキャスト後に即時解決
    const allVoted = activePlayers.every(p => room.votes[p.name] !== null);
    broadcastToRoom(room);
    if (allVoted) {
      resolveVotes(room);
    }
    cb?.({ success: true });
  });

  socket.on('play-card', ({ roomId, cardId, choice }, cb) => {
    recordAction(socket.id);
    if (isSuspiciousBurst(socket.id)) {
      logAudit('burst', { socketId: socket.id, uuid: socket.data?.matchUUID, roomId, event: 'play-card' });
    }
    if (isRateLimited(socket.id)) return cb?.({ success: false, error: '操作が早すぎます' });
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return cb?.({ success: false, error: 'ゲームが進行中ではありません' });
    const result = processPlayCard(room, socket.id, cardId, choice);
    if (!result.success) {
      logAudit('play-invalid', { socketId: socket.id, uuid: socket.data?.matchUUID, roomId, cardId, choice, error: result.error });
      return cb?.({ success: false, error: result.error });
    }
    trackLastCardPlay(room); applyRoundEndStats(room);
    broadcastToRoom(room);
    cb?.({ success: true });
  });

  socket.on('draw-from-deck', ({ roomId }, cb) => {
    recordAction(socket.id);
    if (isSuspiciousBurst(socket.id)) {
      logAudit('burst', { socketId: socket.id, uuid: socket.data?.matchUUID, roomId, event: 'draw-from-deck' });
    }
    if (isRateLimited(socket.id)) return cb?.({ success: false, error: '操作が早すぎます' });
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return cb?.({ success: false, error: 'ゲームが進行中ではありません' });
    const result = drawFromDeck(room, socket.id);
    if (!result.success) {
      logAudit('draw-invalid', { socketId: socket.id, uuid: socket.data?.matchUUID, roomId, error: result.error });
      return cb?.({ success: false, error: result.error });
    }

    if (!result.needsChoice) {
      const playResult = processDrawAndPlay(room, socket.id, null);
      if (!playResult.success) return cb?.({ success: false, error: playResult.error });
      trackLastCardPlay(room); applyRoundEndStats(room);
    }

    broadcastToRoom(room);
    cb?.({ success: true, card: result.card, needsChoice: result.needsChoice });
  });

  socket.on('play-drawn-card', ({ roomId, choice }, cb) => {
    recordAction(socket.id);
    if (isRateLimited(socket.id)) return cb?.({ success: false, error: '操作が早すぎます' });
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return cb?.({ success: false, error: 'ゲームが進行中ではありません' });
    const result = processDrawAndPlay(room, socket.id, choice);
    if (!result.success) {
      logAudit('play-drawn-invalid', { socketId: socket.id, uuid: socket.data?.matchUUID, roomId, choice, error: result.error });
      return cb?.({ success: false, error: result.error });
    }
    trackLastCardPlay(room); applyRoundEndStats(room);
    broadcastToRoom(room);
    cb?.({ success: true });
  });

  socket.on('get-player-stats', ({ uuid }, cb) => {
    cb?.(getStats(uuid));
  });

  socket.on('get-leaderboard', (data, cb) => {
    // 旧API: string or { uuid } → 新API: { uuid, limit, offset, minGames, sinceDays, sort }
    let opts;
    if (typeof data === 'string') opts = { myUUID: data };
    else opts = {
      myUUID: data?.uuid ?? null,
      limit: data?.limit ?? 20,
      offset: data?.offset ?? 0,
      minGames: data?.minGames ?? 0,
      sinceDays: data?.sinceDays ?? 0,
      sort: data?.sort ?? 'points',
      period: data?.period ?? 'all',
      month: data?.month ?? null,
    };
    cb?.(getLeaderboard(opts));
  });

  socket.on('disconnect', () => {
    console.log('切断:', socket.id);
    socketLastAction.delete(socket.id); // レート制限エントリのクリーンアップ
    clearAction(socket.id);

    // マッチメイキングキューから削除
    const qIdx = matchQueue.findIndex(p => p.id === socket.id);
    if (qIdx !== -1) {
      const wasInCountdown = !!matchCountdownStartTime;
      const player = matchQueue[qIdx];
      matchQueue.splice(qIdx, 1);
      matchReady.delete(socket.id);
      if (wasInCountdown) {
        recordMatchAbort(player.uuid);
        handleCountdownAfterLeave();
      } else {
        cancelMatchCountdown();
        broadcastMatchmakingState();
      }
    }

    const roomId = socket.data?.roomId;
    const playerName = socket.data?.playerName;
    if (!roomId || !playerName) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.status === 'waiting') {
      // 待機中も切断フラグを立てて 60 秒待つ (共有シートで一時的に socket が落ちる
      // ケースで部屋ごと消えてしまうのを防ぐ)
      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;
      player.disconnected = true;
      console.log(`切断待機中 (waiting): ${playerName} (${RECONNECT_TIMEOUT_MS / 1000}秒以内に再接続)`);
      broadcastToRoom(room);

      const timerKey = `${roomId}:${playerName}`;
      if (disconnectTimers.has(timerKey)) clearTimeout(disconnectTimers.get(timerKey));
      const timer = setTimeout(() => {
        disconnectTimers.delete(timerKey);
        const r = rooms.get(roomId);
        if (!r) return;
        // 既に再接続してたら何もしない
        const p = r.players.find(pp => pp.name === playerName);
        if (!p || !p.disconnected) return;
        // 完全削除
        r.players = r.players.filter(pp => pp.id !== p.id);
        delete r.points[playerName];
        // 待機中なので脱落ペナルティ等は無し (ゲームが始まってないため)
        const hasHuman = r.players.some(pp => !pp.isBot);
        if (!hasHuman) {
          rooms.delete(roomId);
          if (botTimers.has(roomId)) { clearTimeout(botTimers.get(roomId)); botTimers.delete(roomId); }
          console.log(`[cleanup] 待機中の人間が居なくなったため削除: ${roomId}`);
          return;
        }
        if (r.hostId === p.id) {
          const nextHost = r.players.find(pp => !pp.isBot);
          if (nextHost) r.hostId = nextHost.id;
        }
        broadcastToRoom(r);
        console.log(`脱落 (waiting タイムアウト): ${playerName}`);
      }, RECONNECT_TIMEOUT_MS);
      disconnectTimers.set(timerKey, timer);
    } else {
      // ゲーム中は切断フラグを立てて60秒待つ
      const player = room.players.find(p => p.name === playerName);
      if (!player || player.lost) return;

      player.disconnected = true;
      console.log(`切断待機中: ${playerName} (${RECONNECT_TIMEOUT_MS / 1000}秒以内に再接続してください)`);
      broadcastToRoom(room); // disconnected フラグを他プレイヤーに通知

      // 切断時にターンが来ていた場合: 即座に進めず、リロード復帰のため数秒待つ
      const timerKey = `${roomId}:${playerName}`;
      const wasCurrentTurn = room.status === 'playing' && room.players[room.currentPlayerIndex]?.name === playerName;
      if (wasCurrentTurn) {
        if (turnAdvanceTimers.has(timerKey)) clearTimeout(turnAdvanceTimers.get(timerKey));
        const turnTimer = setTimeout(() => {
          turnAdvanceTimers.delete(timerKey);
          const r = rooms.get(roomId);
          if (!r) return;
          const p = r.players.find(pp => pp.name === playerName);
          if (!p || !p.disconnected) return; // 復帰してたら何もしない
          if (r.players[r.currentPlayerIndex]?.name !== playerName) return; // ターン既に動いてる
          advanceTurnIfNeeded(r, p);
          broadcastToRoom(r);
          scheduleBotTurnIfNeeded(r);
        }, TURN_ADVANCE_GRACE_MS);
        turnAdvanceTimers.set(timerKey, turnTimer);
      }

      // タイムアウト後に脱落（既存タイマーがあれば先にクリア）
      if (disconnectTimers.has(timerKey)) {
        clearTimeout(disconnectTimers.get(timerKey));
      }
      const timer = setTimeout(() => {
        disconnectTimers.delete(timerKey);
        // ターン進行タイマーも片付け
        if (turnAdvanceTimers.has(timerKey)) {
          clearTimeout(turnAdvanceTimers.get(timerKey));
          turnAdvanceTimers.delete(timerKey);
        }
        handlePlayerTimeout(room, playerName);
        console.log(`脱落: ${playerName} (タイムアウト)`);
      }, RECONNECT_TIMEOUT_MS);
      disconnectTimers.set(timerKey, timer);
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`サーバー起動: http://localhost:${PORT}`));
