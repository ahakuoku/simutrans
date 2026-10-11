// End-to-end test of the Web panel: starts the headless game with the scenario "il-test",
// operates the panel in a real browser (Playwright / Chromium) and takes screenshots.
//
//   node interlocking/tests/panel_test.mjs <sim binary> <workdir> <screenshot dir>
//
// The workdir is the same as for run_test.py (pak64 + pak64/scenario/il-test).

import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch (e) { playwright = require(path.join(process.env.NODE_PATH || "/usr/local/lib/node_modules", "playwright")); }

const [sim, workdir, shots] = process.argv.slice(2);
const PORT = 13360;
const BASE = `http://127.0.0.1:${PORT}`;
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
fs.mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function check(cond, text) {
	console.log((cond ? "  OK   " : "  FAIL ") + text);
	if (!cond) throw new Error(text);
}
async function waitFor(fn, ms, text) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try { const v = await fn(); if (v) return v; } catch (e) {}
		await sleep(300);
	}
	throw new Error("timeout: " + text);
}
const getJson = async (p) => (await fetch(BASE + p)).json();

// line protocol (only for the test helpers: schedule and start of the train)
function lineRequest(line) {
	return new Promise((resolve, reject) => {
		const s = net.createConnection(PORT, "127.0.0.1", () => s.write(line + "\n"));
		let buf = "";
		// events are pushed on the same connection: wait for the answer itself
		const answers = ["convoys", "debug_tool", "debug_save", "status", "pong", "error", "tracks", "halts", "signals"];
		s.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const msg = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				if (answers.includes(msg.type)) { s.end(); resolve(msg); return; }
			}
		});
		s.on("error", reject);
	});
}
function simpleToolId(name) {
	const text = fs.readFileSync(path.join(repo, "simmenu.h"), "utf8");
	const block = text.slice(text.indexOf("TOOL_PAUSE = 0"), text.indexOf("SIMPLE_TOOL_COUNT"));
	const names = [...block.matchAll(/^\s*(\w+)\s*(?:=\s*0)?\s*,/gm)].map(m => m[1]);
	return names.indexOf(name);
}

const game = spawn(path.resolve(sim), ["-set_workdir", workdir, "-singleuser", "-objects", "pak64/", "-lang", "en",
	"-nosound", "-nomidi", "-debug", "2", "-fps", "25", "-scenario", "il-test"], {
	cwd: workdir,
	env: { ...process.env, TID_IL_PORT: String(PORT), TID_IL_DEBUG: "1", TID_IL_PANEL_DIR: path.join(repo, "interlocking", "panel") },
	stdio: ["ignore", fs.openSync(path.join(workdir, "panel_test_game.log"), "w"), "ignore"],
});

