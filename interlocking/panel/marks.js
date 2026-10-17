// TID interlocking panel: magnets and memos (マグネット・メモ)
// They lie on a game tile (track, signal, platform end, point), are stored in the game and seen by everybody.
// 使用停止 (X) blocks routes over its tile and the lever / point under it; tags (M) and memos (O) only show.
"use strict";

let markTool = null;          // null, "X", "M", "O" or "del"
let markText = "回送";        // text of the next tag
let markColor = 0;
let openMemo = null;          // id of the memo shown open
let markDragging = false;     // a magnet is being dragged: the map is not drawn again meanwhile
const MARK_COLORS = ["#2f6fdf", "#e0a100", "#1f9d55", "#c2410c", "#7c3aed"];
const MARK_WORDS = ["回送", "臨時", "試運転", "保守", "工事", "注意", "徐行"];
const markTextOf = (m) => { try { return decodeURIComponent(m.s || ""); } catch (e) { return m.s || ""; } };
const monthText = (m) => `${Math.floor(m / 12)}年${m % 12 + 1}月`;

// the section of the run tab: tools, tag words and colours, the list of what lies on the panel
function renderMarkBar() {
	const box = document.getElementById("markBar");
	const st = station();
	if (!st) { box.innerHTML = box.dataset.html = ""; return; }
	const marks = st.marks || [];
	const tool = (k, label, title) => `<button data-mtool="${k}" class="${markTool === k ? "on" : ""}" title="${title}">${label}</button>`;
	const html = `<div class="row">${tool("X", "使用停止", "線路・信号・ポイントに貼ると、そこを通る進路が取れず、てこ・ポイントも扱えなくなる")}${tool("M", "札", "列車番号や「回送」などの札を貼る（表示だけ）")}${tool("O", "メモ", "付せんを貼る（表示だけ）")}${tool("del", "はがす", "押してから、はがすマグネット・メモを押す")}</div>
		${markTool === "M" ? `<div class="row"><input id="markText" value="${esc(markText)}" size="10" placeholder="札の文字">${MARK_WORDS.map(w => `<button data-mword="${esc(w)}" class="chip">${esc(w)}</button>`).join("")}</div>
			<div class="row">${MARK_COLORS.map((c, i) => `<button data-mcolor="${i}" class="swatch ${markColor === i ? "on" : ""}" style="background:${c}" title="色"></button>`).join("")}</div>` : ""}
		${markTool ? `<p class="hint">${markTool === "del" ? "はがすマグネット・メモを押してください。" : "地図の線路・信号・ポイントを押すと貼ります。"}（もう一度ボタンを押すとやめる）</p>` : ""}
		${marks.length ? `<div class="marklist">${marks.map(m => `<div class="row"><span class="mk-${m.k}" style="${m.k === "M" ? `background:${MARK_COLORS[m.c % MARK_COLORS.length]}` : ""}">${m.k === "X" ? "使用停止" : m.k === "O" ? "メモ" : esc(markTextOf(m))}</span>
			<span class="hint">${m.k === "O" ? esc(markTextOf(m)).slice(0, 30) + "　" : ""}(${m.pos.join(", ")}) ${monthText(m.m)} ${esc(companyName(m.o))}</span><button data-mdel="${m.id}" title="はがす">✕</button></div>`).join("")}</div>` : `<p class="hint">貼ってあるものはありません</p>`}`;
	if (box.dataset.html === html || box.contains(document.activeElement) && document.activeElement.id === "markText") return;
	box.innerHTML = box.dataset.html = html;
	for (const b of box.querySelectorAll("[data-mtool]")) b.addEventListener("click", () => { markTool = markTool === b.dataset.mtool ? null : b.dataset.mtool; render(); });
	for (const b of box.querySelectorAll("[data-mword]")) b.addEventListener("click", () => { markText = b.dataset.mword; render(); });
	for (const b of box.querySelectorAll("[data-mcolor]")) b.addEventListener("click", () => { markColor = Number(b.dataset.mcolor); render(); });
	for (const b of box.querySelectorAll("[data-mdel]")) b.addEventListener("click", () => command(`mk_del,${st.id},${b.dataset.mdel}`, "はがす"));
	const t = box.querySelector("#markText");
	if (t) t.addEventListener("input", () => { markText = t.value; });
}

// a click on the map with a tool chosen
function markClicked(pos) {
	const st = station();
	if (!markTool || markTool === "del" || !st) return false;
	const clean = (s) => encodeURIComponent(s.replace(/[\r\n]+/g, " ").slice(0, 120));
	if (markTool === "X") command(`mk_add,${st.id},${pos.join(",")},X,0`, "使用停止");
	else if (markTool === "M") command(`mk_add,${st.id},${pos.join(",")},M,${markColor},${clean(markText || "札")}`, "札 " + markText);
	else if (markTool === "O") {
		const s = prompt("メモ", "");
		if (s) command(`mk_add,${st.id},${pos.join(",")},O,0,${clean(s)}`, "メモ");
	}
	return true;
}

