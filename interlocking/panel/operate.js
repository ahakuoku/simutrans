// TID interlocking panel: operating (levers, destinations) and the checks of the setup tab
// (classic scripts sharing one global scope; loaded in order by index.html)

// ---------------------------------------------------------------------------
// operating: point levers, start lever + destination buttons
// ---------------------------------------------------------------------------
let nxStart = null;   // selected start lever: { pos, dep }
let routeVia = [], routeViaContext = "", routeViaPicking = false;
function routeViaStart() {
	if (tab === "setup") return manualRoute?.start ? { pos: manualRoute.start } : null;
	return tab === "run" ? currentStart() : null;
}
function syncRouteVia() {
	const start = routeViaStart();
	const context = start ? `${stationId}|${tab}|${key(start.pos)}|${!!start.shunt}` : "";
	if (context !== routeViaContext) { routeVia = []; routeViaPicking = false; routeViaContext = context; }
	return start;
}
function routeViaProgress(path, via = routeVia) {
	let i = 0;
	for (const t of path) if (i < via.length && key(t.p || t) === key(via[i])) i++;
	return i;
}
function addRouteVia(pos) {
	const start = syncRouteVia();
	if (!start || !routeViaPicking) return false;
	if (key(pos) === key(start.pos) || routeVia.some(p => key(p) === key(pos))) { toast("始点や指定済みの中継点は追加できません"); return true; }
	if (routeVia.length >= 16) { toast("中継点は16か所まで指定できます"); return true; }
	if (!stationTiles?.has(key(pos))) { toast("連動盤の範囲内の線路を選択してください"); return true; }
	routeVia.push(pos.slice()); render(); return true;
}
function drawRouteViaMarker(parent, x, y, index, scale) {
	const g = el("g", { class: "route-waypoint" }, parent);
	el("circle", { cx: x, cy: y, r: Math.max(10, 10 * scale), fill: "#173d48", stroke: "var(--preview)", "stroke-width": 2 }, g);
	el("text", { x, y: y + 4, "font-size": 12, "text-anchor": "middle", fill: "white" }, g).textContent = index + 1;
}
function renderRouteVia() {
	const start = syncRouteVia(), box = document.getElementById("routeViaBar");
	const host = document.getElementById(tab === "setup" ? "manualRouteViaControls" : "routeViaHost");
	if (box.parentElement !== host) host.appendChild(box);
	box.hidden = !(start || (tab === "setup" && manualRoute)) || isNetworkMode();
	if (box.hidden) return;
	box.innerHTML = `<button id="routeViaPick" ${start ? "" : "disabled"} class="${routeViaPicking ? "on" : ""}" aria-pressed="${routeViaPicking}">${routeViaPicking ? "中継点の指定を終了" : "中継点を指定"}</button>
		<button id="routeViaUndo" ${routeVia.length ? "" : "disabled"}>1つ戻す</button><button id="routeViaClear" ${routeVia.length ? "" : "disabled"}>中継点を消去</button>
		<span>${routeVia.length ? routeVia.map((p, i) => `${i + 1}: (${p.join(", ")})`).join(" → ") : "中継点なし"}</span>
		<span class="hint">${!start ? "まず地図上の始点の信号または仮想出発信号をクリックしてください" : routeViaPicking ? "線路を通過する順にクリックし、追加が終わったら「中継点の指定を終了」を押してください。今は着点をクリックしても中継点として追加されます。" : tab === "setup" ? "中継点を指定するか、地図上の着点の線路をクリックして名前を入力してください" : "着点を選択してください"}</span>`;
	box.querySelector("#routeViaPick").onclick = () => { routeViaPicking = !routeViaPicking; render(); };
	box.querySelector("#routeViaUndo").onclick = () => { routeVia.pop(); render(); };
	box.querySelector("#routeViaClear").onclick = () => { routeVia = []; render(); };
}
// Explicit paths for manually registered routes use the same ordered checkpoints.
function manualPathVia(start, end, via = routeVia) {
	const t0 = tileIndex.get(key(start));
	if (!t0 || !tileIndex.has(key(end))) return null;
	const queue = [{ t: t0, dir: 0, progress: 0, prev: null }], seen = new Set();
	for (let head = 0; head < queue.length; head++) {
		const n = queue[head], k = key(n.t.p);
		const progress = n.progress + (n.progress < via.length && k === key(via[n.progress]) ? 1 : 0);
		const state = `${k}|${n.dir}|${progress}`;
		if (seen.has(state)) continue;
		seen.add(state);
		if (k === key(end) && progress === via.length) {
			const path = []; for (let at = n; at; at = at.prev) path.unshift(at.t.p);
			return path;
		}
		const exits = n.prev ? n.t.m & ~BACK[n.dir] : isDepartureAnchor(station(), start) ? n.t.r : n.t.m;
		for (const d of DIRS) if (exits & d) {
			const t = neighbour(n.t, d);
			if (!t || !stationTiles?.has(key(t.p))) continue;
			let repeated = false; for (let at = n; at; at = at.prev) if (key(at.t.p) === key(t.p)) { repeated = true; break; }
			if (!repeated) queue.push({ t, dir: d, progress, prev: n });
		}
	}
	return null;
}
function routePathCommand(kind, st, path, name) {
	const command = `${kind},${st.id},${path.map(p => (p.p || p).join(":")).join(";")},${name}`;
	if (new TextEncoder().encode(command).length > 4000) { toast("進路が長すぎるため送信できません。進路を分けてください"); return null; }
	return command;
}
// point lever positions are part of the game (saved, shared in network games)
function pointLevers() {
	const st = station();
	const o = {};
	for (const lv of (st && st.levers) || []) o[key(lv.pos)] = lv.value;
	return o;
}
const activeRoutes = () => status.routes.filter(r => r.state !== "idle");
// the leg pair a route uses on a junction tile
function routePairAt(r, pk) {
	for (let i = 1; i + 1 < r.tiles.length; i++) {
		if (key(r.tiles[i]) !== pk) continue;
		const legOf = (q) => DIRS.find(d => DXY[d][0] === q[0] - r.tiles[i][0] && DXY[d][1] === q[1] - r.tiles[i][1]);
		return [legOf(r.tiles[i - 1]), legOf(r.tiles[i + 1])];
	}
	return null;
}
/*
 * Lever position of a point: "N" (定位), "R" (反位) or "a,b" (one of the extra pairs).
 * allowedPairs() gives the leg pairs a route may use; null = automatic (any).
 */
