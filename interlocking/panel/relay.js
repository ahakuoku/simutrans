// TID interlocking panel: relay interlocking (継電連動盤)
// (classic scripts sharing one global scope; loaded in order by index.html)
//
// Operation: turn a signal lever (赤・入換は白) towards the side where the route opens, then press a
// destination button (着点). Point levers (黒) have three positions N / C / R: C = moved by the
// route (総括制御), N / R = fixed. Throwing time, approach locking and the time release (時素) and
// the emergency stop lever are done in the game; the panel only shows them.

let relaySel = null;          // key of the signal lever this browser turned last
let buzzerOn = false;         // approach buzzer (接近電響), per browser
try { buzzerOn = localStorage.getItem("il.buzzer") === "1"; } catch (e) {}
let audioCtx = null;
let lastWaiting = new Set();
let ringing = null;            // approach buzzer ringing: the trains that started it (until 確認 is pressed)
let ringTimer = null;

// direction of travel at a start point (signal or virtual departure)
function startTravelDir(st, pos) {
	const t = tileIndex.get(key(pos));
	if (!t) return 0;
	const dep = (st.departures || []).find(d => key(d.pos) === key(pos));
	if (dep) {
		const own = new Set(dep.tiles.map(key));
		return DIRS.find(d => (t.r & d) && neighbour(t, d) && !own.has(key(neighbour(t, d).p))) || 0;
	}
	return singleDir(t.m) || singleDir(t.r & ~BACK[singleDir(t.m) || 0]) || 0;
}
// the side a signal lever turns to: towards the direction of travel on the panel
function leverSide(st, pos) {
	// one lever for two signals: each signal has its side
	const lp = (st.pairs || []).find(p => key(p[0]) === key(pos) || key(p[1]) === key(pos));
	if (lp) return key(lp[0]) === key(pos) ? "L" : "R";
	// set by hand in the setup tab
	const hand = (st.sides || []).find(s => key(s.pos) === key(pos));
	if (hand) return hand.side;
	return autoLeverSide(st, pos);
}
// towards the direction of travel on the panel; a signal on a track drawn up or down turns
// towards the side where its routes lead (e.g. a home signal below the station on the left)
const autoSideCache = new Map();
function autoLeverSide(st, pos) {
	const ck = key(pos) + "|" + viewRot() + "|" + tracks.tiles.length;
	if (autoSideCache.has(ck)) return autoSideCache.get(ck);
	let side = "R";
	const d = startTravelDir(st, pos);
	const t = tileIndex.get(key(pos));
	if (d && t) {
		const [vx, vy] = screenVec(d);
		if (vx) side = vx < 0 ? "L" : "R";
		else {
			// sideways drift of the track ahead (within the area of the station)
			let sum = 0;
			for (const [, n] of travel(t, 40, d)) {
				if (stationTiles && !stationTiles.has(key(n.t.p))) continue;
				sum += screenOffset(t.p, n.t.p);
			}
			side = sum < 0 ? "L" : sum > 0 ? "R" : vy < 0 ? "R" : "L";
		}
	}
	autoSideCache.set(ck, side);
	return side;
}
// horizontal distance on the (turned) panel from tile a to tile b
function screenOffset(a, b) {
	const dx = b[0] - a[0], dy = b[1] - a[1];
	return [dx, -dy, -dx, dy][viewRot()];
}

// all signal levers of the station: interlocked signals, then virtual departure / shunting signals
// (two signals set as a pair share one lever: left / right)
function signalLevers(st) {
	const starts = [];
	st.signals.forEach(s => starts.push({ pos: s.pos, dep: false, shunt: false }));
	(st.departures || []).filter(d => !d.shunt).forEach(d => starts.push({ pos: d.pos, dep: true, shunt: false }));
	(st.departures || []).filter(d => d.shunt).forEach(d => starts.push({ pos: d.pos, dep: true, shunt: true }));
	const of = (p) => starts.find(x => key(x.pos) === key(p));
	const used = new Set(), res = [];
	for (const s of starts) {
		if (used.has(key(s.pos))) continue;
		const pr = (st.pairs || []).find(p => key(p[0]) === key(s.pos) || key(p[1]) === key(s.pos));
		if (pr && of(pr[0]) && of(pr[1])) {
			const left = of(pr[0]), right = of(pr[1]);
			used.add(key(left.pos)); used.add(key(right.pos));
			res.push({ pair: true, left, right, pos: left.pos, shunt: left.shunt && right.shunt });
			continue;
		}
		used.add(key(s.pos));
		res.push(Object.assign({ pair: false }, s));
	}
	// shunting levers (入換てこ) at start points: white = shunting signal, green = shunting indicator
	for (const x of st.shunt_levers || []) {
		const s = of(x.pos);
		if (s) res.push({ pair: false, extra: true, pos: s.pos, dep: s.dep, shunt: true, color: x.color });
	}
	res.forEach((l, i) => { l.no = i + 1; });
	return res;
}
const shuntColor = (st, pos) => ((st.shunt_levers || []).find(x => key(x.pos) === key(pos)) || {}).color;
// the lever of a start point, and its side when the lever is shared
function leverOfPos(st, pos) {
	for (const l of signalLevers(st)) {
		if (l.extra) continue;
		if (!l.pair && key(l.pos) === key(pos)) return { lever: l, side: null };
		if (l.pair && key(l.left.pos) === key(pos)) return { lever: l, side: "L" };
		if (l.pair && key(l.right.pos) === key(pos)) return { lever: l, side: "R" };
	}
	return { lever: { no: "", shunt: false }, side: null };
}
// the turned lever at a start point: the signal lever, or (sh) its shunting lever
const sleverOf = (st, pos, sh = false) => (st.slevers || []).find(l => key(l.pos) === key(pos) && !!l.shunt === !!sh);
const leverKey = (pos, sh) => key(pos) + (sh ? "|S" : "");

