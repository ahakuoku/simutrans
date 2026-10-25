// Read-only network occupancy and OuDiaSecond operation identification.
"use strict";

// Independent of automatic/operator operation and electric/relay panel kinds.
// Existing browsers start in the original panel until the new mode is selected.
let panelMode = localStore("panelMode") === "network" ? "network" : "legacy";
let stationNameMode = localStore("stationNameMode") === "alias" ? "alias" : "game";
const isNetworkMode = () => panelMode === "network";
function renderPanelMode() {
	const networkMode = isNetworkMode();
	document.body.classList.toggle("network-mode", networkMode);
	document.getElementById("panelMode").value = panelMode;
	document.getElementById("stationNameMode").value = stationNameMode;
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
	const stationNodes = children(rosen, "Eki");
	const stations = stationNodes.map(e => e.values.Ekimei || "");
	const types = children(rosen, "Ressyasyubetsu").map(t => t.values.Syubetsumei || "");
	return children(rosen, "Dia").map((dia, index) => {
		const entries = [], trains = {}, legacyTrains = [], covered = new Set();
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
					const hasSlash = (s.split(";")[1] || "").split("$")[0].includes("/");
					return { name: names[i] || "", arrival: hasSlash ? times[0] : null, departure: hasSlash ? times[1] : times[0] };
				});
				const valid = stops.map((s, i) => s.arrival !== null || s.departure !== null ? i : -1).filter(i => i >= 0);
				const train = { id: `${dir}:${trainIndex}`, number: v.Ressyabangou || "", type: types[Number(v.Syubetsu || 0)] || "", stops,
					destination: valid.length ? stops[valid.at(-1)].name : "", valid };
				const changes = Object.keys(v).filter(k => /^OperationNumber\d+$/.test(k)).map(k => ({ at: Number(k.slice(15)), ops: v[k].split(";") })).sort((a, b) => a.at - b.at);
				train.changes = changes;
				legacyTrains.push({ train, values: v, dir });
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
			for (const op of ops) if (op.trim()) { entries.push({ ...train, operation: op.trim(), start, end, from: a, to: b }); covered.add(train.id); }
		}
		// Saved operation tables also cover files without per-train OperationNumberN fields.
		for (const table of children(dia, "OperationTable")) for (const row of children(table, "OTRessya")) {
			const v = row.values, dir = v.OTHoukou?.endsWith("Nobori") ? "Nobori" : "Kudari";
			const train = trains[dir][Number(v.OTRessyaIndex)];
			if (train && !train.changes.length) add(train, [table.values.OTOperationNumber || ""], Number(v.SihatsuEkiOrder), Number(v.SyuuchakuEkiOrder));
		}
		const explicit = new Set(covered);
		restoreLegacyOperations(legacyTrains, stationNodes, rosen.values, (train, ops, a, b) => {
			if (!explicit.has(train.id)) add(train, ops, a, b);
		});
		return { name: dia.values.DiaName || `ダイヤ${index + 1}`, entries };
	});
}

