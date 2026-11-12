// Kanka Chat: oyunların kendi yerel servislerinden zengin etkinlik bilgisi
// League of Legends (istemci + maç içi API), Valorant (Riot Client), CS2 (Game State Integration)
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Oyunların yerel servisleri kendinden imzalı sertifika kullanır; sadece 127.0.0.1 için doğrulama atlanır
function local(port, p, auth, timeout = 1500) {
  return new Promise(res => {
    const req = https.request({ host: '127.0.0.1', port, path: p, method: 'GET', rejectUnauthorized: false, timeout,
      headers: auth ? { Authorization: 'Basic ' + Buffer.from(auth).toString('base64'), Accept: 'application/json' } : { Accept: 'application/json' } }, r => {
      let d = ''; r.setEncoding('utf8'); r.on('data', c => d += c);
      r.on('end', () => { if (r.statusCode >= 400) return res(null); try { res(JSON.parse(d)); } catch { res(null); } });
    });
    req.on('error', () => res(null)); req.on('timeout', () => { req.destroy(); res(null); }); req.end();
  });
}
// Biten maçlar burada birikir; main.js sunucuya gönderince siler (maç sonu kartı)
const matches = [], sentKeys = new Set();
function pushMatch(m) {
  if (!m?.key || sentKeys.has(m.key)) return;
  sentKeys.add(m.key); if (sentKeys.size > 50) sentKeys.delete(sentKeys.values().next().value);
  matches.push({ ...m, at: Date.now() }); if (matches.length > 5) matches.shift();
}
const getJSON = async (url, ms = 6000) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? r.json() : null; } catch { return null; } };

