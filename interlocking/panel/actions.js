// TID interlocking panel: actions and start-up
// (classic scripts sharing one global scope; loaded in order by index.html)

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
function leverClicked(r) {
	const st = station();
	if (isRelay()) { toast("継電の盤では、信号てこで扱います", true); return; }
	if (!st.manual) { toast("自動モードです。「扱者」に切り替えてください", true); return; }
	if (r.state === "idle") command("set," + r.id, "進路設定 " + r.name);
	else if (r.state === "set") command("cancel," + r.id, "進路取消 " + r.name);
	else toast("列車が進入中です。通過すると自動で解除されます", true);
}

function signalClicked(t, interlocked) {
	if (tab === "setup") {
		if (manualRoute && !manualRoute.start) {
			if (!interlocked) { toast("始点は、てこ扱い信号に登録した信号を選んでください"); return; }
			manualRoute.start = t.p;
			render();
			return;
		}
		if (manualRoute) { tileClicked(t); return; }
		toggleSignal(t, interlocked);
		return;
	}
	// run tab: interlocked signals are start levers
	if (interlocked) { startClicked(t.p, false); return; }
	toast("この信号は連動盤で扱っていません（設定タブで登録できます）", true);
}

function toggleSignal(t, on) {
	const st = station();
	if (!st) return;
	command(`${on ? "sig_del" : "sig_add"},${st.id},${t.p.join(",")}`, `${on ? "解除" : "登録"} 信号(${t.p.join(",")})`);
}

async function tileClicked(t) {
	if (!manualRoute || !manualRoute.start) return;
	const st = station();
	const start = manualRoute.start;
	const name = prompt("進路の名前", `${signalLabel(st, start)}→(${t.p[0]},${t.p[1]})`);
	manualRoute = null;
	render();
	if (!name) return;
	const r = await commandResult(`rt_def,${st.id},${start.join(",")},${t.p.join(",")},${name}`);
	if (!r.ok) toast(tr(r.error));
}

let pendingStation = null;
async function newStation() {
	const h = halts.find(x => x.id === Number(document.getElementById("haltSel").value));
	if (!h) { toast("駅を選んでください"); return; }
	const area = boxAround(h.tiles, 10);
	area.halt = h.id;
	const got = new Promise((resolve) => { pendingStation = resolve; setTimeout(() => resolve(null), 15000); });
	command("st_new," + h.name, "連動駅の作成 " + h.name);
	const ev = await got;
	pendingStation = null;
	if (!ev) return;
	setArea(ev.id, area);
	stationId = ev.id;
	localStore("station", stationId);
	await refreshStatus();
	await refreshTracks();
	toast(`「${h.name}」を作成しました。次に場内・出発信号を登録してください`, true);
	render();
}

