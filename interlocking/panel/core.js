// TID interlocking panel: state, communication, track graph, station layout
// (classic scripts sharing one global scope; loaded in order by index.html)

"use strict";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------
const N = 1, E = 2, S = 4, W = 8;
const DIRS = [N, E, S, W];
const DXY = { [N]: [0, -1], [E]: [1, 0], [S]: [0, 1], [W]: [-1, 0] };
const BACK = { [N]: S, [E]: W, [S]: N, [W]: E };
let CELL = 34;               // size of one tile in pixels (fitted to the window, times the zoom)
let zoom = Number(localStore("zoom")) || 1;
const ZOOM_MIN = 0.5, ZOOM_MAX = 6;

const ERRORS = {
	"another route from this signal is set": "この信号から別の進路が設定されています",
	"conflicting route is set": "敵対進路が設定されています",
	"track is occupied": "進路上に列車がいます（在線）",
	"station is in automatic mode": "自動モードでは進路を扱えません。「扱者」に切り替えてください",
	"route is not idle": "この進路はすでに設定されています",
	"train already admitted": "列車が進入済みのため取り消せません",
	"route is not set": "進路は設定されていません",
	"not owner": "この駅を操作する権限がありません",
	"no track from the start signal to the end tile": "信号から着点まで線路がつながっていません（信号の向きを確認）",
	"start is not a registered signal of this station": "始点がてこ扱い信号として登録されていません",
	"no rail signal at this position": "その位置に信号がありません",
	"signal belongs to another station": "別の連動駅の信号です",
	"signal already registered": "すでに登録されています",
	"signal not registered": "登録されていません",
	"route is occupied": "進入中の進路は削除できません",
	"track of the route is missing": "進路の線路がなくなっています",
	"start signal is missing": "始点の信号がなくなっています",
	"start and end are the same tile": "始点と着点が同じです",
	"unknown station": "連動駅が見つかりません",
	"unknown route": "進路が見つかりません",
	"a point is set against the route": "ポイントが進路と反対の向きに固定されています（転てつてこを確認）",
	"the point is locked": "このポイントは鎖錠中です（進路が通っているか在線中）",
	"no point at this position": "その位置にポイントがありません",
	"bad point lever": "転てつてこの指定が正しくありません",
	"platform already registered": "この番線・線路はすでに登録されています",
	"platform belongs to another station": "別の連動駅の番線・線路です",
	"platform not registered": "この番線・線路は登録されていません",
	"not a platform": "ホームではありません",
	"not a platform or a plain track": "ホームか、ポイント・信号のない線路をクリックしてください",
	"the track is not connected": "この線路はほかの線路につながっていません",
	"click the track end where trains leave": "列車が出ていく側の線路の端をクリックしてください",
	"the platform track is not connected": "この番線はほかの線路につながっていません",
	"click the platform end where trains leave": "列車が出ていく側のホームの端をクリックしてください",
	"the path does not follow the track": "線路に沿っていない経路です",
	"use the levers on a relay panel": "継電の盤では、信号てこで扱います（ショートカットは使えません）",
	"turn the signal lever first": "先に信号てこを開通方向にひねってください",
	"turn the lever back first": "先に信号てこを定位に戻してください",
	"only on a relay panel": "継電の盤だけの操作です",
	"release all routes first": "設定中・進入中・時素中の進路があります。すべて解除されてから切り替えてください",
	"bad setting": "設定の値が正しくありません",
	"bad path": "経路の指定が正しくありません",
	"this side belongs to the other signal of the lever": "その側は、このてこのもう一方の信号です",
	"the signal already has a lever pair": "その信号は、すでにほかの信号とまとめてあります",
	"no lever pair": "まとめてあるてこではありません",
	"another lever is waiting for its destination": "ほかの信号てこが着点待ちです。先に着点ボタンを押すか、そのてこを定位に戻してください",
};
const tr = (e) => {
	if (e === "not owner") {
		const st = station();
		if (st && info.player !== undefined) return `この駅は「${companyName(st.owner)}」の駅です。ゲームで操作中の会社（${companyName(info.player)}）を切り替えてください`;
	}
	return ERRORS[e] || e;
};

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
let status = { stations: [], routes: [] };
let tracks = { tiles: [], convoys: {} };
let halts = [];
let info = { map: [0, 0] };
let lastEvent = 0;
let connected = false;
let stationId = Number(localStore("station") || 0);
let tab = "run";
let pending = new Map();          // command text -> label (waiting for result)
let hoverRoute = null;
let selectedSignal = null;        // key of a signal (run tab)
let manualRoute = null;           // {start:[x,y,z]} while creating a route by clicking
let stationTiles = null;         // keys of the tiles that belong to the station (null = no filter possible)
let tileIndex = new Map();        // "x,y,z" -> tile
let xyIndex = new Map();          // "x,y" -> [tiles]