// ---------------- League of Legends ----------------
const LOL_TIER = { IRON: 'Demir', BRONZE: 'Bronz', SILVER: 'Gümüş', GOLD: 'Altın', PLATINUM: 'Platin', EMERALD: 'Zümrüt', DIAMOND: 'Elmas', MASTER: 'Ustalık', GRANDMASTER: 'Büyük Ustalık', CHALLENGER: 'Şampiyonluk' };
const LOL_PHASE = { Lobby: 'Lobide', Matchmaking: 'Maç arıyor', ReadyCheck: 'Maç bulundu', ChampSelect: 'Şampiyon seçiyor', GameStart: 'Maç yükleniyor', InProgress: 'Maçta', Reconnect: 'Maça dönüyor', WaitingForStats: 'Maç bitti', PreEndOfGame: 'Maç bitti', EndOfGame: 'Maç bitti' };
let ddTry = 0, lcu = null, champs = null, ddVer = null, lolStart = null, lolPhaseWas = null;
let lolGame = null, lolPend = null; // maç sürerken son bilinen durum / maç bitti, derece güncellemesi bekleniyor
const qKey = q => q ? `${q.tier}|${q.division}|${q.leaguePoints}|${q.wins}|${q.losses}` : '';
function lolRankChange(a, b) {
  if (!a || !b || !LOL_TIER[b.tier]) return null;
  const before = rankText(a), after = rankText(b);
  if (!LOL_TIER[a.tier]) return { after, dir: 'up', text: 'Yerleşti' };
  const same = a.tier === b.tier && a.division === b.division;
  if (same) { const d = (b.leaguePoints ?? 0) - (a.leaguePoints ?? 0); return d ? { before, after, delta: d, dir: d > 0 ? 'up' : 'down' } : null; }
  const order = Object.keys(LOL_TIER), DIV = ['IV', 'III', 'II', 'I'], val = q => order.indexOf(q.tier) * 4 + Math.max(0, DIV.indexOf(q.division));
  return { before, after, dir: val(b) > val(a) ? 'up' : 'down', text: val(b) > val(a) ? 'Terfi etti' : 'Düştü' };
}
const rankText = q => q && LOL_TIER[q.tier] ? `${LOL_TIER[q.tier]}${['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(q.tier) ? '' : ' ' + (q.division || '')} · ${q.leaguePoints ?? 0} LP`.replace('  ', ' ') : null;
async function champImg(alias) {
  if (!alias) return null;
  if (!ddVer && Date.now() - ddTry > 10 * 60e3) { ddTry = Date.now(); const v = await getJSON('https://ddragon.leagueoflegends.com/api/versions.json'); ddVer = v?.[0] || null; }
  return ddVer ? `https://ddragon.leagueoflegends.com/cdn/${ddVer}/img/champion/${alias}.png` : null;
}
// LeagueClientUx komut satırından port ve anahtar: --app-port=X --remoting-auth-token=Y
function lolAuth(cmdline) {
  const port = cmdline.match(/--app-port=(\d+)/)?.[1], token = cmdline.match(/--remoting-auth-token=([\w-]+)/)?.[1];
  return port && token ? { port: +port, auth: 'riot:' + token } : null;
}
async function lolRich(getCmdline) {
  if (!lcu) { const c = await getCmdline(); lcu = c && lolAuth(c); if (!lcu) return null; }
  const q = p => local(lcu.port, p, lcu.auth);
  const phase = await q('/lol-gameflow/v1/gameflow-phase');
  if (typeof phase !== 'string') { lcu = null; return null; } // istemci kapandı ya da yeniden başladı
  if (phase !== lolPhaseWas) { lolPhaseWas = phase; if (phase !== 'InProgress') lolStart = null; }
  if (!champs) { const list = await q('/lol-game-data/assets/v1/champion-summary.json'); if (Array.isArray(list)) champs = Object.fromEntries(list.map(c => [c.id, { name: c.name, alias: c.alias }])); }
  const [sess, ranked] = await Promise.all([q('/lol-gameflow/v1/session'), q('/lol-ranked/v1/current-ranked-stats')]);
  const queue = sess?.gameData?.queue || {}, solo = ranked?.queueMap?.RANKED_SOLO_5x5, thisQ = queue.type && ranked?.queueMap?.[queue.type];
  const rank = rankText(thisQ?.tier && thisQ.tier !== 'NONE' ? thisQ : solo);
  const out = { phase, mode: queue.description || queue.shortName || (phase === 'Lobby' ? '' : null), ranked: !!queue.isRanked, rank, state: LOL_PHASE[phase] || null };
  let champ = null;
  if (phase === 'ChampSelect') {
    const cs = await q('/lol-champ-select/v1/session');
    const me = cs?.myTeam?.find(x => x.cellId === cs.localPlayerCellId);
    const id = me?.championId || me?.championPickIntent;
    if (id && champs?.[id]) { champ = champs[id]; out.state = me.championId ? `${champ.name} seçti` : `${champ.name} düşünüyor`; }
  }
  if (['InProgress', 'Reconnect'].includes(phase)) {
    const live = await local(2999, '/liveclientdata/allgamedata', null, 1200);
    if (live?.activePlayer) {
      const id = live.activePlayer.riotId || live.activePlayer.summonerName;
      const p = live.allPlayers?.find(x => (x.riotId || x.summonerName) === id);
      if (p) {
        const alias = (p.rawChampionName || '').replace('game_character_displayname_', '') || null;
        champ = { name: p.championName, alias };
        const s = p.scores || {};
        out.state = `${p.championName} · ${s.kills ?? 0}/${s.deaths ?? 0}/${s.assists ?? 0}`;
        out.kda = [s.kills ?? 0, s.deaths ?? 0, s.assists ?? 0]; out.level = p.level || null;
      }
      if (live.gameData?.gameTime != null) lolStart = Date.now() - Math.round(live.gameData.gameTime * 1000);
    } else {
      const sel = sess?.gameData?.playerChampionSelections, myPuuid = (await q('/lol-summoner/v1/current-summoner'))?.puuid;
      const mine = sel?.find(x => x.puuid === myPuuid) || null;
      if (mine?.championId && champs?.[mine.championId]) { champ = champs[mine.championId]; out.state = `${champ.name} · Yükleniyor`; }
    }
    lolStart ||= Date.now();
  }
  if (champ) { out.champ = champ.name; out.img = await champImg(champ.alias); }
  out.start = lolStart;
  // ---- Maç sonu kartı ----
  if (['InProgress', 'Reconnect'].includes(phase) && sess?.gameData?.gameId) {
    const g = (lolGame?.id === sess.gameData.gameId ? lolGame : null) || { id: sess.gameData.gameId, rankQ: queue.type, rankBefore: thisQ || null, start: Date.now() };
    Object.assign(g, { mode: out.mode, ranked: out.ranked, champ: out.champ || g.champ, img: out.img || g.img, kda: out.kda || g.kda, level: out.level || g.level });
    lolGame = g;
  }
  if (['WaitingForStats', 'PreEndOfGame', 'EndOfGame'].includes(phase) && lolGame && !lolPend) {
    const eog = await q('/lol-end-of-game/v1/eog-stats-block');
    if (eog?.localPlayer || phase === 'EndOfGame' || Date.now() - (lolGame.endSeen ||= Date.now()) > 90e3) {
      const lp = eog?.localPlayer || {}, st = lp.stats || {};
      const myTeam = lp.teamId ?? eog?.teams?.find(t => t.players?.some(x => x.puuid && x.puuid === lp.puuid))?.teamId;
      let win = null;
      if (Array.isArray(eog?.teams) && myTeam != null) { const t = eog.teams.find(t => t.teamId === myTeam); if (t && typeof t.isWinningTeam === 'boolean') win = t.isWinningTeam; }
      if (win == null && st.WIN != null) win = !!+st.WIN;
      if (win == null && st.LOSE != null) win = !+st.LOSE;
      const ch = lp.championId && champs?.[lp.championId];
      const len = +eog?.gameLength || Math.round((Date.now() - (lolGame.start || Date.now())) / 1000);
      const kda = st.CHAMPIONS_KILLED != null ? [+st.CHAMPIONS_KILLED || 0, +st.NUM_DEATHS || 0, +st.ASSISTS || 0] : lolGame.kda;
      const cs = st.MINIONS_KILLED != null ? (+st.MINIONS_KILLED || 0) + (+st.NEUTRAL_MINIONS_KILLED || 0) : null;
      const remake = len < 300 || eog?.gameEndedInEarlySurrender && len < 420;
      if (win != null && !remake) {
        lolPend = { at: Date.now(), m: { key: 'lol:' + lolGame.id, game: 'League of Legends', result: win ? 'win' : 'loss', mode: lolGame.mode, ranked: lolGame.ranked,
          champ: ch?.name || lolGame.champ, img: ch ? await champImg(ch.alias) : lolGame.img, kda, dur: len,
          extra: [cs != null ? `${cs} CS` : null, st.LEVEL || lolGame.level ? `Sv ${st.LEVEL || lolGame.level}` : null, st.GOLD_EARNED ? `${(st.GOLD_EARNED / 1000).toFixed(1)}k altın` : null].filter(Boolean) },
          rankQ: lolGame.rankQ, before: lolGame.rankBefore };
      }
      lolGame = null;
    }
  }
  if (lolPend) { // dereceli ise LP güncellenene kadar (en çok 75 sn) bekle
    const p = lolPend, now = p.before && p.m.ranked ? ranked?.queueMap?.[p.rankQ] : null;
    if (!p.m.ranked || !p.before || (now && qKey(now) !== qKey(p.before)) || Date.now() - p.at > 75e3) {
      if (now) p.m.rank = lolRankChange(p.before, now) || { after: rankText(now) };
      pushMatch(p.m); lolPend = null;
    }
  }
  return out;
}