// OuDiaSecond 2.06.23: CconvCentDed's Operation{station}B/A properties and
// CDedOperationConnecter's station/track timelines. Preserve ordered formations
// through nested coupling/splitting, rather than guessing from train numbers.
function restoreLegacyOperations(records, stations, settings, add) {
	const nodes = [], events = new Map(), links = new Map(), snapshots = [];
	const node = (deps, fn) => { const n = { deps: deps.filter(Boolean), fn, value: null, next: [] }; nodes.push(n); return n; };
	const constant = ops => node([], () => ops);
	const list = s => s == null || s === "" ? [] : s.split(";").map(v => v.trim());
	const clock = t => ((t % 86400) + 86400) % 86400;
	const origin = oudTime(settings.KitenJikoku) ?? 14400;
	const timeOrder = t => clock(t - origin);
	const physical = stations.map((s, i) => i);
	const root = i => { while (physical[i] !== i) i = physical[i]; return i; };
	for (let i = 0; i < stations.length; i++) for (const key of ["BrunchCoreEkiIndex", "LoopOriginEkiIndex"]) {
		const value = stations[i].values[key], target = Number(value);
		if (value != null && Number.isInteger(target) && target >= 0 && target < stations.length) physical[root(i)] = root(target);
	}
	const stationIndex = (record, at) => {
		const i = record.dir === "Nobori" ? stations.length - 1 - at : at;
		return root(i);
	};
	function event(record, at, track, time, kind, port, link = "") {
		if (time == null) return;
		const e = { record, time: timeOrder(time), kind, port };
		const key = `${stationIndex(record, at)}:${track}`;
		if (!events.has(key)) events.set(key, []);
		events.get(key).push(e);
		if (link) {
			if (!links.has(link)) links.set(link, []);
			links.get(link).push(e);
		}
	}
	function compile(record, at, suffix, before, input, platform, fallback, depth = 0) {
		if (depth > 64) throw new Error("駅作業の入れ子が深すぎます");
		let work = record.values["Operation" + suffix];
		if (work == null || work === "") work = "5/$";
		const operations = work.split(",").map(s => { const a = s.split("/"); return { type: Number(a[0]), a }; });
		const beforeTrack = index => {
			for (let j = index; j < operations.length; j++) if (operations[j].type === 0) return Number(operations[j].a[1].split("$")[0]);
			return platform;
		};
		let track = before ? beforeTrack(0) : platform, current = input || constant([]), time = fallback;
		for (let i = 0; i < operations.length; i++) {
			const { type, a } = operations[i], part = (a[1] || "").split("$");
			if (type === 0) {
				time = oudTime((a[2] || "").split("$")[0]) ?? oudTime(part[1]) ?? time;
				track = before ? beforeTrack(i + 1) : Number(part[0]);
			} else if (type === 3 || type === 4 || type === 5) {
				let t = type === 4 ? oudTime(before ? (a[2] || "").split("$")[0] : part[1]) : oudTime(part[0]);
				if (t == null && before) {
					// The first shunt/coupling defines the origin when it is omitted.
					for (const op of operations.slice(i + 1)) if ([0, 1, 2].includes(op.type)) {
						t = oudTime(op.type === 2 ? op.a[2] : (op.a[1] || "").split("$")[1]);
						if (t != null) break;
					}
				}
				t ??= time;
				const link = type === 4 ? (a[2] || "").split("$")[1] : type === 3 ? part[1] : "";
				if (before) {
					const seed = list(type === 3 ? a[2] : type === 4 ? a[3] : part[1]);
					current = node([], vs => vs[0]?.length ? vs[0] : seed);
					event(record, at, track, t, type === 5 ? "start" : "out", current, link);
				} else event(record, at, track, t, type === 5 ? "end" : "in", current, link);
				time = t;
			} else if (type === 6) {
				const ops = list(a[1]);
				current = ops.length ? constant(ops) : node([current], vs => vs[0].slice().reverse());
			} else if (type === 1) {
				const t = oudTime(part[1]) ?? time;
				const child = compile(record, at, `${suffix}.${i}B`, true, null, track, t, depth + 1);
				current = node([current, child], vs => {
					const main = vs[0].length ? vs[0] : [""], sub = vs[1].length ? vs[1] : [""];
					return part[0] === "1" ? [...sub, ...main] : [...main, ...sub];
				});
				time = t;
			} else if (type === 2) {
				const count = Math.max(0, Number(part[1]) || 0), pos = Number(part[0]), previous = current;
				const split = ops => {
					if (ops.length < 2) return [ops, [""]];
					if (pos === 1) { const n = Math.min(ops.length - 1, count); return [ops.slice(n), ops.slice(0, n)]; }
					const n = pos === 0 ? Math.max(1, ops.length - count) : Math.min(ops.length - 1, count);
					return [ops.slice(0, n), ops.slice(n)];
				};
				current = node([previous], vs => split(vs[0])[0]);
				const sub = node([previous], vs => split(vs[0])[1]);
				time = oudTime(a[2]) ?? time;
				compile(record, at, `${suffix}.${i}A`, false, sub, track, time, depth + 1);
			}
		}
		return current;
	}
	for (const record of records) {
		const { train, values, dir } = record;
		if (!train.valid.length) continue;
		const first = train.valid[0], last = train.valid.at(-1), rawStops = values.EkiJikoku.split(","), states = [];
		let current = constant([]);
		for (let at = first; at <= last; at++) {
			const s = train.stops[at], station = stations[dir === "Nobori" ? stations.length - 1 - at : at];
			const trackText = rawStops[at]?.split("$")[1];
			const track = Number(trackText ?? station?.values[dir === "Nobori" ? "UpMain" : "DownMain"] ?? 0);
			const b = `${at}B`, a = `${at}A`;
			if (at === first || values["Operation" + b]) current = compile(record, at, b, true, current, track, s.departure ?? s.arrival);
			if (at === last || values["Operation" + a]) current = compile(record, at, a, false, current, track, s.arrival ?? s.departure);
			if (at < last) states.push({ at, current });
			// A through visit prevents a connection across another train using this track.
			if (at > first && at < last) {
				event(record, at, track, s.arrival, "block", current);
				event(record, at, track, s.departure, "block", current);
			}
		}
		snapshots.push({ train, states, last });
	}
	function connect(end, start) {
		start.port.deps = [end.port];
		const seedFn = start.port.fn;
		start.port.fn = vs => seedFn([settings.OperationNumberReverse === "1" && end.record.dir !== start.record.dir ? vs[0].slice().reverse() : vs[0]]);
	}
	for (const timeline of events.values()) {
		const rank = { end: 0, in: 0, block: 1, start: 2, out: 2 };
		timeline.sort((a, b) => a.time - b.time || rank[a.kind] - rank[b.kind]);
		const counts = new Map();
		for (const e of timeline) { const key = `${e.time}:${e.kind}`; counts.set(key, (counts.get(key) || 0) + 1); }
		for (let i = 0; i < timeline.length; i++) {
			const end = timeline[i], start = timeline[i + 1] || (settings.OperationCrossKitenJikoku === "1" ? timeline[0] : null);
			if (end.kind !== "end" || start?.kind !== "start") continue;
			// Multiple events of the same kind at this instant are a conflict.
			if (counts.get(`${end.time}:end`) !== 1 || counts.get(`${start.time}:start`) !== 1) continue;
			connect(end, start);
		}
	}
	for (const group of links.values()) {
		const ends = group.filter(e => e.kind === "in"), starts = group.filter(e => e.kind === "out");
		if (ends.length === 1 && starts.length === 1) connect(ends[0], starts[0]);
	}
	// Evaluate without recursive train-to-train calls (long daily diagrams can
	// contain thousands of operations). Unseeded cycles remain unidentified.
	const queue = [];
	for (const n of nodes) { n.left = n.deps.length; for (const d of n.deps) d.next.push(n); if (!n.left) queue.push(n); }
	for (let i = 0; i < queue.length; i++) {
		const n = queue[i]; n.value = n.fn(n.deps.map(d => d.value));
		for (const next of n.next) if (!--next.left) queue.push(next);
	}
	for (const { train, states, last } of snapshots) {
		let from = states[0]?.at, ops = states[0]?.current.value || [];
		for (const s of states.slice(1)) {
			const next = s.current.value || [];
			if (JSON.stringify(next) !== JSON.stringify(ops)) { add(train, ops, from, s.at); from = s.at; ops = next; }
		}
		if (from != null) add(train, ops, from, last);
	}
}

