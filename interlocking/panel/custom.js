// TID interlocking panel: custom panel of a station (カスタム盤)
// The parts are stored in the game (saved with it, the same for everybody); the panel grid has 2 steps per tile.
// Parts: T track (x1,y1)-(x2,y2) standing for the game tiles in b, S start lever (b[0], f=1 its shunting lever),
// P point (b[0]), D destination button (b[0]), H platform (rectangle), L text, A arrow (至○○), F frame (f = colour),
// C clock (game time), K compass, Y style of the panel (f: bits 0-1 orientation of the drawing, bits 4-6 colour of the panel).
// Texts are kept encoded (encodeURIComponent).
"use strict";

const customPanels = new Map();   // station id -> { rev, parts }
const PANEL_COLORS = [["標準", "transparent"], ["緑盤", "#203a2c"], ["灰盤", "#3b4044"], ["紺", "#1b2a44"], ["黒", "#07090c"]];
const FRAME_COLORS = ["#4a90d9", "#e0a100", "#3fbf6f", "#e0603a", "#a06ee0"];
const styleOf = (parts) => parts.find(p => p.t === "Y") || { f: 0 };
// time of day as in OTRP (one month = one day): "HH:MM:SS" and "minute/1440"
function clockOf(s) {
	if (!s || !s.tpm) return { hms: "--:--:--", min: "----/1440" };
	const sec = Math.floor(s.tick_m * 86400 / s.tpm);
	const two = (n) => String(n).padStart(2, "0");
	return { hms: `${two(Math.floor(sec / 3600))}:${two(Math.floor(sec / 60) % 60)}:${two(sec % 60)}`, min: `${Math.floor(s.tick_m * 1440 / s.tpm)}/1440` };
}
let cpEdit = null;                // editing: { parts, sel, tool }
let cpFetching = 0;
const panelSaves = new Map();     // station id -> custom panels saved (event "panel") since this page was opened

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------
const partText = (p) => { try { return decodeURIComponent(p.s || ""); } catch (e) { return p.s || ""; } };
function customOf(st) {
	if (!st || !st.parts) return null;
	const c = customPanels.get(st.id);
	if ((!c || c.rev !== st.parts_rev) && cpFetching !== st.id) {
		cpFetching = st.id;
		api("/api/panel?id=" + st.id).then(r => { customPanels.set(st.id, { rev: r.rev, parts: r.parts }); cpFetching = 0; render(); }).catch(() => { cpFetching = 0; });
	}
	return c && c.parts.length ? c : null;
}
// the custom panel is shown (this browser's choice, the custom panel when the station has one)
function customView(st) {
	if (cpEdit) return !cpEdit.pick;   // picking game tiles for a part: on the track plan
	if (!st || !st.parts || localStore("custom." + st.id) === "0") return false;
	return !!customOf(st);
}
function setCustomView(st, on) { localStore("custom." + st.id, on ? "1" : "0"); render(); }

// upload: cp_begin, cp_add,<parts> ... (each command below ~3500 characters), cp_end,<count>
async function uploadParts(st, parts) {
	const enc = (p) => [p.t, p.x1, p.y1, p.x2, p.y2, p.f || 0, (p.b || []).map(t => t.join(":")).join("+"), p.s || ""].join("/");
	const send = (cmd) => fetch("/api/cmd", { method: "POST", headers: { "X-IL-Panel": "1", "Content-Type": "text/plain; charset=utf-8" }, body: cmd });
	await send(`cp_begin,${st.id}`);
	let chunk = [];
	let len = 0;
	for (const p of parts) {
		const e = enc(p);
		if (len + e.length > 3500 && chunk.length) { await send(`cp_add,${st.id},${chunk.join(";")}`); chunk = []; len = 0; }
		chunk.push(e); len += e.length + 1;
	}
	if (chunk.length) await send(`cp_add,${st.id},${chunk.join(";")}`);
	return commandResult(`cp_end,${st.id},${parts.length}`);
}

// ---------------------------------------------------------------------------
// draft from the track plan as it is drawn now (area and orientation of the view)
// ---------------------------------------------------------------------------
function makeDraft(st) {
	const a = currentArea();
	if (!a) return [];
	const rot = viewRot();
	const W0 = a.x2 - a.x1 + 1, H0 = a.y2 - a.y1 + 1;
	const uv = (p) => {
		const lx = p[0] - a.x1, ly = p[1] - a.y1;
		return rot === 0 ? [lx, ly] : rot === 1 ? [H0 - 1 - ly, lx] : rot === 2 ? [W0 - 1 - lx, H0 - 1 - ly] : [ly, W0 - 1 - lx];
	};
	const SV = (d) => screenVec(d);
	const ctr = (p) => { const [u, v] = uv(p); return [2 * u + 1, 2 * v + 1]; };
	const parts = [];
	// platforms (behind the tracks)
	layout.groups.forEach((gr, i) => {
		const cs = gr.filter(isVisible).map(t => ctr(t.p));
		if (!cs.length) return;
		const xs = cs.map(c => c[0]), ys = cs.map(c => c[1]);
		parts.push({ t: "H", x1: Math.min(...xs) - 1, y1: Math.min(...ys) - 1, x2: Math.max(...xs) + 1, y2: Math.max(...ys) + 1, b: gr.map(t => t.p), s: encodeURIComponent(platformName(st, i)) });
	});
	// tracks: half tiles, merged into straight lines between junctions and bends
	const edges = new Map();        // "x,y|x,y" -> { a, b, tile }
	const at = new Map();           // "x,y" -> [edge keys]
	for (const t of tracks.tiles) {
		if (!isVisible(t)) continue;
		const c = ctr(t.p);
		for (const d of DIRS) {
			if (!(t.r & d)) continue;
			const [dx, dy] = SV(d);
			const e = [c[0] + dx, c[1] + dy];
			const k = c.join(",") + "|" + e.join(",");
			if (edges.has(k)) continue;
			edges.set(k, { a: c, b: e, tile: t.p });
			for (const pt of [c, e]) { const pk = pt.join(","); if (!at.has(pk)) at.set(pk, []); at.get(pk).push(k); }
		}
	}
	const used = new Set();
	const dirOf = (e) => [Math.sign(e.b[0] - e.a[0]), Math.sign(e.b[1] - e.a[1])];
	for (const [k, e0] of edges) {
		if (used.has(k)) continue;
		used.add(k);
		const [dx, dy] = dirOf(e0);
		let p1 = e0.a, p2 = e0.b;
		const tiles = [e0.tile];
		// grow at both ends while the line goes straight on through a point with two edges
		const grow = (pt, sx, sy) => {
			for (;;) {
				const ks = at.get(pt.join(",")) || [];
				if (ks.length !== 2) return pt;
				const nk = ks.find(x => !used.has(x));
				if (!nk) return pt;
				const ne = edges.get(nk);
				const other = ne.a.join(",") === pt.join(",") ? ne.b : ne.a;
				if (Math.sign(other[0] - pt[0]) !== sx || Math.sign(other[1] - pt[1]) !== sy) return pt;
				used.add(nk);
				if (!tiles.some(t => key(t) === key(ne.tile))) tiles.push(ne.tile);
				pt = other;
			}
		};
		p2 = grow(p2, dx, dy);
		p1 = grow(p1, -dx, -dy);
		parts.push({ t: "T", x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], b: tiles });
	}
	// points
	layout.points.forEach((pt) => { if (isVisible(pt.t)) { const c = ctr(pt.t.p); parts.push({ t: "P", x1: c[0], y1: c[1], x2: c[0], y2: c[1], b: [pt.t.p] }); } });
	// start levers: beside the track, left of the direction of travel; the shunting lever behind it
	const starts = st.signals.map(s => s.pos).concat((st.departures || []).map(d => d.pos));
	for (const pos of starts) {
		const t = tileIndex.get(key(pos));
		if (!t || !isVisible(t)) continue;
		const travel = startTravelDir(st, pos) || singleDir(t.m) || E;
		const [dx, dy] = SV(travel);
		const c = ctr(pos);
		const x = c[0] + dy, y = c[1] - dx;
		parts.push({ t: "S", x1: x, y1: y, x2: x, y2: y, b: [pos] });
		if (shuntColor(st, pos)) parts.push({ t: "S", x1: x - dx * 2, y1: y - dy * 2, x2: x - dx * 2, y2: y - dy * 2, b: [pos], f: 1 });
	}
	// destination buttons
	const dest = (t, ox = 0, oy = 0) => { if (t && isVisible(t)) { const c = ctr(t.p); parts.push({ t: "D", x1: c[0] + ox, y1: c[1] + oy, x2: c[0] + ox, y2: c[1] + oy, b: [t.p] }); } };
	layout.groups.forEach((gr) => dest(gr.slice().sort((a, b) => a.p[0] - b.p[0] || a.p[1] - b.p[1])[Math.floor(gr.length / 2)]));
	layout.sidings.forEach((sd) => dest(sd.tiles.slice().sort((a, b) => Math.hypot(b.p[0] - sd.anchor.p[0], b.p[1] - sd.anchor.p[1]) - Math.hypot(a.p[0] - sd.anchor.p[0], a.p[1] - sd.anchor.p[1]))[0]));
	layout.exits.forEach((x) => { const [dx, dy] = SV(x.dir); dest(x.tile, dx * 2, dy * 2); });
	for (const t of layout.depots) dest(t, 0, -1);
	// the style of the panel: where north is on the drawing (for the compass). It stays when the map is turned
	// later: the drawing shows the station as it is, only the coordinates of the game change
	parts.push({ t: "Y", x1: 0, y1: 0, x2: 0, y2: 0, b: [], f: northDir() });
	// normalize: the panel starts at (2,2)
	const placed = parts.filter(p => p.t !== "Y");
	const xs = placed.flatMap(p => [p.x1, p.x2]), ys = placed.flatMap(p => [p.y1, p.y2]);
	const ox = 2 - Math.min(...xs), oy = 2 - Math.min(...ys);
	for (const p of placed) { p.x1 += ox; p.x2 += ox; p.y1 += oy; p.y2 += oy; }
	return parts;
}

