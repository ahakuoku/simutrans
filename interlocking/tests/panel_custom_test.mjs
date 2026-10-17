// Web panel: the custom panel of a station (カスタム盤) on the il-tandem scenario.
// The draft is made from the track plan, saved in the game, operated (electronic and relay), edited.
//
//   node interlocking/tests/panel_custom_test.mjs <sim binary> <workdir> <screenshot dir>
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch (e) { playwright = require(path.join(process.env.NODE_PATH || "/usr/local/lib/node_modules", "playwright")); }
let failed = false;
const check = (c, t) => { console.log((c ? "  OK   " : "  FAIL ") + t); if (!c) failed = true; };
const [sim, workdir, shots] = process.argv.slice(2);
const PORT = 13361, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cmd = (c) => fetch(BASE + "/api/cmd", { method: "POST", headers: { "X-IL-Panel": "1" }, body: c });
const st = async () => (await (await fetch(BASE + "/api/status")).json());
const panel = async (id) => (await (await fetch(BASE + "/api/panel?id=" + id)).json());
const waitFor = async (fn, ms, text) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(300); } throw new Error("timeout: " + text); };
const game = spawn(path.resolve(sim), ["-set_workdir", workdir, "-singleuser", "-objects", "pak64/", "-lang", "en", "-nosound", "-nomidi", "-fps", "25", "-scenario", "il-tandem"],
	{ cwd: workdir, env: { ...process.env, TID_IL_PORT: String(PORT), TID_IL_DEBUG: "1", TID_IL_PANEL_DIR: path.resolve("interlocking/panel") }, stdio: "ignore" });
