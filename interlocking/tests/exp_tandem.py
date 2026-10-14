#!/usr/bin/env python3
"""
Experiment: two trains one behind the other in a siding built as a stop (no change in the OTRP core).

Scenario il-tandem: like il-test, but the siding stop is (12,6)-(12,9) (dead end at (12,9)) and there
are two trains in the depot. Both trains have the schedule [siding (12,9), terminus B (14,5)].

  1. train A: route S1 -> far end of the siding (12,9)
  2. train B: route S1 -> the tile in front of the part where A stands ("手前" destination)
  3. B must arrive and be served behind A; both are held by the virtual shunting signal of the siding
  4. B leaves first (it stands nearer to the exit), then A

Usage: exp_tandem.py --sim build/default/sim --workdir <dir>   (workdir as for run_test.py, with il-tandem linked)
"""
import argparse, json, os, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_test import Panel, check, start_game, wait_until, simple_tool_id, PORT


def run(args):
    game = start_game(args, ["-scenario", "il-tandem"])
    try:
        p = Panel(PORT)
        wait_until(lambda: any(s["pos"] == [3, 5, 0] for s in p.request("signals 0 0 15 15")["signals"]), 60, "layout")
        convoys = p.request("debug_convoys")["convoys"]
        check(len(convoys) == 2, f"two trains in the depot: {[c['id'] for c in convoys]}")
        ca, cb = convoys[0]["id"], convoys[1]["id"]
        check(p.cmd("st_new,T")["ok"], "station")
        sid = p.status()["stations"][0]["id"]
        check(p.cmd(f"sig_add,{sid},3,5,0")["ok"] and p.cmd(f"dep_add,{sid},12,9,0,S")["ok"], "S1 and the shunting signal of the siding stop")
        dep = p.status()["stations"][0]["departures"][0]
        check(dep["pos"] == [12, 6, 0], f"siding stop: leaves at {dep['pos']}, tiles {dep['tiles']}")
        check(p.cmd(f"st_mode,{sid},1")["ok"], "operator mode")
        sched = "0|0|0|2|0|12,9,0,0,0,0,0,0,0,0,0,100,0,0|14,5,0,0,0,0,0,0,0,0,0,100,0,0|"
        main = [(x, 5, 0) for x in range(3, 13)]
        into = lambda last_y: ";".join(f"{x}:{y}:{z}" for x, y, z in main + [(12, y, 0) for y in range(6, last_y + 1)])
        pos = lambda cid: tuple(next(c for c in p.request("debug_convoys")["convoys"] if c["id"] == cid)["pos"])
        conv = lambda cid: next(c for c in p.request("debug_convoys")["convoys"] if c["id"] == cid)

        print("[1] train A to the far end of the siding")
        for cid in (ca, cb):
            p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_CONVOI')} g,{cid},{sched}")
        time.sleep(1)
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_DEPOT')} b,1,5,0,{ca}")
        wait_until(lambda: pos(ca) == (3, 5, 0), 60, "A at S1")
        check(p.cmd(f"set_path,{sid},{into(9)},A")["ok"], "route S1 -> (12,9)")
        wait_until(lambda: conv(ca)["stop"] == 1, 120, "A arrived in the siding")
        check(True, f"A arrived at {pos(ca)}")
        time.sleep(3)
        check(pos(ca)[0] == 12 and pos(ca)[1] >= 8, f"A waits in the siding (held by the shunting signal) at {pos(ca)}")
        tracks = lambda: json.loads(urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{PORT}/api/tracks?x1=0&y1=0&x2=15&y2=15", headers={"Host": f"127.0.0.1:{PORT}"})).read())["tiles"]
        held = sorted(tuple(t["p"]) for t in tracks() if t.get("c"))
        print("    reserved tiles:", held)

        print("[2] train B behind A")
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_DEPOT')} b,1,5,0,{cb}")
        wait_until(lambda: pos(cb) == (3, 5, 0), 60, "B at S1")
        # the destination in front of A: the last free tile of the siding
        free_y = max(y for y in range(6, 10) if (12, y, 0) not in held and all((12, yy, 0) not in held for yy in range(6, y + 1)))
        res = p.cmd(f"set_path,{sid},{into(9)},B-far")
        check(not res["ok"], f"a route to the far end is refused while A stands there ({res.get('error')})")
        check(p.cmd(f"set_path,{sid},{into(free_y)},B")["ok"], f"route S1 -> (12,{free_y}) in front of A")
        trace = []
        def b_arrived():
            c = conv(cb)
            trace.append((tuple(c["pos"]), c["state"], c["stop"]))
            return c["stop"] == 1
        wait_until(b_arrived, 120, "B arrived")
        print("    trace of B:", trace[-6:])
        time.sleep(3)
        check(pos(cb)[0] == 12 and 6 <= pos(cb)[1] <= free_y, f"B stands behind A in the siding at {pos(cb)} (A at {pos(ca)})")
        check(conv(cb)["stop"] == 1, "B was served in the siding (its schedule moved on)")

        print("[3] B leaves first, then A")
        out = ";".join(f"{x}:{y}:{z}" for x, y, z in [(12, 6, 0), (12, 5, 0), (13, 5, 0), (14, 5, 0)])
        check(p.cmd(f"set_path,{sid},{out},out")["ok"], "shunting route out of the siding to B")
        wait_until(lambda: pos(cb)[1] == 5 or conv(cb)["stop"] == 0, 120, "B left")
        check(True, f"B left the siding ({pos(cb)})")
        wait_until(lambda: not any(r for r in p.status()["routes"] if r.get("temp")), 120, "route released")
        check(pos(ca)[1] >= 8, f"A still waits ({pos(ca)})")
    finally:
        game.terminate()
        try:
            game.wait(10)
        except Exception:
            game.kill()
    print("EXPERIMENT DONE")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", required=True)
    ap.add_argument("--workdir", required=True)
    try:
        run(ap.parse_args())
    except AssertionError as e:
        print("EXPERIMENT STOPPED:", e)
        sys.exit(1)