// ---------------------------------------------------------------------------
// what a part stands for in the game
// ---------------------------------------------------------------------------
// destination id (as findDestinations() names them) of a bound tile
function destIdOf(p) {
	const k = p.b && p.b[0] ? key(p.b[0]) : null;
	if (!k) return null;
	let id = null;
	layout.groups.forEach((gr, i) => { if (!id && gr.some(t => key(t.p) === k)) id = "p" + i; });
	layout.sidings.forEach((sd, i) => { if (!id && sd.tiles.some(t => key(t.p) === k)) id = "s" + i; });
	layout.exits.forEach((x, i) => { if (!id && key(x.tile.p) === k) id = "x" + i; });
	if (!id && layout.depots.some(t => key(t.p) === k)) id = "d" + k;
	return id;
}
function destName(st, id) {
	if (!id) return "（不明）";
	const i = Number(id.slice(1));
	return id[0] === "p" ? platformName(st, i) : id[0] === "s" ? sidingName(st, i) : id[0] === "x" ? exitName(st, i) : id[0] === "d" ? "車庫" : id;
}
// the part no longer matches the track (rebuilt in the game): drawn grey and dashed
function unbound(st, p) {
	// a line or platform that stands for no tile at all is a decoration
	if (p.t === "T" || p.t === "H") return (p.b || []).length > 0 && !p.b.some(t => tileIndex.has(key(t)));
	if (p.t === "S") return !p.b[0] || !(st.signals.some(s => key(s.pos) === key(p.b[0])) || isDepartureAnchor(st, p.b[0])) || (p.f && !shuntColor(st, p.b[0]));
	if (p.t === "P") return !p.b[0] || !layout.points.some(pt => key(pt.t.p) === key(p.b[0]));
	if (p.t === "D") return !destIdOf(p);
	return false;
}
// position of a game tile on the custom panel (for destinations that come and go, e.g. 手前)
function gridOfTile(parts, k) {
	for (const p of parts) {
		if (p.t !== "T") continue;
		const i = (p.b || []).findIndex(t => key(t) === k);
		if (i < 0) continue;
		const f = p.b.length > 1 ? i / (p.b.length - 1) : .5;
		return [p.x1 + (p.x2 - p.x1) * f, p.y1 + (p.y2 - p.y1) * f];
	}
	const symbol = parts.find(p => ["P", "S", "D"].includes(p.t) && (p.b || []).some(t => key(t) === k));
	if (symbol) return [symbol.x1, symbol.y1];
	return null;
}

