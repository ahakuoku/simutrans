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
	await sleep(1500);
	const clock = await page.$$eval("#map text", ts => ts.map(t => t.textContent).filter(t => /^\d\d:\d\d:\d\d$|^\d+\/1440$/.test(t)));
	const s0 = await st();
	check(clock.length === 2 && s0.tpm > 0, `the clock shows HH:MM:SS and the minute of the day out of 1440: ${clock.join("  ")}`);
	const [h, m] = clock[0].split(":").map(Number), n = Number(clock[1].split("/")[0]);
	check(n === h * 60 + m, "both tell the same time");
	await page.locator("#map").screenshot({ path: path.join(shots, "custom_clock.png"), clip: undefined });

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

	console.log("[8] rebinding (付け直し), a new track line, export and import");
	await page.click("#viewbar button[data-cp=edit]");
	await page.waitForSelector("#map .cpart");
	// as if the track was rebuilt: the lever of S1 stands for a tile without a signal
	await page.evaluate(() => { const p = cpEdit.parts.find(p => p.t === "S" && !p.f && p.b[0].join(",") === "3,5,0"); p.b = [[0, 0, 0]]; render(); });
	await waitFor(async () => (await page.textContent("#viewbar button[data-cp=nextbad]")).includes("1"), 5000, "one part does not match");
	check(true, "the part that no longer matches is counted (合わない部品 1)");
	await page.click("#viewbar button[data-cp=nextbad]");
	await page.click("#viewbar button[data-cp=pick]");
	await page.waitForSelector("#map circle.picktarget[data-pick='3,5,0']");
	const nTargets = await page.locator("#map circle.picktarget").count();
	check(nTargets >= 2 && nTargets <= 4, `while rebinding a lever only start points can be chosen (${nTargets})`);
	await page.screenshot({ path: path.join(shots, "custom_rebind.png") });
	await page.click("#map circle.picktarget[data-pick='3,5,0']");
	await waitFor(async () => (await page.textContent("#viewbar button[data-cp=nextbad]")).includes("0"), 5000, "matches again");
	check(await page.evaluate(() => cpEdit.parts[cpEdit.sel].b[0].join(",") === "3,5,0" && !cpEdit.pick), "the lever stands for S1 again, back on the custom panel");
	// ＋線路: drag a line from one point to another; it is bound to the track between them
	const scr = async (x, y) => page.evaluate(([x, y]) => { const r = document.getElementById("map").getBoundingClientRect(); return [r.left + 20 + x * CELL / 2, r.top + 20 + y * CELL / 2]; }, [x, y]);
	const pts = await page.evaluate(() => cpEdit.parts.filter(p => p.t === "P").map(p => ({ x: p.x1, y: p.y1, t: p.b[0].join(",") })));
	const pa = pts.find(p => p.t === "9,5,0"), pb = pts.find(p => p.t === "9,6,0");
	await page.click("#viewbar button[data-cp=add][data-t=T]");
	const [sx, sy] = await scr(pa.x, pa.y), [ex, ey] = await scr(pb.x + 2, pb.y);
	await page.mouse.move(sx, sy); await page.mouse.down();
	await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 3 }); await page.mouse.move(ex, ey, { steps: 3 });
	await page.mouse.up();
	await page.keyboard.press("Escape");
	const nl = await page.evaluate(() => cpEdit.parts[cpEdit.sel]);
	check(nl.t === "T" && nl.x1 === pa.x && nl.y1 === pa.y && nl.x2 === pb.x + 2 && nl.y2 === pb.y, `a slanting line drawn by dragging (${nl.x1},${nl.y1})-(${nl.x2},${nl.y2})`);
	check(nl.b.map(x => x.join(",")).includes("9,5,0") && nl.b.length >= 2, "it is bound to the track between its ends: " + nl.b.map(x => x.join(",")).join(" "));
	// an L of two lines (a bend, no point there): dragging the corner moves both ends
	const L = await page.evaluate(() => {
		for (let i = 0; i < cpEdit.parts.length; i++) {
			const p = cpEdit.parts[i];
			if (p.t !== "T") continue;
			for (const w of [1, 2]) { const j = joinedEnds(cpEdit.parts, i, w); if (j.length) return { i, w, j: j[0], at: w === 1 ? [p.x1, p.y1] : [p.x2, p.y2] }; }
		}
		return null;
	});
	check(!!L, "the draft has a bend made of two lines");
	await page.evaluate((i) => { cpEdit.sel = i; render(); }, L.i);
	const [hx, hy] = await scr(L.at[0], L.at[1]), [tx, ty] = await scr(L.at[0] + 2, L.at[1] + 1);
	await page.mouse.move(hx, hy); await page.mouse.down(); await page.mouse.move(tx, ty, { steps: 5 }); await page.mouse.up();
	const moved = await page.evaluate((L) => { const p = cpEdit.parts[L.i], q = cpEdit.parts[L.j.index]; return [L.w === 1 ? [p.x1, p.y1] : [p.x2, p.y2], L.j.which === 1 ? [q.x1, q.y1] : [q.x2, q.y2]]; }, L);
	check(moved[0].join(",") === `${L.at[0] + 2},${L.at[1] + 1}` && moved[1].join(",") === moved[0].join(","), `the corner is dragged and both lines follow (${L.at} -> ${moved[0]})`);
	await page.locator("#map").screenshot({ path: path.join(shots, "custom_slant.png") });
	// pressing a selected part again selects the part under it
	const stacked = await page.evaluate(() => { const i = cpEdit.parts.findIndex(p => p.t === "P"); cpEdit.sel = i; render(); return i; });
	const sp = await page.evaluate((i) => [cpEdit.parts[i].x1, cpEdit.parts[i].y1], stacked);
	const [px, py] = await scr(sp[0], sp[1]);
	const seen = [];
	for (let k = 0; k < 4; k++) {
		await page.mouse.click(px, py);
		seen.push(await page.evaluate(() => cpEdit.parts[cpEdit.sel].t));
		if (seen[seen.length - 1] === "T") break;
	}
	check(seen[0] !== "P" && seen.includes("T"), `pressing the selected point again selects the parts under it in turn (${seen.join(" → ")})`);
	// export, then import the file back
	const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#viewbar button[data-cp=export]")]);
	const file = path.join(shots, "exported-panel.json");
	await dl.saveAs(file);
	const exported = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
	const nParts = await page.evaluate(() => cpEdit.parts.length);
	check(exported.format === "tid-custom-panel" && exported.parts.length === nParts, `exported to a file (${exported.parts.length} parts)`);
	exported.parts = exported.parts.filter(p => p.t !== "L");
	require("node:fs").writeFileSync(file, JSON.stringify(exported));
	const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click("#viewbar button[data-cp=import]")]);
	await fc.setFiles(file);
	await waitFor(async () => (await page.evaluate(() => cpEdit.parts.length)) === exported.parts.length, 5000, "imported");
	check(await page.evaluate(() => !cpEdit.parts.some(p => p.t === "L")), "the file is read back into the editor");
	await page.click("#viewbar button[data-cp=apply]");
	await waitFor(async () => (await panel(sid)).parts.length === exported.parts.length, 10000, "saved");
	check(true, "and saved");

	console.log("[9] north after turning the map, undo, somebody else editing");
	await page.evaluate(() => { info.rot = 1; render(); });
	check((await page.getAttribute("#viewbar .compass", "title")).includes("北が右"), "the map turned once in the game: north is on the right");
	await page.evaluate(() => { info.rot = 0; render(); });
	await page.click("#viewbar button[data-cp=edit]");
	await page.waitForSelector("#map .cpart");
	await waitFor(async () => (await st()).stations[0].editing !== undefined, 5000, "editing shown");
	check(true, "the game knows that somebody edits the custom panel");
	const u0 = await page.evaluate(() => { const i = cpEdit.parts.findIndex(p => p.t === "D"); cpEdit.sel = i; render(); return [i, cpEdit.parts[i].x1]; });
	await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
	await page.click("#viewbar button[data-cp=undo]");
	check(await page.evaluate((i) => cpEdit.parts[i].x1, u0[0]) === u0[1] + 1, "↶ undoes one step");
	await page.keyboard.press("Control+z");
	check(await page.evaluate((i) => cpEdit.parts[i].x1, u0[0]) === u0[1], "Ctrl+Z undoes the next step");
	await page.keyboard.press("Control+y");
	check(await page.evaluate((i) => cpEdit.parts[i].x1, u0[0]) === u0[1] + 1, "Ctrl+Y redoes it");
	// a second browser: sees who edits, asked before it starts, and warned before it overwrites
	const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	const asked = [];
	page2.on("dialog", d => { asked.push(d.message()); d.accept(); });
	await page2.goto(BASE + "/");
	await page2.waitForSelector("#conndot.ok");
	await page2.evaluate((id) => { setArea(station().id, Object.assign(boxAround(halts.find(h => h.id === id).tiles, 10), { halt: id })); }, haltT.id);
	await waitFor(async () => (await page2.textContent("#viewbar")).includes("編集中"), 8000, "editing shown to the other");
	check(true, "the other browser shows that the panel is being edited");
	await page2.click("#viewbar button[data-cp=edit]");
	await page2.waitForSelector("#map .cpart");
	check(asked.some(m => m.includes("編集中")), "and asks before it starts editing too");
	await page.click("#viewbar button[data-cp=apply]");
	await waitFor(async () => (await st()).stations[0].editing === undefined, 8000, "first applied");
	await sleep(1500);
	await page2.click("#viewbar button[data-cp=apply]");
	await sleep(1500);
	check(asked.some(m => m.includes("ほかの人がカスタム盤を保存")), "the second is warned before it replaces the panel saved meanwhile");
	await page2.close();

	console.log("[10] another computer (its own browser storage) shows the same area");
	const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const other = await ctx2.newPage();
	other.on("dialog", d => d.accept());
	await other.goto(BASE + "/");
	await other.waitForSelector("#conndot.ok");
	await sleep(1500);
	const areas = await Promise.all([page, other].map(pg => pg.evaluate(() => JSON.stringify(currentArea()))));
	check(areas[0] === areas[1] && (await st()).stations[0].view, `the same area as the browser that made the station: ${areas[1]}`);
	await ctx2.close();

	console.log("[11] stop search, one panel per stop, both ends of a platform, switching the kind");
	await page.click("nav button[data-tab=setup]");
	await page.fill("#haltSearch", "ＳＴＯＰ 2");
	await sleep(500);
	const shown = await page.$$eval("#haltSel option", os => os.map(o => o.textContent));
	check(shown.length >= 1 && shown.every(t => t.includes("stop 2")), `the search keeps the stops whose name matches (full width capitals, too): ${shown.join(" / ")}`);
	await page.fill("#haltSearch", "");
	await sleep(400);
	check(await page.locator(`#haltSel option[value='${haltT.id}'][disabled]`).count() === 1, "the stop that has a panel is marked and cannot be chosen");
	const nst = (await st()).stations.length;
	await page.evaluate((id) => { const sel = document.getElementById("haltSel"); const o = sel.querySelector(`option[value='${id}']`); o.disabled = false; sel.value = String(id); }, haltT.id);
	await page.click("#btnNewStation");
	await sleep(1500);
	check((await st()).stations.length === nst, "no second panel for the same stop");
	await cmd(`dep_add,${sid},6,5,0`); await sleep(1200);
	const names = await page.evaluate(() => [signalLabel(station(), [6, 5, 0]), signalLabel(station(), [8, 5, 0])]);
	check(names[0] !== names[1] && /（[東西南北]）$/.test(names[0]) && /（[東西南北]）$/.test(names[1]), `the two ends of a platform have the side in their names: ${names.join(" / ")}`);
	await cmd(`dep_del,${sid},6,5,0`); await sleep(800);
	await page.click("#stationCfg button[data-kind='1']");
	await waitFor(async () => (await page.locator("#stationCfg #cfgTa").count()) === 1, 8000, "relay settings shown");
	await page.click("#stationCfg button[data-kind='0']");
	await waitFor(async () => (await page.locator("#stationCfg #cfgTa").count()) === 0, 8000, "relay settings gone at once");
	check(true, "switching relay / electronic shows the settings of the new kind at once");
	await page.click("nav button[data-tab=run]");

	console.log("[6] back to the track plan, and no custom panel any more");
	await page.click("#viewbar button[data-cp=auto]");
	await waitFor(async () => (await page.locator("#map [data-part]").count()) === 0, 5000, "track plan");
	check(true, "the track plan is shown again (this browser)");
	await sleep(800);
	const nm = await page.locator("#map [data-mark]").count();
	check(nm === 2, `the tag and the memo are on the track plan, too (${nm})`);
	await page.screenshot({ path: path.join(shots, "plan_marks.png") });
	// drag the tag 保守 from (6,5) to (8,5) with the mouse
	const tagId = (await st()).stations[0].marks.find(m => m.k === "M").id;
	const center = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
	const tileAt = (x, y) => page.locator(`#map rect:has(title:has-text("(${x}, ${y}, 0)"))`).first();
	const [mx, my] = await center(page.locator(`#map [data-mark='${tagId}'] rect`).first());
	const [ax, ay] = await center(tileAt(6, 5)), [bx, by] = await center(tileAt(8, 5));
	await page.mouse.move(mx, my); await page.mouse.down();
	await page.mouse.move(mx + (bx - ax) / 2, my + (by - ay) / 2, { steps: 4 });
	await page.mouse.move(mx + bx - ax, my + by - ay, { steps: 4 });
	await page.mouse.up();
	await waitFor(async () => (await st()).stations[0].marks.find(m => m.id === tagId).pos.join(",") === "8,5,0", 8000, "tag moved");
	check(true, "the tag is dragged to (8,5) with the mouse");
	await browser.close();
} finally { game.kill(); }
console.log(failed ? "TEST FAILED" : "ALL CUSTOM PANEL TESTS PASSED");
if (failed) process.exitCode = 1;
