//
// This file is part of the Simutrans project under the Artistic License.
// (see LICENSE.txt)
//
// Test layout for the TID interlocking panel (driven by interlocking/tests/run_test.py)
//
//  y=5   D . S1 J [A1 A1 A1] . . J . [B  B]      D = depot (1,5), S1 = entry signal (3,5)
//  y=6          J-J[A2 A2 A2]-----J               J = junctions (4,5) (11,5) (5,6), curves (4,6) (11,6)
//  y=7            |                                siding (5,7)-(5,8): dead end at (5,8)
//  y=8            .                      S        S = stop used as a siding (12,8)-(12,9), off the junction (12,5)
//  y=12  a through track (2..12,12) with a stop at (6..8,12): virtual signals at both ends
//
//  Station A has two platforms (y=5 and y=6), station B is a terminus at the east end.
//  A separate line crosses on a bridge at x=10 (not connected). A crossover links both tracks at x=9.
//  The train runs between B and A; on its way east it has to pass S1.
//  OTRP has no script call to set a schedule, so the test driver sets the schedule
//  and starts the train through the bridge (TOOL_CHANGE_CONVOI / TOOL_CHANGE_DEPOT).
//

map.file = "empty-16x16.sve"

scenario.short_description = "TID interlocking test"
scenario.author = "TID"
scenario.version = "0.1"

include("test_helpers")

function get_rule_text(pl)   { return ttext("Interlocking test.") }
function get_goal_text(pl)   { return ttext("-") }
function get_info_text(pl)   { return ttext("-") }
function get_result_text(pl) { return ttext("-") }
function is_tool_allowed(pl, tool_id, wt) { return true }
function is_scenario_completed(pl) { return 0 }

function build_layout()
{
	local pl = player_x(0)
	SET_PLAYER_FUNDS(pl, 100000000)
	local rail = way_desc_x.get_available_ways(wt_rail, st_flat)[0]

	ASSERT_EQUAL(command_x.build_way(pl, coord3d(1, 5, 0), coord3d(14, 5, 0), rail, true), null)
	ASSERT_EQUAL(command_x.build_way(pl, coord3d(4, 5, 0), coord3d(4, 6, 0), rail, true), null)
	ASSERT_EQUAL(command_x.build_way(pl, coord3d(4, 6, 0), coord3d(11, 6, 0), rail, true), null)
	ASSERT_EQUAL(command_x.build_way(pl, coord3d(11, 6, 0), coord3d(11, 5, 0), rail, true), null)
	// a dead-end siding south of platform 2 (virtual shunting signal)
	ASSERT_EQUAL(command_x.build_way(pl, coord3d(5, 6, 0), coord3d(5, 8, 0), rail, true), null)
	// a siding built as a stop (駅属性の留置線) south of (12,5): dead end at (12,9)
	ASSERT_EQUAL(command_x.build_way(pl, coord3d(12, 5, 0), coord3d(12, 9, 0), rail, true), null)
	// a separate through track with a stop in the middle (a siding that can be left at both ends)
	ASSERT_EQUAL(command_x.build_way(pl, coord3d(2, 12, 0), coord3d(12, 12, 0), rail, true), null)
	// a short crossover between the two tracks east of the platforms (one lever for both points)
	ASSERT_EQUAL(command_x.build_way(pl, coord3d(9, 5, 0), coord3d(9, 6, 0), rail, true), null)

	local station_desc = building_desc_x.get_available_stations(building_desc_x.station, wt_rail, good_desc_x.passenger)[0]
	foreach (x in [6, 7, 8]) {
		ASSERT_EQUAL(command_x.build_station(pl, coord3d(x, 5, 0), station_desc), null)
		ASSERT_EQUAL(command_x.build_station(pl, coord3d(x, 6, 0), station_desc), null)
	}
	ASSERT_EQUAL(command_x.build_station(pl, coord3d(12, 8, 0), station_desc), null)
	ASSERT_EQUAL(command_x.build_station(pl, coord3d(12, 9, 0), station_desc), null)
	foreach (x in [6, 7, 8]) {
		ASSERT_EQUAL(command_x.build_station(pl, coord3d(x, 12, 0), station_desc), null)
	}
	ASSERT_EQUAL(command_x.build_station(pl, coord3d(13, 5, 0), station_desc), null)
	ASSERT_EQUAL(command_x.build_station(pl, coord3d(14, 5, 0), station_desc), null)

	ASSERT_EQUAL(command_x.build_depot(pl, coord3d(1, 5, 0), get_depot_by_wt(wt_rail)), null)

	// a plain block signal for eastbound trains at (3,5)
	local sig = sign_desc_x.get_available_signs(wt_rail).filter(@(i, s) (s.is_signal() && !s.is_choose_sign() && !s.is_pre_signal() && !s.is_longblock_signal() && !s.is_priority_signal()))[0]
	local tile = tile_x(3, 5, 0)
	for (local i = 0; i < 4; i++) {
		ASSERT_EQUAL(command_x.build_sign_at(pl, tile, sig), null)
		if (tile.get_way(wt_rail).get_dirs_masked() == dir.east) {
			break
		}
	}
	ASSERT_EQUAL(tile.get_way(wt_rail).get_dirs_masked(), dir.east)

	// one train B <-> A
	local depot = depot_x(1, 5, 0)
	local loco = vehicle_desc_x.get_available_vehicles(wt_rail).filter(@(idx, v) (!v.needs_electrification() && v.can_be_first() && v.get_power() > 0))[0]
	ASSERT_TRUE(depot.append_vehicle(pl, convoy_x(0), loco))
	// an unconnected line on a bridge across the station throat (x=10), to test the height filter of the panel
	local bridge = bridge_desc_x.get_available_bridges(wt_rail)[0]
	local res = command_x.build_bridge(pl, coord3d(10, 8, 0), coord3d(10, 3, 0), bridge)
	print("IL-TEST: bridge " + (res == null ? "ok" : res))

	print("IL-TEST: layout ready")
	return depot
}

function start()
{
	build_layout()
}

function resume_game()
{
}
