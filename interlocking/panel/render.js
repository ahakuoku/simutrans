// TID interlocking panel: rendering of the map and the side panels
// (classic scripts sharing one global scope; loaded in order by index.html)

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
const svgNS = "http://www.w3.org/2000/svg";
function el(name, attrs, parent) {
	const e = document.createElementNS(svgNS, name);
	for (const k in attrs) e.setAttribute(k, attrs[k]);
	if (parent) parent.appendChild(e);
	return e;
}

function render() {
	document.body.classList.toggle("relay", isRelay());
	renderHeader();
	renderViewbar();
	renderMap();
	if (tab === "run") renderRun();
	if (tab === "setup") renderSetup();
}

function renderHeader() {
	const sel = document.getElementById("stationSel");
	const opts = status.stations.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
	if (sel.dataset.opts !== opts) { sel.innerHTML = opts || "<option>（連動駅なし）</option>"; sel.dataset.opts = opts; }
	if (station()) sel.value = stationId;
	const st = station();
	// commands run as the company that is active in the game: it must own the station
	const oi = document.getElementById("ownerInfo");
	const mayOperate = !st || info.player === undefined || info.player === st.owner || info.player === 1 || (st.operators || []).includes(info.player);
	oi.className = "ownerinfo" + (mayOperate ? "" : " bad");
	oi.textContent = !st ? "" : mayOperate ? `所有：${companyName(st.owner)}` :
		`⚠ ゲームで操作中の会社が「${companyName(info.player)}」です。この駅は「${companyName(st.owner)}」の駅なので操作できません。ゲームで会社を切り替えてください`;
	for (const b of document.querySelectorAll("#modeBox button")) {
		b.classList.toggle("on", !!st && (b.dataset.mode === "1") === st.manual);
		b.disabled = !st;
	}
}

function routeStateOfTiles() {
	const m = new Map();
	for (const r of status.routes) {
		if (r.state === "idle") continue;
		// sectional release: after the train has entered, the tiles it has passed are free again
		let from = 1;
		if (r.state === "occupied") {
			const k = r.occupied.findIndex((x, i) => i >= 1 && x);
			from = k < 0 ? r.tiles.length : k;
		}
		for (const p of r.tiles.slice(from)) m.set(key(p), r.state);
	}
	return m;
}

