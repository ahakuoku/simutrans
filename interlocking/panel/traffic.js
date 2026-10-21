// Read-only network occupancy and OuDiaSecond operation identification.
"use strict";

// Independent of automatic/operator operation and electric/relay panel kinds.
// Existing browsers start in the original panel until the new mode is selected.
let panelMode = localStore("panelMode") === "network" ? "network" : "legacy";
const isNetworkMode = () => panelMode === "network";
function renderPanelMode() {
	const networkMode = isNetworkMode();
	document.body.classList.toggle("network-mode", networkMode);
	document.getElementById("panelMode").value = panelMode;
	for (const id of ["networkRun", "networkSetup"]) document.getElementById(id).hidden = !networkMode;
	for (const id of ["legacyRun", "legacySetup"]) document.getElementById(id).hidden = networkMode;
}

function operationNumber(name) {
	return String(name).replace(/^\s*(?:\([0-9０-９]+\)|（[0-9０-９]+）)\s*/, "").trim();
}

function oudTime(value) {
	if (!/^\d{1,6}$/.test(value || "")) return null;
	const s = value.padStart(value.length <= 4 ? 4 : 6, "0");
	const h = Number(s.slice(0, 2)), m = Number(s.slice(2, 4)), sec = Number(s.slice(4) || 0);
	return h < 48 && m < 60 && sec < 60 ? h * 3600 + m * 60 + sec : null;
}

// CconvCentDed::CentDedRessya_To_OuPropertiesText / OperationTableContent_To_OuPropertiesText.
// EkiJikoku entries are in travel order, including on Nobori trains.
function parseOudOperations(text) {
	if (!/^FileType=OuDiaSecond\./m.test(text.replace(/^\uFEFF/, ""))) throw new Error("OuDiaSecond形式のファイルではありません");
	const root = { name: "", values: {}, children: [] }, stack = [root];
	for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const line = raw.trim();
		if (line === ".") { if (stack.length === 1) throw new Error("ファイルの階層が不正です"); stack.pop(); }
		else if (line.endsWith(".") && !line.includes("=")) {
			const n = { name: line.slice(0, -1), values: {}, children: [] };
			stack.at(-1).children.push(n); stack.push(n);
		} else {
			const i = line.indexOf("=");
			if (i >= 0) stack.at(-1).values[line.slice(0, i)] = line.slice(i + 1);
		}
	}
	if (stack.length !== 1) throw new Error("ファイルが途中で切れています");
	const children = (n, name) => n.children.filter(c => c.name === name);
	const rosen = children(root, "Rosen")[0];
	if (!rosen) throw new Error("路線情報がありません");
	const stations = children(rosen, "Eki").map(e => e.values.Ekimei || "");
	const types = children(rosen, "Ressyasyubetsu").map(t => t.values.Syubetsumei || "");
	return children(rosen, "Dia").map((dia, index) => {
		const entries = [], trains = {};
		for (const dir of ["Kudari", "Nobori"]) {
			const names = dir === "Nobori" ? stations.slice().reverse() : stations;
			trains[dir] = children(dia, dir).flatMap(d => children(d, "Ressya")).map((node, trainIndex) => {
				const v = node.values;
				let previous = null;
				const stops = (v.EkiJikoku || "").split(",").map((s, i) => {
					const times = (s.split(";")[1] || "").split("$")[0].split("/").map(oudTime);
					for (let j = 0; j < times.length; j++) if (times[j] !== null) {
						while (previous !== null && times[j] < previous) times[j] += 86400;
						previous = times[j];
					}
					return { name: names[i] || "", arrival: times[0], departure: times[1] ?? times[0] };
				});
				const valid = stops.map((s, i) => s.arrival !== null || s.departure !== null ? i : -1).filter(i => i >= 0);
				const train = { id: `${dir}:${trainIndex}`, number: v.Ressyabangou || "", type: types[Number(v.Syubetsu || 0)] || "", stops,
					destination: valid.length ? stops[valid.at(-1)].name : "", valid };
				const changes = Object.keys(v).filter(k => /^OperationNumber\d+$/.test(k)).map(k => ({ at: Number(k.slice(15)), ops: v[k].split(";") })).sort((a, b) => a.at - b.at);
				train.changes = changes;
				for (let i = 0; i < changes.length; i++) {
					const a = changes[i].at, b = changes[i + 1]?.at ?? valid.at(-1);
					add(train, changes[i].ops, a, b);
				}
				return train;
			});
		}
		function add(train, ops, a, b) {
			if (!train || !Number.isInteger(a) || !Number.isInteger(b)) return;
			const start = train.stops[a]?.departure ?? train.stops[a]?.arrival;
			const end = train.stops[b]?.arrival ?? train.stops[b]?.departure;
			if (start == null || end == null || end < start) return;
			for (const op of ops) if (op.trim()) entries.push({ ...train, operation: op.trim(), start, end, from: a, to: b });
		}
		// Saved operation tables also cover files without per-train OperationNumberN fields.
		for (const table of children(dia, "OperationTable")) for (const row of children(table, "OTRessya")) {
			const v = row.values, dir = v.OTHoukou?.endsWith("Nobori") ? "Nobori" : "Kudari";
			const train = trains[dir][Number(v.OTRessyaIndex)];
			if (train && !train.changes.length) add(train, [table.values.OTOperationNumber || ""], Number(v.SihatsuEkiOrder), Number(v.SyuuchakuEkiOrder));
		}
		return { name: dia.values.DiaName || `ダイヤ${index + 1}`, entries };
	});
}

