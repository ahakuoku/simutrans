// Browser regression test using deterministic game API fixtures.
// NODE_PATH=<directory containing playwright> node interlocking/tests/panel_traffic_browser_test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const panel = new URL("../panel/", import.meta.url);
let offline = false;
let networkRequests = 0, trackRequests = 0;
const station = { id: 1, name: "始発", owner: 0, manual: false, signals: [], departures: [], view: [0, 0, 10, 10, 1] };
const api = {
	status: { stations: [station], routes: [], station_aliases: [], operations: { id: "-", file: "", bytes: 0, diagram: -1 } },
	halts: { halts: [{ id: 1, name: "始発", owner: 0, tiles: [[1, 1, 0]] }] },
	info: { map: [64, 64], player: 0, players: [{ nr: 0, name: "鉄道" }] },
	events: { last: 0, events: [] },
	tracks: { tiles: [{ p: [1, 1, 0], r: 10, m: 10, h: 1 }], convoys: {} },
	network: { time: "10:05:00", seconds: 36300, track_count: 10000,
		tiles: [{ p: [249, 250, 0], r: 10, halt: "始発", s: { dir: 8, aspect: "red", name: "場内信号" } }, { p: [250, 250, 0], r: 10 }, { p: [251, 250, 0], r: 9, s: { dir: 1, aspect: "green", name: "出発信号" } }],
		convoys: [{ id: 7, name: "(7) A01", pos: [250, 250, 0], halt: "", service_from: "始発", service_to: "終点", occupied: [[250, 250, 0]] }] },
	panel: { parts: [] },
};
let operationBytes = Buffer.alloc(0), operationUpload = null, rejectNextOperationPart = false;
const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://localhost");
	if (url.pathname.startsWith("/api/")) {
		if (url.pathname === "/api/operations") {
			const offset = Number(url.searchParams.get("offset") || 0);
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ ...api.status.operations, offset, data: operationBytes.subarray(offset, offset + 4096).toString("hex") })); return;
		}
		if (url.pathname === "/api/cmd") {
			let body = "";
			req.on("data", chunk => body += chunk);
			req.on("end", () => {
				const [cmd, key, value] = body.split(",");
				let ok = true;
				const fields = body.split(",");
				if (cmd === "oud_begin") {
					ok = value === api.status.operations.id;
					if (ok) operationUpload = { id: key, base: value, bytes: Number(fields[3]), file: decodeURIComponent(fields[4]), data: Buffer.alloc(0) };
				} else if (cmd === "oud_part") {
					ok = !rejectNextOperationPart && operationUpload?.id === key && operationUpload.data.length === Number(value);
					rejectNextOperationPart = false;
					if (ok) operationUpload.data = Buffer.concat([operationUpload.data, Buffer.from(fields[3], "hex")]);
				} else if (cmd === "oud_commit") {
					ok = operationUpload?.id === key && operationUpload.base === api.status.operations.id && operationUpload.data.length === operationUpload.bytes;
					if (ok) { operationBytes = operationUpload.data; api.status.operations = { id: key, file: operationUpload.file, bytes: operationBytes.length, diagram: -1 }; operationUpload = null; }
				} else if (cmd === "oud_select" || cmd === "oud_clear") {
					ok = key === api.status.operations.id;
					if (ok && cmd === "oud_select") api.status.operations.diagram = Number(value);
					if (ok && cmd === "oud_clear") { operationBytes = Buffer.alloc(0); api.status.operations = { id: "-", file: "", bytes: 0, diagram: -1 }; }
				}
				const pairs = new Map(api.status.station_aliases);
				if (cmd === "alias_set") pairs.set(decodeURIComponent(key), decodeURIComponent(value));
				if (cmd === "alias_del") pairs.delete(decodeURIComponent(key));
				api.status.station_aliases = [...pairs];
				api.events.events.push({ seq: ++api.events.last, type: "result", command: body, ok, error: ok ? undefined : "diagram upload interrupted or changed" });
				res.end("{}");
			}); return;
		}
		if (url.pathname === "/api/events") {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ last: api.events.last, events: api.events.events.filter(e => e.seq > Number(url.searchParams.get("since"))) })); return;
		}
		if (url.pathname === "/api/network") networkRequests++;
		if (url.pathname === "/api/tracks") trackRequests++;
		if (offline && url.pathname === "/api/network") { res.writeHead(503).end(); return; }
		res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(api[url.pathname.slice(5)] || {})); return;
	}
	const name = path.basename(url.pathname) || "index.html";
	const file = new URL(name, panel);
	if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
	res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
	res.end(fs.readFileSync(file));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	const errors = []; page.on("pageerror", e => errors.push(e.message));
	await page.goto(`http://127.0.0.1:${server.address().port}`);
	await page.locator("#conntext").getByText("ゲームに接続中", { exact: true }).waitFor();
	assert.equal(await page.locator("#panelMode").inputValue(), "legacy");
	assert.deepEqual(await page.locator("#panelMode option").allTextContents(), ["連動盤", "全区間在線"]);
	assert.equal(await page.locator("#stationNameMode").inputValue(), "game");
	assert.equal(await page.locator("#legacyRun").isVisible(), true);
	assert.equal(await page.locator("#networkRun").isVisible(), false);
	assert.equal(networkRequests, 0);
	await page.locator('[data-tab="setup"]').click();
	assert.equal(await page.locator("#legacySetup").isVisible(), true);
	assert.equal(await page.locator("#operationFile").isVisible(), false);
	await page.locator('[data-tab="run"]').click();
	await page.locator("#panelMode").selectOption("network");
	await page.locator("#networkTrains").getByText("運用番号 A01", { exact: false }).waitFor();
	assert.equal(await page.locator("#legacyRun").isVisible(), false);
	assert.equal(await page.locator("#modeBox").isVisible(), false);
	assert.equal(await page.locator("#mapwrap").isVisible(), false);
	assert.match(await page.locator("#networkSummary").innerText(), /10000/);
	assert.match(await page.locator("#networkTrains").innerText(), /250, 250, 0/);
	assert.equal(await page.locator("#networkMap .network-track").count(), 3);
	assert.equal(await page.locator("#networkMap .network-signal").count(), 2);
	assert.equal(await page.locator("#networkMap .occupied").count(), 1);
	const fitWidth = Number(await page.locator("#networkMap").getAttribute("width"));
	const labelHeight = await page.locator("#networkMap .network-station-label").first().evaluate(e => e.getBoundingClientRect().height);
	assert.ok(labelHeight >= 13 && labelHeight <= 22, `readable station label: ${labelHeight}px`);
	await page.locator("#networkZoomIn").click();
	assert.ok(Number(await page.locator("#networkMap").getAttribute("width")) > fitWidth);
	const zoomLabelHeight = await page.locator("#networkMap .network-station-label").first().evaluate(e => e.getBoundingClientRect().height);
	assert.ok(Math.abs(zoomLabelHeight - labelHeight) < 1, "zoom keeps screen text size");
	await page.locator("#networkFit").click();
	const originalTiles = api.network.tiles;
	api.network.tiles = [...originalTiles, { p: [2000, 1200, 0], r: 10, halt: "遠方の駅" }];
	await page.locator("#networkMap text").getByText("遠方の駅", { exact: true }).waitFor();
	const textBoxes = await page.locator("#networkMap text").evaluateAll(es => es.map(e => {
		const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height };
	}));
	const lineHeights = await page.locator("#networkMap tspan").evaluateAll(es => es.map(e => e.getBoundingClientRect().height));
	assert.ok(lineHeights.every(h => h >= 13 && h <= 22), "large network fit keeps each label line readable");
	for (let i = 0; i < textBoxes.length; i++) for (let j = i + 1; j < textBoxes.length; j++) {
		const a = textBoxes[i], b = textBoxes[j];
		assert.ok(!(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y), "nearby labels do not overlap");
	}
	if (process.env.PANEL_TRAFFIC_SCREENSHOT) await page.screenshot({ path: process.env.PANEL_TRAFFIC_SCREENSHOT, fullPage: true });
	api.network.tiles = originalTiles;
	const convoys = api.network.convoys;
	api.network.convoys = [];
	await page.locator("#networkTrains").getByText("接続区間に列車はいません").waitFor();
	assert.equal(await page.locator("#networkMap .network-track").count(), 3);
	assert.equal(await page.locator("#networkMap .network-signal").count(), 2);
	assert.equal(await page.locator("#networkMap .occupied").count(), 0);
	assert.equal(await page.locator("#networkMap .network-train-label").count(), 0);
	api.network.convoys = convoys;
	await page.locator("#networkTrains").getByText("運用番号 A01", { exact: false }).waitFor();
	assert.match(await page.locator("#networkSummary").innerText(), /ダイヤ未読込/);
	assert.match(await page.locator("#networkTrains").innerText(), /運用照合なし/);
	await page.locator('[data-tab="setup"]').click();
	const source = `FileType=OuDiaSecond.1.17\nRosen.\nEki.\nEkimei=始発\n.\nEki.\nEkimei=終点\n.\nRessyasyubetsu.\nSyubetsumei=急行\n.\nDia.\nDiaName=平日\nKudari.\nRessya.\nRessyabangou=101\nEkiJikoku=1;1000,1;1020/\nOperationNumber0=A01\n.\n.\n.\n.\n`;
	const overlappingSource = source.replace(".\n.\n.\n.\n", ".\n.\nNobori.\nRessya.\nRessyabangou=100\nEkiJikoku=1;940,1;1000/\nOperationNumber0=A01\n.\n.\n.\n.\n");
	await page.locator("#operationFile").setInputFiles({ name: "test.oud2", mimeType: "text/plain", buffer: Buffer.from(overlappingSource) });
	await page.locator("#operationFileStatus").getByText("test.oud2", { exact: false }).waitFor();
	assert.equal(await page.locator("#operationDiagram").inputValue(), "-1");
	assert.equal(await page.evaluate(() => localStorage.getItem("tidil.operations")), null);
	await page.locator('[data-tab="run"]').click();
	assert.match(await page.locator("#networkSummary").innerText(), /ダイヤ未選択/);
	assert.match(await page.locator("#networkTrains").innerText(), /運用番号 A01/);
	assert.match(await page.locator("#networkTrains").innerText(), /250, 250, 0/);
	await page.reload();
	await page.locator("#networkTrains").getByText("運用照合なし").waitFor();
	await page.locator('[data-tab="setup"]').click();
	assert.equal(await page.locator("#operationDiagram").inputValue(), "-1");
	await page.locator("#operationDiagram").selectOption("0");
	await page.waitForFunction(() => operationConfig.diagram === 0 && !operationsBusy);
	await page.locator("#operationEarly").fill("45"); await page.locator("#operationEarly").dispatchEvent("change");
	await page.locator("#operationLate").fill("360"); await page.locator("#operationLate").dispatchEvent("change");
	await page.locator('[data-tab="run"]').click();
	assert.match(await page.locator("#networkTrains").innerText(), /101 急行 終点行/);
	assert.equal(await page.evaluate(() => matchOperation("A01", network.seconds, operationData.diagrams[operationConfig.diagram], operationConfig.early, operationConfig.late).length), 2, "old and new services overlap before direction filtering");
	assert.doesNotMatch(await page.locator("#networkTrains").innerText(), /候補複数/);
	assert.match(await page.locator("#networkMap .network-train-label").textContent(), /101 急行 終点行/);
	assert.match(await page.locator("#networkMap .network-train-label").textContent(), /遅延不明/);
	api.network.convoys[0].loading = false;
	api.network.convoys[0].next_halt = "ゲーム終点";
	api.network.convoys[0].eta_seconds = 1200;
	await page.locator('[data-tab="setup"]').click();
	await page.locator("#stationAliasAdd").click();
	await page.locator(".alias-game").fill("ゲーム終点");
	await page.locator(".alias-oud").fill("終点");
	await page.locator("#stationAliasSave").click();
	await page.locator("#stationAliasStatus").getByText("1件をゲーム共通設定", { exact: false }).waitFor();
	await page.locator('[data-tab="run"]').click();
	await page.locator("#networkTrains").getByText("推定遅延 5分00秒（ゲーム終点 到着見込）", { exact: true }).waitFor();
	// A separate browser context has no localStorage from the first panel.
	const otherContext = await browser.newContext();
	const other = await otherContext.newPage();
	await other.goto(`http://127.0.0.1:${server.address().port}`);
	await other.locator("#panelMode").selectOption("network");
	await other.locator('[data-tab="setup"]').click();
	await other.locator("#operationFileStatus").getByText("test.oud2", { exact: false }).waitFor();
	assert.equal(await other.locator("#operationDiagram").inputValue(), "0", "selected diagram is shared with a fresh browser");
	assert.equal(await other.evaluate(() => localStorage.getItem("tidil.operations")), null, "source is not saved to the browser");
	await other.locator("#operationDiagram").selectOption("-1");
	await page.locator("#networkTrains").getByText("運用照合なし", { exact: false }).waitFor();
	await other.waitForFunction(() => !operationsBusy);
	await other.locator("#operationDiagram").selectOption("0");
	await page.locator("#networkTrains").getByText("101 急行 終点行", { exact: false }).waitFor();
	await other.locator(".alias-game").waitFor();
	assert.equal(await other.locator(".alias-game").inputValue(), "ゲーム終点");
	assert.equal(await other.locator(".alias-oud").inputValue(), "終点");
	await other.locator(".alias-oud").fill("別終点");
	await other.locator("#stationAliasSave").click();
	await page.waitForFunction(() => oudStationName("ゲーム終点") === "別終点");
	await page.locator("#networkTrains").getByText("遅延不明", { exact: true }).waitFor();
	await other.locator("#stationAliasStatus").getByText("1件をゲーム共通設定", { exact: false }).waitFor();
	await other.locator(".alias-oud").fill("終点");
	await other.locator("#stationAliasSave").click();
	await page.waitForFunction(() => oudStationName("ゲーム終点") === "終点");
	await page.locator("#networkTrains").getByText("推定遅延 5分00秒（ゲーム終点 到着見込）", { exact: true }).waitFor();
	await otherContext.close();
	assert.match(await page.locator("#networkMap .network-train-label").textContent(), /推定遅延 5分00秒/);
	assert.equal(await page.locator("#networkMap .network-train-label tspan.network-delay-late").count(), 1);
	for (const [delay, red] of [[59, false], [60, true], [0, false], [-60, false]]) {
		api.network.convoys[0].eta_seconds = 900 + delay;
		await page.waitForFunction(value => network?.convoys[0]?.eta_seconds === value, 900 + delay);
		assert.equal(await page.locator("#networkTrains .network-delay-late").count(), red ? 1 : 0);
		assert.equal(await page.locator("#networkMap .network-train-label tspan.network-delay-late").count(), red ? 1 : 0);
		assert.equal(await page.locator("#networkMap .network-train-label tspan:nth-child(-n+2).network-delay-late").count(), 0, "train identity stays its normal color");
	}
	api.network.time = "10:21:00"; api.network.seconds = 37260;
	api.network.convoys[0].loading = true; api.network.convoys[0].halt = "ゲーム終点"; api.network.convoys[0].arrival_elapsed = 0;
	await page.locator("#networkTrains").getByText("遅延 1分00秒（ゲーム終点 到着基準）", { exact: true }).waitFor();
	assert.match(await page.locator("#networkMap .network-train-label").textContent(), /遅延 1分00秒/);
	await page.locator("#stationNameMode").selectOption("alias");
	assert.match(await page.locator("#networkTrains").innerText(), /遅延 1分00秒（終点 到着基準）/);
	assert.match(await page.locator("#networkMap .network-train-label").textContent(), /終点 到着基準/);
	assert.doesNotMatch(await page.locator("#networkMap .network-train-label").textContent(), /ゲーム終点/);
	api.network.tiles[0].halt = "ゲーム終点";
	await page.locator("#networkMap .network-station-label").getByText("終点", { exact: true }).waitFor();
	station.signals = [{ pos: [1, 1, 0], aspect: "red", train: "(7) A01", dest: "ゲーム終点" }];
	await page.locator("#panelMode").selectOption("legacy");
	await page.locator("#approach").getByText("次 終点", { exact: false }).waitFor();
	assert.doesNotMatch(await page.locator("#approach").innerText(), /ゲーム終点/);
	await page.locator("#stationNameMode").selectOption("game");
	assert.match(await page.locator("#approach").innerText(), /次 ゲーム終点/);
	await page.locator("#stationNameMode").selectOption("alias");
	await page.locator("#panelMode").selectOption("network");
	api.network.tiles[0].halt = "始発";
	station.signals = [];
	api.network.time = "10:05:00"; api.network.seconds = 36300;
	api.network.convoys[0].loading = false; api.network.convoys[0].halt = "";
	await page.locator('[data-tab="setup"]').click();
	await page.locator("#operationFile").setInputFiles({ name: "test-legacy.oud2", mimeType: "text/plain", buffer: Buffer.from(overlappingSource.replace("OperationNumber0=A01", "Operation0B=3/950$/A01")) });
	await page.locator("#operationFileStatus").getByText("test-legacy.oud2", { exact: false }).waitFor();
	assert.equal(await page.locator("#operationDiagram").inputValue(), "-1");
	await page.locator("#operationDiagram").selectOption("0");
	await page.waitForFunction(() => operationConfig.diagram === 0 && !operationsBusy);
	await page.locator('[data-tab="run"]').click();
	assert.match(await page.locator("#networkTrains").innerText(), /101 急行 終点行/);
	await page.reload();
	await page.locator("#networkTrains").getByText("101 急行 終点行").waitFor();
	assert.equal(await page.locator("#panelMode").inputValue(), "network");
	assert.equal(await page.locator("#stationNameMode").inputValue(), "alias");
	await page.locator('[data-tab="setup"]').click();
	assert.equal(await page.locator("#operationEarly").inputValue(), "45");
	assert.equal(await page.locator("#operationLate").inputValue(), "360");
	assert.equal(await page.locator(".alias-game").inputValue(), "ゲーム終点");
	assert.equal(await page.locator(".alias-oud").inputValue(), "終点");
	await page.locator("#stationAliasAdd").click();
	await page.locator(".alias-game").last().fill("ゲーム終点");
	await page.locator(".alias-oud").last().fill("別の駅");
	await page.locator("#stationAliasSave").click();
	assert.match(await page.locator("#toast").innerText(), /重複/);
	assert.equal(api.status.station_aliases.length, 1);
	await page.locator(".station-alias-row").last().getByRole("button", { name: "この駅名エイリアスを削除" }).click();
	await page.locator(".station-alias-row").getByRole("button", { name: "この駅名エイリアスを削除" }).click();
	await page.locator("#stationAliasSave").click();
	await page.locator("#stationAliasStatus").getByText("0件をゲーム共通設定", { exact: false }).waitFor();
	await page.locator('[data-tab="run"]').click();
	assert.match(await page.locator("#networkTrains").innerText(), /遅延不明/);
	assert.match(await page.locator("#networkMap .network-train-label").textContent(), /遅延不明/);
	await page.locator('[data-tab="setup"]').click();
	await page.locator("#operationDiagram").selectOption("-1");
	await page.waitForFunction(() => operationConfig.diagram === -1 && !operationsBusy);
	await page.locator('[data-tab="run"]').click();
	assert.match(await page.locator("#networkTrains").innerText(), /運用照合なし/);
	assert.doesNotMatch(await page.locator("#networkTrains").innerText(), /101 急行/);
	assert.doesNotMatch(await page.locator("#networkMap .network-train-label").textContent(), /101 急行/);
	assert.match(await page.locator("#networkMap .network-train-label").textContent(), /遅延不明/);
	// A different save with the same filename must replace cached data.
	const freshContext = await browser.newContext();
	const fresh = await freshContext.newPage();
	await fresh.goto(`http://127.0.0.1:${server.address().port}`);
	await fresh.locator("#panelMode").selectOption("network");
	operationBytes = Buffer.from(overlappingSource.replace("Ressyabangou=101", "Ressyabangou=201"));
	api.status.operations = { ...api.status.operations, id: "33333333333333333333333333333333", bytes: operationBytes.length, diagram: 0 };
	await page.locator("#networkTrains").getByText("201 急行 終点行", { exact: false }).waitFor();
	await fresh.locator("#networkTrains").getByText("201 急行 終点行", { exact: false }).waitFor();
	rejectNextOperationPart = true;
	await page.locator('[data-tab="setup"]').click();
	await page.locator("#operationFile").setInputFiles({ name: "interrupted.oud2", mimeType: "text/plain", buffer: Buffer.from(overlappingSource) });
	await page.waitForFunction(() => !operationsBusy);
	assert.equal(api.status.operations.id, "33333333333333333333333333333333");
	assert.equal(await fresh.locator("#networkTrains").getByText("201 急行 終点行", { exact: false }).count(), 1);
	await fresh.locator('[data-tab="setup"]').click();
	await fresh.locator("#operationClear").click();
	await fresh.waitForFunction(() => !operationData && !operationsBusy);
	await page.waitForFunction(() => !operationData);
	assert.equal(operationBytes.length, 0);
	await freshContext.close();
	await page.locator('[data-tab="run"]').click();
	offline = true;
	await page.locator("#networkSummary").getByText("在線情報を取得できません", { exact: false }).waitFor();
	assert.equal(await page.locator("#networkTrains").innerText(), "");
	assert.equal(await page.locator("#networkMap .network-track").count(), 0);
	await page.locator("#panelMode").selectOption("legacy");
	assert.equal(await page.locator("#mapwrap").isVisible(), true);
	assert.equal(await page.locator("#modeBox").isVisible(), true);
	assert.equal(await page.locator("#legacyRun").isVisible(), true);
	const requestsBefore = networkRequests, tracksBefore = trackRequests;
	// Wait for multiple normal polling cycles, without relying on a fixed sleep.
	await new Promise((resolve, reject) => {
		const end = Date.now() + 10000;
		const timer = setInterval(() => {
			if (trackRequests >= tracksBefore + 3) { clearInterval(timer); resolve(); }
			else if (Date.now() > end) { clearInterval(timer); reject(new Error("legacy polling stopped")); }
		}, 50);
	});
	assert.equal(networkRequests, requestsBefore);
	await page.reload();
	await page.locator("#conntext").getByText("ゲームに接続中", { exact: true }).waitFor();
	assert.equal(await page.locator("#panelMode").inputValue(), "legacy");
	assert.equal(networkRequests, requestsBefore);
	assert.deepEqual(errors, []);
	console.log("PASS: legacy mode, mode persistence, empty-network track/signal map, zoom, occupancy, optional operation identification, thresholds and API failure");
} finally {
	await browser.close(); await new Promise(r => server.close(r));
}