try {
	for (let i = 0; i < 120; i++) { try { await fetch(BASE + "/api/info"); break; } catch (e) { await sleep(500); } }
	await sleep(4000);
	await cmd("st_new,T"); await sleep(600);
	const sid = (await st()).stations[0].id;
	for (const c of [`sig_add,${sid},3,5,0`, `dep_add,${sid},8,5,0`, `dep_add,${sid},12,9,0,S`, `st_mode,${sid},1`]) { await cmd(c); await sleep(500); }
	const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	page.on("dialog", d => d.accept());
	await page.goto(BASE + "/");
	await page.waitForSelector("#conndot.ok");
	const haltT = (await (await fetch(BASE + "/api/halts")).json()).halts.find(h => h.tiles.length === 6);
	await page.evaluate((id) => { setArea(station().id, Object.assign(boxAround(halts.find(h => h.id === id).tiles, 10), { halt: id })); }, haltT.id);
	await sleep(1500);

	console.log("[1] draft from the track plan");
	await page.click("#viewbar button[data-cp=edit]");
	await page.waitForSelector("#map [data-part]");
	const kinds = await page.evaluate(() => cpEdit.parts.reduce((m, p) => (m[p.t] = (m[p.t] || 0) + 1, m), {}));
	check(kinds.T > 0 && kinds.S >= 3 && kinds.D >= 3 && kinds.H >= 2 && kinds.P >= 1, "draft has tracks, start levers, destinations, platforms, points: " + JSON.stringify(kinds));
	const longest = await page.evaluate(() => Math.max(...cpEdit.parts.filter(p => p.t === "T").map(p => Math.abs(p.x2 - p.x1) + Math.abs(p.y2 - p.y1))));
	check(longest >= 6, `straight track is merged into long lines (longest ${longest} steps)`);
	await page.screenshot({ path: path.join(shots, "custom_draft.png") });

	console.log("[2] saved in the game");
	await page.click("#viewbar button[data-cp=apply]");
	await waitFor(async () => (await st()).stations[0].parts > 0, 10000, "parts saved");
	const saved = await panel(sid);
	check(saved.parts.length === Object.values(kinds).reduce((a, b) => a + b, 0), `all parts saved (${saved.parts.length})`);
	check(saved.parts.some(p => p.t === "H" && decodeURIComponent(p.s).length > 0), "platform names kept");
	await waitFor(async () => (await page.locator("#viewbar button[data-cp=custom].on").count()) === 1, 5000, "custom view");
	check(true, "the custom panel is shown");

	console.log("[3] operation (electronic): S1 -> platform 1");
	await page.click("#map [data-part]:has(text:text-is('S1'))");
	await sleep(800);
	const lit = await page.locator("#map g.blink").count();
	check(lit >= 1, `destinations lit after choosing S1 (${lit})`);
	await page.screenshot({ path: path.join(shots, "custom_run.png") });
	const pf = await page.evaluate(() => platformName(station(), 0));
	await page.click(`#map g.blink:has(text:text-is('${pf}'))`);
	await waitFor(async () => (await st()).routes.some(r => r.temp && r.state === "set"), 10000, "route set");
	const r1 = (await st()).routes.find(r => r.temp && r.state === "set");
	check(r1 && r1.start.join(",") === "3,5,0", "route set from the custom panel: " + (r1 && r1.name));
	await cmd(`cancel,${r1.id}`); await sleep(800);

	console.log("[4] edit: move a part, add a text, apply");
	await page.click("#viewbar button[data-cp=edit]");
	await page.waitForSelector("#map .cpart");
	const before = await page.evaluate(() => { const i = cpEdit.parts.findIndex(p => p.t === "S"); cpEdit.sel = i; render(); return [i, cpEdit.parts[i].x1, cpEdit.parts[i].y1]; });
	await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowDown");
	// drag the end of a track line with the mouse: two steps down (e.g. to draw it slanting)
	const ti = await page.evaluate(() => { const i = cpEdit.parts.findIndex(p => p.t === "T" && p.y1 === p.y2 && p.x2 > p.x1 + 3); cpEdit.sel = i; render(); return [i, cpEdit.parts[i].x2, cpEdit.parts[i].y2, CELL / 2]; });
	const hb = await page.locator("#map .cphandle[data-h='2']").boundingBox();
	await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
	await page.mouse.down();
	await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + ti[3], { steps: 3 });
	await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 2 * ti[3], { steps: 3 });
	await page.mouse.up();
	const dragged = await page.evaluate((i) => [cpEdit.parts[i].x2, cpEdit.parts[i].y2], ti[0]);
	check(dragged[0] === ti[1] && dragged[1] === ti[2] + 2, `the end of a track line follows the mouse on the grid (${ti[1]},${ti[2]} -> ${dragged})`);
	await page.evaluate(() => { cpEdit.tool = "text"; });
	page.removeAllListeners("dialog");
	page.once("dialog", d => d.accept("上り本線"));
	const box = await page.locator("#map").boundingBox();
	await page.mouse.click(box.x + 40, box.y + box.height - 30);
	await sleep(300);
	page.on("dialog", d => d.accept());
	await page.click("#viewbar button[data-cp=apply]");
	await waitFor(async () => (await panel(sid)).parts.some(p => p.t === "L"), 10000, "text saved");
	const after = (await panel(sid)).parts;
	check(after[before[0]].x1 === before[1] + 2 && after[before[0]].y1 === before[2] + 1, "the moved lever is saved at its new place");
	check(after.some(p => p.t === "L" && decodeURIComponent(p.s) === "上り本線"), "the text is saved");
	await page.screenshot({ path: path.join(shots, "custom_edited.png") });

	console.log("[5] relay: levers on the custom panel");
	await cmd(`st_cfg,${sid},1,0,5,3,2`); await sleep(1200);
	await page.waitForSelector("#map [data-part] .knob, #map [data-part] g[transform]");
	await page.click("#map [data-part]:has(text:text-is('S1'))");
	await waitFor(async () => ((await st()).stations[0].slevers || []).some(l => l.pos.join(",") === "3,5,0"), 10000, "lever turned");
	check(true, "the lever of S1 turned from the custom panel");
	await page.screenshot({ path: path.join(shots, "custom_relay.png") });

	console.log("[6] decorations and the colour of the panel");
	await cmd(`st_cfg,${sid},0,0,5,3,2`); await sleep(1200);
	await page.click("#viewbar button[data-cp=edit]");
	await page.waitForSelector("#map .cpart");
	const place = async (t, answer, dx, dy) => {
		await page.click(`#viewbar button[data-cp=add][data-t=${t}]`);
		if (answer !== null) { page.removeAllListeners("dialog"); page.once("dialog", d => d.accept(answer)); }
		const b = await page.locator("#map").boundingBox();
		await page.mouse.click(b.x + dx, b.y + b.height - dy);
		await sleep(300);
		page.removeAllListeners("dialog"); page.on("dialog", d => d.accept());
	};
	await place("A", "至 東京", 120, 120);
	await place("F", "東扱い", 300, 200);
	await page.click("#viewbar button[data-cp=add][data-t=C]"); await sleep(200);
	await page.click("#viewbar button[data-cp=add][data-t=K]"); await sleep(200);
	await page.selectOption("#viewbar select[data-cp=color]", "1");
	await sleep(300);
	await page.screenshot({ path: path.join(shots, "custom_decor_edit.png") });
	await page.click("#viewbar button[data-cp=apply]");
	await waitFor(async () => (await panel(sid)).parts.some(p => p.t === "A"), 10000, "decorations saved");
	const dp = (await panel(sid)).parts;
	check(["A", "F", "C", "K"].every(t => dp.some(p => p.t === t)), "arrow, frame, clock and compass saved");
	check(dp.some(p => p.t === "A" && decodeURIComponent(p.s) === "至 東京") && dp.some(p => p.t === "F" && decodeURIComponent(p.s) === "東扱い"), "their texts saved");
	check(dp.some(p => p.t === "Y" && (p.f >> 4) === 1), "the colour of the panel saved (緑盤)");

	console.log("[7] magnets and memos on the custom panel");
	await page.click("#markBar [data-mtool=X]");
	await page.click("#map circle.marktarget:has(title:text('(5, 5, 0)'))");
	await waitFor(async () => ((await st()).stations[0].marks || []).some(m => m.k === "X"), 10000, "magnet");
	check(true, "使用停止 put on the track at (5,5)");
	await page.click("#markBar [data-mtool=M]");
	await page.click("#markBar [data-mword='保守']");
	await page.click("#map circle.marktarget:has(title:text('(6, 5, 0)'))");
	await page.click("#markBar [data-mtool=O]");
	page.removeAllListeners("dialog"); page.once("dialog", d => d.accept("点検中です"));
	await page.click("#map circle.marktarget:has(title:text('(7, 5, 0)'))");
	await waitFor(async () => ((await st()).stations[0].marks || []).length === 3, 10000, "three marks");
	page.removeAllListeners("dialog"); page.on("dialog", d => d.accept());
	const ms = (await st()).stations[0].marks;
	check(ms.some(m => m.k === "M" && decodeURIComponent(m.s) === "保守") && ms.some(m => m.k === "O" && decodeURIComponent(m.s) === "点検中です"), "tag 保守 and a memo put with one click each");
	await page.click("#markBar [data-mtool=O]");   // tool off
	await page.waitForSelector("#map [data-mark]");
	await page.click(`#map [data-mark='${ms.find(m => m.k === "O").id}']`);
	await sleep(500);
	await page.screenshot({ path: path.join(shots, "custom_marks.png") });
	// the magnet blocks the route S1 -> platform 1
	await page.click("#map [data-part]:has(text:text-is('S1'))");
	await sleep(600);
	const pf1 = await page.evaluate(() => platformName(station(), 0));
	const blocked = await page.locator(`#map g.blink:has(text:text-is('${pf1}'))`).count();
	if (blocked) await page.click(`#map g.blink:has(text:text-is('${pf1}'))`);
	else await page.evaluate(() => destinationClicked("p0"));
	await sleep(1500);
	check(!(await st()).routes.some(r => r.temp && r.state !== "idle"), "no route over the magnet 使用停止");
	await page.click("#markBar [data-mtool=del]");
	await page.click(`#map [data-mark='${ms.find(m => m.k === "X").id}']`);
	await waitFor(async () => !((await st()).stations[0].marks || []).some(m => m.k === "X"), 10000, "magnet removed");
	check(true, "the magnet is removed with はがす");
	await page.click("#markBar [data-mtool=del]");

	console.log("[6] back to the track plan, and no custom panel any more");
	await page.click("#viewbar button[data-cp=auto]");
	await waitFor(async () => (await page.locator("#map [data-part]").count()) === 0, 5000, "track plan");
	check(true, "the track plan is shown again (this browser)");
	await sleep(800);
	const nm = await page.locator("#map [data-mark]").count();
	check(nm === 2, `the tag and the memo are on the track plan, too (${nm})`);
	await page.screenshot({ path: path.join(shots, "plan_marks.png") });
	await browser.close();
} finally { game.kill(); }
console.log(failed ? "TEST FAILED" : "ALL CUSTOM PANEL TESTS PASSED");
if (failed) process.exitCode = 1;