// operating areas (扱い区分): the area of a start point or point (0 = common), and the area this browser operates
const deskOf = (st, pos) => ((st.area_of || []).find(x => key(x.pos) === key(pos)) || {}).a || 0;
function myDesk(st) {
	const d = Number(localStore("desk." + st.id) || 0);
	return d > 0 && d <= (st.areas || []).length ? d : 0;
}
function setMyDesk(st, d) { localStore("desk." + st.id, String(d)); }
const deskName = (st, d) => d ? ((st.areas || [])[d - 1] || `区分${d}`) : "共通";
// this browser may operate the lever at pos (its own area, or a common lever, or no area chosen)
function mayHandle(st, pos) {
	const mine = myDesk(st), d = deskOf(st, pos);
	return !mine || !d || d === mine;
}
function refuseOther(st, pos) {
	if (mayHandle(st, pos)) return false;
	toast(`このてこは「${deskName(st, deskOf(st, pos))}」の担当です（担当：${deskName(st, myDesk(st))}）`, true);
	return true;
}
// the area of a point lever: the area of its first point
const pointDesk = (st, li) => deskOf(st, layout.points[layout.levers[li].pts[0]].t.p);

// selector of the operating area (運転タブ), only when the station has areas
function renderDeskBar() {
	const box = document.getElementById("deskBar");
	const st = station();
	const areas = st ? st.areas || [] : [];
	const html = !areas.length ? "" : `<div class="row"><label>担当 <select id="deskSel">
		<option value="0">すべて（区分なし）</option>${areas.map((n, i) => `<option value="${i + 1}" ${myDesk(st) === i + 1 ? "selected" : ""}>${esc(deskName(st, i + 1))}</option>`).join("")}</select></label>
		<span class="hint">ほかの区分のてこは薄く表示され、扱えません（このブラウザだけの設定）</span></div>`;
	if (box.dataset.html === html) return;
	box.innerHTML = box.dataset.html = html;
	box.hidden = !html;
	const sel = box.querySelector("#deskSel");
	if (sel) sel.addEventListener("change", () => { setMyDesk(st, Number(sel.value)); relaySel = null; render(); });
}

// re-reading the track after it was rebuilt in the game (配線を読み直す): the last result of each station
const rescanResults = new Map();
function rescanSummary(ev) {
	const out = [];
	if (ev.signals_removed) out.push(`撤去された信号 ${ev.signals_removed} 個を外した`);
	if (ev.departures_removed) out.push(`番線・留置線がなくなった出発点 ${ev.departures_removed} 個を外した`);
	if (ev.departures_moved) out.push(`番線の端が変わった出発点 ${ev.departures_moved} 個を移した`);
	if (ev.levers_removed) out.push(`なくなったポイントの転てつてこ ${ev.levers_removed} 本を外した`);
	if (ev.sidings_removed) out.push(`なくなった留置線の駅 ${ev.sidings_removed} 個を外した`);
	if (ev.marks_removed) out.push(`線路がなくなったマグネット・メモ ${ev.marks_removed} 枚をはがした`);
	if (ev.routes_rerouted.length) out.push(`進路を今の線路で引き直した：${ev.routes_rerouted.join("・")}`);
	if (ev.routes_removed.length) out.push(`始点がなくなった進路を消した：${ev.routes_removed.join("・")}`);
	if (ev.routes_broken.length) out.push(`通れなくなった進路（作り直してください）：${ev.routes_broken.join("・")}`);
	if (ev.routes_busy) out.push(`使用中の進路 ${ev.routes_busy} 本は、解除後にもう一度読み直してください`);
	return out.length ? out : ["変わったところはありません"];
}
function rescanCfg(st) {
	const ev = rescanResults.get(st.id);
	// signals on the map that belong to no station (new signals are not registered by themselves)
	const known = new Set(status.stations.flatMap(s => s.signals.map(x => key(x.pos))));
	const fresh = (tracks.tiles || []).filter(t => t.s && isVisible(t) && !known.has(key(t.p)));
	return `<div class="hint" style="margin-top:6px"><b>配線を読み直す</b>：ゲームで線路・信号・ホームを作り直したあとに押すと、今の配線に合わせます
		（撤去された信号やポイントを外す、番線の長さ・端を合わせる、進路を今の線路で引き直す）。新しく置いた信号は自動では登録しません。</div>
		<div class="row"><button id="rescanBtn">配線を読み直す</button></div>
		${ev ? `<div class="check" data-rescan="1">${rescanSummary(ev).map(esc).join("<br>")}</div>` : ""}
		${ev && fresh.length ? `<div class="check warn" data-rescanfresh="1">表示範囲にある未登録の信号：${fresh.slice(0, 8).map(t => `(${t.p.join(", ")})`).join(" ")}${fresh.length > 8 ? ` ほか ${fresh.length - 8} 個` : ""}
			<br>てこで扱うなら「3. 入口」などで登録してください。</div>` : ""}`;
}