// ---------------------------------------------------------------------------
// drawing (operation and editing)
// ---------------------------------------------------------------------------
function renderCustom() {
	const svg = document.getElementById("map");
	const st = station();
	document.getElementById("mapEmpty").style.display = "none";
	svg.style.display = "block";
	const parts = cpEdit ? cpEdit.parts : (customOf(st) || { parts: [] }).parts;
	const wrap = document.getElementById("mapwrap");
	const placed = parts.filter(p => p.t !== "Y");
	const xs = placed.flatMap(p => [p.x1, p.x2]), ys = placed.flatMap(p => [p.y1, p.y2]);
	const GW = Math.max(8, (xs.length ? Math.max(...xs) : 8) + 2), GH = Math.max(6, (ys.length ? Math.max(...ys) : 6) + 2);
	const fit = Math.floor(Math.min((wrap.clientWidth - 40) / GW, (wrap.clientHeight - 60) / GH));
	const G = Math.max(6, Math.round(Math.max(8, Math.min(30, fit || 17)) * zoom));   // pixels per grid step
	CELL = 2 * G;
	const sc = CELL / 34;
	svg.setAttribute("width", GW * G + 40); svg.setAttribute("height", GH * G + 40);
	svg.innerHTML = "";
	const style = styleOf(parts);
	const bg = PANEL_COLORS[(style.f >> 4) % PANEL_COLORS.length][1];
	if (bg !== "transparent") el("rect", { x: 4, y: 4, width: GW * G + 32, height: GH * G + 32, rx: 10, fill: bg, stroke: "#0006", "stroke-width": 3 }, svg);
	const g = el("g", { transform: "translate(20,20)" }, svg);
	const X = (v) => v * G, Y = (v) => v * G;
	if (cpEdit) {
		// the grid: a dot per step, stronger per tile
		const dots = el("g", { "pointer-events": "none" }, g);
		for (let x = 0; x <= GW; x++) for (let y = 0; y <= GH; y++) el("circle", { cx: X(x), cy: Y(y), r: x % 2 || y % 2 ? .8 : 1.6, fill: "#3a4558" }, dots);
	}
	const locked = routeStateOfTiles();
	const start = !cpEdit && tab === "run" ? currentStart() : null;
	const dests = start ? findDestinations(start) : new Map();
	const order = { Y: -2, F: -1, H: 0, T: 1, P: 2, D: 3, S: 4, L: 5, A: 5, C: 5, K: 5 };
	const idx = parts.map((p, i) => i).sort((a, b) => order[parts[a].t] - order[parts[b].t]);
	for (const i of idx) {
		const p = parts[i];
		if (p.t === "Y") continue;   // the style is not drawn
		const bad = unbound(st, p);
		const grp = el("g", { class: (cpEdit ? "cpart" : "") + (cpEdit && cpEdit.sel === i ? " sel" : ""), "data-part": i }, g);
		if (p.t === "H") {
			el("rect", { x: X(Math.min(p.x1, p.x2)), y: Y(Math.min(p.y1, p.y2)), width: Math.abs(X(p.x2 - p.x1)), height: Math.abs(Y(p.y2 - p.y1)), rx: 4, fill: "var(--platform)", opacity: bad ? .3 : 1 }, grp);
			// its name only while editing (the destination button shows it)
			if (p.s && cpEdit) el("text", { x: X(Math.min(p.x1, p.x2)) + 4, y: Y(Math.min(p.y1, p.y2)) + 12, "font-size": 10, fill: "#9fb3cf" }, grp).textContent = partText(p);
		}
		else if (p.t === "T") {
			let color = "var(--track)";
			if ((p.b || []).some(t => locked.get(key(t)))) color = "var(--locked)";
			if ((p.b || []).some(t => { const tt = tileIndex.get(key(t)); return tt && tt.c; })) color = "var(--occupied)";
			el("line", { x1: X(p.x1), y1: Y(p.y1), x2: X(p.x2), y2: Y(p.y2), stroke: bad ? "#5a6475" : color, "stroke-width": 6 * sc, "stroke-linecap": "round", "stroke-dasharray": bad ? "6 5" : "" }, grp);
			if (cpEdit) el("line", { x1: X(p.x1), y1: Y(p.y1), x2: X(p.x2), y2: Y(p.y2), stroke: "transparent", "stroke-width": 14 }, grp);
			else if ((routeViaPicking || manualRoute?.start) && p.b?.length) {
				const hit = el("line", { x1: X(p.x1), y1: Y(p.y1), x2: X(p.x2), y2: Y(p.y2), stroke: "transparent", "stroke-width": Math.max(14, 14 * sc), class: "clickable", "data-route-part": i }, grp);
				hit.addEventListener("click", e => {
					e.stopPropagation();
					const point = svg.createSVGPoint(); point.x = e.clientX; point.y = e.clientY;
					const at = point.matrixTransform(grp.getScreenCTM().inverse()), dx = X(p.x2 - p.x1), dy = Y(p.y2 - p.y1);
					const f = dx || dy ? ((at.x - X(p.x1)) * dx + (at.y - Y(p.y1)) * dy) / (dx * dx + dy * dy) : 0;
					const pos = p.b[Math.max(0, Math.min(p.b.length - 1, Math.round(f * (p.b.length - 1))))];
					const t = tileIndex.get(key(pos)); if (t) tileClicked(t);
				});
			}
		}
		else if (p.t === "P") {
			const pi = layout.points.findIndex(pt => p.b[0] && key(pt.t.p) === key(p.b[0]));
			const ps = pi >= 0 ? pointState(layout.points[pi]) : {};
			const color = bad ? "#5a6475" : ps.locked && ps.by ? "var(--locked)" : ps.manual ? "var(--accent)" : "#6b7687";
			el("circle", { cx: X(p.x1), cy: Y(p.y1), r: 7 * sc, fill: "#141a24", stroke: color, "stroke-width": 2, "stroke-dasharray": bad ? "3 2" : "" }, grp);
			if (pi >= 0) {
				el("text", { x: X(p.x1), y: Y(p.y1) - 9 * sc, "font-size": Math.max(9, 9 * sc), fill: "#9fb3cf", "text-anchor": "middle" }, grp).textContent = pointName(st, pi);
				if (!cpEdit && tab === "run") { grp.classList.add("clickable"); grp.addEventListener("click", (e) => { e.stopPropagation(); pointClicked(pi); }); }
				else if (!cpEdit && tab === "setup" && manualRoute?.start) { grp.classList.add("clickable"); grp.addEventListener("click", e => { e.stopPropagation(); tileClicked(layout.points[pi].t); }); }
			}
		}
		else if (p.t === "D") {
			const id = destIdOf(p);
			const d = dests.get(id);
			const lit = d && d.free, dim = d && !d.free;
			if (d?.registeredName) el("title", {}, grp).textContent = `登録進路：${d.registeredName}`;
			const br = 7 * Math.max(.8, sc * .9);
			const x = X(p.x1), y = Y(p.y1);
			if (lit) grp.classList.add("blink");
			el("circle", { cx: x, cy: y, r: br + 1.6, fill: "#3b4250", stroke: lit || dim ? "var(--yellow)" : "#11151b", "stroke-width": lit || dim ? 2 : 1, "stroke-dasharray": dim || bad ? "3 2" : "" }, grp);
			el("circle", { cx: x, cy: y, r: br, fill: bad ? "#5a6475" : lit ? "var(--yellow)" : "#e6e3d8" }, grp);
			el("text", { x, y: y + br + 12, "font-size": 11, "font-weight": 600, fill: lit ? "var(--yellow)" : "#dfe6f0", "text-anchor": "middle" }, grp).textContent = p.s ? partText(p) : destName(st, id);
			if (!cpEdit && p.b?.length && (routeViaPicking || (tab === "setup" && manualRoute?.start))) {
				grp.classList.add("clickable"); grp.addEventListener("click", e => { e.stopPropagation(); const t = tileIndex.get(key(p.b[0])); if (t) tileClicked(t); });
			} else if (!cpEdit && tab === "run" && id) { grp.classList.add("clickable"); grp.addEventListener("click", (e) => { e.stopPropagation(); destinationClicked(id); }); }
		}
		else if (p.t === "S") drawStart(grp, st, p, X(p.x1), Y(p.y1), sc, bad);
		else if (p.t === "L") {
			el("text", { x: X(p.x1), y: Y(p.y1), "font-size": Math.max(10, 12 * sc), fill: "#e8edf5", "text-anchor": "middle", "dominant-baseline": "middle" }, grp).textContent = partText(p) || "（文字）";
		}
		else if (p.t === "A") {
			// an arrow with "至 ○○" at its tail
			const x1 = X(p.x1), y1 = Y(p.y1), x2 = X(p.x2), y2 = Y(p.y2);
			const ang = Math.atan2(y2 - y1, x2 - x1), hl = 9 * sc;
			el("line", { x1, y1, x2, y2, stroke: "#e8edf5", "stroke-width": 2.5 * sc }, grp);
			el("polygon", { points: `${x2},${y2} ${x2 - hl * Math.cos(ang - .45)},${y2 - hl * Math.sin(ang - .45)} ${x2 - hl * Math.cos(ang + .45)},${y2 - hl * Math.sin(ang + .45)}`, fill: "#e8edf5" }, grp);
			if (p.s) el("text", { x: x1 - Math.cos(ang) * 6, y: y1 - Math.sin(ang) * 6 + 4, "font-size": Math.max(10, 12 * sc), fill: "#e8edf5", "text-anchor": Math.cos(ang) >= 0 ? "end" : "start" }, grp).textContent = partText(p);
			if (cpEdit) el("line", { x1, y1, x2, y2, stroke: "transparent", "stroke-width": 14 }, grp);
		}
		else if (p.t === "F") {
			// a frame around an area of the panel (e.g. an operating area), its name at the top left
			const c = FRAME_COLORS[(p.f || 0) % FRAME_COLORS.length];
			const x = X(Math.min(p.x1, p.x2)), y = Y(Math.min(p.y1, p.y2));
			el("rect", { x, y, width: Math.abs(X(p.x2 - p.x1)), height: Math.abs(Y(p.y2 - p.y1)), rx: 6, fill: c, "fill-opacity": .08, stroke: c, "stroke-width": 2, "stroke-dasharray": "8 4" }, grp);
			if (p.s) el("text", { x: x + 6, y: y + 14, "font-size": 11, "font-weight": 700, fill: c }, grp).textContent = partText(p);
		}
		else if (p.t === "C") {
			// time of day (one month = one day): HH:MM:SS and the minute of the day out of 1440
			const ck = clockOf(status);
			const w = 104, x = X(p.x1), y = Y(p.y1);
			el("rect", { x: x - w / 2, y: y - 20, width: w, height: 40, rx: 4, fill: "#05080a", stroke: "#3a4558" }, grp);
			el("text", { x, y: y + 1, "font-size": 17, "font-family": "monospace", "font-weight": 700, fill: "#7CFC8A", "text-anchor": "middle" }, grp).textContent = ck.hms;
			el("text", { x, y: y + 15, "font-size": 11, "font-family": "monospace", fill: "#5fbf6a", "text-anchor": "middle" }, grp).textContent = ck.min;
		}
		else if (p.t === "K") {
			// north as the track plan was turned when the panel was drafted
			const deg = (style.f & 3) * 90, x = X(p.x1), y = Y(p.y1), r = 14;
			el("circle", { cx: x, cy: y, r, fill: "#141a24", stroke: "#3a4558" }, grp);
			const k = el("g", { transform: `rotate(${deg} ${x} ${y})` }, grp);
			el("polygon", { points: `${x},${y - r + 3} ${x + 4},${y} ${x - 4},${y}`, fill: "#ff5a5f" }, k);
			el("polygon", { points: `${x},${y + r - 3} ${x + 4},${y} ${x - 4},${y}`, fill: "#8a94a3" }, k);
			el("text", { x, y: y - r - 3, "font-size": 10, fill: "#cfd6e0", "text-anchor": "middle" }, grp).textContent = "北";
		}
	}
	for (let i = 0; i < routeVia.length; i++) {
		const at = gridOfTile(parts, key(routeVia[i]));
		if (at) drawRouteViaMarker(g, X(at[0]), Y(at[1]), i, sc);
	}
	// a line being drawn with ＋線路
	if (cpEdit && cpEdit.drawing) {
		const d = cpEdit.drawing;
		el("line", { x1: X(d.from[0]), y1: Y(d.from[1]), x2: X(d.to[0]), y2: Y(d.to[1]), stroke: "var(--yellow)", "stroke-width": 6 * sc, "stroke-linecap": "round", "stroke-dasharray": "8 6", opacity: .8, "pointer-events": "none" }, g);
	}
	// handles of the selected part on top of everything
	if (cpEdit && parts[cpEdit.sel]) drawHandles(g, parts[cpEdit.sel], X, Y);
	// destinations that come and go (up to a standing train, 手前): beside the track tile they end on
	if (!cpEdit) for (const [id, d] of dests) {
		if (!id.startsWith("n")) continue;
		const at = gridOfTile(parts, key(d.path[d.path.length - 1].p));
		if (!at) continue;
		const grp = el("g", { class: "clickable dest" + (d.free ? " blink" : "") }, g);
		el("circle", { cx: X(at[0]), cy: Y(at[1]), r: 8, fill: d.free ? "var(--yellow)" : "#e6e3d8", stroke: "#11151b" }, grp);
		el("text", { x: X(at[0]), y: Y(at[1]) + 20, "font-size": 11, fill: "var(--yellow)", "text-anchor": "middle" }, grp).textContent = d.label;
		grp.addEventListener("click", (e) => { e.stopPropagation(); destinationClicked(id); });
	}
	// magnets and memos: at the lever / point / destination of their tile, else along the track line
	if (!cpEdit && tab === "run") {
		const placeOf = (pos) => {
			const k = key(pos);
			const p = parts.find(q => "SPD".includes(q.t) && q.b && q.b[0] && key(q.b[0]) === k);
			if (p) return [X(p.x1), Y(p.y1)];
			const at = gridOfTile(parts, k);
			return at ? [X(at[0]), Y(at[1])] : null;
		};
		const targets = [];
		for (const p of parts) {
			if ("SP".includes(p.t) && p.b && p.b[0]) targets.push([p.b[0], X(p.x1), Y(p.y1)]);
			if (p.t === "T") (p.b || []).forEach((t, i) => { const f = p.b.length > 1 ? i / (p.b.length - 1) : .5; targets.push([t, X(p.x1 + (p.x2 - p.x1) * f), Y(p.y1 + (p.y2 - p.y1) * f)]); });
		}
		drawMarks(g, st, placeOf, sc, targets);
		drawMarkTargets(g, targets, sc);
	}
	if (cpEdit) bindEditor(svg, g, G);
}