function matchOperation(name, seconds, diagram, early, late, halt = "") {
	if (!diagram || !Number.isFinite(seconds)) return [];
	const candidates = new Map(), op = operationNumber(name);
	for (const entry of diagram.entries) {
		if (entry.operation !== op) continue;
		let windows = [[entry.start, entry.end]];
		// At a named stop, its arrival/departure gives a tighter identification window.
		const stops = entry.stops.slice(entry.from, entry.to + 1).filter(s => halt && s.name === halt && (s.arrival != null || s.departure != null));
		if (stops.length) windows = stops.map(s => [s.arrival ?? s.departure, s.departure ?? s.arrival]);
		for (const [start, end] of windows) for (const day of [-1, 0, 1, 2]) {
			const now = seconds + day * 86400;
			if (now >= start - early && now <= end + late) candidates.set(entry.id, entry);
		}
	}
	return [...candidates.values()];
}

let operationData = null;
try {
	const saved = JSON.parse(localStore("operations") || "null");
	if (saved?.source) operationData = { file: saved.file, diagrams: parseOudOperations(saved.source) };
} catch (e) {}
let network = null, networkSeed = "", networkError = "", networkDue = 0;
let networkMapZoom = 1;
let networkMapRendered = null;
const operationConfig = { early: 120, late: 1800, diagram: -1 };
try { Object.assign(operationConfig, JSON.parse(localStore("operationConfig") || "{}")); } catch (e) {}
function saveOperationConfig() { localStore("operationConfig", JSON.stringify(operationConfig)); }

async function refreshNetwork() {
	if (!isNetworkMode()) return;
	const a = currentArea(), hid = stationHalt(a), h = halts.find(x => x.id === hid);
	const p = h?.tiles[0];
	const seed = p ? `${stationId}:${p.join(",")}` : "";
	if (seed !== networkSeed) { network = null; networkDue = 0; networkSeed = seed; networkMapZoom = 1; }
	if (!p) { networkError = "設定で対応する駅を選択してください"; return; }
	if (performance.now() < networkDue) return;
	networkDue = performance.now() + 2000;
	try {
		const result = await api(`/api/network?x=${p[0]}&y=${p[1]}&z=${p[2]}`);
		if (!isNetworkMode() || networkSeed !== seed) return;
		network = result; networkError = "";
	} catch (e) { network = null; networkError = "在線情報を取得できません（対応するゲーム本体が必要です）"; }
}

function renderNetwork() {
	if (!isNetworkMode()) return;
	const clock = document.getElementById("networkClock"), summary = document.getElementById("networkSummary"), list = document.getElementById("networkTrains");
	if (!clock || !summary || !list) return;
	clock.textContent = connected && network ? network.time : "";
	if (!connected || networkError || !network || !networkSeed.startsWith(stationId + ":")) {
		summary.textContent = !connected ? "ゲームに接続できません。在線情報は更新されていません。" : networkError || "在線情報を取得中…";
		list.innerHTML = ""; renderNetworkMap(null); return;
	}
	renderNetworkMap(network);
	const diagram = operationData?.diagrams[operationConfig.diagram];
	summary.textContent = `接続線路 ${network.track_count} タイル・在線 ${network.convoys.length} 編成` + (diagram ? ` ／ ${diagram.name}` : operationData ? " ／ ダイヤ未選択（在線表示のみ）" : " ／ ダイヤ未読込（在線表示のみ）");
	list.innerHTML = network.convoys.map(c => {
		const matches = matchOperation(c.name, network.seconds, diagram, operationConfig.early, operationConfig.late, c.halt);
		const label = t => `${t.number || "列車番号なし"} ${t.type} ${t.destination}行`;
		const text = !diagram ? "運用照合なし" : matches.length === 1 ? label(matches[0]) : matches.length ? `候補複数：${matches.map(label).join(" ／ ")}` : "列車未特定";
		return `<div class="item"><b>${esc(text)}</b><div>運用番号 ${esc(operationNumber(c.name))} <small>（編成 ${c.id}）</small></div><div class="hint">${esc(c.halt || "駅間")} (${esc(c.pos.join(", "))}) ／ 在線 ${c.occupied.length} タイル</div></div>`;
	}).join("") || '<p class="hint">接続区間に列車はいません</p>';
}