// ---------------- Valorant ----------------
const VAL_MAP = { Ascent: 'Ascent', Duality: 'Bind', Triad: 'Haven', Bonsai: 'Split', Port: 'Icebox', Foxtrot: 'Breeze', Canyon: 'Fracture', Pitt: 'Pearl', Jam: 'Lotus', Juliett: 'Sunset', Infinity: 'Abyss', Rook: 'Corrode', Range: 'Atış poligonu', HURM_Alley: 'District', HURM_Bowl: 'Kasbah', HURM_Yard: 'Piazza', HURM_Helix: 'Drift', HURM_HighTide: 'Glitch' };
const VAL_Q = { competitive: 'Rekabetçi', unrated: 'Derecesiz', swiftplay: 'Hızlı oyun', spikerush: 'Spike Rush', deathmatch: 'Ölüm maçı', ggteam: 'Tırmanış', hurm: 'Takım ölüm maçı', premier: 'Premier', onefa: 'Kopya', snowball: 'Kartopu', newmap: 'Yeni harita', '': 'Özel oyun' };
const VAL_TIERS = ['Derecesiz', '', '', 'Demir 1', 'Demir 2', 'Demir 3', 'Bronz 1', 'Bronz 2', 'Bronz 3', 'Gümüş 1', 'Gümüş 2', 'Gümüş 3', 'Altın 1', 'Altın 2', 'Altın 3', 'Platin 1', 'Platin 2', 'Platin 3',
  'Elmas 1', 'Elmas 2', 'Elmas 3', 'Yücelik 1', 'Yücelik 2', 'Yücelik 3', 'Ölümsüzlük 1', 'Ölümsüzlük 2', 'Ölümsüzlük 3', 'Radyant'];