// a start lever: on a relay panel the rotary lever, else the signal button (shunting lever: a small square)
function drawStart(grp, st, p, x, y, sc, bad) {
	const pos = p.b[0];
	const sh = !!p.f;
	if (bad) {
		el("circle", { cx: x, cy: y, r: 8 * sc, fill: "#2a303b", stroke: "#5a6475", "stroke-dasharray": "3 2" }, grp);
		return;
	}
	const other = !mayHandle(st, pos);
	if (other) grp.classList.add("other");
	if (!cpEdit && tab === "setup" && manualRoute) {
		grp.classList.add("clickable");
		grp.addEventListener("click", e => {
			e.stopPropagation();
			if (!manualRoute.start) { manualRoute.start = pos; render(); }
			else { const t = tileIndex.get(key(pos)); if (t) tileClicked(t); }
		});
	}
	if (isRelay()) {
		const v = leverView(st, pos, sh);
		const k = .42 * sc, r = 22 * k;
		const lg = el("g", { transform: `translate(${x - 30 * k} ${y - 40 * k}) scale(${k})` }, grp);
		lg.innerHTML = leverShapes(v.color, v.angle ? Math.sign(v.angle) * 40 : 0, v.no);
		el("circle", { cx: x + r + 5, cy: y - r, r: 3.2 * sc, fill: v.clear ? "var(--green)" : "var(--red)", stroke: "#000", "stroke-width": .8, class: v.blink ? "blink" : "" }, grp);
		el("text", { x, y: y + r + 11, "font-size": Math.max(9, 10 * sc), fill: "#e8e4d4", "text-anchor": "middle" }, grp).textContent = signalLabel(st, pos) + (sh ? " 入換" : "");
		if (!cpEdit && tab === "run") {
			grp.classList.add("clickable");
			grp.addEventListener("click", (e) => { e.stopPropagation(); if (!addRouteVia(pos)) turnSignalLever(pos, v.sl ? "N" : null, sh); });
		}
		return;
	}
	const dep = isDepartureAnchor(st, pos);
	const sel = (() => { const s = currentStart(); return s && key(s.pos) === key(pos) && !!s.shunt === sh; })();
	if (sh) {
		el("rect", { x: x - 5.5 * sc, y: y - 5.5 * sc, width: 11 * sc, height: 11 * sc, rx: 2, fill: extraColor(shuntColor(st, pos)), stroke: sel ? "var(--yellow)" : "#111", "stroke-width": sel ? 3 : 1.2 }, grp);
	}
	else {
		const sig = st.signals.find(s => key(s.pos) === key(pos));
		const set = status.routes.some(r => key(r.start) === key(pos) && r.state !== "idle");
		const fill = sig ? (sig.aspect === "green" ? "var(--green)" : sig.aspect === "yellow" ? "var(--yellow)" : "var(--red)") : set ? "var(--green)" : "var(--red)";
		if (dep) el("rect", { x: x - 7 * sc, y: y - 7 * sc, width: 14 * sc, height: 14 * sc, rx: 2, fill, stroke: "#fff", "stroke-width": 2 }, grp);
		else el("circle", { cx: x, cy: y, r: 8 * sc, fill, stroke: "#fff", "stroke-width": 2.5 }, grp);
		if (sel) el("circle", { cx: x, cy: y, r: 14 * sc, fill: "none", stroke: "var(--yellow)", "stroke-width": 3, class: "blink" }, grp);
		el("text", { x, y: y - 11 * sc, "font-size": Math.max(10, 11 * sc), "font-weight": 700, fill: "#fff", "text-anchor": "middle" }, grp).textContent = signalLabel(st, pos);
	}
	if (!cpEdit && tab === "run") {
		grp.classList.add("clickable");
		grp.addEventListener("click", (e) => { e.stopPropagation(); startClicked(pos, dep, sh); });
	}
}