function renderMap() {
	const svg = document.getElementById("map");
	const a = currentArea();
	document.getElementById("mapEmpty").style.display = a ? "none" : "block";
	svg.style.display = a ? "block" : "none";
	if (!a) return;
	// fit the area into the window
	const wrap = document.getElementById("mapwrap");
	// the panel may be turned (a station drawn north-south on the map can be shown left-right like a real panel)
	const rot = viewRot();
	const W0 = a.x2 - a.x1 + 1, H0 = a.y2 - a.y1 + 1;
	const WT = rot & 1 ? H0 : W0, HT = rot & 1 ? W0 : H0;
	const fit = Math.floor(Math.min((wrap.clientWidth - 60) / WT, (wrap.clientHeight - 60) / HT));
	CELL = Math.max(10, Math.round(Math.max(16, Math.min(56, fit || 34)) * zoom));
	const sc = CELL / 34; // scale of the symbols
	const w = WT * CELL, h = HT * CELL;
	svg.setAttribute("width", w + 40); svg.setAttribute("height", h + 40);
	svg.innerHTML = "";
	const g = el("g", { transform: "translate(30,30)" }, svg);
	// tracks of another height are drawn slightly shifted, so that lines above each other stay apart
	const mainZ = mostVisibleZ();
	const zs = layers().map(l => l.z).filter(z => z !== mainZ);
	const shift = (z) => z === mainZ ? 0 : (zs.indexOf(z) + 1) * 0.22 * CELL;
	// map tile -> grid cell of the (turned) panel, map direction -> screen vector
	const uv = (p) => {
		const lx = p[0] - a.x1, ly = p[1] - a.y1;
		return rot === 0 ? [lx, ly] : rot === 1 ? [H0 - 1 - ly, lx] : rot === 2 ? [W0 - 1 - lx, H0 - 1 - ly] : [ly, W0 - 1 - lx];
	};
	const SV = (d) => { let [dx, dy] = DXY[d]; for (let i = 0; i < rot; i++) [dx, dy] = [-dy, dx]; return [dx, dy]; };
	const cx = (p) => uv(p)[0] * CELL + CELL / 2 + shift(p[2]);
	const cy = (p) => uv(p)[1] * CELL + CELL / 2 + shift(p[2]);

	// grid labels: map x and y on the edge they run along
	const axisLabel = (p, text, horizontal) => horizontal
		? el("text", { x: cx([p[0], p[1], mainZ]), y: -10, fill: "#4a5568", "font-size": 10, "text-anchor": "middle" }, g).textContent = text
		: el("text", { x: -8, y: cy([p[0], p[1], mainZ]) + 3, fill: "#4a5568", "font-size": 10, "text-anchor": "end" }, g).textContent = text;
	for (let x = a.x1; x <= a.x2; x += 5) axisLabel([x, a.y1], (rot & 1 ? "x" : "") + x, !(rot & 1));
	for (let y = a.y1; y <= a.y2; y += 5) axisLabel([a.x1, y], (rot & 1 ? "y" : "") + y, !!(rot & 1));

	const st = station();
	const locked = routeStateOfTiles();
	const preview = new Set();
	if (hoverRoute) for (const p of hoverRoute.tiles) preview.add(key(p));
	if (checkPreview) for (const k of checkPreview) preview.add(k);
	// faint tiles first, so that the visible ones are drawn on top
	const tiles = tracks.tiles.slice().sort((x, y) => isVisible(x) - isVisible(y));

	// platforms
	for (const t of tiles) {
		if (!t.h) continue;
		el("rect", { x: cx(t.p) - CELL / 2 + 1, y: cy(t.p) - CELL / 2 + 1, width: CELL - 2, height: CELL - 2, rx: 4, fill: "var(--platform)", opacity: isVisible(t) ? 1 : .25 }, g);
	}
	// tracks
	for (const t of tiles) {
		const k = key(t.p);
		if (!isVisible(t)) {
			// not part of the view: faint, not clickable
			for (const d of DIRS) {
				if (!(t.r & d)) continue;
				const [dx, dy] = SV(d);
				el("line", { x1: cx(t.p), y1: cy(t.p), x2: cx(t.p) + dx * CELL / 2, y2: cy(t.p) + dy * CELL / 2,
					stroke: t.c ? "var(--occupied)" : "var(--track)", "stroke-width": 3 * sc, "stroke-linecap": "round", opacity: .18 }, g);
			}
			continue;
		}
		let color = "var(--track)";
		if (locked.get(k)) color = "var(--locked)";
		if (t.c) color = "var(--occupied)";
		const dashed = t.p[2] !== mainZ;
		for (const d of DIRS) {
			if (!(t.r & d)) continue;
			const [dx, dy] = SV(d);
			el("line", { x1: cx(t.p), y1: cy(t.p), x2: cx(t.p) + dx * CELL / 2, y2: cy(t.p) + dy * CELL / 2,
				stroke: color, "stroke-width": 6 * sc, "stroke-linecap": "round", "stroke-dasharray": dashed ? "5 4" : "" }, g);
		}
		if (preview.has(k)) {
			el("circle", { cx: cx(t.p), cy: cy(t.p), r: 7 * sc, fill: "none", stroke: "var(--preview)", "stroke-width": 3 }, g);
		}
		if (t.d) {
			el("rect", { x: cx(t.p) - 9 * sc, y: cy(t.p) - 9 * sc, width: 18 * sc, height: 18 * sc, rx: 3, fill: "#3a4252", stroke: "#8a94a3" }, g);
			el("text", { x: cx(t.p), y: cy(t.p) + 4, "font-size": 11 * sc, "text-anchor": "middle", fill: "#e6e9ee" }, g).textContent = "車";
		}
		// a click target for creating routes by hand
		const hit = el("rect", { x: cx(t.p) - CELL / 2, y: cy(t.p) - CELL / 2, width: CELL, height: CELL, fill: "transparent", class: manualRoute ? "clickable" : "" }, g);
		hit.addEventListener("click", () => tileClicked(t));
		hit.appendChild(el("title", {})).textContent = `(${t.p.join(", ")}) ${layerName(t.p[2])}` + (t.c ? " " + (tracks.convoys[t.c] || "") : "");
	}
	// train names (at the tile that is reserved and has the highest reservation... keep it simple: first tile per convoy)
	const shown = new Set();
	for (const t of tracks.tiles) {
		if (!t.c || shown.has(t.c)) continue;
		shown.add(t.c);
	}
	// signals (only of the visible tracks)
	for (const t of tiles) {
		if (!t.s || !isVisible(t)) continue;
		const interlocked = st && st.signals.some(s => key(s.pos) === key(t.p));
		const travel = singleDir(t.m) || singleDir(t.r & ~BACK[singleDir(t.m) || 0]) || E;
		// signal head on the left side of the direction of travel (Japanese left-hand running)
		const [dx, dy] = SV(travel);
		const ox = dy * 11 * sc, oy = -dx * 11 * sc;
		const x = cx(t.p) + ox, y = cy(t.p) + oy;
		const fill = t.s.aspect === "green" ? "var(--green)" : t.s.aspect === "yellow" ? "var(--yellow)" : "var(--red)";
		const grp = el("g", { class: "clickable" }, g);
		// arrow for the direction of travel
		const ax = cx(t.p) + dx * 10 * sc, ay = cy(t.p) + dy * 10 * sc, a7 = 7 * sc, a5 = 5 * sc;
		el("polygon", { points: `${ax},${ay} ${ax - dx * a7 + dy * a5},${ay - dy * a7 - dx * a5} ${ax - dx * a7 - dy * a5},${ay - dy * a7 + dx * a5}`, fill: "#cfd6e0" }, grp);
		el("circle", { cx: x, cy: y, r: (interlocked ? 8 : 6) * sc, fill, stroke: interlocked ? "#fff" : "#0f1319", "stroke-width": interlocked ? 2.5 : 1.5 }, grp);
		if (interlocked) {
			el("text", { x: x, y: y - 12 * sc, "font-size": Math.max(11, 12 * sc), "font-weight": 700, "text-anchor": "middle", fill: "#fff" }, grp).textContent = signalLabel(st, t.p);
		}
		if (selectedSignal === key(t.p)) el("circle", { cx: x, cy: y, r: 12 * sc, fill: "none", stroke: "var(--accent)", "stroke-width": 2 }, grp);
		grp.appendChild(el("title", {})).textContent = `${t.s.name} (${t.p.join(", ")}) ${layerName(t.p[2])} ${companyName(t.s.o)}` + (interlocked ? " てこ扱い" : "");
		grp.addEventListener("click", (e) => { e.stopPropagation(); signalClicked(t, interlocked); });
	}
	// points (junctions): the lever position or the leg pair of the route on it
	if (st) layout.points.forEach((pt, i) => {
		const t = pt.t;
		if (!isVisible(t)) return;
		const ps = pointState(pt);
		const color = ps.locked && ps.by ? "var(--locked)" : ps.manual ? "var(--accent)" : "#6b7687";
		const x = cx(t.p), y = cy(t.p);
		const grp = el("g", { class: tab === "run" ? "clickable" : "" }, g);
		el("circle", { cx: x, cy: y, r: 9 * sc, fill: "#141a24", stroke: color, "stroke-width": 2 }, grp);
		const legs = new Set();
		for (const pr of ps.pairs || []) for (const leg of pr) legs.add(leg);
		for (const leg of legs) {
			const [dx, dy] = SV(leg);
			el("line", { x1: x, y1: y, x2: x + dx * 8 * sc, y2: y + dy * 8 * sc, stroke: color, "stroke-width": 3, "stroke-linecap": "round" }, grp);
		}
		el("text", { x: x + 11 * sc, y: y + 14 * sc, "font-size": Math.max(10, 10 * sc), fill: "#9fb3cf" }, grp).textContent = pointName(st, i);
		grp.appendChild(el("title", {})).textContent = `${pointName(st, i)} ` + (ps.by ? `鎖錠中（${ps.by}）` : posName(ps.manual) + (ps.pairs ? `（${pairsText(ps.pairs)}）` : "")) + "（クリックで 自動→定位→反位 と切り替え）";
		if (tab === "run") grp.addEventListener("click", (e) => { e.stopPropagation(); pointClicked(i); });
	});
	// destination buttons (着点): lit when reachable from the selected start lever
	if (st && tab === "run") {
		const start = currentStart();
		const dests = start ? findDestinations(start) : new Map();
		const button = (id, label, t, ox, oy) => {
			if (!t || !isVisible(t)) return;
			const d = dests.get(id);
			const lit = d && d.free, dim = d && !d.free;
			const w = Math.max(44, label.length * 12) * Math.max(.8, sc * .9), h = 18 * Math.max(.8, sc * .9);
			const x = cx(t.p) + ox, y = cy(t.p) + oy;
			const grp = el("g", { class: "clickable" + (lit ? " blink" : "") }, g);
			el("rect", { x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 4, fill: lit ? "var(--yellow)" : "#20283a", stroke: lit || dim ? "var(--yellow)" : "#3a4558", "stroke-dasharray": dim ? "4 3" : "" }, grp);
			el("text", { x, y: y + 4, "font-size": 11, "text-anchor": "middle", fill: lit ? "#1a1a1a" : "#9fb3cf", "font-weight": 600 }, grp).textContent = label;
			grp.appendChild(el("title", {})).textContent = `着点ボタン：${label}` + (lit ? "（押すと進路を引きます）" : dim ? "（在線・他の進路と重なるため今は引けません）" : "");
			grp.addEventListener("click", (e) => { e.stopPropagation(); destinationClicked(id); });
		};
		layout.groups.forEach((gr, i) => {
			const mid = gr.slice().sort((a, b) => a.p[0] - b.p[0] || a.p[1] - b.p[1])[Math.floor(gr.length / 2)];
			button("p" + i, platformName(st, i), mid, 0, 0);
		});
		layout.sidings.forEach((sd, i) => {
			const far = sd.tiles.slice().sort((a, b) => Math.hypot(b.p[0] - sd.anchor.p[0], b.p[1] - sd.anchor.p[1]) - Math.hypot(a.p[0] - sd.anchor.p[0], a.p[1] - sd.anchor.p[1]))[0];
			button("s" + i, sidingName(st, i), far, 0, 0);
		});
		layout.exits.forEach((x, i) => button("x" + i, exitName(st, i), x.tile, SV(x.dir)[0] * CELL * .9, SV(x.dir)[1] * CELL * .9));
		for (const t of layout.depots) button("d" + key(t.p), "車庫", t, 0, -CELL * .7);
		if (start) {
			const t = tileIndex.get(key(start.pos));
			if (t) el("circle", { cx: cx(t.p), cy: cy(t.p), r: 16 * sc, fill: "none", stroke: "var(--yellow)", "stroke-width": 3, class: "blink", "pointer-events": "none" }, g);
		}
	}
	// virtual departure signals: a square at the platform end
	if (st) for (const d of st.departures || []) {
		const t = tileIndex.get(key(d.pos));
		if (!t || !isVisible(t)) continue;
		const rs = status.routes.filter(r => key(r.start) === key(d.pos));
		const clear = rs.some(r => r.state !== "idle");
		const x = cx(t.p), y = cy(t.p), r = 7 * sc;
		const grp = el("g", { class: tab === "run" ? "clickable" : "" }, g);
		if (tab === "run") grp.addEventListener("click", (e) => { e.stopPropagation(); startClicked(d.pos, true); });
		if (d.shunt) {
			// virtual shunting signal: a diamond (lit white when a route is set)
			el("path", { d: `M${x} ${y - r * 1.25} L${x + r * 1.25} ${y} L${x} ${y + r * 1.25} L${x - r * 1.25} ${y} Z`, fill: clear ? "#f4f4f4" : "var(--red)", stroke: "#fff", "stroke-width": 2 }, grp);
		}
		else el("rect", { x: x - r, y: y - r, width: 2 * r, height: 2 * r, rx: 2, fill: clear ? "var(--green)" : "var(--red)", stroke: "#fff", "stroke-width": 2 }, grp);
		el("text", { x, y: y - 11 * sc, "font-size": Math.max(11, 12 * sc), "font-weight": 700, "text-anchor": "middle", fill: "#fff" }, grp).textContent = signalLabel(st, d.pos);
		grp.appendChild(el("title", {})).textContent = `${d.shunt ? "仮想入換信号" : "仮想出発信号"} ${signalLabel(st, d.pos)} (${d.pos.join(", ")})` + (d.train ? " " + d.train : "");
	}
	// halt names
	const named = new Set();
	for (const t of tiles) {
		if (!t.h || named.has(t.h) || !isVisible(t)) continue;
		named.add(t.h);
		const hl = halts.find(x => x.id === t.h);
		if (hl) el("text", { x: cx(t.p) - CELL / 2 + 3, y: cy(t.p) - CELL / 2 - 3, "font-size": 11, fill: "#9fb3cf" }, g).textContent = hl.name;
	}
}
function singleDir(r) { return DIRS.includes(r) ? r : 0; }
function layerName(z) {
	const l = layers().find(x => x.z === z);
	return l ? `${l.name}（高さ ${z}）` : `高さ ${z}`;
}
function mostVisibleZ() {
	const c = new Map();
	for (const t of tracks.tiles) if (isVisible(t)) c.set(t.p[2], (c.get(t.p[2]) || 0) + 1);
	let best = 0, n = -1;
	for (const [z, k] of c) if (k > n) { best = z; n = k; }
	return best;
}

