#!/usr/bin/env python3
"""
End-to-end test of the TID interlocking panel.

Starts the headless game (posix backend) with the scenario "il-test",
drives it through the panel bridge (TCP, 127.0.0.1) and checks:
  1. a train waits at an interlocked signal in operator mode
  2. conflicting routes are refused, cancel works
  3. the train follows the route set by the operator (platform 2)
  4. the route is released automatically after the train has passed
  5. rotating the map keeps the definitions consistent
  6. the definitions survive saving and loading

Usage:
  run_test.py --sim build/default/sim --workdir <dir with pak64/, config/, text/>

The workdir must contain pak64/scenario/il-test (link to interlocking/tests/il-test).
"""

import argparse
import json
import os
import queue
import re
import socket
import subprocess
import sys
import threading
import time

PORT = 13360
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def simple_tool_id(name):
    """index of a simple tool in simmenu.h (TOOL_PAUSE = 0 ... SIMPLE_TOOL_COUNT)"""
    text = open(os.path.join(REPO, "simmenu.h"), encoding="utf-8").read()
    block = text[text.index("TOOL_PAUSE = 0"):text.index("SIMPLE_TOOL_COUNT")]
    names = re.findall(r"^\s*(\w+)\s*(?:=\s*0)?\s*,", block, re.M)
    return names.index(name)


class Panel:
    def __init__(self, port):
        self.events = queue.Queue()
        self.answers = queue.Queue()
        for _ in range(120):
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=1)
                break
            except OSError:
                time.sleep(0.5)
        else:
            raise RuntimeError("cannot connect to the bridge")
        self.sock.settimeout(None)
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        buf = b""
        while True:
            data = self.sock.recv(65536)
            if not data:
                return
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                msg = json.loads(line.decode("utf-8"))
                if msg["type"] in ("status", "signals", "convoys", "pong", "error", "debug_tool", "debug_save"):
                    self.answers.put(msg)
                else:
                    self.events.put(msg)

    def request(self, line):
        self.sock.sendall((line + "\n").encode("utf-8"))
        return self.answers.get(timeout=20)

    def send(self, line):
        self.sock.sendall((line + "\n").encode("utf-8"))

    def wait_event(self, pred, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            try:
                ev = self.events.get(timeout=max(0.1, end - time.time()))
            except queue.Empty:
                break
            if pred(ev):
                return ev
        raise AssertionError("timeout waiting for event")

    def cmd(self, param):
        """sends a command and returns its result event"""
        self.send("cmd " + param)
        return self.wait_event(lambda e: e["type"] == "result" and e["command"] == param)

    def status(self):
        return self.request("status")


def check(cond, text):
    print(("  OK   " if cond else "  FAIL ") + text)
    if not cond:
        raise AssertionError(text)


def start_game(args, extra):
    env = dict(os.environ, TID_IL_PORT=str(PORT), TID_IL_DEBUG="1")
    log = open(os.path.join(args.workdir, "il_test_game.log"), "w")
    cmdline = [os.path.abspath(args.sim), "-set_workdir", args.workdir, "-singleuser", "-objects", "pak64/",
               "-lang", "en", "-nosound", "-nomidi", "-debug", "2", "-fps", "25"] + extra
    return subprocess.Popen(cmdline, cwd=args.workdir, env=env, stdout=log, stderr=subprocess.STDOUT)


def wait_until(fn, timeout, text):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.3)
    raise AssertionError("timeout: " + text)


