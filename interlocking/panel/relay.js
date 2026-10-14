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
	res.forEach((l, i) => { l.no = i + 1; });
	return res;
}
// the lever of a start point, and its side when the lever is shared
function leverOfPos(st, pos) {
	for (const l of signalLevers(st)) {
		if (!l.pair && key(l.pos) === key(pos)) return { lever: l, side: null };
		if (l.pair && key(l.left.pos) === key(pos)) return { lever: l, side: "L" };
		if (l.pair && key(l.right.pos) === key(pos)) return { lever: l, side: "R" };
	}
	return { lever: { no: "", shunt: false }, side: null };
}
const sleverOf = (st, pos) => (st.slevers || []).find(l => key(l.pos) === key(pos));

// start of the next route: the lever this browser turned, else any turned lever without a route yet
function relayStart() {
	const st = station();
	if (!st) return null;
	const free = (st.slevers || []).filter(l => !l.used);
	const sel = free.find(l => key(l.pos) === relaySel) || free[free.length - 1];
	if (!sel) return null;
	return { pos: sel.pos, dep: isDepartureAnchor(st, sel.pos) };
}

function turnSignalLever(pos, side) {
	const st = station();
	if (!st.manual) { toast("CTC集中（自動）です。駅扱切換てこを「駅扱」にしてください", true); return; }
	const lv = sleverOf(st, pos);
	const want = side || (lv ? "N" : leverSide(st, pos));
	if (want !== "N" && want !== leverSide(st, pos)) { toast("このてこは反対側には開通しません", true); return; }
	if (want !== "N") relaySel = key(pos);
	command(`sl_turn,${st.id},${pos.join(",")},${want}`, `${signalLabel(st, pos)} てこ ${want === "N" ? "定位" : want === "L" ? "左反位" : "右反位"}`);
}