function allowedPairs(pt, pos) {
	if (pos === undefined || pos === null) return null;
	if (pos === "N") return pt.normal;
	if (pos === "R") return pt.reverse;
	const p = pt.pairs.find(x => pairKey(x) === pos);
	return p ? [p] : null;
}
const posName = (pos) => pos === "N" ? "定位" : pos === "R" ? "反位" : pos ? "その他" : "自動";
const pairsText = (prs) => prs.map(p => `${dirName(p[0])}⇔${dirName(p[1])}`).join("・");
// state of a point: locked by a route / held by a train, the shown pairs, the manual lever position
function pointState(pt) {
	const pk = key(pt.t.p);
	for (const r of activeRoutes()) {
		const pair = routePairAt(r, pk);
		if (pair) return { locked: true, pairs: [pair], by: r.name };
	}
	const pos = pointLevers()[pk];
	const prs = allowedPairs(pt, pos);
	return { locked: !!pt.t.c, pairs: prs, manual: prs ? pos : null };
}
function leverState(li) {
	const lv = layout.levers[li];
	const sts = lv.pts.map(i => pointState(layout.points[i]));
	const lockedBy = sts.find(x => x.locked);
	const m = sts[0].manual;
	return { locked: !!lockedBy, by: lockedBy && lockedBy.by, manual: sts.every(x => x.manual === m) ? m : "mixed" };
}
function setLever(li, pos) {
	const st = station();
	if (refuseOther(st, layout.points[layout.levers[li].pts[0]].t.p)) return;
	// all points of the lever in one command: a crossover moves together or not at all
	const spec = layout.levers[li].pts.map(i => {
		const pt = layout.points[i];
		const prs = allowedPairs(pt, pos) || [];
		return `${pt.t.p.join(":")}/${pos || ""}/${prs.map(p => p.join("-")).join(".")}`;
	}).join(";");
	command(`pt_set,${st.id},${spec}`, `${leverName(st, li)} ${posName(pos)}`);
}