// setup of the operating areas (設定タブ)
function areaCfg(st) {
	const areas = st.areas || [];
	const opts = (d) => `<option value="0" ${d === 0 ? "selected" : ""}>共通</option>` + areas.map((n, i) => `<option value="${i + 1}" ${d === i + 1 ? "selected" : ""}>${esc(deskName(st, i + 1))}</option>`).join("");
	const sigs = signalLevers(st).filter(l => !l.extra).map(l => {
		const pos = l.pair ? [l.left.pos, l.right.pos] : [l.pos];
		const name = l.pair ? `${signalLabel(st, l.left.pos)}／${signalLabel(st, l.right.pos)}` : signalLabel(st, l.pos);
		return `<label>${l.no} ${esc(name)}<select data-area="${pos.map(key).join(";")}">${opts(deskOf(st, pos[0]))}</select></label>`;
	});
	const pts = (layout && layout.levers || []).map((lv, li) => {
		const p = layout.points[lv.pts[0]].t.p;
		return `<label>${esc(leverName(st, li))}<select data-area="${lv.pts.map(i => key(layout.points[i].t.p)).join(";")}">${opts(deskOf(st, p))}</select></label>`;
	});
	return `<div class="hint" style="margin-top:6px"><b>扱い区分</b>：大きな駅を何人かで扱うとき、てこを区分（例：東扱い・西扱い）に分けます。
		運転タブで各自が自分の区分を選ぶと、ほかの区分のてこは扱えなくなります。着点待ちのてこは区分ごとに 1 本です。「共通」のてこは誰でも扱えます。</div>
		<div class="row">${areas.map((n, i) => `<span class="areaname"><input data-areaname="${i + 1}" value="${esc(n)}" placeholder="区分${i + 1}" size="8"><button data-areadel="${i + 1}" title="この区分を消す（てこは共通に戻る）">✕</button></span>`).join("")}
		${areas.length < 9 ? `<button id="areaAdd">区分を追加</button>` : ""}</div>
		${areas.length ? `<div class="sidegrid">${sigs.concat(pts).join("")}</div>` : ""}`;
}
function bindAreaCfg(box, st) {
	const clean = (s) => s.replace(/[,;|\n\r]/g, " ").trim().slice(0, 40);
	const add = box.querySelector("#areaAdd");
	if (add) add.addEventListener("click", () => {
		const n = (st.areas || []).length + 1;
		command(`ar_name,${st.id},${n},区分${n}`, `扱い区分を追加（区分${n}）`);
	});
	for (const i of box.querySelectorAll("[data-areaname]")) i.addEventListener("change", () =>
		command(`ar_name,${st.id},${i.dataset.areaname},${clean(i.value)}`, "扱い区分の名前"));
	for (const b of box.querySelectorAll("[data-areadel]")) b.addEventListener("click", () => {
		if (!confirm(`「${deskName(st, Number(b.dataset.areadel))}」を消しますか？この区分のてこは共通に戻ります。`)) return;
		command(`ar_del,${st.id},${b.dataset.areadel}`, "扱い区分を削除");
	});
	for (const c of box.querySelectorAll("select[data-area]")) c.addEventListener("change", () => {
		for (const k of c.dataset.area.split(";")) command(`ar_pos,${st.id},${k},${c.value}`, "てこの扱い区分");
	});
}

// start of the next route: the lever this browser turned, else any turned lever without a route yet
// (of this browser's operating area)
function relayStart() {
	const st = station();
	if (!st) return null;
	const free = (st.slevers || []).filter(l => !l.used && mayHandle(st, l.pos));
	const sel = free.find(l => leverKey(l.pos, l.shunt) === relaySel) || free[free.length - 1];
	if (!sel) return null;
	return { pos: sel.pos, dep: isDepartureAnchor(st, sel.pos), shunt: !!sel.shunt, color: sel.shunt ? shuntColor(st, sel.pos) : null };
}

function turnSignalLever(pos, side, sh = false) {
	const st = station();
	if (!st.manual) { toast("CTC集中（自動）です。駅扱切換てこを「駅扱」にしてください", true); return; }
	if (refuseOther(st, pos)) return;
	const lv = sleverOf(st, pos, sh);
	const want = side || (lv ? "N" : leverSide(st, pos));
	if (want !== "N" && want !== leverSide(st, pos)) { toast("このてこは反対側には開通しません", true); return; }
	if (want !== "N") relaySel = leverKey(pos, sh);
	command(`sl_turn,${st.id},${pos.join(",")},${want}${sh ? ",S" : ""}`, `${signalLabel(st, pos)}${sh ? " 入換" : ""} てこ ${want === "N" ? "定位" : want === "L" ? "左反位" : "右反位"}`);
}

// actual position of a point (from the game): "N", "R", "X" (other pair) or null (unknown)
function pointLamp(st, pt) {
	const p = (st.points || []).find(x => key(x.pos) === key(pt.t.p));
	if (!p) return { pos: null, moving: 0 };
	const k = pairKey(p.pair);
	const pos = pt.normal.some(x => pairKey(x) === k) ? "N" : pt.reverse.some(x => pairKey(x) === k) ? "R" : "X";
	return { pos, moving: p.moving };
}

// browsers keep sound off until the page is clicked once: after a reload the buzzer would stay silent,
// so the sound is (re)started on the first click anywhere on the page
function unlockAudio() {
	try {
		audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
		if (audioCtx.state === "suspended") audioCtx.resume();
	} catch (e) {}
}
document.addEventListener("pointerdown", unlockAudio, true);
document.addEventListener("keydown", unlockAudio, true);
// the buzzer is on but the browser does not allow sound yet (no click since the page was loaded)
const audioBlocked = () => buzzerOn && (!audioCtx || audioCtx.state !== "running");

// an approach buzzer: a short tone when a new train waits at a signal of this station
function beep() {
	try {
		audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
		const o = audioCtx.createOscillator(), g = audioCtx.createGain();
		o.type = "square"; o.frequency.value = 880;
		g.gain.value = 0.06;
		o.connect(g); g.connect(audioCtx.destination);
		o.start();
		o.stop(audioCtx.currentTime + 0.6);
	} catch (e) {}
}
// the buzzer rings (a tone every 1.2 s) from the arrival of a train until the operator presses 確認,
// or until no train that started it waits at a signal any more
function startRinging(keys) {
	ringing = new Set([...(ringing || []), ...keys]);
	if (!ringTimer) { beep(); ringTimer = setInterval(beep, 1200); }
}
function stopRinging() {
	ringing = null;
	if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
}
function checkApproach(st) {
	const now = new Set();
	for (const s of st.signals) if (s.train && s.aspect === "red") now.add(key(s.pos) + "|" + s.train);
	// only trains approaching the station (waiting at its signals), not trains waiting to depart
	const fresh = [...now].filter(k => !lastWaiting.has(k));
	if (buzzerOn && fresh.length) startRinging(fresh);
	if (ringing && ![...ringing].some(k => now.has(k))) stopRinging();
	lastWaiting = now;
}