function renderNetworkMap(data) {
	const svg = document.getElementById("networkMap"), wrap = document.getElementById("networkMapWrap"), hint = document.getElementById("networkMapHint");
	const size = `${wrap.clientWidth},${wrap.clientHeight},${networkMapZoom}`;
	if (networkMapRendered?.data === data && networkMapRendered.size === size) return;
	networkMapRendered = { data, size };
	const tiles = data?.tiles || [];
	if (!tiles.length) {
		svg.replaceChildren();
		hint.textContent = !data ? "" : data.tiles ? "接続する線路がありません" : "線形・信号表示にはゲーム本体を更新してください";
		return;
	}
	hint.textContent = "";
	let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
	for (const t of tiles) { x1 = Math.min(x1, t.p[0]); x2 = Math.max(x2, t.p[0]); y1 = Math.min(y1, t.p[1]); y2 = Math.max(y2, t.p[1]); }
	const unit = 24, width = (x2 - x1 + 3) * unit, height = (y2 - y1 + 3) * unit;
	const fit = Math.min(Math.max(1, wrap.clientWidth - 20) / width, Math.max(1, wrap.clientHeight - 20) / height);
	const scale = fit * networkMapZoom;
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("width", width * scale);
	svg.setAttribute("height", height * scale);
	// SVG normally scales text along with the tracks. Compensate so labels keep
	// a readable 14 CSS pixels even when fitting a large railway to the screen.
	svg.style.setProperty("--network-label-size", `${14 / scale}px`);
	svg.style.setProperty("--network-label-outline", `${2 / scale}px`);
	const xy = p => [(p[0] - x1 + 1.5) * unit, (p[1] - y1 + 1.5) * unit];
	const occupied = new Set((data.convoys || []).flatMap(c => c.occupied.map(p => p.join(","))));
	const platforms = [], rails = [], signals = [], labels = [], named = new Set();
	const labelBoxes = [], measure = document.createElement("canvas").getContext("2d");
	function addLabel(text, p, stationLabel) {
		const [ax, ay] = xy(p), px = ax * scale, py = ay * scale;
		measure.font = `${stationLabel ? 600 : 400} 14px system-ui`;
		const w = measure.measureText(text).width + 4, h = 20;
		let box;
		// Place nearby names in separate rows, in screen pixels rather than tiles.
		for (let row = 0; row < 100; row++) {
			const offset = (Math.floor(row / 2) + 1) * 22 * (row % 2 ? 1 : -1);
			box = { x: Math.max(3, Math.min(px + 8, width * scale - w - 3)), y: Math.max(3, Math.min(py + offset, height * scale - h - 3)), w, h };
			if (!labelBoxes.some(b => box.x < b.x + b.w + 4 && box.x + w + 4 > b.x && box.y < b.y + b.h && box.y + h > b.y)) break;
		}
		labelBoxes.push(box);
		const x = box.x / scale, y = (box.y + 15) / scale;
		labels.push(`<g><path class="network-label-leader" d="M${ax},${ay} L${x},${y}"/><text class="${stationLabel ? "network-station-label" : "network-train-label"}" x="${x}" y="${y}">${esc(text)}</text></g>`);
	}
	for (const t of tiles) {
		const [x, y] = xy(t.p), ends = DIRS.filter(d => t.r & d).map(d => [x + DXY[d][0] * unit / 2, y + DXY[d][1] * unit / 2]);
		const title = esc(`${t.halt || "線路"} (${t.p.join(", ")})`);
		if (t.halt) {
			platforms.push(`<rect class="network-platform" x="${x - 8}" y="${y - 8}" width="16" height="16"><title>${title}</title></rect>`);
			if (!named.has(t.halt)) { named.add(t.halt); addLabel(t.halt, t.p, true); }
		}
		let path = "";
		if (ends.length === 2) path = `M${ends[0]} Q${x},${y} ${ends[1]}`;
		else for (const end of ends) path += `M${x},${y} L${end} `;
		rails.push(`<path class="network-track${occupied.has(t.p.join(",")) ? " occupied" : ""}" d="${path}"><title>${title}</title></path>`);
		if (t.s) for (const d of DIRS.filter(d => t.s.dir & d)) {
			const [dx, dy] = DXY[d], sx = x + dx * 5 - dy * 6, sy = y + dy * 5 + dx * 6;
			const color = { green: "var(--green)", yellow: "var(--yellow)", red: "var(--red)" }[t.s.aspect] || "var(--muted)";
			signals.push(`<g class="network-signal"><title>${esc(`${t.s.name || "信号"} (${t.p.join(", ")}) ${t.s.aspect}`)}</title><path d="M${sx},${sy} l${dx * 5},${dy * 5}" stroke="${color}"/><circle cx="${sx}" cy="${sy}" r="3" fill="${color}" stroke="white" stroke-width="0.6"/></g>`);
		}
	}
	for (const c of data.convoys || []) {
		addLabel(operationNumber(c.name), c.pos, false);
	}
	svg.innerHTML = platforms.join("") + rails.join("") + signals.join("") + labels.join("");
}