/*
 * Paths from a start lever to every destination (platform, exit, depot) that follows the
 * track in the direction of travel and the manually set points. free = no train and no
 * other route on it.
 */
function findDestinations(start, via = routeVia) {
	const st = station();
	const res = new Map(); // id -> { label, path, free }
	const t0 = tileIndex.get(key(start.pos));
	if (!st || !t0 || !stationTiles) return res;
	const blocked = new Set();
	for (const r of activeRoutes()) for (const q of r.tiles.slice(1)) blocked.add(key(q));
	for (const t of tracks.tiles) if (t.c && t !== t0) blocked.add(key(t.p));
	const levers = pointLevers();
	const pointAt = new Map(layout.points.map(pt => [key(pt.t.p), pt]));
	const exitAt = new Map(layout.exits.map((x, i) => [key(x.tile.p), i]));
	const startGroup = layout.groupOf.get(key(t0.p));
	const startSiding = layout.sidingOf.get(key(t0.p));
	let firstDirs = DIRS.filter(d => t0.m & d);
	if (start.dep) {
		const own = startSiding !== undefined ? layout.sidings[startSiding].tiles : layout.groups[startGroup] || [t0];
		const g = new Set(own.map(x => key(x.p)));
		firstDirs = DIRS.filter(d => (t0.r & d) && neighbour(t0, d) && !g.has(key(neighbour(t0, d).p)));
	}
	// up to a train standing on a platform or siding: electronic panel, or a green shunting lever (入換標識)
	// (a shunting lever: start.shunt, its colour start.color; pink = calling-on (誘導), a train route)
	const allowShort = !!start.shunt && (start.color === "G" || start.color === "P");
	const extend = (path, d, gi, tilesOf) => {
		// on to the far end of the platform (or of the siding)
		const g = new Set((tilesOf || layout.groups[gi]).map(x => key(x.p)));
		let t = path[path.length - 1];
		for (let n = 0; n < 200; n++) {
			const e = DIRS.find(x => (t.r & x) && x !== BACK[d] && neighbour(t, x) && g.has(key(neighbour(t, x).p)));
			if (!e) break;
			t = neighbour(t, e); d = e; path.push(t);
		}
		return path;
	};
	for (const loose of [false, true]) {
		const seen = new Set();
		const q = firstDirs.map(d => ({ t: neighbour(t0, d), d, progress: 0, prev: { t: t0, prev: null } })).filter(x => x.t);
		while (q.length) {
			const cur = q.shift();
			const t = cur.t, k = key(t.p);
			const progress = (cur.progress || 0) + (cur.progress < via.length && k === key(via[cur.progress]) ? 1 : 0);
			const sk = k + "|" + cur.d + "|" + progress;
			if (seen.has(sk)) continue;
			seen.add(sk);
			if (!stationTiles.has(k)) continue;
			if (!loose && blocked.has(k)) continue;
			const pathTo = () => { const p = []; for (let n = cur; n; n = n.prev) p.unshift(n.t); return p; };
			const record = (id, label, path, free = !loose) => { if (routeViaProgress(path, via) !== via.length) return; if (!res.has(id) || (free && !res.get(id).free)) { if (!res.has(id) || free) res.set(id, { label, path, free }); } };
			// a platform or siding: to its far end; with a train standing on it also "up to the train" (手前)
			const target = (id, label, full) => {
				const firstBlocked = full.findIndex((x, i) => i > 0 && blocked.has(key(x.p)));
				if (!(loose && res.has(id))) record(id, label, full, !loose && firstBlocked < 0);
				const entry = pathTo().length - 1;
				if (allowShort && firstBlocked > entry && !(loose && res.has("n" + id))) record("n" + id, label + "手前", full.slice(0, firstBlocked), !loose);
			};
			if (layout.groupOf.has(k) && layout.groupOf.get(k) !== startGroup) {
				const gi = layout.groupOf.get(k);
				target("p" + gi, platformName(st, gi), extend(pathTo(), cur.d, gi));
				if (progress === via.length || routeViaProgress(extend(pathTo(), cur.d, gi), via) === via.length) continue;
			}
			if (layout.sidingOf.has(k) && layout.sidingOf.get(k) !== startSiding) {
				const si = layout.sidingOf.get(k);
				target("s" + si, sidingName(st, si), extend(pathTo(), cur.d, si, layout.sidings[si].tiles));
				if (progress === via.length || routeViaProgress(extend(pathTo(), cur.d, si, layout.sidings[si].tiles), via) === via.length) continue;
			}
			if (exitAt.has(k)) {
				// a shunting lever leads to platforms, sidings and depots only
				if (start.shunt && start.color !== "P") continue;
				const i = exitAt.get(k);
				if (!(loose && res.has("x" + i))) record("x" + i, exitName(st, i), pathTo());
				// the exit tile may also lead on (e.g. a junction at the edge): do not continue
				continue;
			}
			if (t.d) {
				if (!(loose && res.has("d" + k))) record("d" + k, "車庫", pathTo());
				continue;
			}
			// direction of travel, points
			let exits = t.m & ~BACK[cur.d];
			const pt = pointAt.get(k);
			if (pt) {
				const prs = allowedPairs(pt, levers[k]);
				const came = BACK[cur.d];
				if (prs) {
					let allowed = 0;
					for (const pr of prs) if (pr.includes(came)) allowed |= pr[0] === came ? pr[1] : pr[0];
					exits &= allowed; // 0 = the point is set against us
				}
			}
			for (const e of DIRS) {
				if (!(exits & e)) continue;
				const n = neighbour(t, e);
				if (n) {
					let repeated = false; for (let at = cur; at; at = at.prev) if (key(at.t.p) === key(n.p)) { repeated = true; break; }
					if (!repeated) q.push({ t: n, d: e, progress, prev: cur });
				}
			}
		}
	}
	// Destination buttons must honour the paths registered in setup, just like shortcuts.
	// A blocked or invalid registered path must never fall back to another branch.
	const registered = new Map();
	for (const r of status.routes) {
		if (r.temp || r.station !== st.id || key(r.start) !== key(start.pos) || !r.tiles?.length) continue;
		const end = key(r.end), gi = layout.groupOf.get(end), si = layout.sidingOf.get(end);
		const id = gi !== undefined && gi !== startGroup ? "p" + gi : si !== undefined && si !== startSiding ? "s" + si :
			exitAt.has(end) ? "x" + exitAt.get(end) : tileIndex.get(end)?.d ? "d" + end : null;
		if (!id || (id[0] === "x" && start.shunt && start.color !== "P")) continue;
		if (!registered.has(id)) registered.set(id, []);
		registered.get(id).push(r);
	}
	for (const [id, definitions] of registered) {
		res.delete(id); res.delete("n" + id);
		for (const r of definitions) {
			let path = r.tiles.map(p => tileIndex.get(key(p)));
			if (path.length < 2 || path.some(t => !t || !stationTiles.has(key(t.p))) || new Set(r.tiles.map(key)).size !== path.length) continue;
			const directions = path.slice(1).map((t, i) => DIRS.find(d => neighbour(path[i], d) === t));
			if (directions.some(d => !d) || !firstDirs.includes(directions[0])) continue;
			let valid = true;
			for (let i = 1; i < directions.length; i++) {
				const came = BACK[directions[i - 1]], out = directions[i], pt = pointAt.get(key(path[i].p));
				const pairs = pt ? allowedPairs(pt, levers[key(path[i].p)]) : null;
				if (out === came || !(path[i].m & out) || (pairs && !pairs.some(p => p.includes(came) && p.includes(out)))) { valid = false; break; }
			}
			if (!valid) continue;
			const label = id[0] === "p" ? platformName(st, Number(id.slice(1))) : id[0] === "s" ? sidingName(st, Number(id.slice(1))) : id[0] === "x" ? exitName(st, Number(id.slice(1))) : "車庫";
			const group = id[0] === "p" ? layout.groups[Number(id.slice(1))] : id[0] === "s" ? layout.sidings[Number(id.slice(1))].tiles : null;
			if (group) path = extend(path, directions.at(-1), null, group);
			const record = (target, tiles) => {
				if (routeViaProgress(tiles, via) !== via.length) return;
				const free = !tiles.slice(1).some(t => blocked.has(key(t.p)));
				if (!res.has(target) || (free && !res.get(target).free)) res.set(target, { label: label + (target === id ? "" : "手前"), path: tiles, free, registeredName: r.name });
			};
			record(id, path);
			if (allowShort && group) {
				const groupKeys = new Set(group.map(t => key(t.p)));
				const entry = path.findIndex(t => groupKeys.has(key(t.p)));
				const stop = path.findIndex((t, i) => i > 0 && blocked.has(key(t.p)));
				if (entry >= 0 && stop > entry) record("n" + id, path.slice(0, stop));
			}
		}
	}
	return res;
}