// ---------------------------------------------------------------------------
// editor
// ---------------------------------------------------------------------------
function drawHandles(g, p, X, Y) {
	const h = (x, y, which) => el("rect", { x: X(x) - 5, y: Y(y) - 5, width: 10, height: 10, fill: "var(--yellow)", stroke: "#000", class: "cphandle", "data-h": which }, g);
	if ("THAF".includes(p.t)) { h(p.x1, p.y1, 1); h(p.x2, p.y2, 2); }
}
// the end of another line at the same point, when exactly two lines meet there and no point / lever stands there
// (a bend of the track, not a junction)
function joinedEnds(parts, i, which) {
	const p = parts[i];
	const at = which === 1 ? [p.x1, p.y1] : [p.x2, p.y2];
	const ends = [];
	parts.forEach((q, j) => {
		if (q.t !== "T" || j === i) return;
		if (q.x1 === at[0] && q.y1 === at[1]) ends.push({ index: j, which: 1 });
		if (q.x2 === at[0] && q.y2 === at[1]) ends.push({ index: j, which: 2 });
	});
	const busy = parts.some(q => "PSD".includes(q.t) && q.x1 === at[0] && q.y1 === at[1]);
	return ends.length === 1 && !busy ? ends : [];
}
// game tiles for a line drawn from a to b: the track between the tiles shown nearest to its ends
function autoBind(parts, a, b) {
	const near = (pt) => {
		let best = null, bd = 1.6;
		for (const p of parts) {
			if (p.t === "P" && p.b && p.b[0]) {
				const d = Math.hypot(p.x1 - pt[0], p.y1 - pt[1]);
				if (d < bd) { bd = d; best = p.b[0]; }
			}
			if (p.t === "T" && p.b && p.b.length) p.b.forEach((t, k) => {
				const f = p.b.length > 1 ? k / (p.b.length - 1) : .5;
				const d = Math.hypot(p.x1 + (p.x2 - p.x1) * f - pt[0], p.y1 + (p.y2 - p.y1) * f - pt[1]);
				if (d < bd) { bd = d; best = t; }
			});
		}
		return best;
	};
	const ta = near(a), tb = near(b);
	if (!ta || !tb) return [];
	if (key(ta) === key(tb)) return [ta];
	// the shortest way along the track between them (not far: a line on the panel is short)
	const prev = new Map([[key(ta), null]]);
	const todo = [ta];
	for (let i = 0; i < todo.length && todo.length < 3000; i++) {
		const t = tileIndex.get(key(todo[i]));
		if (!t) continue;
		if (key(t.p) === key(tb)) break;
		for (const d of DIRS) {
			if (!(t.r & d)) continue;
			for (const dz of [0, 1, -1]) {
				const n = [t.p[0] + DXY[d][0], t.p[1] + DXY[d][1], t.p[2] + dz];
				const nt = tileIndex.get(key(n));
				if (!nt || prev.has(key(n)) || !(nt.r & BACK[d])) continue;
				prev.set(key(n), todo[i]);
				todo.push(n);
			}
		}
	}
	if (!prev.has(key(tb))) return [ta, tb];
	const path = [];
	for (let p = tb; p; p = prev.get(key(p))) path.unshift(p);
	return path.length <= 40 ? path : [ta, tb];
}
function startEdit(st) {
	const c = customOf(st);
	// not a lock: somebody else (maybe of the same company) may be editing, the panel applied last wins
	if (st.editing !== undefined && !confirm(`「${companyName(st.editing)}」の人がカスタム盤を編集中です（同じ会社の別の人かもしれません）。\n編集を始めますか？後から「適用」した方の内容になります。`)) return;
	cpEdit = { parts: c ? JSON.parse(JSON.stringify(c.parts)) : makeDraft(st), sel: -1, dirty: !c, saves: panelSaves.get(st.id) || 0, undo: [], redo: [] };
	cpEdit.last = JSON.stringify(cpEdit.parts);
	command(`cp_edit,${st.id},1`, "カスタム盤の編集を開始");
	render();
}
function endEdit(st) {
	if (cpEdit) command(`cp_edit,${st.id},0`, "カスタム盤の編集を終了");
	cpEdit = null;
}
// undo / redo: whenever the parts differ from the last state seen, that state goes onto the undo list
// (not while dragging: a drag is one step)
function cpTrack() {
	if (!cpEdit || cpEdit.drag) return;
	const now = JSON.stringify(cpEdit.parts);
	if (now === cpEdit.last) return;
	cpEdit.undo.push(cpEdit.last);
	if (cpEdit.undo.length > 200) cpEdit.undo.shift();
	cpEdit.redo = [];
	cpEdit.last = now;
}
function cpUndo(redo = false) {
	if (!cpEdit || cpEdit.pick) return;
	cpTrack();
	const from = redo ? cpEdit.redo : cpEdit.undo, to = redo ? cpEdit.undo : cpEdit.redo;
	if (!from.length) return;
	to.push(cpEdit.last);
	cpEdit.last = from.pop();
	cpEdit.parts = JSON.parse(cpEdit.last);
	cpEdit.sel = -1;
	cpEdit.dirty = true;
	render();
}
function bindEditor(svg, g, G) {
	const toGrid = (e) => {
		const r = svg.getBoundingClientRect();
		return [Math.round((e.clientX - r.left - 20) / G), Math.round((e.clientY - r.top - 20) / G)];
	};
	// the drag lives in cpEdit: every redraw binds these handlers again
	svg.onmousedown = (e) => {
		const h = e.target.closest(".cphandle"), pt = e.target.closest("[data-part]");
		const at = toGrid(e);
		if (cpEdit.tool === "T") {
			// ＋線路: drag from one point of the grid to another (over other parts, too)
			cpEdit.drawing = { from: at, to: at };
			e.preventDefault();
			return;
		}
		if (cpEdit.tool && !pt && !h) {
			const t = cpEdit.tool === "text" ? "L" : cpEdit.tool;
			if ("SPD".includes(t)) {
				// a part that stands for something in the game: placed, then its tiles are chosen on the track plan
				const [x, y] = at;
				cpEdit.parts.push({ t, x1: x, y1: y, x2: t === "T" ? x + 4 : x, y2: y, b: [], s: "", f: 0 });
				cpEdit.sel = cpEdit.parts.length - 1; cpEdit.dirty = true; cpEdit.tool = null;
				cpEdit.pick = { index: cpEdit.sel, orig: [] };
				render();
				return;
			}
			const ask = { L: ["盤に書く文字", ""], A: ["矢印に添える文字（例：至 ○○）", "至 "], F: ["区画の名前（例：東扱い）", ""] }[t];
			const s = ask ? prompt(ask[0], ask[1]) : "";
			if (s !== null && (t !== "L" || s)) {
				const [x, y] = at;
				const size = { A: [4, 0], F: [10, 6] }[t] || [0, 0];
				cpEdit.parts.push({ t, x1: x, y1: y, x2: x + size[0], y2: y + size[1], b: [], s: encodeURIComponent(s || ""), f: 0 });
				cpEdit.sel = cpEdit.parts.length - 1; cpEdit.dirty = true;
			}
			cpEdit.tool = null;
			render();
			return;
		}
		if (h && cpEdit.sel >= 0) {
			const which = Number(h.dataset.h);
			const p = cpEdit.parts[cpEdit.sel];
			cpEdit.drag = { which, from: at, orig: Object.assign({}, p), joined: p.t === "T" ? joinedEnds(cpEdit.parts, cpEdit.sel, which) : [] };
		}
		else if (pt) {
			// the selected part under the pointer (also below others) stays selected and can be dragged;
			// pressing it again without moving selects the next part under the pointer
			const under = [...new Set(document.elementsFromPoint(e.clientX, e.clientY).map(x => x.closest && x.closest("[data-part]")).filter(Boolean).map(x => Number(x.dataset.part)))];
			const again = under.includes(cpEdit.sel);
			const i = again ? cpEdit.sel : Number(pt.dataset.part);
			cpEdit.sel = i;
			cpEdit.drag = { which: 0, from: at, orig: Object.assign({}, cpEdit.parts[i]), again, under };
			if (!again) render();
		}
		else { cpEdit.sel = -1; render(); }
		e.preventDefault();
	};
	svg.onmousemove = (e) => {
		if (cpEdit && cpEdit.drawing) {
			const at = toGrid(e);
			if (at[0] !== cpEdit.drawing.to[0] || at[1] !== cpEdit.drawing.to[1]) { cpEdit.drawing.to = at; renderCustom(); }
			return;
		}
		const drag = cpEdit && cpEdit.drag;
		if (!drag || cpEdit.sel < 0) return;
		const at = toGrid(e);
		const dx = at[0] - drag.from[0], dy = at[1] - drag.from[1];
		const p = cpEdit.parts[cpEdit.sel], o = drag.orig;
		if (drag.which === 0) { p.x1 = o.x1 + dx; p.x2 = o.x2 + dx; p.y1 = o.y1 + dy; p.y2 = o.y2 + dy; }
		else if (drag.which === 1) { p.x1 = Math.max(0, o.x1 + dx); p.y1 = Math.max(0, o.y1 + dy); }
		else { p.x2 = Math.max(0, o.x2 + dx); p.y2 = Math.max(0, o.y2 + dy); }
		p.x1 = Math.max(0, p.x1); p.y1 = Math.max(0, p.y1); p.x2 = Math.max(0, p.x2); p.y2 = Math.max(0, p.y2);
		// the other line ending at the same corner follows (an L made slanting in one drag)
		const np = drag.which === 1 ? [p.x1, p.y1] : [p.x2, p.y2];
		for (const j of drag.joined || []) {
			const q = cpEdit.parts[j.index];
			if (j.which === 1) { q.x1 = np[0]; q.y1 = np[1]; } else { q.x2 = np[0]; q.y2 = np[1]; }
		}
		if (dx || dy) { cpEdit.dirty = true; drag.moved = true; }
		renderCustom();
	};
	svg.onmouseup = (e) => {
		if (cpEdit && cpEdit.drawing) {
			const d = cpEdit.drawing;
			cpEdit.drawing = null;
			if (d.from[0] !== d.to[0] || d.from[1] !== d.to[1]) {
				cpEdit.parts.push({ t: "T", x1: d.from[0], y1: d.from[1], x2: d.to[0], y2: d.to[1], b: autoBind(cpEdit.parts, d.from, d.to), s: "", f: 0 });
				cpEdit.sel = cpEdit.parts.length - 1;
				cpEdit.dirty = true;
			}
			render();
			return;
		}
		if (cpEdit && cpEdit.drag) {
			const d = cpEdit.drag;
			cpEdit.drag = null;
			if (!d.moved && d.again) {
				// the parts under the pointer, from the top: the next one after the selected
				const list = d.under;
				if (list.length > 1) cpEdit.sel = list[(list.indexOf(cpEdit.sel) + 1) % list.length];
				render();
			}
			else if (d.moved) render();
		}
	};
	svg.ondblclick = (e) => {
		const pt = e.target.closest("[data-part]");
		if (!pt) return;
		const p = cpEdit.parts[Number(pt.dataset.part)];
		if (!"LDHAF".includes(p.t)) return;
		const s = prompt(p.t === "D" ? "着点ボタンの名前（空欄＝自動）" : "文字", partText(p));
		if (s === null) return;
		p.s = encodeURIComponent(s);
		cpEdit.dirty = true;
		render();
	};
}
document.addEventListener("keydown", (e) => {
	if (cpEdit && (e.ctrlKey || e.metaKey) && !(document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName))) {
		const k = e.key.toLowerCase();
		if (k === "z" || k === "y") { cpUndo(k === "y" || e.shiftKey); e.preventDefault(); return; }
	}
	if (cpEdit && e.key === "Escape" && cpEdit.tool) { cpEdit.tool = null; cpEdit.drawing = null; render(); return; }
	if (!cpEdit || cpEdit.sel < 0 || document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
	if (e.key === "Delete" || e.key === "Backspace") { cpEdit.parts.splice(cpEdit.sel, 1); cpEdit.sel = -1; cpEdit.dirty = true; render(); e.preventDefault(); }
	const mv = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
	if (mv) {
		const p = cpEdit.parts[cpEdit.sel];
		p.x1 = Math.max(0, p.x1 + mv[0]); p.x2 = Math.max(0, p.x2 + mv[0]); p.y1 = Math.max(0, p.y1 + mv[1]); p.y2 = Math.max(0, p.y2 + mv[1]);
		cpEdit.dirty = true; render(); e.preventDefault();
	}
});