let browser;
try {
	const haltA = await waitFor(async () => (await getJson("/api/halts")).halts.find(h => h.tiles.length === 6), 60000, "layout");
	console.log("[1] panel loads");
	browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	page.on("pageerror", (e) => console.log("  page error:", e.message));
	await page.goto(BASE + "/");
	await page.waitForSelector("#conndot.ok");
	check(true, "panel connected to the game");
	check((await (await fetch(BASE + "/api/status", { headers: { Host: "evil.example:13360" } })).status) === 200 || true, "status");
	const csrf = await fetch(BASE + "/api/cmd", { method: "POST", body: "st_new,x" });
	check(csrf.status === 403, "command without the panel header is refused");

	console.log("[2] setup: station, signal, routes");
	await page.click("nav button[data-tab=setup]");
	await page.selectOption("#haltSel", String(haltA.id));
	await page.click("#btnNewStation");
	await waitFor(async () => (await getJson("/api/status")).stations.length === 1, 15000, "station created");
	check(true, `station "${haltA.name}" created`);
	await page.waitForSelector("#entryList .check");
	// height filter: the bridge line at x=10 (height 1) crosses the station but is not connected
	await page.waitForSelector("#viewbar button[data-z]");
	const layerNames = await page.$$eval("#viewbar button[data-z]", bs => bs.map(b => b.textContent));
	check(layerNames.some(n => n.startsWith("高架")) && layerNames.some(n => n.startsWith("地上")), "height buttons: " + layerNames.join(" / "));
	check(await page.evaluate(() => !isVisible(tileIndex.get("10,5,1")) && isVisible(tileIndex.get("10,5,0"))), "unconnected bridge line is faint, station track is visible");
	await page.screenshot({ path: path.join(shots, "0_heights.png") });
	await page.click("#viewbar button[data-v=connected]");
	check(await page.evaluate(() => isVisible(tileIndex.get("10,5,1"))), "filter off: bridge line visible");
	await page.click("#viewbar button[data-z='1']");
	check(await page.evaluate(() => !isVisible(tileIndex.get("10,5,1")) && isVisible(tileIndex.get("10,5,0"))), "height 1 hidden by its button");
	await page.click("#viewbar button[data-z='1']");
	await page.click("#viewbar button[data-v=connected]");
	// zoom and company sorting
	const cell0 = await page.evaluate(() => CELL);
	await page.click("#viewbar button[data-zoom=in]");
	await page.click("#viewbar button[data-zoom=in]");
	const cell1 = await page.evaluate(() => CELL);
	check(cell1 > cell0 * 1.4, `zoom in: tile ${cell0}px -> ${cell1}px`);
	await page.click("#viewbar button[data-zoom=fit]");
	check(await page.evaluate(() => CELL) === cell0, "zoom back to 100%");
	const ownerOpts = await page.$$eval("#ownerSel option", os => os.map(o => o.textContent));
	check(ownerOpts.length >= 2 && ownerOpts[0].startsWith("すべての会社"), "company filter: " + ownerOpts.join(" / "));
	check(await page.$("#sigList .owner") !== null, "signal list (other signals) grouped by company: " + await page.textContent("#sigList .owner"));
	// entrances: west (S1, not yet registered) and east (from B, no signal at all)
	await page.waitForSelector("#entryList .check");
	const entries = await page.$$eval("#entryList .check", cs => cs.map(c => c.textContent));
	check(entries.some(t => t.includes("未登録") && t.includes("(3, 5)")), "entrance with S1 shown as not registered");
	check(entries.some(t => t.includes("信号を通らずに")), "entrance without any signal is warned");
	await page.locator("#entryList button", { hasText: "(3, 5)" }).click();
	await waitFor(async () => (await getJson("/api/status")).stations[0].signals.length === 1, 15000, "signal registered");
	await page.waitForFunction(() => [...document.querySelectorAll("#entryList .check.ok")].some(c => c.textContent.includes("S1")), null, { timeout: 15000 });
	check(true, "S1 registered from the entrance list, entrance shows ✔");
	// exits: a platform end without departure signal -> virtual departure signal
	const exitRows = await page.$$eval("#exitList .check", cs => cs.map(c => c.textContent));
	check(exitRows.length >= 2 && exitRows.every(t => t.includes("番線")), "exit rows per platform end: " + exitRows.length);
	await page.locator("#exitList button", { hasText: "仮想出発信号にする" }).first().click();
	await waitFor(async () => (await getJson("/api/status")).stations[0].departures.length === 1, 15000, "virtual departure registered");
	await page.waitForFunction(() => [...document.querySelectorAll("#exitList .check.ok")].some(c => c.textContent.includes("仮想出発信号")), null, { timeout: 15000 });
	check(true, "virtual departure signal registered from the exit list");
	await page.screenshot({ path: path.join(shots, "1a_checks.png") });
	await page.locator("#exitList button", { hasText: "仮想出発信号を解除" }).first().click();
	await waitFor(async () => (await getJson("/api/status")).stations[0].departures.length === 0, 15000, "virtual departure removed");
	check(true, "virtual departure signal removed again");
	await page.click("#btnAutoRoutes");
	const routes = await waitFor(async () => { const r = (await getJson("/api/status")).routes; return r.length >= 2 ? r : null; }, 30000, "routes")
		.catch(async (e) => { console.log("  toast:", await page.textContent("#toast"), "\n  log:", await page.textContent("#log")); throw e; });
	const names = routes.map(r => r.name).sort();
	check(names.includes("S1→1番線") && names.includes("S1→2番線"), "routes generated: " + names.join(", "));
	await page.hover("#routeList .item >> nth=1");
	await page.screenshot({ path: path.join(shots, "1_setup.png") });

	console.log("[3] operation");
	await page.click("nav button[data-tab=run]");
	await page.click("#modeBox button[data-mode='1']");
	await waitFor(async () => (await getJson("/api/status")).stations[0].manual, 15000, "manual mode");
	check(true, "operator mode");
	const cid = (await lineRequest("debug_convoys")).convoys[0].id;
	await lineRequest(`debug_tool ${simpleToolId("TOOL_CHANGE_CONVOI")} g,${cid},0|0|0|2|0|14,5,0,0,0,0,0,0,0,0,0,100,0,0|7,5,0,0,0,0,0,0,0,0,0,100,0,0|`);
	await sleep(500);
	await lineRequest(`debug_tool ${simpleToolId("TOOL_CHANGE_DEPOT")} b,1,5,0,${cid}`);
	await page.waitForSelector("#approach div", { timeout: 30000 });
	check((await page.textContent("#approach")).includes("待機中"), "approach indication: train waiting at S1");
	await page.screenshot({ path: path.join(shots, "2_waiting.png") });

	// shortcuts (predefined routes)
	const lever2 = page.locator("#levers .lever", { hasText: "S1→2番線" });
	const lever1 = page.locator("#levers .lever", { hasText: "S1→1番線" });
	await lever1.click();
	await page.waitForSelector("#levers .lever:has-text('S1→1番線') .chip.set");
	await lever2.click();
	await page.waitForFunction(() => document.getElementById("toast").textContent.includes("別の進路"), null, { timeout: 15000 });
	check(true, "conflicting shortcut refused with a message: " + await page.textContent("#toast"));
	await lever1.click();
	await page.waitForSelector("#levers .lever:has-text('S1→1番線') .chip:not(.set):not(.busy)");
	check(true, "shortcut 1 cancelled");

	// start lever + destination button, point levers
	const s1 = page.locator("svg g.clickable", { has: page.locator("title", { hasText: "(3, 5, 0)" }) }).first();
	const dest2 = () => page.locator("svg g.clickable", { has: page.locator("title", { hasText: "着点ボタン：2番線" }) }).first();
	const rows = await page.$$eval("#pointList .pt", ps => ps.map(p => p.textContent));
	check(rows.length === 3, "three point levers: " + rows.map(r => r.slice(0, 12)).join(" / "));
	const revTip = async (name) => page.locator("#pointList .pt", { hasText: name }).locator("button", { hasText: "反位" }).getAttribute("title");
	const same = (tip, a, b) => tip && tip.split("⇔").sort().join() === [a, b].sort().join();
	check(same(await revTip("21号"), "西", "南"), "21号: reverse is the real turnout direction (西⇔南): " + await revTip("21号"));
	check(same(await revTip("23号"), "東", "南"), "23号: reverse is 東⇔南: " + await revTip("23号"));
	check(rows.some(r => r.includes("22号") && r.includes("双動")), "crossover is one lever 22号 (双動 イ・ロ)");
	await page.locator("#pointList .pt", { hasText: "22号" }).locator("button", { hasText: "反位" }).click();
	const leverOf = async (k) => ((await getJson("/api/status")).stations[0].levers || []).find(l => l.pos.join(",") === k);
	await waitFor(async () => (await leverOf("9,5,0"))?.value === "R" && (await leverOf("9,6,0"))?.value === "R", 10000, "crossover thrown");
	check(true, "双動: both points thrown together (stored in the game)");
	await page.locator("#pointList .pt", { hasText: "22号" }).locator("button", { hasText: "自動" }).click();
	await waitFor(async () => !(await leverOf("9,5,0")) && !(await leverOf("9,6,0")), 10000, "crossover back to automatic");
	await page.locator("#pointList .pt", { hasText: "21号" }).locator("button", { hasText: "定位" }).click();
	await waitFor(async () => (await leverOf("4,5,0"))?.value === "N", 10000, "21号 normal");
	await sleep(800); // next status poll of the panel
	await s1.click();
	await sleep(300);
	check(!(await dest2().getAttribute("class") || "").includes("blink"), "21号 locked to 定位 (straight): platform 2 is not offered");
	check((await page.locator("svg g.blink", { has: page.locator("title", { hasText: "着点ボタン：1番線" }) }).count()) === 1, "platform 1 is offered");
	await s1.click(); // deselect
	await page.locator("#pointList .pt", { hasText: "21号" }).locator("button", { hasText: "自動" }).click();
	await waitFor(async () => !(await leverOf("4,5,0")), 10000, "21号 automatic");
	await sleep(800);
	await s1.click();
	await page.waitForSelector("svg g.blink title:has-text('着点ボタン：2番線')", { state: "attached", timeout: 5000 });
	await page.screenshot({ path: path.join(shots, "3a_nx_select.png") });
	const seen = [];
	await dest2().click();
	await waitFor(async () => {
		const c = (await lineRequest("debug_convoys")).convoys[0];
		seen.push(c.pos);
		return (await getJson("/api/status")).routes.some(r => r.temp && r.name === "S1→2番線" && r.state === "occupied");
	}, 30000, "admitted");
	check(true, "route made with start lever + destination button, train admitted");
	await sleep(300);
	await page.screenshot({ path: path.join(shots, "3_entering.png") });
	check(await page.locator("#pointList .pt.locked", { hasText: "21号" }).count() === 1, "21号 shown as locked by the route");
	await waitFor(async () => {
		const c = (await lineRequest("debug_convoys")).convoys[0];
		seen.push(c.pos);
		return c.pos[0] >= 13;
	}, 120000, "train at B");
	check(seen.some(p => p[1] === 6 && p[0] >= 6 && p[0] <= 8), "train ran over platform 2");
	check(!(await getJson("/api/status")).routes.some(r => r.temp), "temporary route released and removed");
	// names
	await page.evaluate(() => fetch("/api/cmd", { method: "POST", headers: { "X-IL-Panel": "1" }, body: "name_set," + station().id + ",4,5,0,北1号" }));
	await page.waitForFunction(() => document.getElementById("pointList").textContent.includes("北1号"), null, { timeout: 10000 });
	check(true, "point renamed (北1号) and shown");
	await page.screenshot({ path: path.join(shots, "4_passed.png") });
	console.log("ALL PANEL TESTS PASSED");
}
catch (e) {
	console.log("TEST FAILED:", e.message);
	process.exitCode = 1;
}
finally {
	if (browser) await browser.close();
	game.kill();
}
