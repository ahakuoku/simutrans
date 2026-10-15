#!/usr/bin/env python3
"""
Coupling (OTRP) with the calling-on lever (誘導, pink) (scenario il-coupling, no change in the OTRP core).

S1 is a choose signal with its guide setting (連結誘導) on: OTRP lets a coupling child pass a plain
signal when its partner is in the block behind it, without asking the signal (and so the panel).
Parent A waits for coupling in the siding stop (12,6)-(12,9) (schedule entry: wait for coupling).
Child B has the same schedule with "try coupling". The operator sets a route for B with the pink
calling-on lever of S1 up to the tile in front of A; on the platform OTRP itself extends the route
to the coupling point and couples B to A.

Usage: coupling_test.py --sim build/default/sim --workdir <dir> [--relay]
"""
import argparse, json, os, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_test import Panel, check, start_game, wait_until, simple_tool_id, PORT


def run(args):
    game = start_game(args, ["-scenario", "il-coupling"])
    try:
        p = Panel(PORT)
        wait_until(lambda: any(s["pos"] == [3, 5, 0] for s in p.request("signals 0 0 15 15")["signals"]), 60, "layout")
        convoys = p.request("debug_convoys")["convoys"]
        ca, cb = convoys[0]["id"], convoys[1]["id"]
        conv = lambda cid: next((c for c in p.request("debug_convoys")["convoys"] if c["id"] == cid), None)
        pos = lambda cid: tuple(conv(cid)["pos"])
        tracks = lambda: json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/tracks?x1=0&y1=0&x2=15&y2=15").read())["tiles"]
        # S1 is a choose signal: OTRP checks it for a coupling child only with its guide setting (連結誘導) on
        time.sleep(2)  # the scenario turns S1 until it faces east
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_ROADSIGN')} 3,5,0,1,s")
        check(p.cmd("st_new,T")["ok"], "station")
        sid = p.status()["stations"][0]["id"]
        check(p.cmd(f"sig_add,{sid},3,5,0")["ok"] and p.cmd(f"dep_add,{sid},12,9,0,S")["ok"], "S1 and the shunting signal of the siding stop")
        check(p.cmd(f"st_mode,{sid},1")["ok"], "operator mode")
        if args.relay:
            check(p.cmd(f"st_cfg,{sid},1,0,5,3,2")["ok"], "relay interlocking")
        check(p.cmd(f"lv_shunt,{sid},3,5,0,P")["ok"], "S1 gets a pink calling-on lever (誘導)")
        # entry: x,y,z,min_load,waiting_time_shift,stop_flags(1 = wait for coupling, 2 = try coupling),...
        parent = "0|0|0|2|0|12,9,0,0,0,1,0,0,0,0,0,100,0,0|14,5,0,0,0,0,0,0,0,0,0,100,0,0|"
        child = "0|0|0|2|0|12,9,0,0,0,2,0,0,0,0,0,100,0,0|14,5,0,0,0,0,0,0,0,0,0,100,0,0|"
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_CONVOI')} g,{ca},{parent}")
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_CONVOI')} g,{cb},{child}")
        main = [(x, 5, 0) for x in range(3, 13)]
        into = lambda last_y: ";".join(f"{x}:{y}:{z}" for x, y, z in main + [(12, y, 0) for y in range(6, last_y + 1)])
        def turn(sh):
            if args.relay:
                p.cmd(f"sl_turn,{sid},3,5,0,N")
                p.cmd(f"sl_turn,{sid},3,5,0,N,S")
                r = p.cmd(f"sl_turn,{sid},3,5,0,R" + (",S" if sh else ""))
                check(r["ok"], f"lever turned ({r.get('error')})")

        print("[1] parent A into the siding stop, waits for coupling")
        time.sleep(1)
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_DEPOT')} b,1,5,0,{ca}")
        wait_until(lambda: pos(ca) == (3, 5, 0), 60, "A at S1")
        turn(False)
        check(p.cmd(f"set_path,{sid},{into(9)},A")["ok"], "route S1 -> (12,9)")
        wait_until(lambda: pos(ca) == (12, 9, 0) and conv(ca)["state"] == 7, 120, "A loading (waiting for coupling)")
        check(True, f"A waits at {pos(ca)} (state {conv(ca)['state']})")

        print("[2] child B with the calling-on lever up to A")
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_DEPOT')} b,1,5,0,{cb}")
        wait_until(lambda: pos(cb) == (3, 5, 0), 60, "B at S1")
        held = sorted((tuple(t["p"]), t["c"]) for t in tracks() if t.get("c"))
        check(held == [((3, 5, 0), cb), ((12, 9, 0), ca)], f"B waits at S1 (guide signal), it did not pass it for the coupling: {held}")
        cmd = "set_path" if args.relay else "set_path_s"
        turn(False)
        r = p.cmd(f"set_path,{sid},{into(9)},B")
        check(not r["ok"], f"the signal lever cannot lead up to A ({r.get('error')})")
        turn(True)
        r = p.cmd(f"{cmd},{sid},{into(9)},B")
        check(r["ok"], f"calling-on lever: route S1 -> the siding stop where A waits for coupling ({r.get('error')})")
        trace = []
        def coupled():
            a, b = conv(ca), conv(cb)
            trace.append((b and tuple(b["pos"]), b and b["state"]))
            # after coupling the child is part of the parent (OTRP keeps both convoys, linked)
            return b is None or a.get("coupled_to") or b.get("coupled_to")
        try:
            wait_until(coupled, 90, "coupled")
            check(True, "B coupled to A")
        except AssertionError:
            print("    trace of B:", trace[-8:])
            print("    convoys:", p.request("debug_convoys")["convoys"])
            raise
    finally:
        game.terminate()
        try:
            game.wait(10)
        except Exception:
            game.kill()
    print("COUPLING TEST DONE")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--relay", action="store_true")
    try:
        run(ap.parse_args())
    except AssertionError as e:
        print("TEST FAILED:", e)
        sys.exit(1)