function oudStationName(name, aliases = operationConfig.stationAliases) {
	return (aliases || []).find(pair => pair[0] === name)?.[1] || name;
}

function displayStationName(name) {
	return stationNameMode === "alias" ? oudStationName(name) : name;
}

function matchOperation(name, seconds, diagram, early, late, halt = "", journey = null) {
	if (!diagram || !Number.isFinite(seconds)) return [];
	halt = oudStationName(halt);
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
	const matches = [...candidates.values()];
	if (!journey) return matches;
	const from = oudStationName(journey.service_from || (journey.loading === true ? journey.halt : ""));
	const to = oudStationName(journey.service_to || (journey.loading === false ? journey.next_halt : ""));
	if (!to || from === to) return matches;
	const paths = matches.map(entry => ({ entry, names: entry.stops.slice(entry.from, entry.to + 1).filter(s => s.arrival != null || s.departure != null).map(s => s.name) }));
	// Unknown game/diagram station names are not evidence against a candidate.
	if (!paths.some(p => p.names.includes(to))) return matches;
	const knownFrom = from && paths.some(p => p.names.includes(from));
	return paths.filter(p => knownFrom ? p.names.some((name, i) => name === from && p.names.slice(i + 1).includes(to)) : p.names.includes(to)).map(p => p.entry);
}

