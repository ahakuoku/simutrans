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
	status: { stations: [station], routes: [] },
	halts: { halts: [{ id: 1, name: "始発", owner: 0, tiles: [[1, 1, 0]] }] },
	info: { map: [64, 64], player: 0, players: [{ nr: 0, name: "鉄道" }] },
	events: { last: 0, events: [] },
	tracks: { tiles: [{ p: [1, 1, 0], r: 10, m: 10, h: 1 }], convoys: {} },
	network: { time: "10:05:00", seconds: 36300, track_count: 10000,
		tiles: [{ p: [249, 250, 0], r: 10, halt: "始発", s: { dir: 8, aspect: "red", name: "場内信号" } }, { p: [250, 250, 0], r: 10 }, { p: [251, 250, 0], r: 9, s: { dir: 1, aspect: "green", name: "出発信号" } }],
		convoys: [{ id: 7, name: "(7) A01", pos: [250, 250, 0], halt: "", occupied: [[250, 250, 0]] }] },
	panel: { parts: [] },
};
const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://localhost");
	if (url.pathname.startsWith("/api/")) {
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
	assert.ok(textBoxes.every(b => b.height >= 13 && b.height <= 22), "large network fit keeps all labels readable");
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
	await page.locator("#operationFile").setInputFiles({ name: "test.oud2", mimeType: "text/plain", buffer: Buffer.from(source) });
	await page.locator("#operationFileStatus").getByText("test.oud2", { exact: false }).waitFor();
	assert.equal(await page.locator("#operationDiagram").inputValue(), "-1");
	await page.locator('[data-tab="run"]').click();
	assert.match(await page.locator("#networkSummary").innerText(), /ダイヤ未選択/);
	assert.match(await page.locator("#networkTrains").innerText(), /運用番号 A01/);
	assert.match(await page.locator("#networkTrains").innerText(), /250, 250, 0/);
	await page.reload();
	await page.locator("#networkTrains").getByText("運用照合なし").waitFor();
	await page.locator('[data-tab="setup"]').click();
	assert.equal(await page.locator("#operationDiagram").inputValue(), "-1");
	await page.locator("#operationDiagram").selectOption("0");
	await page.locator("#operationEarly").fill("45"); await page.locator("#operationEarly").dispatchEvent("change");
	await page.locator("#operationLate").fill("360"); await page.locator("#operationLate").dispatchEvent("change");
	await page.locator('[data-tab="run"]').click();
	assert.match(await page.locator("#networkTrains").innerText(), /101 急行 終点行/);
	await page.reload();
	await page.locator("#networkTrains").getByText("101 急行 終点行").waitFor();
	assert.equal(await page.locator("#panelMode").inputValue(), "network");
	await page.locator('[data-tab="setup"]').click();
	assert.equal(await page.locator("#operationEarly").inputValue(), "45");
	assert.equal(await page.locator("#operationLate").inputValue(), "360");
	await page.locator("#operationDiagram").selectOption("-1");
	await page.locator('[data-tab="run"]').click();
	assert.match(await page.locator("#networkTrains").innerText(), /運用照合なし/);
	assert.doesNotMatch(await page.locator("#networkTrains").innerText(), /101 急行/);
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