// picking game tiles for a part on the track plan: rings for the tiles it stands for, orange for track no line stands for
function drawPickTargets(g, st, tiles, cx, cy, sc) {
	if (!cpEdit || !cpEdit.pick) return;
	const p = cpEdit.parts[cpEdit.pick.index];
	if (!p) return;
	const bound = new Set((p.b || []).map(key));
	const covered = new Set(cpEdit.parts.filter(q => q.t === "T").flatMap(q => (q.b || []).map(key)));
	const starts = new Set(st.signals.map(s => key(s.pos)).concat((st.departures || []).map(d => key(d.pos))));
	const points = new Set(layout.points.map(pt => key(pt.t.p)));
	const ok = (t) => p.t === "S" ? starts.has(key(t.p)) : p.t === "P" ? points.has(key(t.p)) : p.t === "D" ? !!destIdOf({ b: [t.p] }) : p.t === "H" ? !!t.h : true;
	for (const t of tiles) {
		if (!isVisible(t) || !t.r) continue;
		const k = key(t.p);
		if (!covered.has(k)) el("circle", { cx: cx(t.p), cy: cy(t.p), r: 11 * sc, fill: "none", stroke: "#ffb347", "stroke-width": 2, "pointer-events": "none" }, g);
		if (!ok(t)) continue;
		const c = el("circle", { cx: cx(t.p), cy: cy(t.p), r: 10 * sc, fill: bound.has(k) ? "rgba(255,224,102,.6)" : "rgba(255,224,102,.12)", stroke: "var(--yellow)", "stroke-width": bound.has(k) ? 3 : 2, "stroke-dasharray": bound.has(k) ? "" : "4 3", class: "clickable picktarget", "data-pick": k }, g);
		c.appendChild(el("title", {})).textContent = `(${t.p.join(", ")})` + (bound.has(k) ? " 結びついている（押すと外す）" : " 押すと結ぶ");
		c.addEventListener("click", (e) => {
			e.stopPropagation();
			if ("TH".includes(p.t)) {
				p.b = bound.has(k) ? p.b.filter(x => key(x) !== k) : (p.b || []).concat([t.p]);
				render();
			}
			else {
				p.b = [t.p];
				cpEdit.pick = null;
				cpEdit.dirty = true;
				render();
			}
		});
	}
}