def run(args):
    game = start_game(args, ["-scenario", "il-test"])
    try:
        p = Panel(PORT)

        # wait for the scenario to build the layout (signal S1 at (3,5,0))
        wait_until(lambda: any(s["pos"] == [3, 5, 0] for s in p.request("signals 0 0 15 15")["signals"]), 60, "layout")
        print("[1] configure the interlocking")
        r = p.cmd("st_new,A station, east")
        check(r["ok"], "create station")
        st0 = p.status()["stations"][0]
        sid = st0["id"]
        check(st0["name"] == "A station, east", "station name may contain commas")
        check(not p.cmd(f"rt_def,{sid},3,5,0,8,5,0,x")["ok"], "route from an unregistered signal is refused")
        check(p.cmd(f"sig_add,{sid},3,5,0")["ok"], "register S1 as interlocked signal")
        check(not p.cmd(f"sig_add,{sid},3,5,0")["ok"], "registering S1 twice is refused")
        check(not p.cmd(f"sig_add,{sid},2,5,0")["ok"], "no signal at (2,5): refused")
        check(p.cmd(f"rt_def,{sid},3,5,0,8,5,0,S1-1")["ok"], "define route S1 -> platform 1")
        check(p.cmd(f"rt_def,{sid},3,5,0,8,6,0,S1-2")["ok"], "define route S1 -> platform 2")
        routes = {rt["name"]: rt for rt in p.status()["routes"]}
        r1, r2 = routes["S1-1"], routes["S1-2"]
        check(r1["tiles"][0] == [3, 5, 0] and r1["tiles"][-1] == [8, 5, 0], "route 1 runs from S1 to (8,5)")
        check([4, 6, 0] in r2["tiles"] and r2["tiles"][-1] == [8, 6, 0], "route 2 runs over the junction to (8,6)")
        check(not p.cmd(f"set,{r1['id']}")["ok"], "setting a route in automatic mode is refused")
        check(p.cmd(f"st_mode,{sid},1")["ok"], "switch to operator mode")

        # station B: dead-end platform without a departure signal -> virtual departure signal
        check(p.cmd("st_new,B terminus")["ok"], "create station B")
        sidb = [st for st in p.status()["stations"] if st["name"] == "B terminus"][0]["id"]
        check(not p.cmd(f"dep_add,{sidb},11,5,0")["ok"], "virtual departure on a junction is refused")
        check(not p.cmd(f"dep_add,{sidb},12,9,0")["ok"], "virtual departure without track is refused")
        check(p.cmd(f"dep_add,{sidb},14,5,0")["ok"], "register platform B as virtual departure signal (clicked at the buffer end)")
        dep = [st for st in p.status()["stations"] if st["id"] == sidb][0]["departures"][0]
        check(dep["pos"] == [13, 5, 0], f"departure end found automatically: {dep['pos']}")
        check(p.cmd(f"rt_def,{sidb},13,5,0,9,5,0,B-out")["ok"], "define departure route from platform B")
        rb = [r for r in p.status()["routes"] if r["name"] == "B-out"][0]
        check(rb["tiles"][0] == [13, 5, 0] and rb["tiles"][-1] == [9, 5, 0], "departure route runs from the platform end to (9,5)")
        check(p.cmd(f"st_mode,{sidb},1")["ok"], "station B in operator mode")

        print("[2] conflicting routes (before the train runs)")
        check(p.cmd(f"set,{r1['id']}")["ok"], "set route 1")
        res = p.cmd(f"set,{r2['id']}")
        check(not res["ok"] and res.get("error") == "another route from this signal is set", f"route 2 refused while route 1 is set ({res.get('error')})")
        check(p.cmd(f"cancel,{r1['id']}")["ok"], "cancel route 1")

        print("[2b] route made on the panel (start lever + destination button) and names")
        path = ";".join(f"{x}:{y}:{z}" for x, y, z in r2["tiles"])
        check(p.cmd(f"set_path,{sid},{path},S1 to 2")["ok"], "set a temporary route along platform 2")
        tmp = [r for r in p.status()["routes"] if r.get("temp")]
        check(len(tmp) == 1 and tmp[0]["state"] == "set" and tmp[0]["name"] == "S1 to 2", "temporary route is set")
        res = p.cmd(f"set,{r1['id']}")
        check(not res["ok"], f"predefined route refused while the temporary route is set ({res.get('error')})")
        check(p.cmd(f"cancel,{tmp[0]['id']}")["ok"], "cancel the temporary route")
        check(not [r for r in p.status()["routes"] if r.get("temp")], "temporary route deleted after cancel")
        gap = ";".join(f"{x}:{y}:{z}" for x, y, z in r2["tiles"][:2] + r2["tiles"][3:])
        check(not p.cmd(f"set_path,{sid},{gap},bad")["ok"], "a path with a gap is refused")
        # point levers (stored in the game): 21 at (4,5), legs W(8)-E(2) = straight, W(8)-S(4) = to platform 2
        check(p.cmd(f"pt_set,{sid},4:5:0/N/8-2")["ok"], "fix point (4,5) to normal")
        res = p.cmd(f"set,{r2['id']}")
        check(not res["ok"] and res.get("error") == "a point is set against the route", f"route to platform 2 refused by the fixed point ({res.get('error')})")
        check(not p.cmd(f"set_path,{sid},{path},x")["ok"], "temporary route against the point refused, too")
        check(p.cmd(f"set,{r1['id']}")["ok"], "route along the fixed point direction is allowed")
        res = p.cmd(f"pt_set,{sid},4:5:0/R/8-4")
        check(not res["ok"] and res.get("error") == "the point is locked", f"a point under a set route cannot be thrown ({res.get('error')})")
        check(p.cmd(f"cancel,{r1['id']}")["ok"], "cancel route 1")
        check(p.cmd(f"pt_set,{sid},4:5:0//")["ok"], "point back to automatic")
        check(not p.status()["stations"][0]["levers"], "no fixed points left")
        check(p.cmd(f"pt_set,{sid},9:5:0/R/4-8.4-2;9:6:0/R/1-8.1-2")["ok"], "crossover: both points in one command")
        check(len(p.status()["stations"][0]["levers"]) == 2, "both crossover points stored")
        check(not p.cmd(f"pt_set,{sid},9:5:0/N/8-2;5:5:0/N/8-2")["ok"], "all or nothing: a bad entry rejects the whole command")
        check(len([l for l in p.status()["stations"][0]["levers"] if l["value"] == "R"]) == 2, "crossover unchanged after the rejected command")
        check(p.cmd(f"name_set,{sid},3,5,0,第1場内, west")["ok"], "rename S1")
        lab = p.status()["stations"][0]["labels"]
        check(lab == [{"pos": [3, 5, 0], "name": "第1場内, west"}], f"name stored: {lab}")

        print("[3] the train waits at S1")
        cid = p.request("debug_convoys")["convoys"][0]["id"]
        # first stop: A platform 1 (7,5); the operator will send the train to platform 2
        sched = "0|0|0|2|0|7,5,0,0,0,0,0,0,0,0,0,100,0,0|14,5,0,0,0,0,0,0,0,0,0,100,0,0|"
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_CONVOI')} g,{cid},{sched}")
        time.sleep(1)
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_DEPOT')} b,1,5,0,{cid}")
        time.sleep(10)
        cnv = p.request("debug_convoys")["convoys"][0]
        sig = [s for s in p.status()["stations"][0]["signals"] if s["pos"] == [3, 5, 0]][0]
        check(cnv["state"] in (8, 9, 13) and cnv["speed"] == 0 and cnv["pos"] == [3, 5, 0],
              f"train left the depot and waits in front of S1 (pos {cnv['pos']}, state {cnv['state']})")
        check(sig["aspect"] == "red", "S1 shows danger")

        print("[4] the train follows route 2")
        seen = []
        stop = threading.Event()

        def watch():
            while not stop.is_set():
                try:
                    seen.append(tuple(p.request("debug_convoys")["convoys"][0]["pos"]))
                except Exception:
                    return
                time.sleep(0.2)
        check(p.cmd(f"set,{r2['id']}")["ok"], "set route 2")
        t = threading.Thread(target=watch, daemon=True)
        t.start()
        p.wait_event(lambda e: e["type"] == "route" and e["id"] == r2["id"] and e["state"] == "occupied", 60)
        check(True, "train admitted into route 2 (state occupied)")
        # the schedule says platform 1, the route goes to platform 2 of the same station: the train stops there
        trace = []
        def arrived_at_a():
            c = p.request("debug_convoys")["convoys"][0]
            trace.append((tuple(c["pos"]), c["state"], c["stop"]))
            return c["stop"] == 1  # the schedule moved on: the stop at A is done
        wait_until(arrived_at_a, 120, "train served A")
        where = [t for t in trace if t[1] == 7] or trace[-1:]
        print("    trace (pos, state, stop):", trace[-8:])
        check(any(pos[1] == 6 and 6 <= pos[0] <= 8 for pos, state, stop in trace[-6:]),
              f"train served A at platform 2 although the schedule says platform 1 (last positions {[t[0] for t in trace[-4:]]})")
        p.wait_event(lambda e: e["type"] == "route" and e["id"] == r2["id"] and e["state"] == "idle", 120)
        check(True, "route 2 released automatically after the train passed")
        wait_until(lambda: any(pos[0] >= 13 for pos in seen), 120, "train reaches station B")
        stop.set()
        first_p2 = next((i for i, pos in enumerate(seen) if pos[1] == 6 and 6 <= pos[0] <= 8), None)
        first_b = next(i for i, pos in enumerate(seen) if pos[0] >= 13)
        check(first_p2 is not None and first_p2 < first_b, "train ran over platform 2 (y=6) on its way to B")
        check(not any(pos[1] == 5 and 6 <= pos[0] <= 8 for pos in seen[:first_b]), "train did not use platform 1")

        print("[4b] virtual departure signal at the dead-end platform B")
        def b_departure():
            st = [st for st in p.status()["stations"] if st["id"] == sidb][0]
            return st["departures"][0]
        wait_until(lambda: b_departure().get("waiting"), 120, "train waiting for departure at B")
        check(True, f"train ready to depart at B: {b_departure().get('train')}")
        stay = []
        for _ in range(12):
            stay.append(p.request("debug_convoys")["convoys"][0]["pos"])
            time.sleep(0.5)
        check(all(pos[0] >= 13 for pos in stay), "train does not depart without a departure route")
        check(p.cmd(f"set,{rb['id']}")["ok"], "set the departure route B-out")
        p.wait_event(lambda e: e["type"] == "route" and e["id"] == rb["id"] and e["state"] == "occupied", 60)
        check(True, "train admitted into B-out")
        wait_until(lambda: p.request("debug_convoys")["convoys"][0]["pos"][0] <= 11, 60, "train left B")
        check(True, "train departed from B")
        p.wait_event(lambda e: e["type"] == "route" and e["id"] == rb["id"] and e["state"] == "idle", 120)
        check(True, "departure route released automatically")

        print("[4c] virtual shunting signal at the siding (5,7)-(5,8) and route names")
        check(p.cmd(f"dep_add,{sid},5,8,0")["ok"], "register the siding as virtual shunting signal (clicked at the buffer end)")
        sh = [d for d in p.status()["stations"][0]["departures"]][0]
        check(sh["pos"] == [5, 7, 0] and sorted(sh["tiles"]) == [[5, 7, 0], [5, 8, 0]] and sh.get("shunt"), f"siding found, leaves at (5,7): {sh}")
        check(p.cmd(f"rt_def,{sid},5,7,0,8,6,0,shunt-2")["ok"], "define the shunting route siding -> platform 2")
        rs = [r for r in p.status()["routes"] if r["name"] == "shunt-2"][0]
        check(rs["tiles"][0] == [5, 7, 0] and [5, 6, 0] in rs["tiles"] and rs["tiles"][-1] == [8, 6, 0], "shunting route runs out of the siding to platform 2")
        check(p.cmd(f"rt_name,{rs['id']},入換 2番, test")["ok"], "rename the shunting route")
        rs = [r for r in p.status()["routes"] if r["id"] == rs["id"]][0]
        check(rs["name"] == "入換 2番, test", f"route name changed: {rs['name']}")
        check(p.cmd(f"rt_name,{rs['id']},shunt-2")["ok"], "rename it back")
        check(not p.cmd("rt_name,9999,x")["ok"], "renaming an unknown route is refused")
        # send the train into the siding (waypoint at the buffer end), then to platform 2
        sched = "0|0|0|2|0|5,8,0,0,0,0,0,0,0,0,0,100,0,0|7,6,0,0,0,0,0,0,0,0,0,100,0,0|"
        p.request(f"debug_tool {simple_tool_id('TOOL_CHANGE_CONVOI')} g,{cid},{sched}")
        wait_until(lambda: (lambda st: st["departures"][0].get("train"))(p.status()["stations"][0]), 120, "train in the siding")
        wait_until(lambda: p.request("debug_convoys")["convoys"][0]["stop"] == 1, 60, "waypoint in the siding reached")
        stay = []
        for _ in range(12):
            stay.append(p.request("debug_convoys")["convoys"][0]["pos"])
            time.sleep(0.5)
        check(all(pos[0] == 5 and pos[1] >= 7 for pos in stay), f"train waits in the siding without a shunting route ({stay[-1]})")
        check(p.cmd(f"set,{rs['id']}")["ok"], "set the shunting route")
        p.wait_event(lambda e: e["type"] == "route" and e["id"] == rs["id"] and e["state"] == "occupied", 60)
        check(True, "train admitted into the shunting route")
        trace = []
        def served_p2():
            c = p.request("debug_convoys")["convoys"][0]
            trace.append(tuple(c["pos"]))
            return c["stop"] == 0
        wait_until(served_p2, 120, "train reached platform 2")
        check(any(pos[1] == 6 and 6 <= pos[0] <= 8 for pos in trace[-6:]), f"train came out of the siding to platform 2 ({trace[-4:]})")
        p.wait_event(lambda e: e["type"] == "route" and e["id"] == rs["id"] and e["state"] == "idle", 120)
        check(True, "shunting route released automatically")

        print("[4d] relay interlocking: signal levers, throwing time, approach locking, emergency stop")
        def train_in_siding():
            st = p.status()["stations"][0]
            c = p.request("debug_convoys")["convoys"][0]
            return st["departures"][0].get("train") and c["stop"] == 1 and c["pos"][1] >= 7
        wait_until(train_in_siding, 120, "train back in the siding")
        check(p.cmd(f"st_cfg,{sid},1,1,5,3,4")["ok"], "station A switched to relay (approach 5 s, shunting 3 s, throwing 4 s)")
        sa = p.status()["stations"][0]
        check(sa["kind"] == "relay" and sa["rot"] == 1 and sa["t_throw"] == 4, f"relay settings stored: {sa['kind']} rot {sa['rot']}")
        check(p.cmd(f"st_ops,{sid},3.4")["ok"] and p.status()["stations"][0]["operators"] == [3, 4], "further companies may operate the station")
        res = p.cmd(f"set,{rs['id']}")
        check(not res["ok"] and res["error"] == "use the levers on a relay panel", f"shortcuts refused on a relay panel ({res.get('error')})")
        spath = ";".join(f"{x}:{y}:{z}" for x, y, z in rs["tiles"])
        res = p.cmd(f"set_path,{sid},{spath},入換")
        check(not res["ok"] and res["error"] == "turn the signal lever first", f"no route without turning the lever ({res.get('error')})")
        check(p.cmd(f"sl_turn,{sid},5,7,0,L")["ok"], "shunting lever turned to the left")
        res = p.cmd(f"sl_turn,{sid},5,7,0,R")
        check(not res["ok"] and res["error"] == "turn the lever back first", "lever cannot be turned to the other side directly")
        # approach locking: cancel while the train stands in the siding
        check(p.cmd(f"set_path,{sid},{spath},入換")["ok"], "destination button: route set")
        tr = [r for r in p.status()["routes"] if r.get("temp")][0]
        pts = {tuple(x["pos"]): x for x in p.status()["stations"][0]["points"]}
        check(tr["state"] == "set" and tr.get("waiting", 0) > 0 and pts.get((5, 6, 0), {}).get("moving", 0) > 0,
              f"points are moving, the signal waits ({tr.get('waiting')} s)")
        check(p.cmd(f"sl_turn,{sid},5,7,0,N")["ok"], "lever back to normal while the train is approaching")
        tr = [r for r in p.status()["routes"] if r["id"] == tr["id"]][0]
        check(tr["state"] == "releasing" and tr.get("release_in", 0) > 0, f"approach locking: time release runs ({tr.get('release_in')} s)")
        res = p.cmd(f"pt_set,{sid},5:6:0/N/8-2")
        check(not res["ok"] and res["error"] == "the point is locked", "point locked during the time release")
        t0 = time.time()
        wait_until(lambda: not any(r["id"] == tr["id"] for r in p.status()["routes"]), 30, "time release")
        check(time.time() - t0 >= 1.5, f"route released after the time release ({time.time() - t0:.1f} s)")
        check(p.request("debug_convoys")["convoys"][0]["pos"][1] >= 7, "train still in the siding")
        # emergency stop: the route is set, but the signal does not clear
        check(p.cmd(f"st_stop,{sid},1")["ok"], "emergency stop lever on")
        check(p.cmd(f"sl_turn,{sid},5,7,0,L")["ok"] and p.cmd(f"set_path,{sid},{spath},入換")["ok"], "lever turned again, route set")
        t_set = time.time()
        time.sleep(7)
        tr = [r for r in p.status()["routes"] if r.get("temp")][0]
        check(tr["state"] == "set" and p.request("debug_convoys")["convoys"][0]["pos"][1] >= 7, "emergency stop: the train does not leave")
        check(p.cmd(f"st_stop,{sid},0")["ok"], "emergency stop lever off")
        p.wait_event(lambda e: e["type"] == "route" and e["id"] == tr["id"] and e["state"] == "occupied", 60)
        check(True, "train admitted after the emergency stop was released")
        p.wait_event(lambda e: e["type"] == "route" and e["id"] == tr["id"] and e["state"] == "idle", 120)
        lev = p.status()["stations"][0]["slevers"]
        check(lev == [{"pos": [5, 7, 0], "side": "L", "used": True}], f"the lever stays turned after the train has passed: {lev}")
        res = p.cmd(f"set_path,{sid},{spath},入換")
        check(not res["ok"] and res["error"] == "turn the lever back first", "no second route before the lever is turned back")
        check(p.cmd(f"sl_turn,{sid},5,7,0,N")["ok"] and not p.status()["stations"][0]["slevers"], "lever turned back")
        # throwing time: the train is admitted only after the points are in place
        wait_until(train_in_siding, 120, "train back in the siding again")
        check(p.cmd(f"pt_set,{sid},5:6:0/R/8-4")["ok"], "point 24 fixed against the route (to the west)")
        check(p.cmd(f"sl_turn,{sid},5,7,0,L")["ok"], "lever turned")
        res = p.cmd(f"set_path,{sid},{spath},入換")
        check(not res["ok"] and res["error"] == "a point is set against the route", "route refused by the point lever")
        check(p.cmd(f"pt_set,{sid},5:6:0//")["ok"], "point lever back to C (automatic)")
        check(p.cmd(f"set_path,{sid},{spath},入換")["ok"], "route set")
        t_set = time.time()
        tr = [r for r in p.status()["routes"] if r.get("temp")][0]
        p.wait_event(lambda e: e["type"] == "route" and e["id"] == tr["id"] and e["state"] == "occupied", 60)
        check(time.time() - t_set >= 2.5, f"admitted only after the throwing time ({time.time() - t_set:.1f} s)")
        p.wait_event(lambda e: e["type"] == "route" and e["id"] == tr["id"] and e["state"] == "idle", 120)
        check(p.cmd(f"sl_turn,{sid},5,7,0,N")["ok"], "lever turned back")

        print("[5] rotate the map")
        rot = simple_tool_id("TOOL_ROTATE90")
        before = p.status()
        p.request(f"debug_tool {rot} ")
        p.wait_event(lambda e: e["type"] == "rotated", 30)
        after = p.status()
        s_after = after["stations"][0]["signals"][0]
        d_after = [st for st in after["stations"] if st["id"] == sidb][0]["departures"][0]
        lv_after = after["stations"][0]["levers"]
        check(lv_after and lv_after[0]["pos"] != [9, 5, 0], f"point levers follow the rotation ({[l['pos'] for l in lv_after]})")
        check(d_after["pos"] != [13, 5, 0] and d_after["pos"] in d_after["tiles"], f"virtual departure follows the rotation ({d_after['pos']})")
        check(s_after["pos"] != [3, 5, 0] and s_after["aspect"] != "missing", f"signal follows the rotation ({s_after['pos']})")
        for _ in range(3):
            p.request(f"debug_tool {rot} ")
            p.wait_event(lambda e: e["type"] == "rotated", 30)
        check([r["tiles"] for r in p.status()["routes"]] == [r["tiles"] for r in before["routes"]], "four rotations restore the route tiles")
        check(p.status()["stations"][0]["levers"] == before["stations"][0]["levers"], "four rotations restore the point levers")
        check(p.status()["stations"][0]["signals"][0]["pos"] == [3, 5, 0], "four rotations restore the signal position")

        print("[6] save and load")
        # set any free route (the train may just be running over one of them)
        set_ok = wait_until(lambda: next((rid for rid in (r2["id"], rb["id"], r1["id"]) if p.cmd(f"set,{rid}")["ok"]), None), 90, "a free route to set")
        check(True, f"route {set_ok} set before saving")
        saved = p.status()
        p.request("debug_save il_test")
        time.sleep(2)
    finally:
        game.terminate()
        try:
            game.wait(10)
        except subprocess.TimeoutExpired:
            game.kill()

    time.sleep(1)
    game = start_game(args, ["-load", "il_test"])
    try:
        p = Panel(PORT)
        loaded = wait_until(lambda: (lambda s: s if s["stations"] else None)(p.status()), 60, "loaded status")
        strip_st = lambda sts: [(st["id"], st["name"], st["owner"], st["manual"], [sg["pos"] for sg in st["signals"]], [(d["pos"], d["tiles"]) for d in st["departures"]], st["labels"], st["levers"],
                                 st["kind"], st["rot"], st["t_approach"], st["t_shunt"], st["t_throw"], st["operators"], st["slevers"], [x["pos"] for x in st["points"]]) for st in sts]
        check(strip_st(loaded["stations"]) == strip_st(saved["stations"]), "stations restored (name, owner, mode, signals, virtual departures)")
        strip = lambda rs: [(r["id"], r["name"], r["state"], r["tiles"]) for r in rs]
        check(strip(loaded["routes"]) == strip(saved["routes"]), "routes and their states restored")
    finally:
        game.terminate()
        try:
            game.wait(10)
        except subprocess.TimeoutExpired:
            game.kill()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", required=True)
    ap.add_argument("--workdir", required=True)
    try:
        run(ap.parse_args())
    except AssertionError as e:
        print("TEST FAILED:", e)
        sys.exit(1)