function trainDelay(convoy, seconds, entry) {
	const unknown = { text: "遅延不明", seconds: null };
	if (!entry || !Number.isFinite(seconds)) return unknown;
	const difference = (actual, scheduled) => ((actual - scheduled + 43200) % 86400 + 86400) % 86400 - 43200;
	function nearest(times, actual) {
		const found = times.filter(t => t != null).map(t => ({ time: t, diff: difference(actual, t) })).sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff));
		return !found.length || (found[1] && Math.abs(found[0].diff) === Math.abs(found[1].diff)) ? null : found[0];
	}
	function result(diff, basis, estimate = false) {
		diff = Math.round(diff);
		const n = Math.abs(diff), duration = `${Math.floor(n / 60)}分${String(n % 60).padStart(2, "0")}秒`;
		return { seconds: diff, text: (diff > 0 ? `${estimate ? "推定遅延" : "遅延"} ${duration}` : diff < 0 ? `早着${estimate ? "見込" : ""} ${duration}` : estimate ? "定刻見込" : "定刻") + `（${basis}）` };
	}
	const stops = entry.stops.slice(entry.from, entry.to + 1);
	if (convoy.loading === true && convoy.halt) {
		const here = stops.filter(s => s.name === oudStationName(convoy.halt));
		const departure = nearest(here.map(s => s.departure), seconds);
		let arrival = null;
		if (Number.isFinite(convoy.arrival_elapsed) && convoy.arrival_elapsed >= 0 && convoy.arrival_elapsed < 86400) {
			arrival = nearest(here.map(s => s.arrival), seconds - convoy.arrival_elapsed);
		}
		if (departure && departure.diff > 0 && (!arrival || departure.diff > arrival.diff)) return result(departure.diff, `${displayStationName(convoy.halt)} 発車待ち`);
		if (arrival) return result(arrival.diff, `${displayStationName(convoy.halt)} 到着基準`);
		// At an origin only a departure time may exist; waiting before it is on time.
		if (departure && !here.some(s => s.arrival != null)) return result(0, `${displayStationName(convoy.halt)} 発車待ち`);
	} else if (convoy.loading === false && convoy.next_halt && Number.isFinite(convoy.eta_seconds) && convoy.eta_seconds >= 0 && convoy.eta_seconds < 86400) {
		const arrival = nearest(stops.filter(s => s.name === oudStationName(convoy.next_halt)).map(s => s.arrival ?? s.departure), seconds + convoy.eta_seconds);
		if (arrival) return result(arrival.diff, `${displayStationName(convoy.next_halt)} 到着見込`, true);
	}
	return unknown;
}

const isDelayLate = delay => delay.seconds >= 60;

function networkTrainDisplay(c, data) {
	const diagram = operationData?.diagrams[operationConfig.diagram];
	const matches = matchOperation(c.name, data.seconds, diagram, operationConfig.early, operationConfig.late, c.halt, c);
	const label = t => `${t.number || "列車番号なし"} ${t.type} ${t.destination}行`;
	const text = !diagram ? "運用照合なし" : matches.length === 1 ? label(matches[0]) : matches.length ? `候補複数：${matches.map(label).join(" ／ ")}` : "列車未特定";
	const delay = trainDelay(c, data.seconds, matches.length === 1 ? matches[0] : null);
	return { text, delay, lines: [`運用 ${operationNumber(c.name)}`, matches.length === 1 ? label(matches[0]) : matches.length ? "候補複数" : diagram ? "列車未特定" : "運用照合なし", delay.text] };
}