async function autoRoutes() {
	// work on the latest state (a signal may just have been registered)
	try { await refreshStatus(); await refreshTracks(); } catch (e) {}
	const st = station();
	if (!st) return;
	if (!st.signals.length) { toast("先にてこ扱い信号を登録してください"); return; }
	const a = currentArea();
	const groups = platformGroups(stationHalt(a));
	if (!groups.length) { toast("範囲内にホームがありません"); return; }
	const existing = new Set(status.routes.filter(r => r.station === st.id).map(r => key(r.start) + ">" + key(r.end)));
	const inArea = (p) => p[0] >= a.x1 && p[0] <= a.x2 && p[1] >= a.y1 && p[1] <= a.y2;
	// the area of the station ends where the visible tracks end
	const inside = (t) => t && inArea(t.p) && (!stationTiles || stationTiles.has(key(t.p)));
	const groupOf = new Map();
	groups.forEach((g, i) => g.forEach(t => groupOf.set(key(t.p), i)));
	const todo = [];

	const starts = st.signals.map(s => ({ pos: s.pos, dep: false })).concat((st.departures || []).map(d => ({ pos: d.pos, dep: true, shunt: !!d.shunt })));
	for (const s of starts) {
		const anchor = tileIndex.get(key(s.pos));
		if (!anchor) continue;
		let t = anchor, reach, startDir = 0;
		if (s.dep) {
			// virtual departure / shunting signal: leave the platform (siding) over the anchor end only
			const g = s.shunt && layout.sidingOf.has(key(anchor.p)) ? layout.sidings[layout.sidingOf.get(key(anchor.p))].tiles : groups[groupOf.get(key(anchor.p))] || [anchor];
			const inG = new Set(g.map(x => key(x.p)));
			const dOut = DIRS.find(d => (anchor.r & d) && neighbour(anchor, d) && !inG.has(key(neighbour(anchor, d).p)));
			if (!dOut) continue;
			startDir = dOut;
			reach = travel(anchor, 400, dOut); // as if the train came from the platform, moving outwards
		}
		else reach = travel(t);
		const startGroup = groupOf.get(key(t.p));
		const pathOf = (n) => { const p = []; for (let m = n; m; m = m.prev) p.unshift(m.t.p); return p; };
		// search again without running over other platforms (the route ends at the far end of the target)
		const avoiding = (keep) => travel(t, 400, startDir, (x) => { const gi = groupOf.get(key(x.p)); return gi !== undefined && gi !== startGroup && gi !== keep; });
		let toPlatform = 0;
		if (!s.dep || s.shunt) groups.forEach((g, i) => {
			if (i === startGroup) return;
			// the far end of the platform seen from the signal
			const r2 = avoiding(i);
			let best = null;
			for (const pt of g) {
				const n = r2.get(key(pt.p));
				if (n && (!best || n.dist > best.dist)) best = n;
			}
			if (!best) return;
			toPlatform++;
			todo.push({ start: s.pos, end: best.t.p, path: pathOf(best), name: `${signalLabel(st, s.pos)}→${platformName(st, i)}` });
		});
		// shunting routes into the sidings (to the buffer end)
		layout.sidings.forEach((sd, i) => {
			if (sd.tiles.includes(anchor)) return;
			const r2 = avoiding(-1);
			let best = null;
			for (const q of sd.tiles) {
				const n = r2.get(key(q.p));
				if (n && (!best || n.dist > best.dist)) best = n;
			}
			if (!best) return;
			todo.push({ start: s.pos, end: best.t.p, path: pathOf(best), name: `${signalLabel(st, s.pos)}→${sidingName(st, i)}` });
		});
		if (toPlatform === 0 || (s.dep && !s.shunt)) {
			// departure signal: routes to the exits of the area (next signal or edge of the area)
			let k = 0;
			for (const [, n] of reach) {
				if (n.t === t) continue;
				if (groupOf.has(key(n.t.p))) continue;
				if (!inside(n.t)) continue;
				const atSignal = n.t.s && n.dist > 0;
				const atEdge = DIRS.some(d => (n.t.m & d) && !(n.dir && d === BACK[n.dir]) && !inside(neighbour(n.t, d)));
				if (!atSignal && !atEdge) continue;
				// stop in front of the next signal
				const endNode = atSignal && n.prev ? n.prev : n;
				const end = endNode.t.p;
				// only the first such tile on each branch
				let first = true;
				for (let m = n.prev; m && m.t !== t; m = m.prev) if (m.t.s) { first = false; break; }
				if (!first) continue;
				todo.push({ start: s.pos, end, path: pathOf(endNode), name: `${signalLabel(st, s.pos)}→出口${++k}` });
			}
		}
	}
	const fresh = todo.filter(r => !existing.has(key(r.start) + ">" + key(r.end)));
	if (!fresh.length) { toast("新しく作れる進路はありませんでした（信号の向きと登録を確認してください）", true); return; }
	let ok = 0, ng = 0;
	for (const r of fresh) {
		const res = r.path && r.path.length >= 2
			? await commandResult(`rt_path,${st.id},${r.path.map(p => p.join(":")).join(";")},${r.name}`)
			: await commandResult(`rt_def,${st.id},${r.start.join(",")},${r.end.join(",")},${r.name}`);
		res.ok ? ok++ : ng++;
	}
	toast(`進路を ${ok} 本作成しました` + (ng ? `（${ng} 本は作れませんでした）` : ""), true);
}