// start of the next route: the selected start lever (electronic) or the turned signal lever (relay)
function currentStart() { return isRelay() ? relayStart() : nxStart; }

function startClicked(pos, dep, sh = false) {
	if (addRouteVia(pos)) return;
	const st = station();
	if (isRelay()) { turnSignalLever(pos, sleverOf(st, pos) ? "N" : null); return; }
	if (!st.manual) { toast("自動モードです。「扱者」に切り替えてください", true); return; }
	if (refuseOther(st, pos)) return;
	// a route from this lever is set: pulling the lever back cancels it
	const set = activeRoutes().find(r => r.station === st.id && key(r.start) === key(pos));
	if (set) {
		if (set.state === "set") command("cancel," + set.id, "進路取消 " + set.name);
		else toast("列車が進入中です。通過すると自動で解除されます", true);
		nxStart = null;
		render();
		return;
	}
	nxStart = nxStart && key(nxStart.pos) === key(pos) && !!nxStart.shunt === sh ? null : { pos, dep, shunt: sh, color: sh ? shuntColor(st, pos) : null };
	render();
}

function destinationClicked(id) {
	const st = station();
	const start = currentStart();
	if (!start) { toast(isRelay() ? "先に信号てこを開通方向にひねってください" : "先に信号てこ（信号・出発点）を押してください", true); return; }
	const d = findDestinations(start).get(id);
	if (!d) { toast("この着点へは進路が引けません（線路の向き・ポイントを確認）"); return; }
	if (!d.free) { toast("在線しているか、ほかの進路と重なるため引けません"); return; }
	const name = d.registeredName || `${signalLabel(st, start.pos)}${start.shunt ? (start.color === "P" ? "誘導" : "入換") : ""}→${d.label}`;
	// electronic panel: say that the shunting / calling-on lever of the start is used
	const cmdName = !isRelay() && start.shunt ? "set_path_s" : "set_path";
	const cmd = routePathCommand(cmdName, st, d.path, name);
	if (!cmd) return;
	command(cmd, "進路設定 " + name);
	routeVia = []; routeViaPicking = false;
	nxStart = null;
	render();
}