function localStore(k, v) {
	try {
		if (v === undefined) return localStorage.getItem("tidil." + k);
		localStorage.setItem("tidil." + k, v);
	} catch (e) { return null; }
}
function areaOf(id) {
	try { return JSON.parse(localStore("area." + id) || "null"); } catch (e) { return null; }
}
function setArea(id, a) { localStore("area." + id, JSON.stringify(a)); }
const key = (p) => p.join(",");
const station = () => status.stations.find(s => s.id === stationId);
// relay interlocking (継電連動): the panel is operated with rotary levers
const isRelay = () => { const st = station(); return !!st && st.kind === "relay"; };
// orientation of the panel: the same for everybody on a relay panel (stored in the game), per browser otherwise
function viewRot() {
	const st = station();
	return st && st.kind === "relay" ? (st.rot || 0) & 3 : (viewOpt().rot || 0) & 3;
}
// a map direction as a vector on the (turned) panel
function screenVec(d) {
	let [dx, dy] = DXY[d];
	for (let i = 0; i < viewRot(); i++) [dx, dy] = [-dy, dx];
	return [dx, dy];
}
// command text of the station settings (kind, orientation, times)
const cfgCommand = (st, o) => `st_cfg,${st.id},${o.kind ?? (st.kind === "relay" ? 1 : 0)},${o.rot ?? st.rot ?? 0},${o.ta ?? st.t_approach ?? 90},${o.ts ?? st.t_shunt ?? 30},${o.tt ?? st.t_throw ?? 4}`;

// ---------------------------------------------------------------------------
// communication
// ---------------------------------------------------------------------------
async function api(path) {
	const r = await fetch(path, { cache: "no-store" });
	if (!r.ok) throw new Error(path + " " + r.status);
	return r.json();
}
async function command(cmd, label) {
	pending.set(cmd, label || cmd);
	render();
	try {
		const r = await fetch("/api/cmd", { method: "POST", headers: { "X-IL-Panel": "1", "Content-Type": "text/plain; charset=utf-8" }, body: cmd });
		if (!r.ok) throw new Error("HTTP " + r.status);
	} catch (e) {
		pending.delete(cmd);
		toast("送信できませんでした: " + e.message);
	}
	// the result arrives as an event; give up waiting after a while
	setTimeout(() => { if (pending.delete(cmd)) render(); }, 15000);
}
// sends a command and waits for its result event
function commandResult(cmd) {
	return new Promise((resolve) => {
		waiters.push({ cmd, resolve });
		command(cmd);
		setTimeout(() => resolve({ ok: false, error: "timeout" }), 15000);
	});
}
let waiters = [];

async function pollEvents() {
	const r = await api("/api/events?since=" + lastEvent);
	if (r.last < lastEvent) lastEvent = 0; // game restarted
	for (const ev of r.events) handleEvent(ev);
	lastEvent = r.last;
}
function handleEvent(ev) {
	if (ev.type === "result") {
		const label = pending.get(ev.command) || ev.command;
		pending.delete(ev.command);
		waiters = waiters.filter(w => { if (w.cmd === ev.command) { w.resolve(ev); return false; } return true; });
		log((ev.ok ? "OK  " : "NG  ") + label + (ev.ok ? "" : " … " + tr(ev.error)), ev.ok ? "ok" : "err");
		if (!ev.ok && !ev.command.startsWith("rt_def") && !ev.command.startsWith("rt_path")) toast(tr(ev.error));
	}
	else if (ev.type === "route") {
		const r = status.routes.find(x => x.id === ev.id);
		const name = r ? r.name : "#" + ev.id;
		const st = { idle: "定位（解除）", set: "設定", occupied: "進入" + (ev.convoy ? "：" + ev.convoy : "") }[ev.state];
		log(`進路 ${name} → ${st}`);
	}
	else if (ev.type === "wrong_route") {
		const r = status.routes.find(x => x.id === ev.id);
		toast(`誤進路: ${ev.convoy} は「${r ? r.name : ev.id}」の先から目的地へ行けません`);
		log(`誤進路: ${ev.convoy} / ${r ? r.name : ev.id}`, "err");
	}
	else if (ev.type === "station") {
		pendingStation && pendingStation(ev);
	}
	else if (ev.type === "rotated") {
		rotateAreas();
	}
	else if (ev.type === "reset") {
		log("マップが読み込み直されました");
	}
	else if (ev.type === "rescan") {
		rescanResults.set(ev.station, ev);
		log("配線を読み直しました：" + rescanSummary(ev).join("、"));
		refreshTracks().then(render);
	}
}

