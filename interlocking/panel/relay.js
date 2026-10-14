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
	const d = startTravelDir(st, pos);
	if (!d) return "R";
	const [vx, vy] = screenVec(d);
	return vx < 0 ? "L" : vx > 0 ? "R" : vy < 0 ? "R" : "L";
}

// all signal levers of the station: interlocked signals, then virtual departure / shunting signals
function signalLevers(st) {
	const res = [];
	st.signals.forEach(s => res.push({ pos: s.pos, dep: false, shunt: false }));
	(st.departures || []).filter(d => !d.shunt).forEach(d => res.push({ pos: d.pos, dep: true, shunt: false }));
	(st.departures || []).filter(d => d.shunt).forEach(d => res.push({ pos: d.pos, dep: true, shunt: true }));
	res.forEach((l, i) => { l.no = i + 1; });
	return res;
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
	const txt = String(no ?? "");
	const numColor = "#f4f4f4";
	const edge = color === "#2b2f33" ? `stroke="#8a948d" stroke-opacity=".9"` : `stroke="#000" stroke-opacity=".45"`;
	const fs = txt.length >= 3 ? 7.4 : 9.6;
	return `<circle cx="30" cy="40" r="22" fill="#0d1210" stroke="#3b4a42" stroke-width="1.5"/>
		<circle cx="30" cy="40" r="17" fill="#1a211d"/>
		<g transform="rotate(${angle} 30 40)">
			<path d="M17 46 V21 A13 13 0 0 1 43 21 V46 Q43 52 37 52 H23 Q17 52 17 46 Z" fill="${color}" ${edge} stroke-width="1"/>
			<path d="M20.5 30 V21 A9.5 9.5 0 0 1 27 12" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="2" stroke-linecap="round"/>
			<rect x="21" y="44" width="18" height="4" rx="2" fill="#000" opacity=".18"/>
			<circle cx="30" cy="25" r="9.6" fill="#111" stroke="#efefef" stroke-width="1.6"/>
			<text x="30" y="${25 + fs * .36}" font-size="${fs}" font-weight="700" text-anchor="middle" fill="${numColor}" font-family="Arial, sans-serif">${esc(txt)}</text>
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
function setHoverLever(k) {
	hoverLever = k;
	for (const e of document.querySelectorAll("#relayBoard [data-sl]")) e.classList.toggle("hl", e.dataset.sl.split(",").join(",") === k);
	for (const e of document.querySelectorAll("#map [data-mk]")) e.classList.toggle("hl", e.dataset.mk === k);
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
		const sl = sleverOf(st, l.pos);
		const r = act(l.pos);
		const side = leverSide(st, l.pos);
		const angle = sl ? (sl.side === "L" ? -45 : 45) : 0;
		const sig = st.signals.find(s => key(s.pos) === key(l.pos));
		const clear = !!(r && r.state === "set" && !r.waiting && !st.all_stop) || !!(sig && sig.aspect !== "red");
		let state = "";
		if (r && r.state === "releasing") state = `<span class="timer blink">時素 ${r.release_in}秒</span>`;
		else if (r && r.state === "set" && r.waiting) state = `<span class="timer">${st.all_stop ? "一斉停止" : "転換中"}</span>`;
		else if (sl && sl.used && !r) state = `<span class="timer dim">復位してください</span>`;
		else if (sl && !sl.used) state = `<span class="timer">着点を押す</span>`;
		html += `<div class="rlever ${relayStart() && key(relayStart().pos) === key(l.pos) ? "sel" : ""} ${hoverLever === key(l.pos) ? "hl" : ""}" data-sl="${key(l.pos)}" title="${esc(signalLabel(st, l.pos))}：${side === "L" ? "左" : "右"}にひねって着点ボタンを押す（つまみを押すと ひねる／戻す）">
			<div class="lamps">${lamp(sl && sl.side === "L", "#f4f1e6")}${lamp(clear, "var(--green)")}${lamp(!clear, "var(--red)", "small")}${lamp(sl && sl.side === "R", "#f4f1e6")}</div>
			${knob(l.shunt ? LEVER_WHITE : LEVER_RED, sl ? (sl.side === "L" ? -40 : 40) : 0, "", l.no)}
			${sideBtns("◀", "▶", side !== "L" || (sl && sl.side !== "L"), side !== "R" || (sl && sl.side !== "R"), sl && sl.side === "L", sl && sl.side === "R")}
			<div class="plate">${l.no}</div><div class="lname">${esc(signalLabel(st, l.pos))}</div>${state}</div>`;
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
		const pos = d.dataset.sl.split(",").map(Number);
		// the knob: turn to its side, or back to normal
		d.querySelector(".knob").addEventListener("click", () => turnSignalLever(pos, sleverOf(st, pos) ? "N" : null));
		for (const b of d.querySelectorAll("[data-side]")) b.addEventListener("click", () => {
			const sl = sleverOf(st, pos);
			turnSignalLever(pos, sl && sl.side === b.dataset.side ? "N" : b.dataset.side);
		});
		d.addEventListener("mouseenter", () => setHoverLever(d.dataset.sl));
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
			<p class="hint">秒数はゲーム内の時間（通常速度のとき）。早送り中は速く過ぎます。</p>` : ""}
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
	const l = signalLevers(st).find(x => key(x.pos) === key(pos)) || { no: "", shunt: false };
	const sl = sleverOf(st, pos);
	const r = status.routes.find(x => key(x.start) === key(pos) && x.state !== "idle");
	const sig = st.signals.find(s => key(s.pos) === key(pos));
	const clear = !!(r && r.state === "set" && !r.waiting && !st.all_stop) || !!(sig && sig.aspect !== "red");
	const state = r && r.state === "releasing" ? `時素 ${r.release_in}秒` : r && r.state === "set" && r.waiting ? (st.all_stop ? "一斉停止" : "転換中") :
		sl && sl.used && !r ? "復位してください" : sl && !sl.used ? "着点を押す" : "";
	return { no: l.no, shunt: l.shunt, sl, clear, state, angle: sl ? (sl.side === "L" ? -45 : 45) : 0, blink: !!(r && (r.state === "releasing" || r.waiting)) };
}