function pointClicked(i) {
	if (addRouteVia(layout.points[i].t.p)) return;
	const lo = layout.leverOf.get(i);
	if (!lo) return;
	const ls = leverState(lo.li);
	if (ls.locked) { toast(`${leverName(station(), lo.li)} は鎖錠中です` + (ls.by ? `（${ls.by}）` : "（在線）"), true); return; }
	// 自動 -> 定位 -> 反位 -> 自動
	const next = ls.manual === "N" ? "R" : ls.manual === "R" ? null : "N";
	setLever(lo.li, next);
	render();
}
const isDepartureAnchor = (st, pos) => !!(st && (st.departures || []).some(d => key(d.pos) === key(pos)));
// a map direction as a direction on the earth: turning the map in the game turns the coordinates
const dirName = (d) => { const i = DIRS.indexOf(d); return i < 0 ? "" : ["北", "東", "南", "西"][(i - worldRot() + 4) & 3]; };

/*
 * Checks of the interlocking area for the setup tab.
 * explore(): from a tile entered with direction dir, follows the track in the direction of travel
 * and stops at every signal (recorded) and at target tiles (recorded); returns also all tiles seen.
 */
function explore(start, dir, isTarget, isStop) {
	const signals = [], targets = [], seen = new Set(), tiles = new Set();
	const q = [[start, dir]];
	while (q.length) {
		const [t, d] = q.shift();
		const k = key(t.p) + "|" + d;
		if (seen.has(k)) continue;
		seen.add(k);
		tiles.add(key(t.p));
		if (t.s) {
			// a signal counts only if the train may pass it in this direction (one-way signals block the other)
			if (!d || (t.m & d)) { if (!signals.includes(t)) signals.push(t); }
			continue;
		}
		if (isTarget(t)) { if (!targets.includes(t)) targets.push(t); continue; }
		if (isStop && isStop(t)) continue;
		const exits = t.m & ~(d ? BACK[d] : 0);
		for (const e of DIRS) {
			if (!(exits & e)) continue;
			const n = neighbour(t, e);
			if (n) q.push([n, e]);
		}
	}
	return { signals, targets, tiles: [...tiles] };
}