// magnets and memos on the drawing; at(pos) gives the place on the drawing (or null), targets the tiles
// a magnet may be dragged to ([pos, x, y] on the drawing)
function drawMarks(g, st, at, sc, targets = []) {
	if (!st || !st.marks) return;
	const count = new Map();
	for (const m of st.marks) {
		const p = at(m.pos);
		if (!p) continue;
		const k = key(m.pos);
		const n = count.get(k) || 0;
		count.set(k, n + 1);
		const x = p[0] + 10 * sc, y = p[1] - 14 * sc - n * 15 * sc;
		const grp = el("g", { class: "mark clickable", "data-mark": m.id }, g);
		const text = m.k === "X" ? "使用停止" : m.k === "O" ? "✎" : markTextOf(m);
		const fs = Math.max(9, 10 * sc);
		const w = m.k === "O" ? 16 * sc : [...text].reduce((s, c) => s + (c.charCodeAt(0) > 255 ? fs : fs * .62), 0) + 8;
		const fill = m.k === "X" ? "#d62828" : m.k === "O" ? "#ffe066" : MARK_COLORS[m.c % MARK_COLORS.length];
		el("rect", { x: x - w / 2, y: y - fs * .8, width: w, height: fs * 1.6, rx: m.k === "O" ? 1 : 4, fill, stroke: "#111", "stroke-width": 1 }, grp);
		el("text", { x, y: y + fs * .35, "font-size": fs, "font-weight": 700, fill: m.k === "O" ? "#5b4300" : "#fff", "text-anchor": "middle" }, grp).textContent = text;
		if (m.k === "X") el("line", { x1: p[0] - 9 * sc, y1: p[1] - 9 * sc, x2: p[0] + 9 * sc, y2: p[1] + 9 * sc, stroke: "#d62828", "stroke-width": 3, "pointer-events": "none" }, grp);
		if (m.k === "O" && openMemo === m.id) {
			const lines = markTextOf(m).match(/.{1,14}/g) || [""];
			const bw = 14 * fs + 12, bh = lines.length * fs * 1.3 + fs * 1.6 + 8;
			el("rect", { x: x - 8, y: y + fs, width: bw, height: bh, fill: "#fff6b0", stroke: "#a68a00" }, grp);
			lines.forEach((l, i) => { el("text", { x: x - 2, y: y + fs * 2.2 + i * fs * 1.3, "font-size": fs, fill: "#3d3200" }, grp).textContent = l; });
			el("text", { x: x - 2, y: y + fs * 2.2 + lines.length * fs * 1.3 + 2, "font-size": fs * .85, fill: "#7a6a20" }, grp).textContent = `${monthText(m.m)} ${companyName(m.o)}`;
		}
		grp.appendChild(el("title", {})).textContent = (m.k === "X" ? "使用停止（ここを通る進路は取れません）" : m.k === "O" ? "メモ：" + markTextOf(m) : "札：" + markTextOf(m)) + `　${monthText(m.m)} ${companyName(m.o)}` + (markTool === "del" ? "（押すとはがす）" : "（ドラッグでほかの線路・信号・ポイントへ移せる）");
		let drag = null;
		grp.addEventListener("pointerdown", (e) => {
			if (markTool === "del" || e.button !== 0) return;
			e.stopPropagation();
			drag = { x: e.clientX, y: e.clientY, moved: false };
			grp.setPointerCapture(e.pointerId);
		});
		grp.addEventListener("pointermove", (e) => {
			if (!drag) return;
			if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
			drag.moved = markDragging = true;
			// the drawing may be scaled: move by the distance on the drawing
			const k = 1 / (g.getScreenCTM() ? g.getScreenCTM().a : 1);
			drag.dx = (e.clientX - drag.x) * k; drag.dy = (e.clientY - drag.y) * k;
			grp.setAttribute("transform", `translate(${drag.dx} ${drag.dy})`);
			grp.classList.add("dragging");
		});
		grp.addEventListener("pointerup", (e) => {
			if (!drag) return;
			const d = drag;
			drag = null;
			markDragging = false;
			if (!d.moved) return;
			grp.dataset.dragged = "1";
			// dropped: onto the nearest tile it may lie on (near enough), else back where it was
			const tx = p[0] + d.dx, ty = p[1] + d.dy;
			let best = null, bd = Infinity;
			for (const t of targets) { const dd = Math.hypot(t[1] - tx, t[2] - ty); if (dd < bd) { bd = dd; best = t; } }
			if (best && bd < 24 * sc && key(best[0]) !== key(m.pos)) command(`mk_mov,${st.id},${m.id},${best[0].join(",")}`, (m.k === "X" ? "使用停止" : m.k === "O" ? "メモ" : "札") + " を移す");
			render();
		});
		grp.addEventListener("click", (e) => {
			e.stopPropagation();
			if (grp.dataset.dragged) { delete grp.dataset.dragged; return; }
			if (markTool === "del") { command(`mk_del,${st.id},${m.id}`, "はがす"); return; }
			if (m.k === "O") { openMemo = openMemo === m.id ? null : m.id; render(); }
		});
	}
}

// targets for placing a magnet, on top of the drawing (a circle per tile / part)
function drawMarkTargets(g, targets, sc) {
	if (!markTool || markTool === "del") return;
	for (const [pos, x, y] of targets) {
		const c = el("circle", { cx: x, cy: y, r: 9 * sc, fill: "rgba(255,224,102,.12)", stroke: "rgba(255,224,102,.5)", "stroke-dasharray": "2 2", class: "clickable marktarget" }, g);
		c.appendChild(el("title", {})).textContent = `ここに貼る (${pos.join(", ")})`;
		c.addEventListener("click", (e) => { e.stopPropagation(); markClicked(pos); });
	}
}
