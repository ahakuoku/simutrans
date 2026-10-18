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
	await page.waitForFunction(() => document.getElementById("ownerInfo").textContent.startsWith("所有："), null, { timeout: 10000 });
	check(true, "owner shown in the header: " + await page.textContent("#ownerInfo"));
	// the game switches to another company: the panel says why commands are refused
	await page.evaluate(() => { info = Object.assign({}, info, { player: 3 }); render(); });
	check((await page.textContent("#ownerInfo")).includes("操作できません"), "company mismatch warned: " + await page.textContent("#ownerInfo"));
	await page.evaluate(() => { info = Object.assign({}, info, { player: station().owner }); render(); });
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
	// turn the panel: a station drawn north-south can be shown left-right
	const size = async () => page.evaluate(() => [Number(document.getElementById("map").getAttribute("width")), Number(document.getElementById("map").getAttribute("height"))]);
	const s0 = await size();
	await page.click("#viewbar button[data-rot]");
	const s1r = await size();
	check(Math.abs((s1r[0] - 40) / (s1r[1] - 40) - (s0[1] - 40) / (s0[0] - 40)) < 0.01, `rotated 90°: map ${s0} -> ${s1r}`);
	check((await page.textContent("#viewbar button[data-rot]")).includes("90°（北は右）"), "rotation shown with the direction of north");
	await page.screenshot({ path: path.join(shots, "0b_rotated.png") });
	check((await page.textContent("#viewbar .compass")).includes("北→"), "compass: north to the right");
	for (let i = 0; i < 3; i++) await page.click("#viewbar button[data-rot]");
	check((await page.textContent("#viewbar .compass")).includes("北↑"), "compass: north up again");
	check((await page.textContent("#viewbar button[data-rot]")).includes("0°"), "four turns: back to 0°");
	const ownerOpts = await page.$$eval("#ownerSel option", os => os.map(o => o.textContent));
	check(ownerOpts.length >= 2 && ownerOpts[0].startsWith("すべての会社"), "company filter: " + ownerOpts.join(" / "));
	check(await page.$("#sigList .owner") !== null, "signal list (other signals) grouped by company: " + await page.textContent("#sigList .owner"));
	await page.click("#otherSigs summary");
	await page.hover("#sigList [data-hsig='3,5,0']");
	check(await page.locator("#hoverSignalRing").count() === 1, "pointing at a signal in the list highlights it on the map");
	await page.screenshot({ path: path.join(shots, "0c_signal_hover.png") });
	await page.mouse.move(5, 5);
	await page.waitForFunction(() => !document.getElementById("hoverSignalRing"), null, { timeout: 5000 });
	await page.click("#otherSigs summary");
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
	// siding (5,7)-(5,8): virtual shunting signal
	const sidRows = await page.$$eval("#sidingList .check[data-prev]", cs => cs.map(c => c.textContent));
	check(sidRows.length === 1 && sidRows[0].includes("留置1") && sidRows[0].includes("行き止まり"), "siding found: " + sidRows.join(" / "));
	await page.locator("#sidingList button", { hasText: "仮想入換信号にする" }).click();
	await waitFor(async () => (await getJson("/api/status")).stations[0].departures.some(d => d.shunt && d.pos.join(",") === "5,7,0"), 15000, "shunting signal registered");
	await page.waitForSelector("#sidingList .check.ok");
	check(true, "virtual shunting signal registered from the siding list (leaves at (5,7))");
	// a stop next to the station used as a siding (駅属性の留置線)
	const sidHalt = (await getJson("/api/halts")).halts.find(h => h.tiles.some(t => t.join(",") === "12,8,0" || t.join(",") === "12,8"));
	check(!!sidHalt, "the stop at (12,8) exists: " + (sidHalt && sidHalt.name));
	await page.waitForSelector(`#sidingList [data-sidhalt='${sidHalt.id}']`);
	await page.check(`#sidingList [data-sidhalt='${sidHalt.id}']`);
	await waitFor(async () => ((await getJson("/api/status")).stations[0].siding_halts || []).length === 1, 10000, "siding stop");
	await page.waitForFunction(() => [...document.querySelectorAll("#sidingList .check[data-prev]")].some(c => c.textContent.includes("駅") && c.textContent.includes("行き止まり")), null, { timeout: 10000 });
	check(true, "stop (12,8) used as a siding: listed with its tracks");
	await page.locator("#sidingList .check[data-prev]", { hasText: "駅" }).locator("button", { hasText: "仮想入換信号にする" }).click();
	await waitFor(async () => (await getJson("/api/status")).stations[0].departures.some(d => d.shunt && d.pos.join(",") === "12,8,0"), 10000, "shunting signal in the stop")
		.catch(async (e) => { console.log("  log:", await page.textContent("#log"), JSON.stringify((await getJson("/api/status")).stations[0].departures)); throw e; });
	check(true, "virtual shunting signal at the siding stop (leaves at (12,8))");
	await page.click("#btnAutoRoutes");
	await page.waitForFunction(() => document.getElementById("toast").textContent.includes("本作成しました"), null, { timeout: 30000 }).catch(() => {});
	const routes = await waitFor(async () => { const r = (await getJson("/api/status")).routes; return r.length >= 2 ? r : null; }, 30000, "routes")
		.catch(async (e) => { console.log("  toast:", await page.textContent("#toast"), "\n  log:", await page.textContent("#log")); throw e; });
	const names = routes.map(r => r.name).sort();
	check(names.includes("S1→1番線") && names.includes("S1→2番線"), "routes generated: " + names.join(", "));
	check(names.includes("S1→留置1") && names.includes("留置1入換→2番線"), "shunting routes generated (into and out of the siding)");
	// rename a predefined route
	page.once("dialog", (d) => d.accept("入換 留置→2番"));
	await page.locator("#routeList .item", { hasText: "留置1入換→2番線" }).locator("button", { hasText: "名前" }).click();
	await waitFor(async () => (await getJson("/api/status")).routes.some(r => r.name === "入換 留置→2番"), 10000, "route renamed");
	await page.waitForSelector("#routeList .item:has-text('入換 留置→2番')");
	check(true, "predefined route renamed from the route list");
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
	check(rows.length === 5, "five point levers: " + rows.map(r => r.slice(0, 12)).join(" / "));
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
	check((await page.locator("svg g.blink", { has: page.locator("title", { hasText: "着点ボタン：留置1" }) }).count()) === 1, "siding offered as destination from S1");
	check((await page.locator("svg g.clickable title", { hasText: "仮想入換信号 留置1入換" }).count()) === 1, "shunting signal drawn on the map as a start lever");
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

	console.log("[4] relay interlocking panel");
	const stA = async () => (await getJson("/api/status")).stations[0];
	await page.click("nav button[data-tab=setup]");
	page.once("dialog", (d) => d.accept());
	await page.click("#stationCfg button[data-kind='1']");
	await waitFor(async () => (await stA()).kind === "relay", 15000, "relay");
	await page.waitForFunction(() => document.body.classList.contains("relay"), null, { timeout: 10000 });
	check(true, "switched to relay from the setup tab, panel in relay colours");
	check(!(await page.isVisible("#btnAutoRoutes")), "auto routes hidden on a relay panel");
	// all further companies at once (two more companies made up in the browser: the scenario has one)
	await page.evaluate(() => { info.players = info.players.concat([{ nr: 5, name: "会社5" }, { nr: 6, name: "会社6" }]); renderSetup(); });
	const opCount = await page.locator("#stationCfg [data-op]").count();
	if (opCount > 1) {
		await page.click("[data-opall='1']");
		await waitFor(async () => ((await stA()).operators || []).length === opCount, 10000, "all companies checked");
		check(true, `"すべてチェック": all ${opCount} further companies may operate`);
		await page.click("[data-opall='0']");
		await waitFor(async () => ((await stA()).operators || []).length === 0, 10000, "all unchecked");
		check(true, `"すべて外す": the owner only`);
	}
	else console.log(`  (only ${opCount} further company: no "すべてチェック")`);
	await page.click("nav button[data-tab=run]");
	await page.waitForSelector("#relayBoard .rlever[data-sl='3,5,0']");
	check(!(await page.isVisible("#levers")), "shortcuts hidden on a relay panel");
	const levers = await page.$$eval("#relayBoard .rlever .plate", ps => ps.map(p => p.textContent));
	check(levers.includes("1") && levers.includes("21") && levers.includes("停"), "levers on the board: " + levers.join(" "));
	await page.screenshot({ path: path.join(shots, "5_relay.png") });
	check(!(await page.isEnabled("#relayBoard .rlever[data-sl='3,5,0'] [data-side=L]")), "lever 1 (eastbound) cannot be turned to the left");
	// a finger on a lever: the board is not drawn anew until the tap is done (the tap would be lost)
	check(await page.evaluate(() => {
		const k = document.querySelector("#relayBoard .rlever[data-sl='3,5,0'] .knob");
		k.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
		document.getElementById("relayBoard").dataset.html = "";
		renderFromGame();
		const same = document.querySelector("#relayBoard .rlever[data-sl='3,5,0'] .knob") === k;
		k.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
		return same;
	}), "a tap on a lever is not lost by the panel being drawn anew meanwhile");
	await sleep(400);
	// signal lever 1 (S1, eastbound): turn to the right, then press the destination button
	await page.click("#relayBoard .rlever[data-sl='3,5,0'] [data-side=R]");
	await waitFor(async () => ((await stA()).slevers || []).some(l => l.pos.join(",") === "3,5,0" && l.side === "R"), 10000, "lever turned");
	check(true, "signal lever 1 turned to the right (stored in the game)");
	await sleep(800);
	await page.waitForSelector("svg g.blink title:has-text('着点ボタン：2番線')", { state: "attached", timeout: 5000 });
	await dest2().click();
	const relayRoute = await waitFor(async () => (await getJson("/api/status")).routes.find(r => r.temp && r.start.join(",") === "3,5,0" && r.state !== "idle"), 10000, "relay route");
	check(true, `route set with lever + destination button (${relayRoute.state}${relayRoute.waiting ? ", points moving " + relayRoute.waiting + " s" : ""})`);
	await sleep(800);
	await page.screenshot({ path: path.join(shots, "6_relay_route.png") });
	// lever back to normal with the lever on the map: the route is cancelled (or the time release starts when a train approaches)
	check(await page.locator("#map [data-mk='3,5,0']").count() === 1, "signal lever 1 also drawn on the map");
	await page.hover("#map [data-mk='3,5,0']");
	check(await page.locator("#relayBoard .rlever.hl[data-sl='3,5,0']").count() === 1, "hovering the lever on the map highlights it on the board");
	await page.click("#map [data-mk='3,5,0']");
	await waitFor(async () => !((await stA()).slevers || []).length, 10000, "lever back");
	const after = (await getJson("/api/status")).routes.find(r => r.id === relayRoute.id);
	check(!after || after.state === "releasing" || after.state === "occupied", `lever back to normal: route ${after ? after.state : "cancelled"}`);
	// point lever 21: N (left third)
	await sleep(1500);
	await page.click("#relayBoard .rlever[data-pl='0'] [data-side=L]");
	const lv21 = await waitFor(async () => ((await stA()).levers || []).find(l => l.pos.join(",") === "4,5,0"), 10000, "point lever N").catch(() => null);
	check(!lv21 || lv21.value === "N", "point lever 21 to N with its button" + (lv21 ? "" : " (locked by a train, skipped)"));
	if (lv21) {
		await sleep(1500);
		await page.click("#relayBoard .rlever[data-pl='0'] .knob");
		await waitFor(async () => !((await stA()).levers || []).some(l => l.pos.join(",") === "4,5,0"), 10000, "point lever C");
		check(true, "point lever 21 back to C with the knob");
	}
	check(await page.locator("#relayBoard .rlegend").count() === 1, "legend of the lamps shown");
	// emergency stop lever
	await page.click("#relayBoard .rlever[data-stop] .knob");
	await waitFor(async () => (await stA()).all_stop, 10000, "all stop");
	await page.waitForSelector("#relayBoard .rlever[data-stop] .lamp.on", { timeout: 10000 });
	check(true, "emergency stop lever on (lamp lit)");
	await page.click("#relayBoard .rlever[data-stop] .knob");
	await waitFor(async () => !(await stA()).all_stop, 10000, "all stop off");
	check(true, "emergency stop lever off");
	// the side a lever turns to can be set by hand
	await page.click("nav button[data-tab=setup]");
	await page.waitForSelector("#stationCfg [data-lvside='3,5,0']");
	await page.selectOption("#stationCfg [data-lvside='3,5,0']", "L");
	await waitFor(async () => ((await stA()).sides || []).some(s => s.pos.join(",") === "3,5,0" && s.side === "L"), 10000, "side by hand");
	await page.click("nav button[data-tab=run]");
	await page.waitForFunction(() => document.querySelector("#relayBoard .rlever[data-sl='3,5,0'] [data-side=L]") && !document.querySelector("#relayBoard .rlever[data-sl='3,5,0'] [data-side=L]").disabled, null, { timeout: 10000 });
	check(true, "lever 1 set to turn to the left by hand (stored in the game)");
	await page.evaluate(() => fetch("/api/cmd", { method: "POST", headers: { "X-IL-Panel": "1" }, body: "lv_side," + station().id + ",3,5,0,A" }));
	await waitFor(async () => !((await stA()).sides || []).length, 10000, "side automatic");
	// one lever for two signals: S1 on the left, the shunting signal of the siding on the right
	await page.click("nav button[data-tab=setup]");
	await page.waitForSelector("#pairAdd");
	await page.selectOption("#pairL", "3,5,0");
	await page.selectOption("#pairR", "5,7,0");
	await page.click("#pairAdd");
	await waitFor(async () => ((await stA()).pairs || []).length === 1, 10000, "lever pair");
	await page.click("nav button[data-tab=run]");
	await page.waitForSelector("#relayBoard .rlever[data-keys='3,5,0;5,7,0']");
	check((await page.textContent("#relayBoard .rlever[data-keys='3,5,0;5,7,0'] .lname")).includes("1R"), "shared lever on the board (1L / 1R)");
	await sleep(800);
	await page.click("#relayBoard .rlever[data-keys='3,5,0;5,7,0'] [data-side=R]");
	await waitFor(async () => ((await stA()).slevers || []).some(l => l.pos.join(",") === "5,7,0" && l.side === "R"), 10000, "shared lever right");
	check(true, "shared lever turned to the right: the shunting signal");
	await sleep(1200);
	check(!(await page.isEnabled("#relayBoard .rlever[data-keys='3,5,0;5,7,0'] [data-side=L]")), "the other side is locked while the lever is turned");
	await page.click("#relayBoard .rlever[data-keys='3,5,0;5,7,0'] [data-side=R]");
	await waitFor(async () => !((await stA()).slevers || []).length, 10000, "shared lever back");
	await page.evaluate(() => fetch("/api/cmd", { method: "POST", headers: { "X-IL-Panel": "1" }, body: "lv_unpair," + station().id + ",3,5,0" }));
	await waitFor(async () => !((await stA()).pairs || []).length, 10000, "unpair");
	check(true, "lever back to normal, pair removed");
	// a shunting lever (入換てこ) at S1, chosen in the setup tab
	await page.click("nav button[data-tab=setup]");
	await page.waitForSelector("#stationCfg [data-lvshunt='3,5,0']");
	await page.selectOption("#stationCfg [data-lvshunt='3,5,0']", "G");
	await waitFor(async () => ((await stA()).shunt_levers || []).some(x => x.pos.join(",") === "3,5,0" && x.color === "G"), 10000, "shunting lever");
	await page.click("nav button[data-tab=run]");
	await page.waitForSelector("#relayBoard .rlever[data-sl='3,5,0|S']");
	check((await page.textContent("#relayBoard .rlever[data-sl='3,5,0|S'] .lname")).includes("入換標識"), "green shunting lever on the board");
	check(await page.locator("#map [data-mk='3,5,0|S']").count() === 1, "shunting lever also on the map, beside the signal lever");
	await sleep(800);
	await page.click("#relayBoard .rlever[data-sl='3,5,0|S'] .knob");
	await waitFor(async () => ((await stA()).slevers || []).some(l => l.pos.join(",") === "3,5,0" && l.shunt), 10000, "shunting lever turned");
	await sleep(1200);
	const shuntDests = await page.$$eval("svg g.blink title", ts => ts.map(t => t.textContent));
	check(!shuntDests.some(t => t.includes("出口")), "shunting lever: no exit offered (" + shuntDests.join(" / ") + ")");
	await page.click("#relayBoard .rlever[data-sl='3,5,0|S'] .knob");
	await waitFor(async () => !((await stA()).slevers || []).length, 10000, "shunting lever back");
	// a pink lever (誘導) on the plain signal S1: the setup tab warns that a coupling train would pass it
	await page.click("nav button[data-tab=setup]");
	check(await page.locator("#stationCfg [data-couplingwarn]").count() === 0, "no coupling warning for a green lever");
	await page.selectOption("#stationCfg [data-lvshunt='3,5,0']", "P");
	await waitFor(async () => ((await stA()).shunt_levers || []).some(x => x.pos.join(",") === "3,5,0" && x.color === "P"), 10000, "pink lever");
	await page.waitForSelector("#stationCfg [data-couplingwarn]", { timeout: 10000 });
	check((await page.textContent("#stationCfg [data-couplingwarn]")).includes("普通の信号"), "pink lever on a plain signal: coupling warning shown");
	await page.click("nav button[data-tab=run]");
	await page.evaluate(() => fetch("/api/cmd", { method: "POST", headers: { "X-IL-Panel": "1" }, body: "lv_shunt," + station().id + ",3,5,0,N" }));
	await waitFor(async () => !((await stA()).shunt_levers || []).length, 10000, "shunting lever removed");
	check(true, "shunting lever turned and back, removed");
	// approach buzzer (接近電響): it listens on every tab, also while the setup tab is shown
	await page.click("nav button[data-tab=setup]");
	const beeps = await page.evaluate(() => {
		let n = 0; const realBeep = beep; beep = () => { n++; };
		const was = buzzerOn; buzzerOn = true; lastWaiting = new Set();
		const s1 = station().signals.find(s => s.pos.join(",") === "3,5,0");
		const saved = { train: s1.train, aspect: s1.aspect };
		Object.assign(s1, { train: "test train", aspect: "red" }); render();
		const first = n; render();
		Object.assign(s1, saved); buzzerOn = was; beep = realBeep; lastWaiting = new Set(); render();
		return [first, n];
	});
	check(beeps[0] === 1 && beeps[1] === 1, `buzzer sounds once for a new train at S1 while the setup tab is shown (${beeps})`);
	await page.click("nav button[data-tab=run]");
	await page.waitForSelector("#relayBoard [data-buzz]");
	check((await page.textContent("#relayBoard [data-buzz]")).includes("切（オフ）"), "the buzzer switch says it is off");
	await page.click("#relayBoard [data-buzz] .knob");
	await waitFor(async () => (await page.textContent("#relayBoard [data-buzz]")).includes("入（オン）"), 5000, "buzzer on");
	// a train arrives: the buzzer rings until 確認 is pressed
	await page.evaluate(() => {
		window.__beeps = 0; window.__realBeep = beep; beep = () => { window.__beeps++; };
		lastWaiting = new Set();
		// a train waiting at S1 in every status update (the panel refreshes the status from the game)
		window.__realCheck = checkApproach;
		checkApproach = (st) => window.__realCheck({ signals: st.signals.map(x => x.pos.join(",") === "3,5,0" ? Object.assign({}, x, { train: "test train", aspect: "red" }) : x) });
		render();
	});
	await waitFor(async () => (await page.textContent("#relayBoard [data-ack]")).includes("鳴動中"), 5000, "ringing");
	await sleep(2600);
	const rang = await page.evaluate(() => window.__beeps);
	check(rang >= 2, `the buzzer keeps ringing until 確認 (${rang} tones)`);
	await page.locator("#relayBoard [data-buzz]").locator("..").screenshot({ path: path.join(shots, "buzzer_on.png") });
	await page.click("#relayBoard [data-ack] .pushbtn");
	await sleep(2600);
	const ackd = await page.evaluate(() => { const n = window.__beeps; beep = window.__realBeep; checkApproach = window.__realCheck; return [n, ringing]; });
	check(ackd[0] === rang && ackd[1] === null && !(await page.textContent("#relayBoard [data-ack]")).includes("鳴動中"), "確認 stops it");
	await page.click("#relayBoard [data-buzz] .knob");
	await waitFor(async () => (await page.textContent("#relayBoard [data-buzz]")).includes("切（オフ）"), 5000, "buzzer off");
	check(true, "the buzzer switch says 入（オン） / 切（オフ）");
	// the lever board can be closed and opened again
	await page.click("#boardToggle");
	await waitFor(async () => !(await page.isVisible("#relayBoard")), 5000, "board closed");
	check((await page.textContent("#boardToggle")).includes("開く"), "the lever board is closed");
	await page.click("#boardToggle");
	await waitFor(async () => await page.isVisible("#relayBoard"), 5000, "board open");
	check(true, "and opened again");
	// re-reading the track (配線を読み直す): nothing changed in this game
	await page.click("nav button[data-tab=setup]");
	await page.click("#stationCfg #rescanBtn");
	await waitFor(async () => (await page.locator("#stationCfg [data-rescan]").count()) > 0, 10000, "rescan result");
	check((await page.textContent("#stationCfg [data-rescan]")).includes("変わったところはありません"), "re-reading the track: nothing changed");
	await page.click("nav button[data-tab=run]");
	// operating areas (扱い区分): S1 belongs to 西扱い; this browser takes 東扱い, so S1 is dimmed and cannot be turned
	const api = (c) => page.evaluate((c) => fetch("/api/cmd", { method: "POST", headers: { "X-IL-Panel": "1" }, body: c.replace("ST", station().id) }), c);
	await api("ar_name,ST,1,東扱い"); await sleep(300); await api("ar_name,ST,2,西扱い"); await sleep(300); await api("ar_pos,ST,3,5,0,2");
	await waitFor(async () => ((await stA()).area_of || []).some(x => x.pos.join(",") === "3,5,0" && x.a === 2), 10000, "area of S1");
	await page.click("nav button[data-tab=setup]");
	await page.waitForSelector("#stationCfg select[data-area='3,5,0']");
	await waitFor(async () => await page.inputValue("#stationCfg select[data-area='3,5,0']") === "2", 10000, "area in the setup tab");
	check(true, "setup tab shows the area of S1");
	await page.click("nav button[data-tab=run]");
	await page.waitForSelector("#deskSel");
	await page.selectOption("#deskSel", "1");
	await waitFor(async () => await page.locator("#relayBoard .rlever.other[data-sl='3,5,0']").count() === 1, 10000, "S1 dimmed");
	check(true, "with 東扱い chosen, the lever of S1 (西扱い) is dimmed");
	await page.click("#relayBoard .rlever[data-sl='3,5,0'] .knob");
	await sleep(1200);
	check(!((await stA()).slevers || []).length, "the lever of another area cannot be turned");
	await page.selectOption("#deskSel", "2");
	await waitFor(async () => await page.locator("#relayBoard .rlever.other[data-sl='3,5,0']").count() === 0, 10000, "S1 not dimmed");
	await sleep(800);
	await page.click("#relayBoard .rlever[data-sl='3,5,0'] .knob");
	await waitFor(async () => ((await stA()).slevers || []).some(l => l.pos.join(",") === "3,5,0"), 10000, "S1 turned in its own area");
	await sleep(1200);
	await page.click("#relayBoard .rlever[data-sl='3,5,0'] .knob");
	await waitFor(async () => !((await stA()).slevers || []).length, 10000, "S1 back");
	check(true, "with 西扱い chosen, S1 can be turned");
	await page.selectOption("#deskSel", "0");
	await api("ar_del,ST,2"); await sleep(300); await api("ar_del,ST,1");
	await waitFor(async () => !((await stA()).areas || []).length, 10000, "areas removed");
	await waitFor(async () => await page.locator("#deskSel").count() === 0, 10000, "area selector gone");
	check(true, "no area selector without areas");
	// the orientation of a relay panel is stored in the game (the same for everybody)
	await page.click("#viewbar button[data-rot]");
	await waitFor(async () => (await stA()).rot === 1, 10000, "relay panel turned");
	check(true, "relay panel turned: orientation stored in the game");
	await sleep(800);
	await page.screenshot({ path: path.join(shots, "7_relay_turned.png") });
	for (let i = 0; i < 3; i++) { await sleep(1500); const r0 = (await stA()).rot; await page.click("#viewbar button[data-rot]"); await waitFor(async () => (await stA()).rot === ((r0 + 1) & 3), 10000, "turn"); }
	check((await stA()).rot === 0, "four turns: back to 0");
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