// entrances: track edges where a train can come from outside the area into it
function areaEntrances(st) {
	const halt = stationHalt(currentArea());
	if (!stationTiles || !halt) return null;
	const res = [];
	const reg = (t) => st.signals.some(s => key(s.pos) === key(t.p));
	for (const k of stationTiles) {
		const t = tileIndex.get(k);
		if (!t) continue;
		for (const d of DIRS) {
			if (!(t.r & d)) continue;
			const n = neighbour(t, d);
			if (!n || stationTiles.has(key(n.p))) continue;
			// can a train move from n (outside) into t?
			if (!(n.m & BACK[d])) continue;
			const ex = explore(t, BACK[d], (x) => x.h === halt);
			if (!ex.signals.length && !ex.targets.length) continue; // does not lead to the platforms
			res.push({ from: n, inside: t, dir: BACK[d], ex, registered: ex.signals.filter(reg), unregistered: ex.signals.filter(x => !reg(x)) });
		}
	}
	// depots inside the area are entrances, too
	for (const k of stationTiles) {
		const t = tileIndex.get(k);
		if (!t || !t.d) continue;
		const ex = explore(t, 0, (x) => x.h === halt && x !== t);
		if (!ex.signals.length && !ex.targets.length) continue;
		res.push({ from: t, inside: t, dir: 0, depot: true, ex, registered: ex.signals.filter(reg), unregistered: ex.signals.filter(x => !reg(x)) });
	}
	return res;
}

// exits: for each platform end, the way out of the area
function areaExits(st) {
	const halt = stationHalt(currentArea());
	if (!stationTiles || !halt) return null;
	const groups = platformGroups(halt);
	const reg = (t) => st.signals.some(s => key(s.pos) === key(t.p));
	const res = [];
	groups.forEach((g, gi) => {
		const inGroup = new Set(g.map(t => key(t.p)));
		const deadEnd = g.filter(t => DIRS.some(d => (t.r & d) && neighbour(t, d) && !inGroup.has(key(neighbour(t, d).p)))).length === 1;
		for (const t of g) {
			for (const d of DIRS) {
				if (!(t.r & d)) continue;
				const n = neighbour(t, d);
				if (!n || inGroup.has(key(n.p))) continue;
				const ex = explore(n, d, (x) => !stationTiles.has(key(x.p)) || (x.h && x.h !== halt && !sidingHaltIds().has(x.h)), (x) => x.h === halt);
				if (!ex.signals.length && !ex.targets.length) continue; // trains cannot leave this way (one-way)
				const dep = (st.departures || []).find(x => key(x.pos) === key(t.p));
				res.push({ group: gi, end: t, dir: d, deadEnd, ex, dep, registered: ex.signals.filter(reg), unregistered: ex.signals.filter(x => !reg(x)) });
			}
		}
	});
	return res;
}