function renderRun() {
	const st = station();
	const lv = document.getElementById("levers");
	const hint = document.getElementById("runHint");
	const ap = document.getElementById("approach");
	if (!st) { lv.innerHTML = ""; ap.innerHTML = ""; hint.textContent = ""; return; }

	// approach indication: a train holds an interlocked signal at danger
	const waiting = st.signals.filter(s => s.train && s.aspect === "red").map(s => `<div>${signalLabel(st, s.pos)}：${esc(s.train)} 待機中</div>`);
	const leaving = (st.departures || []).filter(d => d.train && d.waiting && !status.routes.some(r => key(r.start) === key(d.pos) && r.state !== "idle"))
		.map(d => `<div>${signalLabel(st, d.pos)}：${esc(d.train)} ${d.shunt ? "入換待ち" : "発車待ち"}</div>`);
	ap.innerHTML = waiting.concat(leaving).join("") || `<span class="hint">待っている列車はありません</span>`;

	// routes that are set or occupied
	const act = document.getElementById("activeRoutes");
	const mine = activeRoutes().filter(r => r.station === st.id);
	const actHtml = mine.map(r => `<button class="lever" data-active="${r.id}"><span><span class="name">${esc(r.name)}</span></span>${r.state === "releasing" ? `<span class="chip set blink">時素 ${r.release_in}秒</span>` : r.state === "set" && r.waiting ? `<span class="chip set">${st.all_stop ? "一斉停止中" : "転換中"}</span>` : r.state === "set" ? `<span class="chip set">${isRelay() ? "設定" : "設定（押すと取消）"}</span>` : `<span class="chip occupied">進入</span>`}</button>`).join("") || `<span class="hint">ありません</span>`;
	if (act.dataset.html !== actHtml) {
		act.innerHTML = act.dataset.html = actHtml;
		for (const b of act.querySelectorAll("[data-active]")) {
			const r = mine.find(x => x.id === Number(b.dataset.active));
			b.addEventListener("click", () => leverClicked(r));
			b.addEventListener("mouseenter", () => { hoverRoute = r; renderMap(); });
			b.addEventListener("mouseleave", () => { hoverRoute = null; renderMap(); });
		}
	}
	// point levers
	const pl = document.getElementById("pointList");
	const plHtml = layout.levers.map((lv, li) => {
		const ls = leverState(li);
		const pts = lv.pts.map(i => layout.points[i]);
		const tip = (sel) => pts.map((pt, k) => (lv.double ? (k === 0 ? "イ " : "ロ ") : "") + pairsText(sel(pt))).join(" / ");
		const b = (v, label, title) => `<button data-lv="${li}" data-v="${v}" class="${(ls.manual || "") === v ? "on" : ""}" title="${esc(title)}">${label}</button>`;
		let btns = b("", "自動", "列車の進路に合わせて自動で転換") + b("N", "定位", tip(pt => pt.normal)) + b("R", "反位", tip(pt => pt.reverse));
		if (!lv.double && pts[0].extras.length) btns += pts[0].extras.map(pr => b(pairKey(pr), "その他", "実物の分岐器にない組み合わせ：" + pairsText([pr]))).join("");
		const name = esc(leverName(st, li)) + (lv.double ? `<span class="tag">双動 イ・ロ</span>` : "");
		return `<div class="pt ${ls.locked ? "locked" : ""}"><span>${name}${ls.locked ? ` <span class="tag">鎖錠${ls.by ? "：" + esc(ls.by) : "（在線）"}</span>` : ""}</span><span class="pos">${btns}</span></div>`;
	}).join("") || `<span class="hint">区域内にポイントはありません</span>`;
	if (pl.dataset.html !== plHtml) {
		pl.innerHTML = pl.dataset.html = plHtml;
		for (const btn of pl.querySelectorAll("button[data-lv]")) btn.addEventListener("click", () => {
			const li = Number(btn.dataset.lv);
			const ls = leverState(li);
			if (ls.locked) { toast(`${leverName(st, li)} は鎖錠中です`, true); return; }
			setLever(li, btn.dataset.v || null);
			render();
		});
	}

	const routes = status.routes.filter(r => r.station === st.id && !r.temp);
	const groups = new Map();
	for (const r of routes) {
		const k = key(r.start);
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(r);
	}
	const sig = (k) => st.signals.find(s => key(s.pos) === k);
	let html = "";
	for (const [k, rs] of groups) {
		const s = sig(k);
		const startPos = rs[0].start;
		const asp = s ? "現示：" + { green: "進行", red: "停止", yellow: "注意", missing: "なし" }[s.aspect] : isDepartureAnchor(st, startPos) ? ((st.departures.find(d => key(d.pos) === key(startPos)) || {}).shunt ? "仮想入換信号" : "仮想出発信号") : "";
		html += `<div class="group" data-sig="${k}"><div class="group-title">${signalLabel(st, startPos)}　${asp}</div>`;
		for (const r of rs) {
			const busy = [...pending.keys()].some(c => c === "set," + r.id || c === "cancel," + r.id);
			const chip = busy ? `<span class="chip busy">扱い中…</span>` :
				r.state === "set" ? `<span class="chip set">設定</span>` :
				r.state === "occupied" ? `<span class="chip occupied">進入</span>` : `<span class="chip">定位</span>`;
			// tiles[0] is the signal itself, where a waiting train stands
			const occ = r.occupied.slice(1).some(x => x) && r.state !== "occupied" ? `<span class="sub">在線あり</span>` : "";
			html += `<button class="lever" data-route="${r.id}"><span><span class="name">${esc(r.name)}</span> ${occ}</span>${chip}</button>`;
		}
		html += `</div>`;
	}
	if (selectedSignal && !groups.has(selectedSignal)) selectedSignal = null;
	lv.innerHTML = html || `<span class="hint">登録済みの進路はありません（設定タブの「進路を自動作成」で作れます）。</span>`;
	for (const b of lv.querySelectorAll(".lever")) {
		const r = routes.find(x => x.id === Number(b.dataset.route));
		b.addEventListener("click", () => leverClicked(r));
		b.addEventListener("mouseenter", () => { hoverRoute = r; renderMap(); });
		b.addEventListener("mouseleave", () => { hoverRoute = null; renderMap(); });
		if (selectedSignal && key(r.start) !== selectedSignal) b.style.opacity = .4;
	}
	if (isRelay()) {
		renderRelayBoard();
		hint.innerHTML = !st.manual ? "CTC集中（自動）です。信号は通常どおり自動で動きます。扱うには「駅扱切換てこ」を駅扱にしてください。" :
			"① <b>信号てこ</b>を開通方向（左・右）にひねる → ② 光った<b>着点ボタン</b>を押す と進路が取れます。ポイントは転換を終えてから鎖錠され、信号が進行になります。" +
			"列車の通過後もてこは反位のままです。次の進路の前に<b>定位に戻して</b>ください。列車の接近中にてこを戻すと、<b>時素</b>（本線 " + st.t_approach + " 秒・入換 " + st.t_shunt + " 秒）がたってから解けます。" +
			"転てつてこは 左＝N（定位）・中央＝C（総括）・右＝R（反位）。";
		return;
	}
	hint.innerHTML = !st.manual ? "自動モードです。信号は通常どおり自動で動きます。進路を扱うには上の「扱者」に切り替えてください。" :
		nxStart ? `<b>${esc(signalLabel(st, nxStart.pos))}</b> を選択中。光っている<b>着点ボタン</b>を押すと進路が引けます（もう一度信号を押すと選択をやめます）。` :
		"① 地図上の<b>信号てこ</b>（白枠の信号・四角の出発点・ひし形の入換信号）を押す → ② 光った<b>着点ボタン</b>（番線・留置線・出口）を押す と進路が引けます。ポイントは自動で転換されます。下の転てつてこで向きを固定すると、その向きの進路だけになります。設定中の進路は、同じ信号てこをもう一度押すと取り消せます。";
}