// ---------------------------------------------------------------------------
// ui
// ---------------------------------------------------------------------------
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
let toastTimer = null;
function toast(text, info) {
	const t = document.getElementById("toast");
	t.textContent = text;
	t.className = info ? "info" : "";
	t.style.display = "block";
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.style.display = "none", 4500);
}
function log(text, cls) {
	const l = document.getElementById("log");
	const d = document.createElement("div");
	if (cls) d.className = cls;
	d.textContent = new Date().toLocaleTimeString() + "  " + text;
	l.prepend(d);
	while (l.childNodes.length > 300) l.removeChild(l.lastChild);
}

document.getElementById("stationSel").addEventListener("change", (e) => {
	stationId = Number(e.target.value);
	localStore("station", stationId);
	selectedSignal = null;
	refreshTracks().then(render);
});
for (const b of document.querySelectorAll("#modeBox button")) b.addEventListener("click", () => {
	const st = station();
	if (st) command(`st_mode,${st.id},${b.dataset.mode}`, b.dataset.mode === "1" ? "扱者モードへ" : "自動モードへ");
});
for (const b of document.querySelectorAll("nav button")) b.addEventListener("click", async () => {
	tab = b.dataset.tab;
	for (const x of document.querySelectorAll("nav button")) x.classList.toggle("on", x === b);
	for (const s of ["run", "setup", "log"]) document.getElementById("tab-" + s).hidden = s !== tab;
	manualRoute = null;
	if (tab === "setup") { try { halts = (await api("/api/halts")).halts; info = await api("/api/info"); } catch (e) {} }
	render();
});
document.getElementById("btnNewStation").addEventListener("click", newStation);
document.getElementById("ownerSel").addEventListener("change", (e) => { localStore("owner", e.target.value); renderSetup(); });
document.getElementById("sigSort").addEventListener("change", (e) => { localStore("sigsort", e.target.value); renderSetup(); });
document.getElementById("sigSort").value = localStore("sigsort") || "owner";
document.getElementById("btnArea").addEventListener("click", () => {
	const st = station();
	if (!st) return;
	const v = (id) => Number(document.getElementById(id).value);
	const old = areaOf(st.id) || {};
	setArea(st.id, { x1: Math.min(v("ax1"), v("ax2")), x2: Math.max(v("ax1"), v("ax2")), y1: Math.min(v("ay1"), v("ay2")), y2: Math.max(v("ay1"), v("ay2")), halt: old.halt });
	refreshTracks().then(render);
});
document.getElementById("btnAreaFit").addEventListener("click", () => {
	const st = station();
	const a = st && areaOf(st.id);
	const h = halts.find(x => x.id === (a && a.halt)) || halts.find(x => x.name === (st && st.name));
	if (!h) { toast("対応する駅が見つかりません"); return; }
	setArea(st.id, Object.assign(boxAround(h.tiles, 10), { halt: h.id }));
	refreshTracks().then(render);
});
document.getElementById("btnAutoRoutes").addEventListener("click", autoRoutes);
document.getElementById("btnManualRoute").addEventListener("click", () => {
	manualRoute = manualRoute ? null : { start: null };
	render();
});
document.getElementById("btnDelStation").addEventListener("click", () => {
	const st = station();
	if (st && confirm(`連動駅「${st.name}」と、その進路をすべて削除しますか？`)) command("st_del," + st.id, "連動駅の削除 " + st.name);
});
window.addEventListener("resize", () => renderMap());
document.getElementById("mapwrap").addEventListener("wheel", (e) => {
	if (!e.ctrlKey) return;
	e.preventDefault();
	setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
}, { passive: false });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && manualRoute) { manualRoute = null; render(); } });

(async () => {
	try { halts = (await api("/api/halts")).halts; info = await api("/api/info"); } catch (e) {}
	// skip the old events of this game session
	try { lastEvent = (await api("/api/events?since=4294967295")).last; } catch (e) {}
	loop();
})();
