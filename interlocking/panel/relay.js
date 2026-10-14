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
function knob(color, angle, label) {
	return `<svg class="knob" viewBox="0 0 60 60" width="56" height="56" aria-hidden="true">
		<circle cx="30" cy="30" r="25" fill="#11161a" stroke="#4a5a52" stroke-width="2"/>
		<g transform="rotate(${angle} 30 30)">
			<rect x="22" y="6" width="16" height="44" rx="8" fill="${color}" stroke="#000" stroke-opacity=".35"/>
			<rect x="28" y="8" width="4" height="14" rx="2" fill="#fff" opacity=".85"/>
		</g>
		${label ? `<text x="30" y="58" font-size="9" text-anchor="middle" fill="#cfd6cf">${label}</text>` : ""}
	</svg>`;
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
		html += `<div class="rlever ${relayStart() && key(relayStart().pos) === key(l.pos) ? "sel" : ""}" data-sl="${l.pos.join(",")}" title="${esc(signalLabel(st, l.pos))}：${side === "L" ? "左" : "右"}にひねって着点ボタンを押す">
			<div class="lamps">${lamp(sl && sl.side === "L", "#f4f1e6")}${lamp(clear, "var(--green)")}${lamp(!clear, "var(--red)", "small")}${lamp(sl && sl.side === "R", "#f4f1e6")}</div>
			${knob(l.shunt ? "#e9ebe4" : "#c8323a", angle)}
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
		html += `<div class="rlever point ${ls.locked ? "locked" : ""}" data-pl="${li}" title="${esc(leverName(st, li))}：左＝N（定位）・中央＝C（総括）・右＝R（反位）">
			<div class="lamps">${lamp(lp.pos === "N", "var(--green)", blink)}<span class="lt">N</span><span class="lt">R</span>${lamp(lp.pos === "R", "var(--green)", blink)}</div>
			${knob("#23272b", angle, "N　C　R")}
			<div class="plate">${21 + li}${lv.double ? "<small>イロ</small>" : ""}</div>${labelAt(st, pt.t.p) ? `<div class="lname">${esc(labelAt(st, pt.t.p))}</div>` : ""}
			${ls.locked ? `<span class="timer dim">鎖錠</span>` : lp.moving > 0 ? `<span class="timer blink">転換 ${lp.moving}秒</span>` : ""}</div>`;
	});
	html += `</div><h2>その他のてこ</h2><div class="rboard">
		<div class="rlever" data-stop="1" title="一斉停止てこ：すべての信号を停止にする">
			<div class="lamps">${lamp(st.all_stop, "var(--red)", st.all_stop ? "blink" : "")}</div>
			${knob("#c8323a", st.all_stop ? 45 : 0)}<div class="plate">停</div><div class="lname">一斉停止</div></div>
		<div class="rlever" data-mode="1" title="駅扱切換てこ：左＝CTC集中（自動）、右＝駅扱（扱者）">
			<div class="lamps">${lamp(!st.manual, "#f4f1e6")}${lamp(st.manual, "var(--green)")}</div>
			${knob("#e9ebe4", st.manual ? 45 : -45, "集中　駅扱")}<div class="plate">扱</div><div class="lname">駅扱切換</div></div>
		<div class="rlever" data-buzz="1" title="接近電響：列車が信号で待つと音で知らせる（このブラウザだけ）">
			<div class="lamps">${lamp(buzzerOn, "var(--green)")}</div>
			<span class="pushbtn ${buzzerOn ? "on" : ""}"></span><div class="plate">電響</div><div class="lname">接近電響</div></div>
	</div>`;
	if (box.dataset.html === html) return;
	box.innerHTML = box.dataset.html = html;
	// left third / middle / right third of a knob
	const third = (e, elm) => { const r = elm.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width; return x < .36 ? "L" : x > .64 ? "R" : "M"; };
	for (const d of box.querySelectorAll("[data-sl]")) d.querySelector(".knob").addEventListener("click", (e) => {
		const pos = d.dataset.sl.split(",").map(Number);
		const t = third(e, e.currentTarget);
		const sl = sleverOf(st, pos);
		// a turned lever goes back to normal; otherwise it turns to the clicked side (middle: its own side)
		turnSignalLever(pos, sl ? "N" : t === "M" ? null : t);
	});
	for (const d of box.querySelectorAll("[data-pl]")) d.querySelector(".knob").addEventListener("click", (e) => {
		const li = Number(d.dataset.pl);
		const ls = leverState(li);
		if (ls.locked) { toast(`${leverName(st, li)} は鎖錠中です` + (ls.by ? `（${ls.by}）` : "（在線）"), true); return; }
		const t = third(e, e.currentTarget);
		setLever(li, t === "L" ? "N" : t === "R" ? "R" : null);
	});
	box.querySelector("[data-stop] .knob").addEventListener("click", () =>
		command(`st_stop,${st.id},${st.all_stop ? 0 : 1}`, st.all_stop ? "一斉停止 解除" : "一斉停止"));
	box.querySelector("[data-mode] .knob").addEventListener("click", (e) => {
		const t = third(e, e.currentTarget);
		const manual = t === "L" ? false : t === "R" ? true : !st.manual;
		if (manual !== st.manual) command(`st_mode,${st.id},${manual ? 1 : 0}`, manual ? "駅扱" : "CTC集中");
	});
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