let checkPreview = null; // tiles highlighted while hovering a check row
function renderChecks(st) {
	const el1 = document.getElementById("entryList"), el2 = document.getElementById("exitList");
	if (!st) { el1.innerHTML = el2.innerHTML = `<span class="hint">先に連動駅を作成してください</span>`; el1.dataset.html = el2.dataset.html = ""; return; }
	const ents = areaEntrances(st), exs = areaExits(st);
	if (!ents) { el1.innerHTML = el2.innerHTML = `<span class="hint">駅のホームが表示範囲に見つかりません。「駅に合わせる」を押してください。</span>`; el1.dataset.html = el2.dataset.html = ""; return; }
	const pos = (t) => `(${t.p[0]}, ${t.p[1]})`;
	const sigBtn = (t, on) => `<button data-sigtoggle="${key(t.p)}">${on ? "解除" : "登録"}：信号 ${pos(t)}</button>`;
	let i = 0;
	const html1 = ents.map(e => {
		i++;
		const title = e.depot ? `入口${i}（車庫 ${pos(e.from)}）` : `入口${i}（${dirName(BACK[e.dir])}側 ${pos(e.from)}）`;
		let cls, msg, acts = "";
		if (e.ex.targets.length) { cls = "warn"; msg = "⚠ 信号を通らずにホームへ入れます。ゲーム内で、この線路に駅へ向かう信号を置いてください。"; }
		else if (e.unregistered.length && !e.registered.length) { cls = "warn"; msg = "⚠ 入口の信号が未登録です。"; acts = e.unregistered.map(t => sigBtn(t, false)).join(""); }
		else { cls = "ok"; msg = "✔ " + e.registered.map(t => signalLabel(st, t.p)).join("・") + " で管理しています"; acts = e.registered.map(t => sigBtn(t, true)).join(""); }
		return `<div class="check ${cls}" data-prev="${e.ex.tiles.join(";")}"><div class="head"><b>${title}</b></div><div class="msg">${msg}</div><div class="acts">${acts}</div></div>`;
	}).join("") || `<span class="hint">外から入ってくる線路は見つかりませんでした。</span>`;

	const html2 = exs.map(x => {
		const title = `${x.group + 1}番線 ${dirName(x.dir)}側` + (x.deadEnd ? `<span class="tag">行き止まり</span>` : "");
		let cls, msg, acts = "";
		const depBtn = x.dep ? `<button data-depdel="${key(x.end.p)}">仮想出発信号を解除</button>` : `<button data-depadd="${key(x.end.p)}">仮想出発信号にする</button>`;
		if (x.dep) { cls = "ok"; msg = `✔ 仮想出発信号（${signalLabel(st, x.end.p)}）で管理しています`; acts = depBtn; }
		else if (x.registered.length) { cls = "ok"; msg = "✔ 出発信号 " + x.registered.map(t => signalLabel(st, t.p)).join("・") + " で管理しています"; acts = x.registered.map(t => sigBtn(t, true)).join(""); }
		else if (x.unregistered.length && !x.ex.targets.length) { cls = "warn"; msg = "⚠ 出発信号が未登録です。信号を登録するか、仮想出発信号にしてください。"; acts = x.unregistered.map(t => sigBtn(t, false)).join("") + depBtn; }
		else { cls = "warn"; msg = "⚠ 出発信号がありません。仮想出発信号にしてください。"; acts = depBtn; }
		return `<div class="check ${cls}" data-prev="${x.ex.tiles.concat([key(x.end.p)]).join(";")}"><div class="head"><b>${title}</b></div><div class="msg">${msg}</div><div class="acts">${acts}</div></div>`;
	}).join("") || `<span class="hint">番線が見つかりませんでした。</span>`;

	if (el1.dataset.html === html1 && el2.dataset.html === html2) return;
	el1.innerHTML = el1.dataset.html = html1;
	el2.innerHTML = el2.dataset.html = html2;
	checkPreview = null;
	for (const c of document.querySelectorAll("#entryList .check, #exitList .check")) {
		c.addEventListener("mouseenter", () => { checkPreview = new Set(c.dataset.prev.split(";")); renderMap(); });
		c.addEventListener("mouseleave", () => { checkPreview = null; renderMap(); });
	}
	for (const b of document.querySelectorAll("[data-sigtoggle]")) b.addEventListener("click", () => {
		const t = tileIndex.get(b.dataset.sigtoggle);
		toggleSignal(t, st.signals.some(s => key(s.pos) === b.dataset.sigtoggle));
	});
	for (const b of document.querySelectorAll("[data-depadd]")) b.addEventListener("click", () =>
		command(`dep_add,${st.id},${b.dataset.depadd}`, "仮想出発信号の登録 (" + b.dataset.depadd + ")"));
	for (const b of document.querySelectorAll("[data-depdel]")) b.addEventListener("click", () =>
		command(`dep_del,${st.id},${b.dataset.depdel}`, "仮想出発信号の解除 (" + b.dataset.depdel + ")"));
}