// actual position of a point (from the game): "N", "R", "X" (other pair) or null (unknown)
function pointLamp(st, pt) {
	const p = (st.points || []).find(x => key(x.pos) === key(pt.t.p));
	if (!p) return { pos: null, moving: 0 };
	const k = pairKey(p.pair);
	const pos = pt.normal.some(x => pairKey(x) === k) ? "N" : pt.reverse.some(x => pairKey(x) === k) ? "R" : "X";
	return { pos, moving: p.moving };
}

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
function checkApproach(st) {
	const now = new Set();
	for (const s of st.signals) if (s.train && s.aspect === "red") now.add(key(s.pos) + "|" + s.train);
	for (const d of st.departures || []) if (d.train && d.waiting) now.add(key(d.pos) + "|" + d.train);
	if (buzzerOn && [...now].some(k => !lastWaiting.has(k))) beep();
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
const LEVER_RED = "#c8323a", LEVER_WHITE = "#ecebe4", LEVER_BLACK = "#2b2f33";

// the two side buttons under a knob (the knob itself is the middle)
const sideBtns = (l, r, disL, disR, onL, onR) =>
	`<div class="lrbtn"><button data-side="L" class="${onL ? "on" : ""}" ${disL ? "disabled" : ""}>${l}</button><button data-side="R" class="${onR ? "on" : ""}" ${disR ? "disabled" : ""}>${r}</button></div>`;
let hoverLever = null;    // key of the signal lever under the mouse (board or map)
// k: one start point "x,y,z" (from the map) or all of a lever "k1|k2" (from the board)
function setHoverLever(k) {
	const ks = k ? k.split("|") : [];
	let all = ks;
	for (const e of document.querySelectorAll("#relayBoard [data-keys]")) {
		const mine = e.dataset.keys.split("|");
		const on = ks.some(x => mine.includes(x));
		e.classList.toggle("hl", on);
		if (on) all = [...new Set(all.concat(mine))];
	}
	hoverLever = ks[0] || null;
	for (const e of document.querySelectorAll("#map [data-mk]")) e.classList.toggle("hl", all.includes(e.dataset.mk));
}
const lamp = (on, color, cls = "") => `<span class="lamp ${cls} ${on ? "on" : ""}" style="--lc:${color}"></span>`;

function renderRelayBoard() {
	const box = document.getElementById("relayBoard");
	const st = station();
	if (!st || !isRelay()) { box.innerHTML = ""; box.dataset.html = ""; return; }
	checkApproach(st);
	const act = (pos) => status.routes.find(r => key(r.start) === key(pos) && r.state !== "idle");
	let html = `<h2>信号てこ</h2><div class="rboard">`;
	for (const l of signalLevers(st)) {
		// the start point on each side of the lever (a shared lever has one on each side)
		const sides = l.pair ? { L: l.left.pos, R: l.right.pos } : { [leverSide(st, l.pos)]: l.pos };
		const slL = sides.L && sleverOf(st, sides.L), slR = sides.R && sleverOf(st, sides.R);
		const turned = slL ? "L" : slR ? "R" : null;
		const sl = slL || slR;
		const cur = turned ? sides[turned] : l.pos;
		const r = act(cur);
		const sig = st.signals.find(s => key(s.pos) === key(cur));
		const clear = !!(r && r.state === "set" && !r.waiting && !st.all_stop) || !!(sig && sig.aspect !== "red");
		let state = "";
		if (r && r.state === "releasing") state = `<span class="timer blink">時素 ${r.release_in}秒</span>`;
		else if (r && r.state === "set" && r.waiting) state = `<span class="timer">${st.all_stop ? "一斉停止" : "転換中"}</span>`;
		else if (sl && sl.used && !r) state = `<span class="timer dim">復位してください</span>`;
		else if (sl && !sl.used) state = `<span class="timer">着点を押す</span>`;
		const keys = Object.values(sides).map(key);
		const name = l.pair ? `${l.no}L ${esc(signalLabel(st, l.left.pos))}<br>${l.no}R ${esc(signalLabel(st, l.right.pos))}` : esc(signalLabel(st, l.pos));
		const tip = l.pair ? `左＝${signalLabel(st, l.left.pos)}、右＝${signalLabel(st, l.right.pos)}（◀ ▶ で倒す）` : `${signalLabel(st, l.pos)}：${sides.L ? "左" : "右"}にひねって着点ボタンを押す（つまみを押すと ひねる／戻す）`;
		const color = l.shunt ? LEVER_WHITE : LEVER_RED;
		html += `<div class="rlever ${relayStart() && keys.includes(key(relayStart().pos)) ? "sel" : ""} ${keys.includes(hoverLever) ? "hl" : ""}" data-sl="${key(l.pos)}" data-keys="${keys.join("|")}"
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
		html += `<div class="rlever point ${ls.locked ? "locked" : ""}" data-pl="${li}" title="${esc(leverName(st, li))}：◀ N（定位）・つまみ C（総括）・▶ R（反位）">
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
		<div class="rlever" data-buzz="1" title="接近電響：列車が信号で待つと音で知らせる（このブラウザだけ）">
			<div class="lamps">${lamp(buzzerOn, "var(--green)")}</div>
			<span class="pushbtn ${buzzerOn ? "on" : ""}"></span><div class="plate">電響</div><div class="lname">接近電響</div></div>
	</div>
	<div class="rlegend">
		<div><b>てこの使い方</b>：つまみを押すと ひねる／戻す（転てつてこは C）。◀ ▶ で左右に倒す（転てつてこは N・R）。</div>
		<div>${lamp(true, "#f4f1e6")} てこが反位（ひねった側）</div>
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
		const turnedSide = () => ["L", "R"].find(sd => sides[sd] && sleverOf(st, sides[sd]));
		// the knob: back to normal, or turn to its only side (a shared lever needs ◀ / ▶)
		d.querySelector(".knob").addEventListener("click", () => {
			const t = turnedSide();
			if (t) { turnSignalLever(sides[t], "N"); return; }
			if (sides.L && sides.R) { toast("◀ ▶ で倒す方向を選んでください", true); return; }
			const sd = sides.L ? "L" : "R";
			turnSignalLever(sides[sd], sd);
		});
		for (const b of d.querySelectorAll("[data-side]")) b.addEventListener("click", () => {
			const sd = b.dataset.side;
			if (!sides[sd]) return;
			turnSignalLever(sides[sd], turnedSide() === sd ? "N" : sd);
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
	box.querySelector("[data-buzz] .pushbtn").addEventListener("click", () => {
		buzzerOn = !buzzerOn;
		try { localStorage.setItem("il.buzzer", buzzerOn ? "1" : "0"); } catch (e) {}
		if (buzzerOn) beep();
		renderRelayBoard();
	});
}

// ---------------------------------------------------------------------------
// setup tab: kind of the interlocking, times, companies that may operate
// ---------------------------------------------------------------------------
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
		<div class="hint" style="margin-top:6px">所有：<b>${esc(companyName(st.owner))}</b>。ほかに操作できる会社（直通運転の駅などに）：</div>
		<div class="row">${others.map(p => `<label><input type="checkbox" data-op="${p.nr}" ${(st.operators || []).includes(p.nr) ? "checked" : ""}>${esc(p.name)}</label>`).join("") || `<span class="hint">ほかの会社はありません</span>`}</div>
	</div>`;
	if (box.dataset.html === html || box.contains(document.activeElement)) return;
	box.innerHTML = box.dataset.html = html;
	for (const b of box.querySelectorAll("[data-kind]")) b.addEventListener("click", () => {
		const kind = Number(b.dataset.kind);
		if ((kind === 1) === relay) return;
		if (kind === 1 && !confirm("継電連動（上級者向け）に切り替えますか？\n信号てこをひねってから着点ボタンを押す扱いになり、転換時間・時素があります。ショートカットは使えなくなります。")) return;
		command(cfgCommand(st, { kind }), kind ? "継電連動に切替" : "電子連動に切替");
	});
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
}

// state of a signal lever for drawing it (board and map)
function leverView(st, pos) {
	const { lever: l, side } = leverOfPos(st, pos);
	const sl = sleverOf(st, pos);
	const r = status.routes.find(x => key(x.start) === key(pos) && x.state !== "idle");
	const sig = st.signals.find(s => key(s.pos) === key(pos));
	const clear = !!(r && r.state === "set" && !r.waiting && !st.all_stop) || !!(sig && sig.aspect !== "red");
	const state = r && r.state === "releasing" ? `時素 ${r.release_in}秒` : r && r.state === "set" && r.waiting ? (st.all_stop ? "一斉停止" : "転換中") :
		sl && sl.used && !r ? "復位してください" : sl && !sl.used ? "着点を押す" : "";
	const shunt = side ? (side === "L" ? l.left.shunt : l.right.shunt) : l.shunt;
	return { no: side ? l.no + side : l.no, shunt, sl, clear, state, angle: sl ? (sl.side === "L" ? -45 : 45) : 0, blink: !!(r && (r.state === "releasing" || r.waiting)) };
}