async function rotateAreas() {
	try { info = await api("/api/info"); } catch (e) { return; }
	const sx = info.map[0];
	for (const st of status.stations) {
		const a = areaOf(st.id);
		if (!a) continue;
		const p1 = [sx - 1 - a.y1, a.x1], p2 = [sx - 1 - a.y2, a.x2];
		setArea(st.id, { x1: Math.min(p1[0], p2[0]), x2: Math.max(p1[0], p2[0]), y1: Math.min(p1[1], p2[1]), y2: Math.max(p1[1], p2[1]), halt: a.halt });
	}
	log("マップが回転しました");
	await refreshTracks();
	render();
}

async function refreshStatus() {
	status = await api("/api/status");
	if (!station() && status.stations.length) {
		stationId = status.stations[0].id;
		localStore("station", stationId);
	}
}
async function refreshTracks() {
	const a = currentArea();
	if (!a) { tracks = { tiles: [], convoys: {} }; indexTracks(); return; }
	tracks = await api(`/api/tracks?x1=${a.x1}&y1=${a.y1}&x2=${a.x2}&y2=${a.y2}`);
	indexTracks();
}
function indexTracks() {
	tileIndex = new Map(); xyIndex = new Map();
	for (const t of tracks.tiles) {
		tileIndex.set(key(t.p), t);
		const k = t.p[0] + "," + t.p[1];
		if (!xyIndex.has(k)) xyIndex.set(k, []);
		xyIndex.get(k).push(t);
	}
	const a = currentArea();
	stationTiles = a ? computeConnected(stationHalt(a)) : null;
	computeLayout();
}

// ---------------------------------------------------------------------------
// view options: only the tracks of the station, heights
// ---------------------------------------------------------------------------
function viewOpt() {
	try { return Object.assign({ connected: true, hidden: [] }, JSON.parse(localStore("view." + stationId) || "{}")); }
	catch (e) { return { connected: true, hidden: [] }; }
}
function setViewOpt(o) { localStore("view." + stationId, JSON.stringify(o)); }

// the halt of the station: stored with the area, otherwise by name
function stationHalt(a) {
	if (a && a.halt) return a.halt;
	const st = station();
	const h = st && halts.find(x => x.name === st.name);
	return h ? h.id : 0;
}

const bitCount = (r) => (r & 1) + (r >> 1 & 1) + (r >> 2 & 1) + (r >> 3 & 1);

/*
 * Tracks that belong to the station: walk outwards from the platforms along the track,
 * every branch is cut at the first signal outside the outermost junction (the boundary of
 * the interlocking area). Lines that are not connected (another line above or below) are
 * never reached.
 */
function computeConnected(haltId) {
	if (!haltId) return null;
	const plat = tracks.tiles.filter(t => t.h === haltId);
	if (!plat.length) return null;
	const set = new Set(plat.map(t => key(t.p)));
	const visited = new Set();
	const MAX = 80;
	const sidings = sidingHaltIds();
	nearHalts = new Set();
	const finalize = (path, all) => {
		let cut = path.length - 1;
		if (!all) {
			let j = -1;
			path.forEach((t, i) => { if (bitCount(t.r) >= 3) j = i; });
			cut = -1;
			for (let i = j + 1; i < path.length; i++) if (path[i].s) { cut = i; break; }
			if (cut < 0) cut = Math.min(path.length - 1, (j >= 0 ? j : 0) + 4);
		}
		for (let i = 0; i <= cut; i++) set.add(key(path[i].p));
	};
	const walk = (t, d, path) => {
		for (;;) {
			if (t.h === haltId) { finalize(path, true); return; }          // back at our own platforms
			if (t.h && !sidings.has(t.h)) { nearHalts.add(t.h); finalize(path, false); return; } // another station: outside
			path.push(t);
			const vk = key(t.p) + "|" + d;
			if (visited.has(vk) || path.length > MAX) { finalize(path, false); return; }
			visited.add(vk);
			const outs = [];
			for (const e of DIRS) {
				if (!(t.r & e) || e === BACK[d]) continue;
				const n = neighbour(t, e);
				if (n) outs.push([e, n]);
			}
			if (!outs.length) {
				// a dead end (siding, pull-out track) belongs to the station unless a signal comes first
				let j = -1;
				path.forEach((x, i) => { if (bitCount(x.r) >= 3) j = i; });
				finalize(path, !path.slice(j + 1).some(x => x.s));
				return;
			}
			if (outs.length === 1) { d = outs[0][0]; t = outs[0][1]; continue; }
			for (const [e, n] of outs) walk(n, e, path.slice());
			return;
		}
	};
	for (const p of plat) {
		for (const e of DIRS) {
			if (!(p.r & e)) continue;
			const n = neighbour(p, e);
			if (n && n.h !== haltId) walk(n, e, [p]);
		}
	}
	// never hide what the station already uses
	const st = station();
	if (st) {
		for (const sg of st.signals) set.add(key(sg.pos));
		for (const r of status.routes) if (r.station === st.id) for (const q of r.tiles) set.add(key(q));
		for (const d of st.departures || []) for (const q of d.tiles) set.add(key(q));
	}
	return set;
}