function renderSidings(st) {
	const box = document.getElementById("sidingList");
	const html = !st ? `<span class="hint">先に連動駅を作成してください</span>` : layout.sidings.map((sd, i) => {
		const k = key(sd.anchor.p);
		const title = `${esc(sidingName(st, i))}（${sd.anchor.p[0]}, ${sd.anchor.p[1]}）` + (sd.deadEnd ? `<span class="tag">行き止まり</span>` : "") + `<span class="tag">${sd.tiles.length}マス</span>`;
		const msg = sd.dep ? `✔ 仮想入換信号（${esc(signalLabel(st, sd.dep.pos))}）で管理しています` : "入換を扱わないなら、このままで構いません。";
		const btn = sd.dep ? `<button data-shdel="${key(sd.dep.pos)}">仮想入換信号を解除</button>` : `<button data-shadd="${k}">仮想入換信号にする</button>`;
		return `<div class="check ${sd.dep ? "ok" : ""}" data-prev="${sd.tiles.map(t => key(t.p)).join(";")}"><div class="head"><b>${title}</b></div><div class="msg">${msg}</div><div class="acts">${btn}</div></div>`;
	}).join("") || `<span class="hint">区域内に行き止まりの線路はありません。</span>`;
	if (box.dataset.html === html) return;
	box.innerHTML = box.dataset.html = html;
	for (const c of box.querySelectorAll(".check")) {
		c.addEventListener("mouseenter", () => { checkPreview = new Set(c.dataset.prev.split(";")); renderMap(); });
		c.addEventListener("mouseleave", () => { checkPreview = null; renderMap(); });
	}
	for (const b of box.querySelectorAll("[data-shadd]")) b.addEventListener("click", () =>
		command(`dep_add,${st.id},${b.dataset.shadd}`, "仮想入換信号の登録 (" + b.dataset.shadd + ")"));
	for (const b of box.querySelectorAll("[data-shdel]")) b.addEventListener("click", () =>
		command(`dep_del,${st.id},${b.dataset.shdel}`, "仮想入換信号の解除 (" + b.dataset.shdel + ")"));
}