const VAL_STATE = { MENUS: 'Menüde', PREGAME: 'Ajan seçiyor', INGAME: 'Maçta' };
let valStart = null, valWas = null, valGame = null;
// Maç bitince ayrıntılar Riot'un oyuncu verisi servisinden (oyunun kendi kullandığı, oturum anahtarı yerel istemciden)
let valVer = null, valVerAt = 0, valAgents = null;
async function valDetails(port, auth, since) {
  try {
    const [tok, sess] = await Promise.all([local(port, '/entitlements/v1/token', auth), local(port, '/product-session/v1/external-sessions', auth)]);
    if (!tok?.accessToken) return null;
    const args = Object.values(sess || {}).flatMap(x => x?.launchConfiguration?.arguments || []).join(' ');
    const region = args.match(/-ares-deployment=(\w+)/)?.[1] || 'eu', shard = { latam: 'na', br: 'na', na: 'na', eu: 'eu', ap: 'ap', kr: 'kr' }[region] || 'eu';
    if (!valVer || Date.now() - valVerAt > 6 * 3600e3) { const v = await getJSON('https://valorant-api.com/v1/version'); if (v?.data?.riotClientVersion) { valVer = v.data.riotClientVersion; valVerAt = Date.now(); } }
    const H = { Authorization: 'Bearer ' + tok.accessToken, 'X-Riot-Entitlements-JWT': tok.token, 'X-Riot-ClientVersion': valVer || '',
      'X-Riot-ClientPlatform': 'ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9' };
    const pd = async u => { try { const r = await fetch(`https://pd.${shard}.a.pvp.net${u}`, { headers: H, signal: AbortSignal.timeout(8000) }); return r.ok ? r.json() : null; } catch { return null; } };
    const puuid = tok.subject;
    const hist = await pd(`/match-history/v1/history/${puuid}?startIndex=0&endIndex=1`);
    const last = hist?.History?.[0]; if (!last || last.GameStartTime < since - 10 * 60e3) return null;
    const md = await pd(`/match-details/v1/matches/${last.MatchID}`); if (!md?.players) return null;
    const me = md.players.find(p => p.subject === puuid); if (!me) return null;
    const team = md.teams?.find(t => t.teamId === me.teamId), other = md.teams?.find(t => t.teamId !== me.teamId);
    if (!valAgents) { const a = await getJSON('https://valorant-api.com/v1/agents?language=tr-TR&isPlayableCharacter=true'); if (Array.isArray(a?.data)) valAgents = Object.fromEntries(a.data.map(x => [x.uuid.toLowerCase(), x])); }
    const ag = valAgents?.[String(me.characterId).toLowerCase()];
    const out = { id: last.MatchID, agent: ag?.displayName || null, img: ag?.displayIconSmall || ag?.displayIcon || null,
      kda: [me.stats?.kills || 0, me.stats?.deaths || 0, me.stats?.assists || 0], score: team && other ? [team.roundsWon, other.roundsWon] : null,
      win: team ? !!team.won : null, draw: team && other && !team.won && !other.won, dur: Math.round((md.matchInfo?.gameLengthMillis || 0) / 1000) || null,
      acs: me.stats?.score && me.stats.roundsPlayed ? Math.round(me.stats.score / me.stats.roundsPlayed) : null };
    if (md.matchInfo?.isRanked) {
      const cu = await pd(`/mmr/v1/players/${puuid}/competitiveupdates?startIndex=0&endIndex=1&queue=competitive`);
      const u = cu?.Matches?.[0];
      if (u && u.MatchID === last.MatchID) {
        const b = VAL_TIERS[u.TierBeforeUpdate], a = VAL_TIERS[u.TierAfterUpdate], d = u.RankedRatingEarned;
        out.rank = u.TierAfterUpdate !== u.TierBeforeUpdate ? { before: b, after: `${a} · ${u.RankedRatingAfterUpdate} RR`, dir: u.TierAfterUpdate > u.TierBeforeUpdate ? 'up' : 'down', text: u.TierAfterUpdate > u.TierBeforeUpdate ? 'Terfi etti' : 'Düştü' }
          : { before: `${b} · ${u.RankedRatingBeforeUpdate} RR`, after: `${a} · ${u.RankedRatingAfterUpdate} RR`, delta: d, dir: d >= 0 ? 'up' : 'down' };
      }
    }
    return out;
  } catch { return null; }
}
async function valorantRich() {
  const lf = path.join(process.env.LOCALAPPDATA || '', 'Riot Games', 'Riot Client', 'Config', 'lockfile');
  let parts; try { parts = fs.readFileSync(lf, 'utf8').split(':'); } catch { return null; }
  const port = +parts[2], auth = 'riot:' + parts[3]; if (!port) return null;
  const [me, pres] = await Promise.all([local(port, '/chat/v1/session', auth), local(port, '/chat/v4/presences', auth)]);
  const mine = pres?.presences?.find(p => p.puuid === me?.puuid && p.product === 'valorant');
  if (!mine?.private) return null;
  let d; try { d = JSON.parse(Buffer.from(mine.private, 'base64').toString('utf8')); } catch { return null; }
  // Riot 2024'te biçimi değiştirdi: eski düz alanlar ya da yeni iç içe nesneler
  const match = d.matchPresenceData || d, party = d.partyPresenceData || d, player = d.playerPresenceData || d;
  const loop = match.sessionLoopState || d.sessionLoopState, qid = match.queueId ?? d.queueId ?? '';
  const mapKey = (match.matchMap || d.matchMap || '').split('/').filter(Boolean).pop() || '';
  const tier = +(player.competitiveTier ?? d.competitiveTier) || 0;
  if (loop !== valWas) { valWas = loop; valStart = loop === 'INGAME' ? Date.now() : null; }
  const ally = party.partyOwnerMatchScoreAllyTeam ?? d.partyOwnerMatchScoreAllyTeam, enemy = party.partyOwnerMatchScoreEnemyTeam ?? d.partyOwnerMatchScoreEnemyTeam;
  const isCustom = (party.customGameName || d.customGameName) || (party.partyState || d.partyState) === 'CUSTOM_GAME_SETUP';
  const mode = isCustom ? 'Özel oyun' : (VAL_Q[qid] ?? qid) || null;
  const vm = await valMaps(), hit = vm.find(x => x.mapUrl === (match.matchMap || d.matchMap));
  const mapName = hit?.displayName || VAL_MAP[mapKey] || null;
  const out = { phase: loop, mode, ranked: qid === 'competitive' || qid === 'premier', rank: tier ? VAL_TIERS[tier] || null : null, map: mapName, start: valStart };
  if (loop === 'INGAME') out.state = [mapName, ally != null && enemy != null && (ally || enemy) ? `${ally} - ${enemy}` : null].filter(Boolean).join(' · ') || 'Maçta';
  else out.state = (party.partyState || d.partyState) === 'MATCHMAKING' ? 'Maç arıyor' : VAL_STATE[loop] || null;
  if (loop === 'PREGAME' && mapName) out.state = `Ajan seçiyor · ${mapName}`;
  if (hit && loop !== 'MENUS') out.img = hit.listViewIcon || hit.displayIcon || null;
  // ---- Maç sonu kartı ----
  if (loop === 'INGAME' && !isCustom && !['deathmatch', 'ggteam', 'hurm', ''].includes(qid)) {
    valGame ||= { start: Date.now(), tier };
    Object.assign(valGame, { mode, ranked: out.ranked, map: mapName, bg: hit?.splash || hit?.listViewIcon || null, ally, enemy });
  } else if (valGame && loop !== 'INGAME') {
    const g = valGame; valGame = null;
    if (Date.now() - g.start > 4 * 60e3) {
      const d = await valDetails(port, auth, g.start);
      const sc = d?.score || (g.ally != null && g.enemy != null ? [g.ally, g.enemy] : null);
      const res = d ? (d.draw ? 'draw' : d.win ? 'win' : 'loss') : sc && sc[0] !== sc[1] ? (sc[0] > sc[1] ? 'win' : 'loss') : null;
      if (res) pushMatch({ key: 'val:' + (d?.id || `${g.map}:${sc}:${Math.round(g.start / 6e5)}`), game: 'Valorant', result: res, mode: g.mode, ranked: g.ranked, map: g.map,
        champ: d?.agent || null, img: d?.img || null, bg: g.bg, score: sc, kda: d?.kda || null, dur: d?.dur || Math.round((Date.now() - g.start) / 1000),
        extra: d?.acs ? [`${d.acs} ACS`] : [], rank: d?.rank || null });
    }
  }
  return out;
}
let valMapList = null, valMapAt = 0, valTry = 0;
async function valMaps() {
  if (valMapList && Date.now() - valMapAt < 6 * 3600e3) return valMapList;
  if (Date.now() - valTry < 10 * 60e3) return valMapList || [];
  valTry = Date.now();
  const j = await getJSON('https://valorant-api.com/v1/maps?language=tr-TR');
  if (Array.isArray(j?.data)) { valMapList = j.data; valMapAt = Date.now(); }
  return valMapList || [];
}