// heights in the area, with a name (underground / elevated / ground)
function layers() {
	const m = new Map();
	for (const t of tracks.tiles) {
		if (!m.has(t.p[2])) m.set(t.p[2], { z: t.p[2], n: 0, u: 0, b: 0 });
		const l = m.get(t.p[2]);
		l.n++; if (t.u) l.u++; if (t.b) l.b++;
	}
	return [...m.values()].sort((x, y) => y.z - x.z).map(l => Object.assign(l, {
		name: l.u * 2 > l.n ? "地下" : l.b * 2 > l.n ? "高架" : "地上",
	}));
}

// visible = shown normally and clickable; the rest is drawn faint
function isVisible(t) {
	const o = viewOpt();
	if (o.hidden.includes(t.p[2])) return false;
	if (o.connected && stationTiles && !stationTiles.has(key(t.p))) return false;
	return true;
}

// zoom around a point of the window (the centre of the map by default)
function setZoom(nz, clientX, clientY) {
	nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nz));
	const wrap = document.getElementById("mapwrap");
	const r = wrap.getBoundingClientRect();
	const ox = (clientX ?? r.left + r.width / 2) - r.left, oy = (clientY ?? r.top + r.height / 2) - r.top;
	const px = wrap.scrollLeft + ox, py = wrap.scrollTop + oy;
	const ratio = nz / zoom;
	zoom = nz;
	localStore("zoom", zoom);
	render();
	wrap.scrollLeft = px * ratio - ox;
	wrap.scrollTop = py * ratio - oy;
}

function companyName(nr) {
	const p = (info.players || []).find(x => x.nr === nr);
	return p ? p.name : (nr === 1 ? "公共" : "会社 " + nr);
}