function renderNames(st) {
	const box = document.getElementById("nameList");
	if (!st) { box.innerHTML = ""; box.dataset.html = ""; return; }
	const rows = [];
	st.signals.forEach((s, i) => rows.push(["信号 S" + (i + 1), s.pos, "S" + (i + 1)]));
	layout.groups.forEach((g, i) => rows.push(["番線", groupRep(g).p, (i + 1) + "番線"]));
	layout.sidings.forEach((sd, i) => rows.push(["留置線", groupRep(sd.tiles).p, "留置" + (i + 1)]));
	(st.departures || []).forEach(d => rows.push(d.shunt ? ["仮想入換信号", d.pos, "（線名＋入換）"] : ["仮想出発信号", d.pos, "（番線名＋出発）"]));
	layout.exits.forEach((x, i) => rows.push(["出口", x.tile.p, "出口" + (i + 1)]));
	layout.levers.forEach((lv, li) => rows.push([lv.double ? "ポイント（双動）" : "ポイント", layout.points[lv.pts[0]].t.p, (21 + li) + "号"]));
	const html = rows.map(([kind, pos, def]) => `<div class="namerow"><span>${kind} (${pos[0]},${pos[1]})</span><input data-name="${pos.join(",")}" placeholder="${esc(def)}" value="${esc(labelAt(st, pos) || "")}"></div>`).join("");
	if (box.dataset.html === html || box.contains(document.activeElement)) return;
	box.innerHTML = box.dataset.html = html;
	for (const inp of box.querySelectorAll("input[data-name]")) inp.addEventListener("change", () => {
		command(`name_set,${st.id},${inp.dataset.name},${inp.value.trim()}`, "名称の変更 " + (inp.value.trim() || "（自動）"));
	});
}