// ---------------- CS2: Game State Integration ----------------
const CS_MODE = { competitive: 'Rekabetçi', premier: 'Premier', casual: 'Normal', deathmatch: 'Ölüm maçı', scrimcomp2v2: 'Wingman', gungameprogressive: 'Silah yarışı', training: 'Eğitim', custom: 'Özel', survival: 'Tehlike bölgesi' };
const CS_MAP = { de_dust2: 'Dust II', de_mirage: 'Mirage', de_inferno: 'Inferno', de_nuke: 'Nuke', de_overpass: 'Overpass', de_ancient: 'Ancient', de_anubis: 'Anubis', de_vertigo: 'Vertigo', de_train: 'Train', cs_office: 'Office', cs_italy: 'Italy', de_basalt: 'Basalt', de_edin: 'Edin', ar_shoots: 'Shoots', ar_baggage: 'Baggage', ar_pool_day: 'Pool Day' };
let gsi = null, gsiAt = 0, csStart = null, csMapWas = null;
function startGSI(port = 29571) {
  http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
    let d = ''; req.on('data', c => { d += c; if (d.length > 2e5) req.destroy(); });
    req.on('end', () => { try { const j = JSON.parse(d); if (j.auth?.token === 'kanka') { gsi = j; gsiAt = Date.now(); csCheckEnd(j); } } catch {} res.writeHead(200); res.end(); });
  }).on('error', () => {}).listen(port, '127.0.0.1');
}
// CS2'nin cfg klasörüne Kanka ayar dosyasını bir kez yaz (oyun bir sonraki açılışta okur)
function installGSI(steamPaths) {
  const cfg = `"Kanka Chat"\n{\n "uri" "http://127.0.0.1:29571"\n "timeout" "5.0"\n "buffer" "0.5"\n "throttle" "2.0"\n "heartbeat" "15.0"\n "auth" { "token" "kanka" }\n "data"\n {\n  "provider" "1"\n  "map" "1"\n  "round" "1"\n  "player_id" "1"\n  "player_state" "1"\n  "player_match_stats" "1"\n }\n}\n`;
  const libs = new Set(steamPaths);
  for (const sp of steamPaths) {
    try { const vdf = fs.readFileSync(path.join(sp, 'steamapps', 'libraryfolders.vdf'), 'utf8'); for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\')); } catch {}
  }
  let done = false;
  for (const lib of libs) {
    const dir = path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg');
    try { if (!fs.existsSync(dir)) continue; const f = path.join(dir, 'gamestate_integration_kanka.cfg'); if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== cfg) fs.writeFileSync(f, cfg); done = true; } catch {}
  }
  return done;
}
// Maç bitti ekranı (gameover) gelince kart
function csCheckEnd(j) {
  const m = j.map, me = j.provider?.steamid, p = j.player?.steamid === me ? j.player : null;
  if (!m || m.phase !== 'gameover' || !p || ['deathmatch', 'gungameprogressive', 'training', 'custom', 'survival'].includes(m.mode)) return;
  const us = p.team === 'T' ? m.team_t?.score : m.team_ct?.score, them = p.team === 'T' ? m.team_ct?.score : m.team_t?.score;
  if (us == null || them == null || us + them < 3) return;
  const st = p.match_stats || {};
  pushMatch({ key: `cs:${m.name}:${csStart || ''}:${us}-${them}`, game: 'Counter-Strike 2', result: us > them ? 'win' : us < them ? 'loss' : 'draw',
    mode: CS_MODE[m.mode] || m.mode, ranked: m.mode === 'competitive' || m.mode === 'premier', map: CS_MAP[m.name] || m.name, score: [us, them],
    kda: [st.kills || 0, st.deaths || 0, st.assists || 0], dur: csStart ? Math.round((Date.now() - csStart) / 1000) : null,
    extra: [st.mvps ? `${st.mvps} MVP` : null, st.score ? `${st.score} puan` : null].filter(Boolean) });
}
function cs2Rich() {
  if (!gsi || Date.now() - gsiAt > 40e3) return null;
  const m = gsi.map, me = gsi.provider?.steamid, p = gsi.player && gsi.player.steamid === me ? gsi.player : null;
  if (!m) { csMapWas = null; csStart = null; return { phase: 'menu', state: 'Menüde' }; }
  if (m.name !== csMapWas) { csMapWas = m.name; csStart = Date.now(); }
  const mapName = CS_MAP[m.name] || m.name, mode = CS_MODE[m.mode] || m.mode;
  const team = p?.team, us = team === 'T' ? m.team_t?.score : m.team_ct?.score, them = team === 'T' ? m.team_ct?.score : m.team_t?.score;
  const st = p?.match_stats;
  const out = { phase: m.phase, mode, ranked: m.mode === 'competitive' || m.mode === 'premier', map: mapName, start: csStart,
    state: [mapName, us != null && them != null ? `${us} - ${them}` : null].filter(Boolean).join(' · ') };
  if (st) { out.kda = [st.kills || 0, st.deaths || 0, st.assists || 0]; out.extra = `${st.kills || 0}/${st.deaths || 0}/${st.assists || 0}${st.mvps ? ` · ${st.mvps} MVP` : ''}`; }
  if (m.phase === 'warmup') out.state = `${mapName} · Isınma`;
  return out;
}

module.exports = { takeMatches: () => matches.slice(), doneMatch: k => { const i = matches.findIndex(x => x.key === k); if (i >= 0) matches.splice(i, 1); }, lolRich, valorantRich, cs2Rich, startGSI, installGSI, resetLol: () => { lcu = null; } };