function renderViewbar() {
	const bar = document.getElementById("viewbar");
	const a = currentArea();
	bar.style.display = a ? "flex" : "none";
	if (!a) return;
	const o = viewOpt();
	const ls = layers();
	let html = `<button data-zoom="out" title="縮小（Ctrl＋ホイール）">－</button><button data-zoom="fit" title="全体を表示">${Math.round(zoom * 100)}%</button><button data-zoom="in" title="拡大（Ctrl＋ホイール）">＋</button><span class="sep"></span>`;
	const vr = viewRot();
	html += `<button data-rot="1" title="地図を時計回りに90°回す（縦に引かれた駅を横向きにする）${isRelay() ? "。継電の盤は全員同じ向き（ゲームに保存）" : ""}">↻ 回転 ${vr * 90}°${vr ? "（北は" + ["上", "右", "下", "左"][vr] + "）" : ""}</button><span class="sep"></span>`;
	if (isRelay()) html += `<button data-v="levers" class="${o.mapLevers !== false ? "on" : ""}" title="運転タブで、信号てこを地図の上にも表示する">地図にてこ</button>`;
	html += `<button data-v="connected" class="${o.connected ? "on" : ""}" ${stationTiles ? "" : "disabled title='駅が分からないため使えません'"}>この駅につながる線路だけ</button>`;
	if (ls.length > 1) {
		html += `<span class="sep"></span>高さ`;
		// the same name twice (e.g. two ground levels): upper / lower
		for (const l of ls) {
			const same = ls.filter(x => x.name === l.name);
			const rank = same.indexOf(l);
			const part = same.length < 2 ? "" : same.length === 2 ? ["・上段", "・下段"][rank] : `・${rank + 1}段目`;
			html += `<button data-z="${l.z}" class="${o.hidden.includes(l.z) ? "" : "on"}" title="高さ ${l.z}">${l.name}${part}（高さ${l.z}）</button>`;
		}
	}
	// compass: always shows where north is (turns with the map)
	const deg = vr * 90;
	html += `<span class="compass" title="方角（北が${["上", "右", "下", "左"][deg / 90]}）"><svg width="28" height="28" viewBox="0 0 28 28">
		<circle cx="14" cy="14" r="12.5" fill="#141a24" stroke="#3a4558"/>
		<g transform="rotate(${deg} 14 14)"><polygon points="14,3 18,14 10,14" fill="#ff5a5f"/><polygon points="14,25 18,14 10,14" fill="#8a94a3"/></g>
		</svg><b>北</b>${["↑", "→", "↓", "←"][deg / 90]}</span>`;
	if (bar.dataset.html === html) return;
	bar.dataset.html = html;
	bar.innerHTML = html;
	for (const b of bar.querySelectorAll("button")) b.addEventListener("click", () => {
		if (b.dataset.zoom) {
			setZoom(b.dataset.zoom === "in" ? zoom * 1.25 : b.dataset.zoom === "out" ? zoom / 1.25 : 1);
			return;
		}
		const v = viewOpt();
		if (b.dataset.rot && isRelay()) {
			// relay panel: one orientation for all operators
			const st = station();
			command(cfgCommand(st, { rot: (viewRot() + 1) & 3 }), "盤の向き");
			return;
		}
		if (b.dataset.rot) v.rot = ((v.rot || 0) + 1) & 3;
		else if (b.dataset.v === "connected") v.connected = !v.connected;
		else if (b.dataset.v === "levers") v.mapLevers = v.mapLevers === false;
		else {
			const z = Number(b.dataset.z);
			v.hidden = v.hidden.includes(z) ? v.hidden.filter(x => x !== z) : v.hidden.concat([z]);
		}
		setViewOpt(v);
		render();
	});
}

let infoTick = 0;
async function loop() {
	try {
		await refreshStatus();
		await pollEvents();
		await refreshTracks();
		// the company the game operates with (the player may switch companies in the game)
		if (++infoTick % 4 === 0) { try { info = await api("/api/info"); } catch (e) {} }
		setConnected(true);
		render();
	} catch (e) {
		setConnected(false);
	}
	setTimeout(loop, 600);
}
function setConnected(ok) {
	if (ok === connected) return;
	connected = ok;
	document.getElementById("conndot").classList.toggle("ok", ok);
	document.getElementById("conntext").textContent = ok ? "ゲームに接続中" : "ゲームに接続できません";
}

// ---------------------------------------------------------------------------
// area
// ---------------------------------------------------------------------------
function currentArea() {
	const st = station();
	if (!st) return null;
	let a = areaOf(st.id);
	if (!a) {
		// from the signals and routes of the station
		const pts = st.signals.map(s => s.pos);
		for (const r of status.routes) if (r.station === st.id) pts.push(...r.tiles);
		if (!pts.length) return null;
		a = boxAround(pts, 6);
		setArea(st.id, a);
	}
	return a;
}
function boxAround(pts, margin) {
	const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
	return {
		x1: Math.max(0, Math.min(...xs) - margin), x2: Math.max(...xs) + margin,
		y1: Math.max(0, Math.min(...ys) - margin), y2: Math.max(...ys) + margin,
	};
}