for (const [id, factor] of [["networkZoomIn", 1.5], ["networkZoomOut", 1 / 1.5], ["networkFit", 0]]) document.getElementById(id).addEventListener("click", () => {
	networkMapZoom = factor ? Math.max(1, Math.min(128, networkMapZoom * factor)) : 1;
	if (network) renderNetworkMap(network);
});

document.getElementById("panelMode").addEventListener("change", e => {
	panelMode = e.target.value === "network" ? "network" : "legacy";
	localStore("panelMode", panelMode);
	network = null; networkSeed = ""; networkError = ""; networkDue = 0;
	selectedSignal = null; manualRoute = null;
	render();
	if (isNetworkMode()) refreshNetwork().then(render);
});

function renderOperationSettings() {
	const sel = document.getElementById("operationDiagram");
	sel.innerHTML = '<option value="-1">選択しない（在線表示のみ）</option>' + (operationData?.diagrams || []).map((d, i) => `<option value="${i}">${esc(d.name)}（${d.entries.length}件）</option>`).join("");
	sel.value = operationData?.diagrams[operationConfig.diagram] ? operationConfig.diagram : -1;
	document.getElementById("operationFileStatus").textContent = operationData ? `${operationData.file}：運用情報を読込済み` : "運用情報を保存した .oud2 ファイルを選択してください。";
	for (const [field, id] of [["early", "operationEarly"], ["late", "operationLate"]]) document.getElementById(id).value = operationConfig[field];
}

document.getElementById("operationFile").addEventListener("change", async e => {
	const file = e.target.files[0]; if (!file) return;
	try {
		const bytes = await file.arrayBuffer();
		let text;
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
		catch (e) { text = new TextDecoder("shift-jis").decode(bytes); }
		const diagrams = parseOudOperations(text);
		if (!diagrams.some(d => d.entries.length)) throw new Error("保存された運用情報がありません。OuDiaSecondで運用を設定・更新して保存してください");
		const data = { file: file.name, diagrams };
		// Store before replacing the current selection: a quota failure preserves it.
		try { localStorage.setItem("tidil.operations", JSON.stringify({ file: file.name, source: text })); }
		catch (e) { throw new Error("読込データをブラウザに保存できません（保存容量を確認してください）"); }
		operationData = data; operationConfig.diagram = -1; saveOperationConfig();
		renderOperationSettings(); renderNetwork();
	} catch (err) { toast("運用情報を読み込めません: " + err.message); }
	e.target.value = "";
});
document.getElementById("operationDiagram").addEventListener("change", e => { operationConfig.diagram = Number(e.target.value); saveOperationConfig(); renderNetwork(); });
document.getElementById("operationClear").addEventListener("click", () => {
	operationData = null; operationConfig.diagram = -1; saveOperationConfig(); localStore("operations", "null"); renderOperationSettings(); renderNetwork();
});
for (const [field, id] of [["early", "operationEarly"], ["late", "operationLate"]]) document.getElementById(id).addEventListener("change", e => {
	const n = Number(e.target.value);
	if (!e.target.value || !Number.isInteger(n) || n < 0 || n > 86399) { toast("許容時間は0〜86399秒で指定してください"); e.target.value = operationConfig[field]; return; }
	operationConfig[field] = n; saveOperationConfig(); renderNetwork();
});
// esc is supplied by actions.js, which is loaded after this file.
window.addEventListener("DOMContentLoaded", renderOperationSettings);
