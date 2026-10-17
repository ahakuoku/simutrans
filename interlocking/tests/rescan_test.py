#!/usr/bin/env python3
"""
Re-reading the track after it was rebuilt in the game (配線を読み直す, st_rescan) (scenario il-tandem).

  1. nothing changed: nothing to do
  2. the east end of platform 1 (8,5) is no longer part of the stop: the virtual departure signal moves to (7,5),
     the departure route from it is re-routed along the track as it is now
  3. the track at (12,5) is removed: the departure route to B can no longer be laid (reported), the siding stop
     is cut off, its virtual shunting signal goes
  4. the entry signal S1 is removed: it leaves the station, the routes from it are removed

Usage: rescan_test.py --sim build/default/sim --workdir <dir>
"""
import argparse, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from run_test import Panel, check, start_game, wait_until, PORT, REPO
import re


def general_tool_id(name):
    """index of a general tool in simmenu.h (TOOL_QUERY = 0 ... GENERAL_TOOL_COUNT)"""
    text = open(os.path.join(REPO, "simmenu.h"), encoding="utf-8").read()
    block = text[text.index("TOOL_QUERY=0"):text.index("GENERAL_TOOL_COUNT")]
    names = re.findall(r"^\s*(\w+)\s*(?:=\s*0)?\s*,", "\t" + block, re.M)
    return names.index(name)


def run(args):
    game = start_game(args, ["-scenario", "il-tandem"])
    try:
        p = Panel(PORT)
        wait_until(lambda: any(s["pos"] == [3, 5, 0] for s in p.request("signals 0 0 15 15")["signals"]), 60, "layout")
        time.sleep(2)
        check(p.cmd("st_new,T")["ok"], "station")
        sid = p.status()["stations"][0]["id"]
        check(p.cmd(f"sig_add,{sid},3,5,0")["ok"] and p.cmd(f"dep_add,{sid},8,5,0")["ok"] and p.cmd(f"dep_add,{sid},12,9,0,S")["ok"], "S1, departure of platform 1, siding stop")
        tiles = lambda ts: ";".join(f"{x}:{y}:{z}" for x, y, z in ts)
        check(p.cmd(f"rt_path,{sid},{tiles([(x, 5, 0) for x in range(3, 9)])},home")["ok"], "route S1 -> platform 1")
        check(p.cmd(f"rt_path,{sid},{tiles([(3, 5, 0), (4, 5, 0), (4, 6, 0), (5, 6, 0), (6, 6, 0), (7, 6, 0), (8, 6, 0)])},home2")["ok"], "route S1 -> platform 2")
        check(p.cmd(f"rt_path,{sid},{tiles([(x, 5, 0) for x in range(8, 14)])},out")["ok"], "route platform 1 -> B")
        check(p.cmd(f"lv_shunt,{sid},8,5,0,G")["ok"], "a shunting lever at the departure of platform 1")

        def rescan():
            # the summary comes before the result of the command
            p.send(f"cmd st_rescan,{sid}")
            ev = p.wait_event(lambda e: e["type"] == "rescan", 20)
            check(p.wait_event(lambda e: e["type"] == "result" and e["command"] == f"st_rescan,{sid}")["ok"], "re-read the track")
            return ev

        print("[1] nothing changed")
        ev = rescan()
        check(not any(ev[k] for k in ("signals_removed", "departures_removed", "departures_moved", "levers_removed", "sidings_removed", "routes_busy"))
              and not ev["routes_rerouted"] and not ev["routes_broken"] and not ev["routes_removed"], f"nothing to do: {ev}")

        print("[2] platform 1 shortened at its east end")
        r = p.request(f"debug_work {general_tool_id('TOOL_REMOVER')} 8,5,0")
        check(r.get("ok"), f"stop removed at (8,5) ({r})")
        ev = rescan()
        st = p.status()["stations"][0]
        deps = sorted(tuple(d["pos"]) for d in st["departures"])
        check(ev["departures_moved"] == 1 and (7, 5, 0) in deps, f"the departure moved to the new end (7,5): {deps}")
        check(st["shunt_levers"] == [{"pos": [7, 5, 0], "color": "G"}], f"its shunting lever moved with it: {st['shunt_levers']}")
        out = next(r for r in p.status()["routes"] if r["name"] == "out")
        check(ev["routes_rerouted"] == ["out"] and out["tiles"][0] == [7, 5, 0] and out["tiles"][-1] == [13, 5, 0], f"route re-routed from (7,5): {out['tiles']}")
        check(p.cmd(f"st_mode,{sid},1")["ok"], "operator mode")
        res = p.cmd(f"set,{out['id']}")
        check(res["ok"] and p.cmd(f"cancel,{out['id']}")["ok"], f"the re-routed route can be set ({res.get('error')})")

        print("[3] the track at (12,5) removed")
        r = p.request(f"debug_work {general_tool_id('TOOL_REMOVER')} 12,5,0")
        check(r.get("ok"), f"track removed at (12,5) ({r})")
        ev = rescan()
        check(ev["routes_broken"] == ["out"], f"the route to B is reported: {ev['routes_broken']}")
        deps = sorted(tuple(d["pos"]) for d in p.status()["stations"][0]["departures"])
        check(ev["departures_removed"] == 1 and deps == [(7, 5, 0)], f"the cut-off siding stop lost its virtual signal: {deps}")

        print("[4] S1 removed")
        # a two-click tool: start and end on the same tile
        p.request(f"debug_work {general_tool_id('TOOL_REMOVE_SIGNAL')} 3,5,0")
        r = p.request(f"debug_work {general_tool_id('TOOL_REMOVE_SIGNAL')} 3,5,0")
        check(r.get("ok"), f"signal removed ({r})")
        ev = rescan()
        st = p.status()["stations"][0]
        names = sorted(r["name"] for r in p.status()["routes"])
        check(ev["signals_removed"] == 1 and not st["signals"], f"S1 left the station ({ev}, {st['signals']}, {[s for s in p.request('signals 0 0 15 15')['signals'] if s['pos'] == [3, 5, 0]]})")
        check(sorted(ev["routes_removed"]) == ["home", "home2"] and names == ["out"], f"its routes are removed: {names}")
    finally:
        game.terminate()
        try:
            game.wait(10)
        except Exception:
            game.kill()
    print("RESCAN TEST DONE")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", required=True)
    ap.add_argument("--workdir", required=True)
    try:
        run(ap.parse_args())
    except AssertionError as e:
        print("TEST FAILED:", e)
        sys.exit(1)