let operationData = null;
let sharedOperations = null, operationsLoading = null, operationsBusy = false;
const operationMaxBytes = 8 * 1024 * 1024;
let network = null, networkSeed = "", networkError = "", networkDue = 0;
let networkMapZoom = 1;
let networkMapRendered = null;
const operationConfig = { early: 120, late: 1800, diagram: -1, stationAliases: [] };
try { Object.assign(operationConfig, JSON.parse(localStore("operationConfig") || "{}")); } catch (e) {}
operationConfig.stationAliases = [];
operationConfig.diagram = -1;
let sharedAliasesReady = false, aliasDraftDirty = false, aliasSaving = false, aliasDraftBase = [];
function saveOperationConfig() {
	const { stationAliases, diagram, ...config } = operationConfig;
	localStore("operationConfig", JSON.stringify(config));
}

function setOperationsBusy(busy, message = "") {
	operationsBusy = busy;
	for (const id of ["operationFile", "operationDiagram", "operationClear"]) document.getElementById(id).disabled = busy || !sharedOperations;
	if (message) document.getElementById("operationFileStatus").textContent = message;
}

async function syncSharedOperations(state) {
	const meta = state.operations;
	if (!meta || typeof meta.id !== "string") { sharedOperations = null; setOperationsBusy(false); return; }
	sharedOperations = meta;
	const applySelection = () => {
		const selected = operationData?.diagrams[sharedOperations.diagram] ? sharedOperations.diagram : -1;
		if (operationConfig.diagram !== selected) {
			operationConfig.diagram = selected;
			document.getElementById("operationDiagram").value = selected;
			renderNetwork();
		}
	};
	if (!meta.bytes) {
		operationsLoading = null;
		if (operationData) { operationData = null; operationConfig.diagram = -1; renderOperationSettings(); renderNetwork(); }
		setOperationsBusy(operationsBusy); return;
	}
	if (operationData?.id === meta.id) { applySelection(); setOperationsBusy(operationsBusy); return; }
	if (operationsLoading === meta.id) return;
	const key = meta.id; operationsLoading = key;
	// Hide a different game's data while fetching its replacement.
	operationData = null; operationConfig.diagram = -1;
	renderOperationSettings(); renderNetwork();
	try {
		if (!Number.isInteger(meta.bytes) || meta.bytes <= 0 || meta.bytes > operationMaxBytes) throw new Error("ダイヤのサイズが不正です");
		const bytes = new Uint8Array(meta.bytes);
		for (let offset = 0; offset < bytes.length;) {
			const part = await api(`/api/operations?offset=${offset}`);
			if (sharedOperations?.id !== key) return;
			if (part.id !== key || part.offset !== offset || part.bytes !== bytes.length || !/^(?:[0-9a-f]{2})+$/.test(part.data) || offset + part.data.length / 2 > bytes.length) throw new Error("ダイヤが更新されました。再取得します");
			for (let i = 0; i < part.data.length; i += 2) bytes[offset++] = parseInt(part.data.slice(i, i + 2), 16);
		}
		const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		operationData = { id: key, file: meta.file, diagrams: parseOudOperations(source) };
		applySelection(); renderOperationSettings(); renderNetwork();
	} catch (e) {
		if (sharedOperations?.id === key) document.getElementById("operationFileStatus").textContent = `ゲームのダイヤを取得できません: ${e.message}`;
	} finally {
		if (operationsLoading === key) operationsLoading = null;
		setOperationsBusy(operationsBusy);
	}
}
function syncSharedStationAliases(state) {
	const wasReady = sharedAliasesReady;
	sharedAliasesReady = Array.isArray(state.station_aliases);
	if (!sharedAliasesReady) return;
	const pairs = state.station_aliases.filter(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === "string" && n.length));
	if (wasReady && JSON.stringify(pairs) === JSON.stringify(operationConfig.stationAliases)) return;
	operationConfig.stationAliases = pairs;
	if (!aliasDraftDirty && !aliasSaving) renderStationAliasSettings();
	else document.getElementById("stationAliasStatus").textContent = "ほかの盤で共通設定が更新されました。編集中の変更は保存するまで適用されません。";
}

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
		const display = networkTrainDisplay(c, network);
		return `<div class="item"><b>${esc(display.text)}</b><div class="${isDelayLate(display.delay) ? "network-delay-late" : ""}">${esc(display.delay.text)}</div><div>運用番号 ${esc(operationNumber(c.name))} <small>（編成 ${c.id}）</small></div><div class="hint" title="${esc(c.halt || "")}">${esc(displayStationName(c.halt) || "駅間")} (${esc(c.pos.join(", "))}) ／ 在線 ${c.occupied.length} タイル</div></div>`;
	}).join("") || '<p class="hint">接続区間に列車はいません</p>';
}

