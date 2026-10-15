// Web panel: the destination "up to a standing train" (手前) on the il-tandem scenario.
// Train A is sent into the siding stop (12,6)-(12,9) first; the departure of platform 1 (8,5) gets a
// green shunting lever. Only the shunting lever offers 手前, the departure signal itself does not.
//
//   node interlocking/tests/panel_tandem_test.mjs <sim binary> <workdir> <screenshot dir>
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); }
catch (e) { playwright = require(path.join(process.env.NODE_PATH || "/usr/local/lib/node_modules", "playwright")); }
let failed = false;
const check = (c, t) => { console.log((c ? "  OK   " : "  FAIL ") + t); if (!c) failed = true; };
const [sim, workdir, shots] = process.argv.slice(2);
const PORT = 13360, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cmd = (c) => fetch(BASE + "/api/cmd", { method: "POST", headers: { "X-IL-Panel": "1" }, body: c });
const st = async () => (await (await fetch(BASE + "/api/status")).json());
const game = spawn(path.resolve(sim), ["-set_workdir", workdir, "-singleuser", "-objects", "pak64/", "-lang", "en", "-nosound", "-nomidi", "-fps", "25", "-scenario", "il-tandem"],
	{ cwd: workdir, env: { ...process.env, TID_IL_PORT: String(PORT), TID_IL_DEBUG: "1", TID_IL_PANEL_DIR: path.resolve("interlocking/panel") }, stdio: "ignore" });
try {
	for (let i = 0; i < 120; i++) { try { await fetch(BASE + "/api/info"); break; } catch (e) { await sleep(500); } }
	await sleep(3000);
	// train A into the siding by the experiment script's steps (line protocol through python)
	execFileSync("python3", ["-c", `
import sys, time; sys.path.insert(0, "interlocking/tests")
from run_test import Panel, simple_tool_id
p = Panel(13360)
cid = p.request("debug_convoys")["convoys"][0]["id"]
p.cmd("st_new,T"); sid = p.status()["stations"][0]["id"]
p.cmd(f"sig_add,{sid},3,5,0"); p.cmd(f"dep_add,{sid},12,9,0,S"); p.cmd(f"dep_add,{sid},8,5,0"); p.cmd(f"lv_shunt,{sid},8,5,0,G"); p.cmd(f"st_mode,{sid},1")
p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_LINE')} c,0,2,0,0|0|0|2|0|12,9,0,0,0,0,0,0,0,0,0,100,0,0|14,5,0,0,0,0,0,0,0,0,0,100,0,0|")
time.sleep(1)
p.request(f"debug_tool {simple_tool_id('TOOL_RENAME')} l1,【テスト】[本線][快速] 東～西")
time.sleep(1)
p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_CONVOI')} l,{cid},1")
time.sleep(1)
p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_DEPOT')} b,1,5,0,{cid}")
while tuple(p.request("debug_convoys")["convoys"][0]["pos"]) != (3,5,0): time.sleep(0.5)
path = ";".join(f"{x}:5:0" for x in range(3,13)) + ";12:6:0;12:7:0;12:8:0;12:9:0"
p.cmd(f"set_path,{sid},{path},A")
while p.request("debug_convoys")["convoys"][0]["stop"] != 1: time.sleep(0.5)
`], { stdio: "inherit" });
	const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.goto(BASE + "/");
	await page.waitForSelector("#conndot.ok");
	await page.click("nav button[data-tab=setup]");
	const haltT = (await (await fetch(BASE + "/api/halts")).json()).halts.find(h => h.tiles.length === 6);
	await page.evaluate((id) => { setArea(station().id, Object.assign(boxAround(halts.find(h => h.id === id).tiles, 10), { halt: id })); }, haltT.id);
	await sleep(1500);
	await page.waitForSelector("#sidingList [data-sidhalt]");
	const sidHalt = (await (await fetch(BASE + "/api/halts")).json()).halts.find(h => h.tiles.some(t => t.join(",") === "12,8,0" || t.join(",") === "12,8"));
	await page.check(`#sidingList [data-sidhalt='${sidHalt.id}']`);
	await sleep(2000);
	await page.click("nav button[data-tab=run]");
	await sleep(1500);
	// approach indication: the train waiting in the siding stop, with its line (列車種別) and next stop
	for (let i = 0; i < 60 && !(await page.textContent("#approach")).includes("快速"); i++) await sleep(500);
	const ap = await page.textContent("#approach");
	check(ap.includes("次 ") && !ap.includes("テスト"), "approach indication shows the line and the next stop, without the company: " + ap.trim());
	check((await page.textContent("#approach .linename")).trim() === "快速" && ap.includes("[本線] 東～西"), "the last [...] of the line name is the badge (type of train)");
	await page.locator("#approach").screenshot({ path: path.join(shots, "approach_line.png") });
	// electronic panel: S1 -> destination buttons
	// the departure signal of platform 1 itself: no 手前
	await page.evaluate(() => { nxStart = { pos: [8, 5, 0], dep: true }; render(); });
	await sleep(800);
	let titles = await page.$$eval("svg g.blink title", ts => ts.map(t => t.textContent));
	check(!titles.some(t => t.includes("手前")), "departure signal: no destination up to the standing train");
	// its green shunting lever (the small green button behind it)
	await page.evaluate(() => { nxStart = null; render(); });
	await page.click("svg g[data-shuntstart='8,5,0']");
	await sleep(800);
	titles = await page.$$eval("svg g.blink title", ts => ts.map(t => t.textContent));
	console.log("    lit destinations:", titles.join(" / "));
	await page.screenshot({ path: path.join(shots, "tandem_temae.png") });
	check(titles.some(t => t.includes("手前")) && !titles.some(t => t.includes("出口")), "green shunting lever: 手前 offered, no exits");
	await page.click("svg g.blink:has(title:has-text('手前'))");
	await sleep(1500);
	const r = (await st()).routes.find(r => r.temp && r.state !== "idle");
	check(r && r.shunt && r.end.join(",") === "12,8,0", "shunting route up to the standing train set: " + (r ? r.name + " -> " + r.end : "none"));
	await browser.close();
} finally { game.kill(); }
console.log(failed ? "TEST FAILED" : "ALL TANDEM PANEL TESTS PASSED");
if (failed) process.exitCode = 1;