// ---------------------------------------------------------------------------
// track graph (for drawing and for generating routes)
// ---------------------------------------------------------------------------
function neighbour(t, d) {
	const [dx, dy] = DXY[d];
	const cand = xyIndex.get((t.p[0] + dx) + "," + (t.p[1] + dy)) || [];
	let best = null;
	for (const n of cand) {
		if (!(n.r & BACK[d])) continue;
		const dz = Math.abs(n.p[2] - t.p[2]);
		if (dz > 2) continue;
		if (!best || dz < Math.abs(best.p[2] - t.p[2])) best = n;
	}
	return best;
}
// BFS in direction of travel like the game does (uses masked ribi); returns map key -> {t, prev, dir, dist}
function travel(start, maxDist = 400, startDir = 0, blocked = null) {
	const seen = new Map();
	const q = [{ t: start, dir: startDir, prev: null, dist: 0 }];
	seen.set(key(start.p) + "|" + startDir, q[0]);
	const res = new Map();
	while (q.length) {
		const cur = q.shift();
		if (!res.has(key(cur.t.p))) res.set(key(cur.t.p), cur);
		if (cur.dist >= maxDist) continue;
		let exits = cur.t.m;
		if (cur.dir) exits &= ~BACK[cur.dir];
		for (const d of DIRS) {
			if (!(exits & d)) continue;
			const n = neighbour(cur.t, d);
			if (!n || (blocked && blocked(n))) continue;
			const k = key(n.p) + "|" + d;
			if (seen.has(k)) continue;
			const node = { t: n, dir: d, prev: cur, dist: cur.dist + 1 };
			seen.set(k, node);
			q.push(node);
		}
	}
	return res;
}
// platform groups (番線): connected tiles of one halt
function platformGroups(haltId) {
	const tiles = tracks.tiles.filter(t => t.h && (!haltId || t.h === haltId));
	const left = new Set(tiles.map(t => key(t.p)));
	const groups = [];
	for (const t of tiles) {
		if (!left.has(key(t.p))) continue;
		const g = [];
		const q = [t];
		left.delete(key(t.p));
		while (q.length) {
			const c = q.shift();
			g.push(c);
			for (const d of DIRS) {
				if (!(c.r & d)) continue;
				const n = neighbour(c, d);
				if (n && left.has(key(n.p))) { left.delete(key(n.p)); q.push(n); }
			}
		}
		groups.push(g);
	}
	// number them from north to south, west to east
	groups.sort((a, b) => {
		const ay = Math.min(...a.map(t => t.p[1])), by = Math.min(...b.map(t => t.p[1]));
		const ax = Math.min(...a.map(t => t.p[0])), bx = Math.min(...b.map(t => t.p[0]));
		return ay - by || ax - bx;
	});
	return groups;
}
// name given on the panel (stored in the game), or null
function labelAt(st, pos) {
	const l = st && (st.labels || []).find(x => key(x.pos) === key(pos));
	return l ? l.name : null;
}
function signalLabel(st, pos) {
	const own = labelAt(st, pos);
	if (own) return own;
	const i = st.signals.findIndex(s => key(s.pos) === key(pos));
	if (i >= 0) return "S" + (i + 1);
	const d = (st.departures || []).find(x => key(x.pos) === key(pos));
	if (d && d.shunt && layout.sidingOf.has(key(pos))) {
		// a siding with a signal at each end: name the side
		const sd = layout.sidings[layout.sidingOf.get(key(pos))];
		const side = sd.deps.length > 1 ? `（${dirName(startTravelDir(st, pos))}）` : "";
		return sidingName(st, layout.sidingOf.get(key(pos))) + "入換" + side;
	}
	if (d) {
		const g = layout.groupOf.has(key(pos)) ? layout.groupOf.get(key(pos)) : -1;
		return (g >= 0 ? platformName(st, g) : "番線") + "出発";
	}
	return "信号";
}
// platforms are named at their first tile (north-west)
const groupRep = (g) => g.slice().sort((a, b) => a.p[1] - b.p[1] || a.p[0] - b.p[0] || a.p[2] - b.p[2])[0];
function platformName(st, gi) {
	const g = layout.groups[gi];
	return (g && labelAt(st, groupRep(g).p)) || (gi + 1) + "番線";
}
function leverName(st, li) {
	const lv = layout.levers[li];
	return labelAt(st, layout.points[lv.pts[0]].t.p) || (21 + li) + "号";
}
function pointName(st, i) {
	const lo = layout.leverOf.get(i);
	if (!lo) return "ポイント";
	const lv = layout.levers[lo.li];
	return leverName(st, lo.li) + (lv.double ? (lo.mi === 0 ? "イ" : "ロ") : "");
}
function sidingName(st, i) {
	const sd = layout.sidings[i];
	if (!sd) return "留置" + (i + 1);
	const own = labelAt(st, groupRep(sd.tiles).p);
	if (own) return own;
	if (sd.halt) {
		// a stop used as a siding: its name (numbered when it has several tracks)
		const hl = halts.find(h => h.id === sd.halt);
		const same = layout.sidings.filter(x => x.halt === sd.halt);
		if (hl) return hl.name + (same.length > 1 ? same.indexOf(sd) + 1 : "");
	}
	return "留置" + (i + 1);
}
function exitName(st, i) { return labelAt(st, layout.exits[i].tile.p) || "出口" + (i + 1); }