function renderNetworkMap(data) {
	const svg = document.getElementById("networkMap"), wrap = document.getElementById("networkMapWrap"), hint = document.getElementById("networkMapHint");
	const size = `${wrap.clientWidth},${wrap.clientHeight},${networkMapZoom},${stationNameMode},${JSON.stringify(operationConfig)}`;
	if (networkMapRendered?.data === data && networkMapRendered.size === size && networkMapRendered.operations === operationData) return;
	networkMapRendered = { data, size, operations: operationData };
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
	function addLabel(text, p, stationLabel, late = false) {
		const lines = Array.isArray(text) ? text : [text];
		const [ax, ay] = xy(p), px = ax * scale, py = ay * scale;
		measure.font = `${stationLabel ? 600 : 400} 14px system-ui`;
		const w = Math.max(...lines.map(line => measure.measureText(line).width)) + 4, h = lines.length * 18 + 4;
		let box;
		// Place nearby names in separate rows, in screen pixels rather than tiles.
		for (let row = 0; row < 100; row++) {
			const offset = (Math.floor(row / 2) + 1) * (h + 2) * (row % 2 ? 1 : -1);
			box = { x: Math.max(3, Math.min(px + 8, width * scale - w - 3)), y: Math.max(3, Math.min(py + offset, height * scale - h - 3)), w, h };
			if (!labelBoxes.some(b => box.x < b.x + b.w + 4 && box.x + w + 4 > b.x && box.y < b.y + b.h && box.y + h > b.y)) break;
		}
		labelBoxes.push(box);
		const x = box.x / scale, y = (box.y + 15) / scale;
		labels.push(`<g><path class="network-label-leader" d="M${ax},${ay} L${x},${y}"/><text class="${stationLabel ? "network-station-label" : "network-train-label"}" x="${x}" y="${y}">${lines.map((line, i) => `<tspan${late && i === 2 ? ' class="network-delay-late"' : ""} x="${x}" dy="${i ? 18 / scale : 0}">${esc(line)}</tspan>`).join("")}</text></g>`);
	}
	for (const t of tiles) {
		const [x, y] = xy(t.p), ends = DIRS.filter(d => t.r & d).map(d => [x + DXY[d][0] * unit / 2, y + DXY[d][1] * unit / 2]);
		const title = esc(`${t.halt || "線路"} (${t.p.join(", ")})`);
		if (t.halt) {
			platforms.push(`<rect class="network-platform" x="${x - 8}" y="${y - 8}" width="16" height="16"><title>${title}</title></rect>`);
			if (!named.has(t.halt)) { named.add(t.halt); addLabel(displayStationName(t.halt), t.p, true); }
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
		const display = networkTrainDisplay(c, data);
		addLabel(display.lines, c.pos, false, isDelayLate(display.delay));
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

document.getElementById("stationNameMode").addEventListener("change", e => {
	stationNameMode = e.target.value === "alias" ? "alias" : "game";
	localStore("stationNameMode", stationNameMode);
	render();
});

function renderOperationSettings() {
	const sel = document.getElementById("operationDiagram");
	sel.innerHTML = '<option value="-1">選択しない（在線表示のみ）</option>' + (operationData?.diagrams || []).map((d, i) => `<option value="${i}">${esc(d.name)}（${d.entries.length}件）</option>`).join("");
	sel.value = operationData?.diagrams[operationConfig.diagram] ? operationConfig.diagram : -1;
	if (!operationsBusy) document.getElementById("operationFileStatus").textContent = operationData ? `${operationData.file}：ゲーム共通の運用情報を読込済み` : operationsLoading ? "ゲームのダイヤを受信中…" : "ゲーム共通に保存する .oud2 ファイルを選択してください。";
	for (const [field, id] of [["early", "operationEarly"], ["late", "operationLate"]]) document.getElementById(id).value = operationConfig[field];
	if (!aliasDraftDirty && !aliasSaving) renderStationAliasSettings();
	renderStationAliasSuggestions();
	setOperationsBusy(operationsBusy);
}

function renderStationAliasSettings() {
	document.getElementById("stationAliases").innerHTML = "";
	for (const pair of operationConfig.stationAliases) addStationAliasRow(pair);
	aliasDraftBase = operationConfig.stationAliases.map(p => p.slice()); aliasDraftDirty = false;
	document.getElementById("stationAliasStatus").textContent = sharedAliasesReady ? `${operationConfig.stationAliases.length}件をゲーム共通設定に保存済み（全連動盤・全ブラウザで共有）` : "共通設定を取得中です。取得できない場合はゲーム本体を更新してください。";
}

function renderStationAliasSuggestions() {
	const game = [...new Set(halts.map(h => h.name))].sort((a, b) => a.localeCompare(b, "ja"));
	const oud = [...new Set((operationData?.diagrams || []).flatMap(d => d.entries.flatMap(e => e.stops.map(s => s.name))).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
	document.getElementById("aliasGameNames").innerHTML = game.map(n => `<option value="${esc(n)}"></option>`).join("");
	document.getElementById("aliasOudNames").innerHTML = oud.map(n => `<option value="${esc(n)}"></option>`).join("");
}

function addStationAliasRow(pair = ["", ""]) {
	const row = document.createElement("div"); row.className = "station-alias-row";
	row.innerHTML = `<input class="alias-game" aria-label="ゲーム内の駅名" list="aliasGameNames" placeholder="ゲーム内の駅名" value="${esc(pair[0])}"><span>→</span><input class="alias-oud" aria-label="OuDiaSecondの駅名" list="aliasOudNames" placeholder="OuDiaSecondの駅名" value="${esc(pair[1])}"><button type="button" aria-label="この駅名エイリアスを削除">削除</button>`;
	row.querySelector("button").addEventListener("click", () => { row.remove(); stationAliasesEdited(); });
	for (const input of row.querySelectorAll("input")) {
		input.addEventListener("input", stationAliasesEdited);
		input.addEventListener("focus", renderStationAliasSuggestions);
	}
	document.getElementById("stationAliases").appendChild(row);
	return row;
}
function stationAliasesEdited() { aliasDraftDirty = true; document.getElementById("stationAliasStatus").textContent = "未保存の変更があります。「エイリアスを保存」で全連動盤に適用します。"; }
document.getElementById("stationAliasAdd").addEventListener("click", () => {
	addStationAliasRow().querySelector("input").focus(); stationAliasesEdited();
});
function setAliasSaving(saving) {
	aliasSaving = saving;
	for (const id of ["stationAliasSave", "stationAliasAdd"]) document.getElementById(id).disabled = saving;
	for (const input of document.querySelectorAll(".station-alias-row input, .station-alias-row button")) input.disabled = saving;
}
document.getElementById("stationAliasSave").addEventListener("click", async () => {
	if (aliasSaving) return;
	if (!sharedAliasesReady) { toast("ゲーム共通設定を取得できません。ゲーム本体を更新してください"); return; }
	const pairs = [], seen = new Set();
	for (const row of document.querySelectorAll(".station-alias-row")) {
		const game = row.querySelector(".alias-game").value.trim(), oud = row.querySelector(".alias-oud").value.trim();
		if (!game && !oud) continue;
		if (!game || !oud) { toast("ゲーム内とOuDiaSecondの両方の駅名を入力してください"); return; }
		if (seen.has(game)) { toast(`ゲーム内の駅名「${game}」が重複しています。対応先は1つだけ指定してください`); return; }
		if (new TextEncoder().encode(game).length > 512 || new TextEncoder().encode(oud).length > 512) { toast("駅名はそれぞれUTF-8で512バイト以内にしてください"); return; }
		seen.add(game); pairs.push([game, oud]);
	}
	if (pairs.length > 512) { toast("駅名エイリアスは512件までです"); return; }
	const base = new Map(aliasDraftBase), commands = [];
	for (const [game, oud] of pairs) if (base.get(game) !== oud) commands.push(`alias_set,${encodeURIComponent(game)},${encodeURIComponent(oud)}`);
	for (const [game] of base) if (!seen.has(game)) commands.push(`alias_del,${encodeURIComponent(game)}`);
	setAliasSaving(true);
	try {
		for (const cmd of commands) {
			const result = await commandResult(cmd);
			if (!result.ok) throw new Error(tr(result.error));
		}
		await refreshStatus(); renderStationAliasSettings(); render();
	} catch (err) { toast("共通設定を保存できませんでした（一部は反映されている場合があります）: " + err.message); }
	finally { setAliasSaving(false); }
});

document.getElementById("operationFile").addEventListener("change", async e => {
	const file = e.target.files[0]; if (!file) return;
	if (!sharedOperations || operationsBusy) { e.target.value = ""; return; }
	const previous = sharedOperations.id;
	setOperationsBusy(true, "ダイヤを読み込んでいます…");
	try {
		if (file.size > operationMaxBytes || new TextEncoder().encode(file.name).length > 512) throw new Error("ファイルは8MiB以下、ファイル名はUTF-8で512バイト以下にしてください");
		const bytes = await file.arrayBuffer();
		let text;
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
		catch (e) { text = new TextDecoder("shift-jis").decode(bytes); }
		const diagrams = parseOudOperations(text);
		if (!diagrams.some(d => d.entries.length)) throw new Error("運用番号を読み取れません。OuDiaSecondの出区・路線外始発・運用番号変更の作業設定、または保存された運用情報を確認してください");
		const source = new TextEncoder().encode(text);
		if (source.length > operationMaxBytes) throw new Error("UTF-8に変換したファイルが8MiBを超えています");
		const token = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, "0")).join("");
		const begin = await commandResult(`oud_begin,${token},${previous},${source.length},${encodeURIComponent(file.name)}`);
		if (!begin.ok) throw new Error(tr(begin.error));
		for (let offset = 0; offset < source.length; offset += 1600) {
			const hex = [...source.subarray(offset, offset + 1600)].map(n => n.toString(16).padStart(2, "0")).join("");
			const response = await fetch("/api/cmd", { method: "POST", headers: { "X-IL-Panel": "1", "Content-Type": "text/plain; charset=utf-8" }, body: `oud_part,${token},${offset},${hex}` });
			if (!response.ok) throw new Error("送信に失敗しました");
			setOperationsBusy(true, `ダイヤをゲームへ送信中… ${Math.min(offset + 1600, source.length)} / ${source.length} バイト`);
		}
		const result = await commandResult(`oud_commit,${token}`);
		if (!result.ok) throw new Error(tr(result.error));
		await refreshStatus();
	} catch (err) { toast("運用情報を読み込めません: " + err.message); }
	finally { e.target.value = ""; setOperationsBusy(false); renderOperationSettings(); }
});
async function changeSharedOperation(command) {
	if (!sharedOperations || operationsBusy) return;
	setOperationsBusy(true);
	try {
		const result = await commandResult(command);
		if (!result.ok) throw new Error(tr(result.error));
		await refreshStatus();
	} catch (e) { toast(e.message); }
	finally { setOperationsBusy(false); renderOperationSettings(); renderNetwork(); }
}
document.getElementById("operationDiagram").addEventListener("change", e => changeSharedOperation(`oud_select,${sharedOperations?.id},${Number(e.target.value)}`));
document.getElementById("operationClear").addEventListener("click", () => changeSharedOperation(`oud_clear,${sharedOperations?.id}`));
for (const [field, id] of [["early", "operationEarly"], ["late", "operationLate"]]) document.getElementById(id).addEventListener("change", e => {
	const n = Number(e.target.value);
	if (!e.target.value || !Number.isInteger(n) || n < 0 || n > 86399) { toast("許容時間は0〜86399秒で指定してください"); e.target.value = operationConfig[field]; return; }
	operationConfig[field] = n; saveOperationConfig(); renderNetwork();
});
// esc is supplied by actions.js, which is loaded after this file.
window.addEventListener("DOMContentLoaded", renderOperationSettings);