// knob of a rotary lever: angle -45 (left) / 0 / 45 (right)
// lever of a relay panel as on the real panels: a handle with a round top and a black number plate,
// turning on a dark base (shapes in a 60 x 66 box, pivot at 30,40)
function leverShapes(color, angle, no) {
	// as the real knobs: a round body (number plate on its face) with a flat fin standing up from it
	const txt = String(no ?? "");
	const fs = txt.length >= 3 ? 7 : 9;
	const dark = color === "#2b2f33";
	const side = dark ? "#15181b" : "rgba(0,0,0,.35)";
	const edge = dark ? "#8a948d" : "rgba(0,0,0,.5)";
	return `<circle cx="30" cy="40" r="23" fill="#0d1210" stroke="#3b4a42" stroke-width="1.5"/>
		<g transform="rotate(${angle} 30 40)">
			<ellipse cx="30" cy="42.5" rx="15.5" ry="15" fill="#000" opacity=".35"/>
			<path d="M24.5 31 L26 6.5 Q30 4.6 34 6.5 L35.5 31 Z" fill="${color}" stroke="${edge}" stroke-width=".9"/>
			<path d="M34 6.5 L37.2 9 L38.6 31 L35.5 31 Z" fill="${color}"/>
			<path d="M34 6.5 L37.2 9 L38.6 31 L35.5 31 Z" fill="${side}"/>
			<path d="M27.4 10 L26.6 27" stroke="#fff" stroke-opacity=".35" stroke-width="1.6" stroke-linecap="round"/>
			<circle cx="30" cy="40" r="15" fill="${color}" stroke="${edge}" stroke-width=".9"/>
			<circle cx="30" cy="40" r="15" fill="${side}" opacity=".55"/>
			<circle cx="29.2" cy="39" r="13" fill="${color}"/>
			<path d="M19 35 A11.5 11.5 0 0 1 26 28" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="1.6" stroke-linecap="round"/>
			<circle cx="29.2" cy="39" r="8.4" fill="#111" stroke="#efefef" stroke-width="1.4"/>
			<text x="29.2" y="${39 + fs * .36}" font-size="${fs}" font-weight="700" text-anchor="middle" fill="#f4f4f4" font-family="Arial, sans-serif">${esc(txt)}</text>
		</g>`;
}
// a lever on the board; label = small marks under it (e.g. "N C R")
function knob(color, angle, label, no) {
	return `<svg class="knob" viewBox="0 0 60 66" width="56" height="62" aria-hidden="true">${leverShapes(color, angle, no)}
		${label ? `<text x="30" y="65" font-size="8" text-anchor="middle" fill="#cfd6cf">${label}</text>` : ""}</svg>`;
}
// the bar-shaped lever (駅扱切換てこ)
function barKnob(color, angle, label) {
	return `<svg class="knob" viewBox="0 0 60 60" width="56" height="56" aria-hidden="true">
		<circle cx="30" cy="30" r="25" fill="#11161a" stroke="#4a5a52" stroke-width="2"/>
		<g transform="rotate(${angle} 30 30)">
			<rect x="22" y="6" width="16" height="44" rx="8" fill="${color}" stroke="#000" stroke-opacity=".35"/>
			<rect x="28" y="8" width="4" height="14" rx="2" fill="#fff" opacity=".85"/>
		</g>
		${label ? `<text x="30" y="58" font-size="9" text-anchor="middle" fill="#cfd6cf">${label}</text>` : ""}
	</svg>`;
}
const LEVER_RED = "#c8323a", LEVER_WHITE = "#ecebe4", LEVER_BLACK = "#2b2f33", LEVER_GREEN = "#2f8f4e", LEVER_PINK = "#e07aa8";
const extraColor = (c) => c === "G" ? LEVER_GREEN : c === "P" ? LEVER_PINK : LEVER_WHITE;
const extraKind = (c) => c === "G" ? "入換標識" : c === "P" ? "誘導信号" : "入換信号機";

// the two side buttons under a knob (the knob itself is the middle)
const sideBtns = (l, r, disL, disR, onL, onR) =>
	`<div class="lrbtn"><button data-side="L" class="${onL ? "on" : ""}" ${disL ? "disabled" : ""}>${l}</button><button data-side="R" class="${onR ? "on" : ""}" ${disR ? "disabled" : ""}>${r}</button></div>`;
let hoverLever = null;    // key of the signal lever under the mouse (board or map)
// k: one lever key "x,y,z" or "x,y,z|S" (from the map) or all of a board lever "k1;k2"
function setHoverLever(k) {
	const ks = k ? k.split(";") : [];
	let all = ks;
	for (const e of document.querySelectorAll("#relayBoard [data-keys]")) {
		const mine = e.dataset.keys.split(";");
		const on = ks.some(x => mine.includes(x));
		e.classList.toggle("hl", on);
		if (on) all = [...new Set(all.concat(mine))];
	}
	hoverLever = ks[0] || null;
	for (const e of document.querySelectorAll("#map [data-mk]")) e.classList.toggle("hl", all.includes(e.dataset.mk));
}
const lamp = (on, color, cls = "") => `<span class="lamp ${cls} ${on ? "on" : ""}" style="--lc:${color}"></span>`;

// the lever board can be closed (operation on the map only), remembered per browser
function boardClosed() { return localStore("board.closed") === "1"; }
function renderBoardToggle() {
	const b = document.getElementById("boardToggle");
	const closed = boardClosed();
	document.body.classList.toggle("board-closed", closed);
	const text = closed ? "▶ てこの盤を開く" : "▼ てこの盤を閉じる";
	if (b.textContent !== text) b.textContent = text;
	if (!b.dataset.bound) {
		b.dataset.bound = "1";
		b.addEventListener("click", () => { localStore("board.closed", boardClosed() ? "0" : "1"); renderBoardToggle(); });
	}
}