/*
 * Layout of the station for operating: platforms, points (junctions), exits and depots.
 * Computed after every refresh of the tracks.
 */
let layout = { groups: [], groupOf: new Map(), points: [], exits: [], depots: [], sidings: [], sidingOf: new Map(), levers: [], leverOf: new Map() };
function computeLayout() {
	const L = { groups: [], groupOf: new Map(), points: [], exits: [], depots: [], sidings: [], sidingOf: new Map() };
	const halt = stationHalt(currentArea());
	if (stationTiles && halt) {
		L.groups = platformGroups(halt);
		L.groups.forEach((g, i) => g.forEach(t => L.groupOf.set(key(t.p), i)));
		const inside = [...stationTiles].map(k => tileIndex.get(k)).filter(Boolean)
			.sort((a, b) => a.p[1] - b.p[1] || a.p[0] - b.p[0] || b.p[2] - a.p[2]);
		for (const t of inside) {
			if (bitCount(t.r) >= 3 && !L.groupOf.has(key(t.p))) {
				const legs = DIRS.filter(d => t.r & d);
				const pairs = [];
				for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) {
					const a = legs[i], b = legs[j];
					if ((t.m & a) || (t.m & b)) pairs.push([a, b]);
				}
				pairs.sort((x, y) => (y[0] === BACK[y[1]]) - (x[0] === BACK[x[1]])); // straight first (定位)
				L.points.push(classifyPoint({ t, pairs }));
			}
			if (t.d) L.depots.push(t);
			for (const d of DIRS) {
				if (!(t.r & d) || !(t.m & d)) continue;
				const n = neighbour(t, d);
				if (n && stationTiles.has(key(n.p))) continue;
				if (!L.exits.some(x => x.tile === t)) L.exits.push({ tile: t, dir: d });
			}
		}
		L.sidings = findSidings(inside, L);
		L.sidings.forEach((sd, i) => sd.tiles.forEach(t => L.sidingOf.set(key(t.p), i)));
	}
	buildLevers(L);
	layout = L;
}

/*
 * Sidings and pull-out tracks (留置線・引上線): runs of plain track (no junction, platform, signal or
 * depot) that end in a buffer stop inside the area, plus every track registered as a virtual
 * shunting signal. anchor = the end where trains leave (towards the points).
 */
const isPlain = (t) => t && bitCount(t.r) <= 2 && !t.h && !t.s && !t.d;
function findSidings(inside, L) {
	const st = station();
	const deps = (st && st.departures) || [];
	const shunt = new Set(deps.filter(d => d.shunt).flatMap(d => d.tiles.map(key)));
	const exitTiles = new Set(L.exits.map(x => key(x.tile.p)));
	const insideKeys = new Set(inside.map(t => key(t.p)));
	const res = [];
	// a connected run of tiles that belong together; ends = tiles where the track goes on
	const collect = (t0, member, left) => {
		const g = [], q = [t0], ends = [];
		left.delete(key(t0.p));
		let deadEnd = false;
		while (q.length) {
			const c = q.shift();
			g.push(c);
			if (bitCount(c.r) === 1) deadEnd = true;
			for (const d of DIRS) {
				if (!(c.r & d)) continue;
				const n = neighbour(c, d);
				if (!n) continue;
				if (left.has(key(n.p))) { left.delete(key(n.p)); q.push(n); }
				else if (!member(n) && !ends.some(e => e.t === c)) ends.push({ t: c, dir: d });
			}
		}
		return { g, ends, deadEnd };
	};
	const add = (g, ends, deadEnd, halt) => {
		const own = deps.filter(d => g.some(t => key(t.p) === key(d.pos)));
		const anchor = own.length ? tileIndex.get(key(own[0].pos)) || ends[0]?.t : ends[0]?.t;
		if (!anchor) return;
		res.push({ tiles: g, anchor, ends, deadEnd, deps: own, dep: own[0], halt });
	};
	// plain tracks ending in a buffer stop, and every plain track with a virtual shunting signal
	const left = new Set(inside.filter(isPlain).map(t => key(t.p)));
	for (const t0 of inside) {
		if (!left.has(key(t0.p))) continue;
		const { g, ends, deadEnd } = collect(t0, isPlain, left);
		const registered = g.some(t => shunt.has(key(t.p)));
		if (!registered && (!deadEnd || ends.length !== 1 || g.some(t => exitTiles.has(key(t.p))))) continue;
		add(g, ends, deadEnd, 0);
	}
	// stops used as sidings (駅属性の留置線): each track of the stop, also when both ends lead on
	for (const hid of sidingHaltIds()) {
		const hleft = new Set(inside.filter(t => t.h === hid).map(t => key(t.p)));
		for (const t0 of inside) {
			if (!hleft.has(key(t0.p))) continue;
			const { g, ends, deadEnd } = collect(t0, (n) => n.h === hid && insideKeys.has(key(n.p)), hleft);
			add(g, ends, deadEnd || ends.length === 1, hid);
		}
	}
	// number them from north to south, west to east
	res.sort((a, b) => groupRep(a.tiles).p[1] - groupRep(b.tiles).p[1] || groupRep(a.tiles).p[0] - groupRep(b.tiles).p[0]);
	return res;
}

