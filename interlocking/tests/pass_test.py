#!/usr/bin/env python3
"""
Passing trains and virtual departure signals (scenario il-tandem).

A train to the terminus B (14,5) passes platform 1 of station A (6..8,5) without stopping.
Platform 1 has a virtual departure signal at its east end (8,5). The train needs the home
route (S1 -> platform 1) AND the departure route (platform 1 -> B); with the home route only
it waits at S1, it must not run through the platform.

Usage: pass_test.py --sim build/default/sim --workdir <dir>   (workdir as for run_test.py, il-tandem linked)
"""
import argparse, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_test import Panel, check, start_game, wait_until, simple_tool_id, PORT


def run(args):
    game = start_game(args, ["-scenario", "il-tandem"])
    try:
        p = Panel(PORT)
        wait_until(lambda: any(s["pos"] == [3, 5, 0] for s in p.request("signals 0 0 15 15")["signals"]), 60, "layout")
        cid = p.request("debug_convoys")["convoys"][0]["id"]
        conv = lambda: next(c for c in p.request("debug_convoys")["convoys"] if c["id"] == cid)
        check(p.cmd("st_new,A")["ok"], "station")
        sid = p.status()["stations"][0]["id"]
        check(p.cmd(f"sig_add,{sid},3,5,0")["ok"] and p.cmd(f"dep_add,{sid},8,5,0")["ok"], "S1 and the virtual departure signal of platform 1 (east end)")
        check(p.cmd(f"st_mode,{sid},1")["ok"], "operator mode")
        home = ";".join(f"{x}:5:0" for x in range(3, 9))
        dep = ";".join(f"{x}:5:0" for x in range(8, 14))
        # the train only stops at B: it passes platform 1
        # on a line named after the type of train (快速): the approach indication shows it
        sched = "0|0|0|2|0|14,5,0,0,0,0,0,0,0,0,0,100,0,0|1,5,0,0,0,0,0,0,0,0,0,100,0,0|"
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_LINE')} c,0,2,0,{sched}")
        time.sleep(1)
        p.request(f"debug_tool {simple_tool_id('TOOL_RENAME')} l1,快速")
        time.sleep(1)
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_CONVOI')} l,{cid},1")
        time.sleep(1)
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_DEPOT')} b,1,5,0,{cid}")
        wait_until(lambda: tuple(conv()["pos"]) == (3, 5, 0), 60, "train at S1")

        print("[1] home route only: the passing train waits at S1")
        check(p.cmd(f"set_path,{sid},{home},home")["ok"], "home route S1 -> platform 1")
        time.sleep(6)
        check(tuple(conv()["pos"]) == (3, 5, 0), f"train still waits at S1 ({conv()['pos']})")
        s1 = p.status()["stations"][0]["signals"][0]
        check(s1.get("line") == "快速" and s1.get("dest") and s1.get("train"), f"approach indication: line and next stop of the train ({s1})")
        hr = [r for r in p.status()["routes"] if r["name"] == "home"][0]
        check(hr["state"] == "set", "home route still set, not entered")

        print("[2] departure route set as well: the train runs through")
        check(p.cmd(f"set_path,{sid},{dep},departure")["ok"], "departure route platform 1 -> (13,5) (it starts where the home route ends)")
        p.wait_event(lambda e: e["type"] == "route" and e["state"] == "occupied", 60)
        st = {r["name"]: r["state"] for r in p.status()["routes"]}
        check(st.get("home") == "occupied" and st.get("departure") == "occupied", f"both routes entered: {st}")
        seen = []
        def at_b():
            c = conv()
            seen.append((tuple(c["pos"]), c["state"]))
            return c["pos"][0] >= 13
        wait_until(at_b, 120, "train at B")
        stopped_on_1 = any(pos[0] in (6, 7, 8) and pos[1] == 5 and state == 7 for pos, state in seen)
        check(not stopped_on_1, "the train did not stop at platform 1")
        wait_until(lambda: not [r for r in p.status()["routes"] if r.get("temp")], 120, "routes released")
        check(True, "both routes released after the train has passed")
    finally:
        game.terminate()
        try:
            game.wait(10)
        except Exception:
            game.kill()
    print("PASS TEST DONE")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", required=True)
    ap.add_argument("--workdir", required=True)
    try:
        run(ap.parse_args())
    except AssertionError as e:
        print("TEST FAILED:", e)
        sys.exit(1)