function renderRelayBoard() {
	renderBoardToggle();
	const box = document.getElementById("relayBoard");
	const st = station();
	if (!st || !isRelay()) { box.innerHTML = ""; box.dataset.html = ""; return; }
	const act = (pos, sh = false) => status.routes.find(r => key(r.start) === key(pos) && !!r.shunt === sh && r.state !== "idle");
	let html = `<h2>信号てこ</h2><div class="rboard">`;
	for (const l of signalLevers(st)) {
		// the start point on each side of the lever (a shared lever has one on each side)
		const sides = l.pair ? { L: l.left.pos, R: l.right.pos } : { [leverSide(st, l.pos)]: l.pos };
		const sh = !!l.extra;
		const slL = sides.L && sleverOf(st, sides.L, sh), slR = sides.R && sleverOf(st, sides.R, sh);
		const turned = slL ? "L" : slR ? "R" : null;
		const sl = slL || slR;
		const cur = turned ? sides[turned] : l.pos;
		const r = act(cur, sh);
		const sig = st.signals.find(s => key(s.pos) === key(cur));
		const clear = !!(r && r.state === "set" && !r.waiting && !st.all_stop) || !!(sig && sig.aspect !== "red");
		let state = "";
		if (r && r.state === "releasing") state = `<span class="timer blink">時素 ${r.release_in}秒</span>`;
		else if (r && r.state === "set" && r.waiting) state = `<span class="timer">${st.all_stop ? "一斉停止" : "転換中"}</span>`;
		else if (sl && sl.used && !r) state = `<span class="timer dim">復位してください</span>`;
		else if (sl && !sl.used) state = `<span class="timer">着点を押す</span>`;
		const keys = Object.values(sides).map(p => leverKey(p, sh));
		const kind = sh ? extraKind(l.color) : "";
		const name = l.pair ? `${l.no}L ${esc(signalLabel(st, l.left.pos))}<br>${l.no}R ${esc(signalLabel(st, l.right.pos))}` : esc(signalLabel(st, l.pos)) + (sh ? `<br>${kind}` : "");
		const tip = l.pair ? `左＝${signalLabel(st, l.left.pos)}、右＝${signalLabel(st, l.right.pos)}（◀ ▶ で倒す）` : `${signalLabel(st, l.pos)}${sh ? "の" + kind + "てこ" + (l.color === "G" || l.color === "P" ? "（在線の手前まで進路が取れる）" : "") : ""}：${sides.L ? "左" : "右"}にひねって着点ボタンを押す（つまみを押すと ひねる／戻す）`;
		const color = sh ? extraColor(l.color) : l.shunt ? LEVER_WHITE : LEVER_RED;
		const rs = relayStart();
		const other = !Object.values(sides).some(p => mayHandle(st, p));
		html += `<div class="rlever ${rs && keys.includes(leverKey(rs.pos, rs.shunt)) ? "sel" : ""} ${keys.includes(hoverLever) ? "hl" : ""} ${other ? "other" : ""}" data-sl="${leverKey(l.pos, sh)}" data-keys="${keys.join(";")}" data-shunt="${sh ? 1 : ""}"
			data-left="${sides.L ? key(sides.L) : ""}" data-right="${sides.R ? key(sides.R) : ""}" title="${esc(tip)}">
			<div class="lamps">${lamp(turned === "L", "#f4f1e6")}${lamp(clear, "var(--green)")}${lamp(!clear, "var(--red)", "small")}${lamp(turned === "R", "#f4f1e6")}</div>
			${knob(color, turned === "L" ? -40 : turned === "R" ? 40 : 0, "", l.no)}
			${sideBtns(l.pair ? "◀L" : "◀", l.pair ? "R▶" : "▶", !sides.L || (turned && turned !== "L"), !sides.R || (turned && turned !== "R"), turned === "L", turned === "R")}
			<div class="plate">${l.no}${l.pair ? "<small>LR</small>" : ""}</div><div class="lname">${name}</div>${state}</div>`;
	}
	html += `</div><h2>転てつてこ</h2><div class="rboard">`;
	layout.levers.forEach((lv, li) => {
		const ls = leverState(li);
		const pt = layout.points[lv.pts[0]];
		const lp = pointLamp(st, pt);
		const m = ls.manual === "N" ? "N" : ls.manual === "R" ? "R" : "C";
		const angle = m === "N" ? -45 : m === "R" ? 45 : 0;
		const blink = lp.moving > 0 ? "blink" : "";
		const pother = !mayHandle(st, pt.t.p);
		html += `<div class="rlever point ${ls.locked ? "locked" : ""} ${pother ? "other" : ""}" data-pl="${li}" title="${esc(leverName(st, li))}：◀ N（定位）・つまみ C（総括）・▶ R（反位）">
			<div class="lamps">${lamp(lp.pos === "N", "var(--green)", blink)}<span class="lt">N</span><span class="lt">R</span>${lamp(lp.pos === "R", "var(--green)", blink)}</div>
			${knob(LEVER_BLACK, m === "N" ? -40 : m === "R" ? 40 : 0, "N　　C　　R", 21 + li)}
			${sideBtns("◀N", "R▶", false, false, m === "N", m === "R")}
			<div class="plate">${21 + li}${lv.double ? "<small>イロ</small>" : ""}</div>${labelAt(st, pt.t.p) ? `<div class="lname">${esc(labelAt(st, pt.t.p))}</div>` : ""}
			${ls.locked ? `<span class="timer dim">鎖錠</span>` : lp.moving > 0 ? `<span class="timer blink">転換 ${lp.moving}秒</span>` : ""}</div>`;
	});
	html += `</div><h2>その他のてこ</h2><div class="rboard">
		<div class="rlever" data-stop="1" title="一斉停止てこ：すべての信号を停止にする">
			<div class="lamps">${lamp(st.all_stop, "var(--red)", st.all_stop ? "blink" : "")}</div>
			${knob(LEVER_RED, st.all_stop ? 40 : 0, "", "停")}<div class="plate">停</div><div class="lname">一斉停止</div></div>
		<div class="rlever" data-mode="1" title="駅扱切換てこ：左＝CTC集中（自動）、右＝駅扱（扱者）">
			<div class="lamps">${lamp(!st.manual, "#f4f1e6")}${lamp(st.manual, "var(--green)")}</div>
			${barKnob("#e9ebe4", st.manual ? 45 : -45, "集中　駅扱")}${sideBtns("◀", "▶", false, false, !st.manual, st.manual)}<div class="plate">扱</div><div class="lname">駅扱切換</div></div>
		<div class="rlever" data-buzz="1" title="接近電響スイッチ：入にすると、列車が信号で待つと電響が鳴る（このブラウザだけ）">
			<div class="lamps">${lamp(!buzzerOn, "#f4f1e6")}${lamp(buzzerOn, "var(--green)")}</div>
			${barKnob("#e9ebe4", buzzerOn ? 45 : -45, "切　　入")}${sideBtns("◀", "▶", false, false, !buzzerOn, buzzerOn)}<div class="plate">電響</div>
			<div class="lname">接近電響<br><b class="onoff ${buzzerOn ? "on" : ""}">${buzzerOn ? "入（オン）" : "切（オフ）"}</b></div>${audioBlocked() ? `<span class="timer dim">画面を一度クリックすると鳴ります</span>` : ""}</div>
		<div class="rlever" data-ack="1" title="電響確認：鳴っている接近電響を止める（次の列車でまた鳴る）">
			<div class="lamps">${lamp(!!ringing, "var(--yellow)", ringing ? "blink" : "")}</div>
			<span class="pushbtn ${ringing ? "on" : ""}"></span><div class="plate">確認</div><div class="lname">電響確認${ringing ? `<br><b class="onoff on blink">鳴動中</b>` : ""}</div></div>
	</div>
	<div class="rlegend">
		<div><b>てこの使い方</b>：つまみを押すと ひねる／戻す（転てつてこは C）。◀ ▶ で左右に倒す（転てつてこは N・R）。</div>
		<div>${lamp(true, "#f4f1e6")} てこが反位（ひねった側）</div>
		<div>てこの色：赤＝信号機（場内・出発）、白＝入換信号機、緑＝入換標識、ピンク＝誘導信号（緑・ピンクは在線の手前まで進路が取れる）、黒＝転てつ</div>
		<div>${lamp(true, "var(--green)")} 信号進行　／　転てつてこ：ポイントの向き（N 定位・R 反位）</div>
		<div>${lamp(true, "var(--red)")} 信号停止　／　一斉停止中</div>
		<div>${lamp(true, "var(--green)", "blink")} 点滅：ポイント転換中・時素中</div>
		<div><span class="timer">着点を押す</span> てこをひねった。着点ボタンで進路を取る　<span class="timer dim">復位してください</span> 列車が通過した。てこを定位に戻す</div>
	</div>`;
	if (box.dataset.html === html) return;
	box.innerHTML = box.dataset.html = html;
	for (const d of box.querySelectorAll("[data-sl]")) {
		const posOf = (k) => k ? k.split(",").map(Number) : null;
		const sides = { L: posOf(d.dataset.left), R: posOf(d.dataset.right) };
		const sh = !!d.dataset.shunt;
		const turnedSide = () => ["L", "R"].find(sd => sides[sd] && sleverOf(st, sides[sd], sh));
		// the knob: back to normal, or turn to its only side (a shared lever needs ◀ / ▶)
		d.querySelector(".knob").addEventListener("click", () => {
			const t = turnedSide();
			if (t) { turnSignalLever(sides[t], "N", sh); return; }
			if (sides.L && sides.R) { toast("◀ ▶ で倒す方向を選んでください", true); return; }
			const sd = sides.L ? "L" : "R";
			turnSignalLever(sides[sd], sd, sh);
		});
		for (const b of d.querySelectorAll("[data-side]")) b.addEventListener("click", () => {
			const sd = b.dataset.side;
			if (!sides[sd]) return;
			turnSignalLever(sides[sd], turnedSide() === sd ? "N" : sd, sh);
		});
		d.addEventListener("mouseenter", () => setHoverLever(d.dataset.keys));
		d.addEventListener("mouseleave", () => setHoverLever(null));
	}
	for (const d of box.querySelectorAll("[data-pl]")) {
		const li = Number(d.dataset.pl);
		const throwTo = (pos) => {
			const ls = leverState(li);
			if (ls.locked) { toast(`${leverName(st, li)} は鎖錠中です` + (ls.by ? `（${ls.by}）` : "（在線）"), true); return; }
			setLever(li, pos);
		};
		d.querySelector(".knob").addEventListener("click", () => throwTo(null));
		for (const b of d.querySelectorAll("[data-side]")) b.addEventListener("click", () => throwTo(b.dataset.side === "L" ? "N" : "R"));
	}
	box.querySelector("[data-stop] .knob").addEventListener("click", () =>
		command(`st_stop,${st.id},${st.all_stop ? 0 : 1}`, st.all_stop ? "一斉停止 解除" : "一斉停止"));
	const setMode = (manual) => { if (manual !== st.manual) command(`st_mode,${st.id},${manual ? 1 : 0}`, manual ? "駅扱" : "CTC集中"); };
	box.querySelector("[data-mode] .knob").addEventListener("click", () => setMode(!st.manual));
	for (const b of box.querySelectorAll("[data-mode] [data-side]")) b.addEventListener("click", () => setMode(b.dataset.side === "R"));
	const setBuzzer = (on) => {
		if (on === buzzerOn) return;
		buzzerOn = on;
		try { localStorage.setItem("il.buzzer", buzzerOn ? "1" : "0"); } catch (e) {}
		if (buzzerOn) beep(); else stopRinging();
		renderRelayBoard();
	};
	box.querySelector("[data-buzz] .knob").addEventListener("click", () => setBuzzer(!buzzerOn));
	for (const b of box.querySelectorAll("[data-buzz] [data-side]")) b.addEventListener("click", () => setBuzzer(b.dataset.side === "R"));
	box.querySelector("[data-ack] .pushbtn").addEventListener("click", () => { stopRinging(); renderRelayBoard(); });
}