// stops in the area used as sidings (stored in the game as one tile of each stop)
function sidingHaltIds() {
	const st = station();
	const ids = new Set();
	for (const p of (st && st.siding_halts) || []) {
		const t = tileIndex.get(key(p));
		if (t && t.h) ids.add(t.h);
	}
	return ids;
}
// stops reached from the station that are not the station itself (candidates for sidings)
let nearHalts = new Set();
const SIDING_NAME = /留置|引上|電留|検車|車庫|入換/;

const isStraight = (p) => p[0] === BACK[p[1]];
const pairKey = (p) => p.slice().sort((a, b) => a - b).join(",");

/*
 * Normal (定位) = straight through. Reverse (反位) = the branch side. Where the branch track bends
 * away to one side, only the pair of a real turnout is the reverse position; the other curve that
 * a Simutrans junction tile also allows goes to "extras".
 */
function classifyPoint(pt) {
	const t = pt.t;
	const legs = DIRS.filter(d => t.r & d);
	pt.normal = pt.pairs.filter(isStraight);
	const curves = pt.pairs.filter(p => !isStraight(p));
	pt.reverse = curves;
	pt.extras = [];
	pt.branch = null;
	if (legs.length === 3 && pt.normal.length === 1) {
		const b = legs.find(d => !pt.normal[0].includes(d));
		pt.branch = b;
		// follow the branch and see to which side it drifts along the straight track
		let cur = t, d = b, dx = 0, dy = 0;
		for (let n = 0; n < 6; n++) {
			const nx = neighbour(cur, d);
			if (!nx) break;
			dx += DXY[d][0]; dy += DXY[d][1];
			cur = nx;
			if (bitCount(cur.r) >= 3) break;
			const e = DIRS.find(x => (cur.r & x) && x !== BACK[d]);
			if (!e) break;
			d = e;
		}
		const axisNS = pt.normal[0].includes(N);
		const drift = axisNS ? dy : dx;
		if (drift !== 0) {
			// the branch goes on towards +drift: trains come to it from the opposite leg (heel)
			const heel = axisNS ? (drift > 0 ? N : S) : (drift > 0 ? W : E);
			const real = curves.find(p => p.includes(heel) && p.includes(b));
			if (real) {
				pt.reverse = [real];
				pt.extras = curves.filter(p => p !== real);
			}
		}
	}
	return pt;
}

/*
 * Levers: a crossover (the branch of one point leads within a few tiles, without platforms or other
 * junctions, into the branch of another point) is one lever for both points (双動, イ/ロ).
 */
function buildLevers(L) {
	const at = new Map(L.points.map((pt, i) => [key(pt.t.p), i]));
	const used = new Set();
	const levers = [];
	L.points.forEach((pt, i) => {
		if (used.has(i) || !pt.branch) return;
		let cur = pt.t, d = pt.branch;
		for (let n = 0; n < 3; n++) {
			const nx = neighbour(cur, d);
			if (!nx || nx.h) break;
			const j = at.get(key(nx.p));
			if (j !== undefined) {
				const other = L.points[j];
				if (!used.has(j) && j !== i && other.branch === BACK[d]) {
					levers.push({ pts: [i, j], double: true });
					used.add(i); used.add(j);
				}
				break;
			}
			const e = DIRS.find(x => (nx.r & x) && x !== BACK[d]);
			if (!e) break;
			cur = nx; d = e;
		}
	});
	L.points.forEach((pt, i) => { if (!used.has(i)) levers.push({ pts: [i], double: false }); });
	levers.sort((a, b) => Math.min(...a.pts) - Math.min(...b.pts));
	L.levers = levers;
	L.leverOf = new Map();
	levers.forEach((lv, li) => lv.pts.forEach((pi, mi) => L.leverOf.set(pi, { li, mi })));
}