function renderSetup() {
	const st = station();
	// halts
	// company filter
	const os = document.getElementById("ownerSel");
	const owners = [...new Set(halts.map(h => h.owner))].sort((a, b) => a - b);
	const oopts = `<option value="all">すべての会社（${halts.length}駅）</option>` +
		owners.map(o => `<option value="${o}">${esc(companyName(o))}（${halts.filter(h => h.owner === o).length}駅）</option>`).join("");
	if (os.dataset.opts !== oopts) { const v = os.value || localStore("owner") || "all"; os.innerHTML = oopts; os.dataset.opts = oopts; os.value = v; if (!os.value) os.value = "all"; }
	const ownerFilter = os.value;
	// stations: by company, then by name
	const hs = document.getElementById("haltSel");
	const sorted = halts.filter(h => ownerFilter === "all" || String(h.owner) === ownerFilter)
		.sort((a, b) => a.owner - b.owner || a.name.localeCompare(b.name, "ja"));
	let opts = "";
	for (const o of owners) {
		const hsOf = sorted.filter(h => h.owner === o);
		if (!hsOf.length) continue;
		opts += `<optgroup label="${esc(companyName(o))}">` + hsOf.map(h => `<option value="${h.id}">${esc(h.name)}（${h.tiles.length}マス）</option>`).join("") + `</optgroup>`;
	}
	if (hs.dataset.opts !== opts) { const v = hs.value; hs.innerHTML = opts || "<option value=''>鉄道駅がありません</option>"; hs.dataset.opts = opts; if (v) hs.value = v; }
	// area inputs (do not overwrite while editing)
	const a = currentArea();
	for (const [id, v] of [["ax1", a?.x1], ["ax2", a?.x2], ["ay1", a?.y1], ["ay2", a?.y2]]) {
		const inp = document.getElementById(id);
		if (document.activeElement !== inp) inp.value = v ?? "";
	}
	renderStationCfg();
	renderChecks(st);
	renderSidings(st);
	renderNames(st);
	// signals in the area
	const sl = document.getElementById("sigList");
	const sortMode = document.getElementById("sigSort").value;
	const sigs = tracks.tiles.filter(t => t.s && (isVisible(t) || (st && st.signals.some(s => key(s.pos) === key(t.p)))))
		.sort((a, b) => (sortMode === "owner" ? (a.s.o ?? 99) - (b.s.o ?? 99) : 0) || a.p[1] - b.p[1] || a.p[0] - b.p[0] || b.p[2] - a.p[2]);
	let lastOwner = null;
	sl.innerHTML = !st ? `<span class="hint">先に連動駅を作成してください</span>` : sigs.length ? sigs.map(t => {
		const on = st.signals.some(s => key(s.pos) === key(t.p));
		let head = "";
		if (sortMode === "owner" && t.s.o !== lastOwner) { lastOwner = t.s.o; head = `<div class="owner">${esc(companyName(t.s.o))}</div>`; }
		return head + `<div class="item"><span>${on ? "<b>" + signalLabel(st, t.p) + "</b> " : ""}(${t.p.join(", ")}) <span class="hint">${layerName(t.p[2])}${sortMode === "pos" ? "・" + esc(companyName(t.s.o)) : ""}</span></span>
			<button data-sig="${key(t.p)}">${on ? "解除" : "登録"}</button></div>`;
	}).join("") : `<span class="hint">表示中の線路に信号がありません（上の表示の切り替えも確認してください）</span>`;
	for (const b of sl.querySelectorAll("button")) b.addEventListener("click", () => {
		const t = tileIndex.get(b.dataset.sig);
		const on = st.signals.some(s => key(s.pos) === b.dataset.sig);
		toggleSignal(t, on);
	});
	// routes
	const rl = document.getElementById("routeList");
	const routes = st ? status.routes.filter(r => r.station === st.id) : [];
	rl.innerHTML = routes.map(r => `<div class="item" data-route="${r.id}"><span>${esc(r.name)} <span class="hint">${r.tiles.length}マス</span></span><span><button data-ren="${r.id}">名前</button><button data-del="${r.id}">削除</button></span></div>`).join("") || `<span class="hint">進路はまだありません</span>`;
	for (const it of rl.querySelectorAll(".item")) {
		const r = routes.find(x => x.id === Number(it.dataset.route));
		it.addEventListener("mouseenter", () => { hoverRoute = r; renderMap(); });
		it.addEventListener("mouseleave", () => { hoverRoute = null; renderMap(); });
	}
	for (const b of rl.querySelectorAll("button[data-ren]")) b.addEventListener("click", () => {
		const r = routes.find(x => x.id === Number(b.dataset.ren));
		const name = prompt("進路の名前", r.name);
		if (name === null || !name.trim() || name.trim() === r.name) return;
		command(`rt_name,${r.id},${name.trim()}`, "進路の名前 " + name.trim());
	});
	for (const b of rl.querySelectorAll("button[data-del]")) b.addEventListener("click", () => {
		const r = routes.find(x => x.id === Number(b.dataset.del));
		if (confirm(`進路「${r.name}」を削除しますか？`)) command("rt_del," + r.id, "進路の削除 " + r.name);
	});
	document.getElementById("routeHint").textContent = manualRoute ?
		(manualRoute.start ? "着点の線路（番線の端など）をクリックしてください。（Esc で中止）" : "始点のてこ扱い信号をクリックしてください。（Esc で中止）") :
		"自動作成: 各てこ扱い信号から各番線・留置線へ、出発信号から区域の出口への進路を作ります。手で作る: 始点の信号 → 着点の線路の順にクリックします。";
	document.getElementById("btnManualRoute").textContent = manualRoute ? "中止" : "手で作る";
}