// ---------------------------------------------------------------------------
// setup tab: kind of the interlocking, times, companies that may operate
// ---------------------------------------------------------------------------
// a pink lever (誘導) on a signal that a coupling train would pass without asking it:
// OTRP checks the signal for a coupling child only when it is a choose signal with its guide setting on
function couplingWarnings(st) {
	const bad = (st.signals || []).filter(s => shuntColor(st, s.pos) === "P").map(s => tileIndex.get(key(s.pos)))
		.filter(t => t && t.s && !(t.s.ch && t.s.g));
	if (!bad.length) return "";
	const line = t => `<b>${esc(signalLabel(st, t.p))}</b> は${t.s.ch ? "「連結誘導」がオフです。オンにしてください" : "普通の信号です。選択信号にして「連結誘導」をオンにしてください"}`;
	return `<div class="check warn" data-couplingwarn="1">ピンクのてこで連結に使うときの注意（設定はゲームの信号の窓で）：<br>${bad.map(line).join("<br>")}。<br>
		そうしないと、連結する列車はこの信号を確かめずに進みます。</div>`;
}


function renderStationCfg() {
	const box = document.getElementById("stationCfg");
	const st = station();
	if (!st) { box.innerHTML = box.dataset.html = ""; return; }
	const relay = st.kind === "relay";
	const others = (info.players || []).filter(p => p.nr !== st.owner);
	const html = `<h2>0. 連動装置の種類・操作できる会社</h2><div class="cfgbox">
		<div class="kinds"><button data-kind="0" class="${relay ? "" : "on"}">電子連動</button><button data-kind="1" class="${relay ? "on" : ""}">継電連動（上級者向け）</button></div>
		<p class="hint">${relay
			? "継電連動：信号てこを開通方向にひねってから着点ボタンを押します。ポイントの転換時間、接近鎖錠と時素、一斉停止てこがあります。ショートカットは使えません。盤の向きは全員共通です。"
			: "電子連動：信号てこ（信号・出発点）を押してから着点ボタンを押します。ポイントはすぐ転換し、登録した進路（ショートカット）も使えます。"}
			切り替えは、すべての進路が解除されているときだけできます。</p>
		${relay ? `<div class="row">
			<label>時素 本線 <input type="number" min="0" max="600" id="cfgTa" value="${st.t_approach}">秒</label>
			<label>入換 <input type="number" min="0" max="600" id="cfgTs" value="${st.t_shunt}">秒</label>
			<label>転換 <input type="number" min="0" max="60" id="cfgTt" value="${st.t_throw}">秒</label>
			<button id="cfgTimes">適用</button></div>
			<p class="hint">秒数はゲーム内の時間（通常速度のとき）。早送り中は速く過ぎます。</p>
		<div class="hint" style="margin-top:6px"><b>信号てこを倒す向き</b>：自動で決めた向きが盤の配線と合わないときに変えます（全員共通）。</div>
		<div class="sidegrid">${signalLevers(st).filter(l => !l.pair).map(l => {
			const hand = (st.sides || []).find(s => key(s.pos) === key(l.pos));
			const v = hand ? hand.side : "A";
			return `<label>${l.no} ${esc(signalLabel(st, l.pos))}<select data-lvside="${key(l.pos)}">
				<option value="A" ${v === "A" ? "selected" : ""}>自動（${autoLeverSide(st, l.pos) === "L" ? "左" : "右"}）</option>
				<option value="L" ${v === "L" ? "selected" : ""}>左</option><option value="R" ${v === "R" ? "selected" : ""}>右</option></select></label>`;
		}).join("")}</div>
		<div class="hint" style="margin-top:6px"><b>信号てこをまとめる</b>：1本のてこで、左に倒すと一方、右に倒すと他方の信号を扱います（例：上り出発・下り出発）。</div>
		${(st.pairs || []).map(p => { const lv = leverOfPos(st, p[0]).lever; return `<div class="row"><span>${lv.no}L ${esc(signalLabel(st, p[0]))}　／　${lv.no}R ${esc(signalLabel(st, p[1]))}</span><button data-unpair="${key(p[0])}">解除</button></div>`; }).join("")}
		${(() => {
			const free = signalLevers(st).filter(l => !l.pair);
			if (free.length < 2) return "";
			const opts = free.map(l => `<option value="${key(l.pos)}">${l.no} ${esc(signalLabel(st, l.pos))}</option>`).join("");
			return `<div class="row">左<select id="pairL">${opts}</select>右<select id="pairR">${opts}</select><button id="pairAdd">まとめる</button></div>`;
		})()}` : ""}
		<div class="hint" style="margin-top:6px"><b>入換てこ</b>：信号・出発点に、別に入換用のてこを付けます（例：番線から留置線への入換）。白＝入換信号機、緑＝入換標識、ピンク＝誘導信号（緑とピンクは、列車が止まっている線路の手前まで進路が取れる。ピンクは列車の進路扱い）。</div>
		<div class="sidegrid">${signalLevers(st).filter(l => !l.extra).flatMap(l => l.pair ? [l.left, l.right] : [l]).filter(s => !s.shunt).map(s => {
			const c = shuntColor(st, s.pos) || "N";
			return `<label>${esc(signalLabel(st, s.pos))}<select data-lvshunt="${key(s.pos)}">
				<option value="N" ${c === "N" ? "selected" : ""}>なし</option><option value="W" ${c === "W" ? "selected" : ""}>白（入換信号機）</option><option value="G" ${c === "G" ? "selected" : ""}>緑（入換標識）</option><option value="P" ${c === "P" ? "selected" : ""}>ピンク（誘導信号）</option></select></label>`;
		}).join("")}</div>
		${couplingWarnings(st)}
		${areaCfg(st)}
		${rescanCfg(st)}
		<div class="hint" style="margin-top:6px">所有：<b>${esc(companyName(st.owner))}</b>。ほかに操作できる会社（直通運転の駅などに）：</div>
		${others.length > 1 ? `<div class="row"><button data-opall="1" title="ほかの会社をすべて操作できるようにする">すべてチェック</button><button data-opall="0" title="所有の会社だけが操作できるようにする">すべて外す</button></div>` : ""}
		<div class="row">${others.map(p => `<label><input type="checkbox" data-op="${p.nr}" ${(st.operators || []).includes(p.nr) ? "checked" : ""}>${esc(p.name)}</label>`).join("") || `<span class="hint">ほかの会社はありません</span>`}</div>
	</div>`;
	// not while typing or choosing in it (a pressed button does not keep it from being drawn again)
	if (box.dataset.html === html || box.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
	box.innerHTML = box.dataset.html = html;
	for (const b of box.querySelectorAll("[data-kind]")) b.addEventListener("click", () => {
		const kind = Number(b.dataset.kind);
		if ((kind === 1) === relay) return;
		if (kind === 1 && !confirm("継電連動（上級者向け）に切り替えますか？\n信号てこをひねってから着点ボタンを押す扱いになり、転換時間・時素があります。ショートカットは使えなくなります。")) return;
		command(cfgCommand(st, { kind }), kind ? "継電連動に切替" : "電子連動に切替");
	});
	bindAreaCfg(box, st);
	box.querySelector("#rescanBtn").addEventListener("click", (e) => { e.currentTarget.blur(); command(`st_rescan,${st.id}`, "配線を読み直す"); });
	for (const c of box.querySelectorAll("[data-lvshunt]")) c.addEventListener("change", () =>
		command(`lv_shunt,${st.id},${c.dataset.lvshunt},${c.value}`, "入換てこ"));
	for (const c of box.querySelectorAll("[data-lvside]")) c.addEventListener("change", () =>
		command(`lv_side,${st.id},${c.dataset.lvside},${c.value}`, "てこを倒す向き"));
	for (const b of box.querySelectorAll("[data-unpair]")) b.addEventListener("click", () => command(`lv_unpair,${st.id},${b.dataset.unpair}`, "てこのまとめを解除"));
	const pa = box.querySelector("#pairAdd");
	if (pa) pa.addEventListener("click", () => {
		const L = box.querySelector("#pairL").value, R = box.querySelector("#pairR").value;
		if (L === R) { toast("左右に別の信号を選んでください", true); return; }
		command(`lv_pair,${st.id},${L},${R}`, "信号てこをまとめる");
	});
	const ap = box.querySelector("#cfgTimes");
	if (ap) ap.addEventListener("click", () => command(cfgCommand(st, {
		ta: Number(box.querySelector("#cfgTa").value) || 0, ts: Number(box.querySelector("#cfgTs").value) || 0, tt: Number(box.querySelector("#cfgTt").value) || 0,
	}), "時素・転換時間"));
	for (const c of box.querySelectorAll("[data-op]")) c.addEventListener("change", () => {
		const ops = [...box.querySelectorAll("[data-op]")].filter(x => x.checked).map(x => x.dataset.op);
		command(`st_ops,${st.id},${ops.join(".")}`, "操作できる会社");
	});
	for (const b of box.querySelectorAll("[data-opall]")) b.addEventListener("click", (e) => {
		e.currentTarget.blur();
		const ops = b.dataset.opall === "1" ? [...box.querySelectorAll("[data-op]")].map(x => x.dataset.op) : [];
		command(`st_ops,${st.id},${ops.join(".")}`, b.dataset.opall === "1" ? "操作できる会社をすべてチェック" : "操作できる会社をすべて外す");
	});
}

// state of a signal lever for drawing it (board and map)
function leverView(st, pos, sh = false) {
	const { lever: main, side } = leverOfPos(st, pos);
	const l = sh ? (signalLevers(st).find(x => x.extra && key(x.pos) === key(pos)) || main) : main;
	const sl = sleverOf(st, pos, sh);
	const r = status.routes.find(x => key(x.start) === key(pos) && !!x.shunt === sh && x.state !== "idle");
	const sig = st.signals.find(s => key(s.pos) === key(pos));
	const clear = !!(r && r.state === "set" && !r.waiting && !st.all_stop) || !!(sig && sig.aspect !== "red");
	const state = r && r.state === "releasing" ? `時素 ${r.release_in}秒` : r && r.state === "set" && r.waiting ? (st.all_stop ? "一斉停止" : "転換中") :
		sl && sl.used && !r ? "復位してください" : sl && !sl.used ? "着点を押す" : "";
	const shunt = sh || (side ? (side === "L" ? l.left.shunt : l.right.shunt) : l.shunt);
	const color = sh ? extraColor(shuntColor(st, pos)) : shunt ? LEVER_WHITE : LEVER_RED;
	return { no: side && !sh ? l.no + side : l.no, shunt, color, sl, clear, state, angle: sl ? (sl.side === "L" ? -45 : 45) : 0, blink: !!(r && (r.state === "releasing" || r.waiting)) };
}