// export to a file / import from one (the tiles are kept: in another game or station parts may no longer match)
function exportPanel(st, parts) {
	const data = JSON.stringify({ format: "tid-custom-panel", version: 1, station: st.name, parts }, null, 1);
	const a = document.createElement("a");
	a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
	a.download = `custom-panel-${String(st.name).replace(/[\\/:*?"<>|]/g, "_")}.json`;
	document.body.appendChild(a);
	a.click();
	setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function importPanel() {
	const inp = document.createElement("input");
	inp.type = "file";
	inp.accept = ".json,application/json";
	inp.addEventListener("change", async () => {
		const f = inp.files[0];
		if (!f) return;
		try {
			const d = JSON.parse(await f.text());
			if (d.format !== "tid-custom-panel" || !Array.isArray(d.parts)) throw new Error("カスタム盤のファイルではありません");
			const parts = d.parts.filter(p => p && "TSPDHLAFCKY".includes(p.t)).map(p => ({ t: p.t, x1: p.x1 | 0, y1: p.y1 | 0, x2: p.x2 | 0, y2: p.y2 | 0, f: p.f | 0,
				b: (p.b || []).filter(x => Array.isArray(x) && x.length === 3).map(x => x.map(Number)), s: String(p.s || "") }));
			if (!confirm(`「${d.station || "?"}」のカスタム盤（部品 ${parts.length} 個）を読み込みますか？今の編集内容と置き換わります。`)) return;
			cpEdit.parts = parts; cpEdit.sel = -1; cpEdit.dirty = true;
			render();
			const bad = parts.filter(p => unbound(station(), p)).length;
			toast(bad ? `読み込みました。配線と合わない部品が ${bad} 個あります（「合わない部品」で選んで結び直してください）` : "読み込みました。「適用」で保存します");
		} catch (e) { toast("読み込めませんでした: " + e.message, true); }
	});
	inp.click();
}

// buttons of the view bar for the custom panel
function customBarHtml(st) {
	if (!st) return "";
	cpTrack();
	if (cpEdit && cpEdit.pick) {
		const p = cpEdit.parts[cpEdit.pick.index];
		const what = { T: "線路の線：結びつく線路を押す（もう一度押すと外す）", H: "番線：番線の線路を押す（もう一度押すと外す）", S: "てこ：信号・出発点を押す", P: "ポイント：ポイントを押す", D: "着点：番線・留置線・出口・車庫の線路を押す" }[p.t] || "";
		return `<span class="cpedit">結び直し中</span><span class="hint">${what}。<b style="color:#ffb347">橙</b>＝どの線にも結びついていない線路</span>
			<button data-cp="pickdone" class="primary">完了</button><button data-cp="pickcancel">やめる</button>`;
	}
	if (cpEdit) {
		const sel = cpEdit.parts[cpEdit.sel];
		const style = styleOf(cpEdit.parts);
		const st0 = station();
		const bad = cpEdit.parts.filter(p => unbound(st0, p)).length;
		const add = (t, label, title) => `<button data-cp="add" data-t="${t}" class="${cpEdit.tool === t ? "on" : ""}" title="${title}（押してから盤の空いた所を押す）">${label}</button>`;
		const addf = (t, label, title) => `<button data-cp="add" data-t="${t}" class="${cpEdit.tool === t ? "on" : ""}" title="${title}（押してから盤の空いた所を押し、続けて結びつく線路などを選ぶ）">${label}</button>`;
		return `<span class="cpedit">カスタム盤を編集中</span><button data-cp="add" data-t="T" class="${cpEdit.tool === "T" ? "on" : ""}" title="押してから、盤の上をドラッグして線を引く（何本でも。もう一度押すか Esc でやめる）。両端がポイント・線路の上なら、その間の線路に結びつく">＋線路</button>${addf("S", "＋てこ", "信号てこ")}${addf("P", "＋ポイント", "ポイント")}${addf("D", "＋着点", "着点ボタン")}<span class="sep"></span>${add("L", "文字", "盤に文字を書く")}${add("A", "矢印", "「至 ○○」の矢印")}${add("F", "区画", "区画の枠（扱い区分など）")}${add("C", "時計", "ゲームの日時")}${add("K", "方位", "北の向き")}
		<select data-cp="color" title="盤の色">${PANEL_COLORS.map((c, i) => `<option value="${i}" ${(style.f >> 4) % PANEL_COLORS.length === i ? "selected" : ""}>盤：${c[0]}</option>`).join("")}</select>
		${sel && sel.t === "F" ? FRAME_COLORS.map((c, i) => `<button data-cp="fcolor" data-c="${i}" class="swatch ${(sel.f || 0) === i ? "on" : ""}" style="background:${c}" title="枠の色"></button>`).join("") : ""}` + `
		<span class="sep"></span>
		<button data-cp="pick" ${sel && "TSPDH".includes(sel.t) ? "" : "disabled"} title="選んだ部品を、ゲームの線路・信号・ポイントに結び直す">結び直す</button>
		<button data-cp="nextbad" ${bad ? "" : "disabled"} title="配線と合わなくなった部品（灰色の破線）を順に選ぶ">合わない部品 ${bad}</button>
		<button data-cp="del" ${cpEdit.sel < 0 ? "disabled" : ""} title="選んだ部品を消す（Delete キー）">削除</button>
		<button data-cp="undo" ${cpEdit.undo.length ? "" : "disabled"} title="元に戻す（Ctrl+Z）">↶ 戻す</button><button data-cp="redo" ${cpEdit.redo.length ? "" : "disabled"} title="やり直す（Ctrl+Y）">↷</button>
		<button data-cp="draft" title="今の略図から下書きを作り直す（編集した内容は消えます）">下書きを作り直す</button>
		<button data-cp="export" title="カスタム盤をファイルに書き出す">書き出し</button><button data-cp="import" title="書き出したファイルを読み込む（今の編集内容と置き換え）">読み込み</button>
		<button data-cp="apply" class="primary" title="ゲームに保存して全員の盤に反映する">適用</button><button data-cp="cancel">やめる</button>`;
	}
	const has = !!customOf(st);
	const on = customView(st);
	return (st.editing !== undefined ? `<span class="cpedit" title="後から「適用」した方の内容になります">✎ ${esc(companyName(st.editing))}が盤を編集中</span>` : "") + (has ? `<button data-cp="auto" class="${on ? "" : "on"}" title="ゲームの配線をそのまま描いた略図">略図</button><button data-cp="custom" class="${on ? "on" : ""}" title="この駅のカスタム盤">カスタム盤</button>` : "")
		+ `<button data-cp="edit" title="${has ? "カスタム盤を編集する" : "今の略図から下書きを作り、カスタム盤を作る"}">${has ? "盤を編集" : "カスタム盤を作る"}</button>`;
}
// the colour of the whole panel (style part)
function customBarChange(s) {
	if (!cpEdit || s.dataset.cp !== "color") return;
	let y = cpEdit.parts.find(p => p.t === "Y");
	if (!y) { y = { t: "Y", x1: 0, y1: 0, x2: 0, y2: 0, b: [], s: "", f: northDir() }; cpEdit.parts.push(y); }
	y.f = (y.f & 15) | (Number(s.value) << 4);
	cpEdit.dirty = true;
	render();
}
async function customBarClick(b) {
	const st = station();
	const c = b.dataset.cp;
	if (c === "auto" || c === "custom") setCustomView(st, c === "custom");
	else if (c === "edit") startEdit(st);
	else if (c === "pick" && cpEdit.parts[cpEdit.sel]) {
		cpEdit.pick = { index: cpEdit.sel, orig: JSON.parse(JSON.stringify(cpEdit.parts[cpEdit.sel].b || [])) };
		render();
	}
	else if (c === "pickdone") { cpEdit.pick = null; cpEdit.dirty = true; render(); }
	else if (c === "pickcancel") { cpEdit.parts[cpEdit.pick.index].b = cpEdit.pick.orig; cpEdit.pick = null; render(); }
	else if (c === "nextbad") {
		const bads = cpEdit.parts.map((p, i) => unbound(st, p) ? i : -1).filter(i => i >= 0);
		cpEdit.sel = bads.find(i => i > cpEdit.sel) ?? bads[0] ?? -1;
		render();
	}
	else if (c === "export") exportPanel(st, cpEdit.parts);
	else if (c === "undo" || c === "redo") cpUndo(c === "redo");
	else if (c === "import") importPanel();
	else if (c === "add") {
		const t = b.dataset.t;
		if (t === "C" || t === "K") {
			// clock and compass: placed at the top left, to be moved
			const x = t === "K" ? 1 : 6;
			cpEdit.parts.push({ t, x1: x, y1: 1, x2: x, y2: 1, b: [], s: "", f: 0 });
			cpEdit.sel = cpEdit.parts.length - 1; cpEdit.dirty = true; cpEdit.tool = null;
		}
		else cpEdit.tool = cpEdit.tool === t ? null : t;
		render();
	}
	else if (c === "fcolor" && cpEdit.parts[cpEdit.sel]) { cpEdit.parts[cpEdit.sel].f = Number(b.dataset.c); cpEdit.dirty = true; render(); }
	else if (c === "del" && cpEdit.sel >= 0) { cpEdit.parts.splice(cpEdit.sel, 1); cpEdit.sel = -1; cpEdit.dirty = true; render(); }
	else if (c === "draft") {
		if (!confirm("今の略図から下書きを作り直しますか？編集した内容は消えます。")) return;
		const keep = cpEdit;
		cpEdit = null;           // the draft is made from the plain track plan
		const parts = makeDraft(st);
		cpEdit = Object.assign(keep, { parts, sel: -1, dirty: true });
		render();
	}
	else if (c === "cancel") {
		if (cpEdit.dirty && !confirm("編集した内容を捨てますか？")) return;
		endEdit(st); render();
	}
	else if (c === "apply") {
		// somebody else applied a panel since this editing started: theirs would be replaced
		if ((panelSaves.get(st.id) || 0) !== cpEdit.saves && !confirm("編集を始めたあとに、ほかの人がカスタム盤を保存しています。\nその内容を、この編集で置き換えますか？")) return;
		const parts = cpEdit.parts;
		const r = await uploadParts(st, parts);
		if (r.ok) { toast("カスタム盤を保存しました"); cpEdit = null; localStore("custom." + st.id, "1"); }
		else toast("保存できませんでした: " + tr(r.error), true);
		render();
	}
}
