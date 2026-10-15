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
	// margin: room for the destination buttons at the exits and for labels
	const M = Math.round(Math.max(30, CELL * .9 + 50 * Math.max(.8, sc * .9)));
	svg.setAttribute("width", w + 2 * M); svg.setAttribute("height", h + 2 * M);
	svg.innerHTML = "";
	const g = el("g", { transform: `translate(${M},${M})` }, svg);
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

	// labels are placed at the end, beside their mark where they cover the least (tracks, marks, buttons)
	const obstacles = [];
	const labelQueue = [];
	const block = (x1, y1, x2, y2, wt = 1) => obstacles.push([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2), wt]);
	const label = (parent, x, y, rr, text, attrs, plate) => labelQueue.push({ parent, x, y, rr, text, attrs, plate });
	const mapLevers = isRelay() && tab === "run" && viewOpt().mapLevers !== false;

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
			const hw = 4 * sc;
			block(cx(t.p) - hw, cy(t.p) - hw, cx(t.p) + dx * CELL / 2 + hw * (dx ? 0 : 1), cy(t.p) + dy * CELL / 2 + hw * (dy ? 0 : 1));
			block(cx(t.p) + hw, cy(t.p) + hw, cx(t.p) + dx * CELL / 2 - hw * (dx ? 0 : 1), cy(t.p) + dy * CELL / 2 - hw * (dy ? 0 : 1));
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
		const off = (mapLevers && interlocked ? 12 : 11) * sc;
		const ox = dy * off, oy = -dx * off;
		const x = cx(t.p) + ox, y = cy(t.p) + oy;
		const fill = t.s.aspect === "green" ? "var(--green)" : t.s.aspect === "yellow" ? "var(--yellow)" : "var(--red)";
		if (mapLevers && interlocked) {
			// relay panel: the signal lever itself, beside the track
			mapKnob(t.p, x, y, dx, dy);
			if (shuntColor(st, t.p)) mapKnob(t.p, x - dx * 20 * sc, y - dy * 20 * sc, dx, dy, true);
			continue;
		}
		const grp = el("g", { class: "clickable" + (interlocked && !mayHandle(st, t.p) ? " other" : "") }, g);
		// arrow for the direction of travel
		const ax = cx(t.p) + dx * 10 * sc, ay = cy(t.p) + dy * 10 * sc, a7 = 7 * sc, a5 = 5 * sc;
		el("polygon", { points: `${ax},${ay} ${ax - dx * a7 + dy * a5},${ay - dy * a7 - dx * a5} ${ax - dx * a7 - dy * a5},${ay - dy * a7 + dx * a5}`, fill: "#cfd6e0" }, grp);
		el("circle", { cx: x, cy: y, r: (interlocked ? 8 : 6) * sc, fill, stroke: interlocked ? "#fff" : "#0f1319", "stroke-width": interlocked ? 2.5 : 1.5 }, grp);
		block(x - 8 * sc, y - 8 * sc, x + 8 * sc, y + 8 * sc, 3);
		if (interlocked) label(grp, x, y, 8 * sc, signalLabel(st, t.p), { "font-size": Math.max(11, 12 * sc), "font-weight": 700, fill: "#fff" });
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
		block(x - 9 * sc, y - 9 * sc, x + 9 * sc, y + 9 * sc, 3);
		label(grp, x, y, 9 * sc, pointName(st, i), { "font-size": Math.max(10, 10 * sc), fill: "#9fb3cf" });
		grp.appendChild(el("title", {})).textContent = `${pointName(st, i)} ` + (ps.by ? `鎖錠中（${ps.by}）` : posName(ps.manual) + (ps.pairs ? `（${pairsText(ps.pairs)}）` : "")) + "（クリックで 自動→定位→反位 と切り替え）";
		if (tab === "run") grp.addEventListener("click", (e) => { e.stopPropagation(); pointClicked(i); });
	});
	// destination buttons (着点): lit when reachable from the selected start lever
	if (st && tab === "run") {
		const start = currentStart();
		const dests = start ? findDestinations(start) : new Map();
		const button = (id, name, t, ox, oy) => {
			if (!t || !isVisible(t)) return;
			const d = dests.get(id);
			const lit = d && d.free, dim = d && !d.free;
			// a round push button on the track, its name on a plate beside it
			const br = 7.5 * Math.max(.8, sc * .9);
			const x = cx(t.p) + ox, y = cy(t.p) + oy;
			const grp = el("g", { class: "clickable dest" + (lit ? " blink" : "") }, g);
			el("circle", { cx: x, cy: y + 1.6, r: br + 1.6, fill: "#05080a", opacity: .6 }, grp);
			el("circle", { cx: x, cy: y, r: br + 1.6, fill: "#3b4250", stroke: lit || dim ? "var(--yellow)" : "#11151b", "stroke-width": lit || dim ? 2 : 1, "stroke-dasharray": dim ? "3 2" : "" }, grp);
			el("circle", { cx: x, cy: y, r: br, fill: lit ? "var(--yellow)" : "#e6e3d8" }, grp);
			el("circle", { cx: x - br * .3, cy: y - br * .35, r: br * .35, fill: "#fff", opacity: .55 }, grp);
			block(x - br - 2, y - br - 2, x + br + 2, y + br + 2, 3);
			label(grp, x, y, br + 2, name, { "font-size": 11, "font-weight": 600, fill: lit ? "#1a1a1a" : "#dfe6f0" },
				{ fill: lit ? "var(--yellow)" : "#20283a", stroke: lit || dim ? "var(--yellow)" : "#3a4558" });
			grp.appendChild(el("title", {})).textContent = `着点ボタン：${name}` + (lit ? "（押すと進路を引きます）" : dim ? "（在線・他の進路と重なるため今は引けません）" : "");
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
		// up to a train standing on the track (手前): only offered when such a route can be set
		for (const [id, d] of dests) if (id.startsWith("n")) button(id, d.label, d.path[d.path.length - 1], 0, 0);
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
		if (mapLevers) {
			// relay panel: the lever beside the platform end (left of the direction of leaving)
			const [dx, dy] = SV(startTravelDir(st, d.pos) || E);
			mapKnob(d.pos, cx(t.p) + dy * 12 * sc, cy(t.p) - dx * 12 * sc, dx, dy);
			if (shuntColor(st, d.pos)) mapKnob(d.pos, cx(t.p) + dy * 12 * sc - dx * 20 * sc, cy(t.p) - dx * 12 * sc - dy * 20 * sc, dx, dy, true);
			continue;
		}
		const x = cx(t.p), y = cy(t.p), r = 7 * sc;
		block(x - r, y - r, x + r, y + r, 3);
		const grp = el("g", { class: (tab === "run" ? "clickable" : "") + (mayHandle(st, d.pos) ? "" : " other") }, g);
		if (tab === "run") grp.addEventListener("click", (e) => { e.stopPropagation(); startClicked(d.pos, true); });
		if (d.shunt) {
			// virtual shunting signal: a diamond (lit white when a route is set)
			el("path", { d: `M${x} ${y - r * 1.25} L${x + r * 1.25} ${y} L${x} ${y + r * 1.25} L${x - r * 1.25} ${y} Z`, fill: clear ? "#f4f4f4" : "var(--red)", stroke: "#fff", "stroke-width": 2 }, grp);
		}
		else el("rect", { x: x - r, y: y - r, width: 2 * r, height: 2 * r, rx: 2, fill: clear ? "var(--green)" : "var(--red)", stroke: "#fff", "stroke-width": 2 }, grp);
		label(grp, x, y, r, signalLabel(st, d.pos), { "font-size": Math.max(11, 12 * sc), "font-weight": 700, fill: "#fff" });
		grp.appendChild(el("title", {})).textContent = `${d.shunt ? "仮想入換信号" : "仮想出発信号"} ${signalLabel(st, d.pos)} (${d.pos.join(", ")})` + (d.train ? " " + d.train : "");
	}
	// electronic panel: the shunting / calling-on lever of a start point, a small button behind it
	if (st && !isRelay() && tab === "run") for (const x of st.shunt_levers || []) {
		const t = tileIndex.get(key(x.pos));
		if (!t || !isVisible(t)) continue;
		const [dx, dy] = SV(startTravelDir(st, x.pos) || E);
		const bx = cx(t.p) - dx * 16 * sc + dy * 9 * sc, by = cy(t.p) - dy * 16 * sc - dx * 9 * sc, r = 5.5 * sc;
		const sel = nxStart && nxStart.shunt && key(nxStart.pos) === key(x.pos);
		const grp = el("g", { class: "clickable" + (mayHandle(st, x.pos) ? "" : " other"), "data-shuntstart": key(x.pos) }, g);
		el("rect", { x: bx - r, y: by - r, width: 2 * r, height: 2 * r, rx: 2, fill: extraColor(x.color), stroke: sel ? "var(--yellow)" : "#111", "stroke-width": sel ? 3 : 1.2 }, grp);
		block(bx - r, by - r, bx + r, by + r, 3);
		grp.appendChild(el("title", {})).textContent = `${signalLabel(st, x.pos)} の${extraKind(x.color)}（押してから着点ボタン）`;
		grp.addEventListener("click", (e) => { e.stopPropagation(); startClicked(x.pos, isDepartureAnchor(st, x.pos), true); });
	}
	// halt names
	const named = new Set();
	for (const t of tiles) {
		if (!t.h || named.has(t.h) || !isVisible(t)) continue;
		named.add(t.h);
		const hl = halts.find(x => x.id === t.h);
		if (hl) label(g, cx(t.p), cy(t.p) - CELL / 2, 2, hl.name, { "font-size": 11, fill: "#9fb3cf" });
	}
	placeLabels();
	// the signal pointed at in a list of the setup tab
	if (hoverSignal) {
		const t = tileIndex.get(hoverSignal);
		if (t) {
			const ring = el("circle", { cx: cx(t.p), cy: cy(t.p), r: 19 * sc, fill: "none", stroke: "var(--yellow)", "stroke-width": 4, class: "blink", "pointer-events": "none", id: "hoverSignalRing" }, g);
			el("circle", { cx: cx(t.p), cy: cy(t.p), r: 26 * sc, fill: "none", stroke: "var(--yellow)", "stroke-width": 1.5, opacity: .6, "pointer-events": "none" }, g);
			if (hoverScroll) {
				hoverScroll = false;
				const wr = document.getElementById("mapwrap").getBoundingClientRect(), rr = ring.getBoundingClientRect();
				if (rr.left < wr.left || rr.right > wr.right || rr.top < wr.top + 40 || rr.bottom > wr.bottom) ring.scrollIntoView({ block: "center", inline: "center" });
			}
		}
	}

	// a signal lever drawn on the map (relay panel): knob, aspect lamp ahead, number
	function mapKnob(pos, x, y, dx, dy, sh = false) {
		const v = leverView(st, pos, sh);
		const mk = sh ? key(pos) + "|S" : key(pos);
		const k = .42 * sc;              // the lever of the board, scaled down
		const r = 22 * k;                // radius of its base
		const grp = el("g", { class: "mapknob" + (hoverLever === mk ? " hl" : "") + (mayHandle(st, pos) ? "" : " other"), "data-mk": mk }, g);
		el("circle", { cx: x, cy: y, r: r + 3, class: "ring" }, grp);
		const lg = el("g", { transform: `translate(${x - 30 * k} ${y - 40 * k}) scale(${k})` }, grp);
		lg.innerHTML = leverShapes(v.color, v.angle ? Math.sign(v.angle) * 40 : 0, v.no);
		const lx = x + dx * (r + 4 * sc), ly = y + dy * (r + 4 * sc);
		el("circle", { cx: lx, cy: ly, r: 3.2 * sc, fill: v.clear ? "var(--green)" : "var(--red)", stroke: "#000", "stroke-width": .8, class: v.blink ? "blink" : "" }, grp);
		block(x - r - 2, y - r - 2, x + r + 2, y + r + 2, 3);
		block(lx - 4 * sc, ly - 4 * sc, lx + 4 * sc, ly + 4 * sc, 3);
		// the number is on the plate of the lever; at small sizes also beside it
		if (sc < 1.6) label(grp, x, y, r + 1, String(v.no), { "font-size": Math.max(10, 10 * sc), "font-weight": 700, fill: "#e8e4d4" });

		grp.appendChild(el("title", {})).textContent = `${v.no} ${signalLabel(st, pos)}${sh ? " 入換てこ" : ""}：${v.sl ? "反位（もう一度押すと定位）" : "押すと開通方向にひねる"}${v.state ? "　" + v.state : ""}`;
		grp.addEventListener("click", (e) => { e.stopPropagation(); turnSignalLever(pos, v.sl ? "N" : null, sh); });
		grp.addEventListener("mouseenter", () => setHoverLever(mk));
		grp.addEventListener("mouseleave", () => setHoverLever(null));
	}

	function placeLabels() {
		const area = (r, o) => Math.max(0, Math.min(r[2], o[2]) - Math.max(r[0], o[0])) * Math.max(0, Math.min(r[3], o[3]) - Math.max(r[1], o[1]));
		for (const L of labelQueue) {
			const fs = L.attrs["font-size"] || 11;
			const pad = L.plate ? 5 : 0;
			const w = [...String(L.text)].reduce((s, c) => s + (c.charCodeAt(0) > 255 ? fs : fs * .62), 0) + 2 * pad, h = fs * 1.15 + pad;
			const a = L.rr + h / 2 + 1, b = L.rr + w / 2 + 3, d = L.rr * .75;
			const cands = [[0, -a], [0, a], [b, 0], [-b, 0], [d + w / 2, -(d + h / 2)], [d + w / 2, d + h / 2], [-(d + w / 2), -(d + h / 2)], [-(d + w / 2), d + h / 2], [0, -a - h], [0, a + h]];
			let best = null, bestScore = Infinity;
			for (const [ox, oy] of cands) {
				const r = [L.x + ox - w / 2, L.y + oy - h / 2, L.x + ox + w / 2, L.y + oy + h / 2];
				const score = obstacles.reduce((s, o) => s + area(r, o) * o[4], 0);
				if (score < bestScore) { bestScore = score; best = r; }
				if (score === 0) break;
			}
			if (L.plate) el("rect", { x: best[0], y: best[1], width: best[2] - best[0], height: best[3] - best[1], rx: 3, fill: L.plate.fill, stroke: L.plate.stroke }, L.parent);
			el("text", Object.assign({ x: (best[0] + best[2]) / 2, y: best[3] - (h - pad) * .25 - pad / 2, "text-anchor": "middle", "pointer-events": "none" }, L.attrs), L.parent).textContent = L.text;
			obstacles.push([best[0], best[1], best[2], best[3], 4]);
		}
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
	renderDeskBar();
	const st = station();
	const lv = document.getElementById("levers");
	const hint = document.getElementById("runHint");
	const ap = document.getElementById("approach");
	if (!st) { lv.innerHTML = ""; ap.innerHTML = ""; hint.textContent = ""; return; }

	// approach indication: a train holds an interlocked signal at danger
	// the line (路線) of the train often names its type (普通・快速 …): shown first, then the train and its next stop
	const train = (x) => `${x.line ? `<span class="linename">${esc(x.line)}</span> ` : ""}${esc(x.train)}${x.dest ? ` <span class="hint">次 ${esc(x.dest)}</span>` : ""}`;
	const waiting = st.signals.filter(s => s.train && s.aspect === "red").map(s => `<div>${signalLabel(st, s.pos)}：${train(s)} 待機中</div>`);
	const leaving = (st.departures || []).filter(d => d.train && d.waiting && !status.routes.some(r => key(r.start) === key(d.pos) && r.state !== "idle"))
		.map(d => `<div>${signalLabel(st, d.pos)}：${train(d)} ${d.shunt ? "入換待ち" : "発車待ち"}</div>`);
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
let hoverSignal = null;   // signal highlighted while hovering it in a list (key)
let hoverScroll = false;  // bring it into view once
function hoverSignalOn(elements, keyOf) {
	for (const e of elements) {
		e.addEventListener("mouseenter", () => { hoverSignal = keyOf(e); hoverScroll = true; renderMap(); });
		e.addEventListener("mouseleave", () => { hoverSignal = null; renderMap(); });
	}
}
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
	hoverSignalOn(document.querySelectorAll("[data-sigtoggle]"), (e) => e.dataset.sigtoggle);
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
	let html = "";
	if (st) {
		// stops near the station that can be used as sidings (駅属性の留置線)
		const on = sidingHaltIds();
		const cands = [...new Set([...nearHalts, ...on])].map(id => halts.find(h => h.id === id)).filter(Boolean);
		autoSidingHalts(st, cands);
		if (cands.length) {
			html += `<div class="check"><div class="head"><b>ほかの駅を留置線として扱う</b></div><div class="msg">区域につながるほかの駅です。チェックした駅は、この駅の区域の線路（留置線）として扱います。</div><div class="acts">` +
				cands.map(h => `<label><input type="checkbox" data-sidhalt="${h.id}" ${on.has(h.id) ? "checked" : ""}>${esc(h.name)}</label>`).join("") + `</div></div>`;
		}
		html += layout.sidings.map((sd, i) => {
			const title = `${esc(sidingName(st, i))}（${sd.anchor.p[0]}, ${sd.anchor.p[1]}）` + (sd.halt ? `<span class="tag">駅</span>` : "") +
				(sd.deadEnd ? `<span class="tag">行き止まり</span>` : `<span class="tag">両端</span>`) + `<span class="tag">${sd.tiles.length}マス</span>`;
			// one virtual shunting signal per end where trains leave
			const ends = sd.deadEnd ? sd.ends.slice(0, 1) : sd.ends;
			const acts = ends.map(e => {
				const dep = sd.deps.find(d => key(d.pos) === key(e.t.p));
				const side = ends.length > 1 ? `${dirName(e.dir)}側の端` : "";
				return dep ? `<button data-shdel="${key(dep.pos)}">${side}仮想入換信号を解除</button>` : `<button data-shadd="${key(e.t.p)}">${side}仮想入換信号にする</button>`;
			}).join("");
			const msg = sd.deps.length ? `✔ 仮想入換信号（${sd.deps.map(d => esc(signalLabel(st, d.pos))).join("・")}）で管理しています` : "入換を扱わないなら、このままで構いません。";
			return `<div class="check ${sd.deps.length ? "ok" : ""}" data-prev="${sd.tiles.map(t => key(t.p)).join(";")}"><div class="head"><b>${title}</b></div><div class="msg">${msg}</div><div class="acts">${acts}</div></div>`;
		}).join("") || `<span class="hint">区域内に留置線はありません。</span>`;
	}
	else html = `<span class="hint">先に連動駅を作成してください</span>`;
	if (box.dataset.html === html) return;
	box.innerHTML = box.dataset.html = html;
	for (const c of box.querySelectorAll(".check[data-prev]")) {
		c.addEventListener("mouseenter", () => { checkPreview = new Set(c.dataset.prev.split(";")); renderMap(); });
		c.addEventListener("mouseleave", () => { checkPreview = null; renderMap(); });
	}
	for (const b of box.querySelectorAll("[data-shadd]")) b.addEventListener("click", () =>
		command(`dep_add,${st.id},${b.dataset.shadd},S`, "仮想入換信号の登録 (" + b.dataset.shadd + ")"));
	for (const b of box.querySelectorAll("[data-shdel]")) b.addEventListener("click", () =>
		command(`dep_del,${st.id},${b.dataset.shdel}`, "仮想入換信号の解除 (" + b.dataset.shdel + ")"));
	for (const c of box.querySelectorAll("[data-sidhalt]")) c.addEventListener("change", () => {
		const ids = [...box.querySelectorAll("[data-sidhalt]")].filter(x => x.checked).map(x => Number(x.dataset.sidhalt));
		setSidingHalts(st, ids);
	});
}
// stored in the game as one tile of each stop
function setSidingHalts(st, ids) {
	const pos = ids.map(id => (tracks.tiles.find(t => t.h === id) || {}).p).filter(Boolean);
	command(`st_sid,${st.id},${pos.map(p => p.join(":")).join(";")}`, "留置線として扱う駅");
}
// once per station: stops named like a siding (留置・引上…) are used as sidings
function autoSidingHalts(st, cands) {
	if ((st.siding_halts || []).length || localStore("sidauto." + st.id)) return;
	const named = cands.filter(h => SIDING_NAME.test(h.name));
	if (!named.length) return;
	localStore("sidauto." + st.id, "1");
	setSidingHalts(st, named.map(h => h.id));
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
	const slHtml = !st ? `<span class="hint">先に連動駅を作成してください</span>` : sigs.length ? sigs.map(t => {
		const on = st.signals.some(s => key(s.pos) === key(t.p));
		let head = "";
		if (sortMode === "owner" && t.s.o !== lastOwner) { lastOwner = t.s.o; head = `<div class="owner">${esc(companyName(t.s.o))}</div>`; }
		return head + `<div class="item" data-hsig="${key(t.p)}"><span>${on ? "<b>" + signalLabel(st, t.p) + "</b> " : ""}(${t.p.join(", ")}) <span class="hint">${layerName(t.p[2])}${sortMode === "pos" ? "・" + esc(companyName(t.s.o)) : ""}</span></span>
			<button data-sig="${key(t.p)}">${on ? "解除" : "登録"}</button></div>`;
	}).join("") : `<span class="hint">表示中の線路に信号がありません（上の表示の切り替えも確認してください）</span>`;
	// rebuilt only when it changes, so that the item under the mouse stays
	if (sl.dataset.html !== slHtml) {
		sl.innerHTML = sl.dataset.html = slHtml;
		for (const b of sl.querySelectorAll("button")) b.addEventListener("click", () => {
			const t = tileIndex.get(b.dataset.sig);
			const on = st.signals.some(s => key(s.pos) === b.dataset.sig);
			toggleSignal(t, on);
		});
		hoverSignalOn(sl.querySelectorAll("[data-hsig]"), (e) => e.dataset.hsig);
	}
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
