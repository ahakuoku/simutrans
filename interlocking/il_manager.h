/*
 * This file is part of the Simutrans project under the Artistic License.
 * (see LICENSE.txt)
 */

#ifndef INTERLOCKING_IL_MANAGER_H
#define INTERLOCKING_IL_MANAGER_H

#include "../simtypes.h"
#include "../convoihandle_t.h"
#include "../dataobj/koord3d.h"
#include "../tpl/vector_tpl.h"
#include "../utils/plainstring.h"

class cbuffer_t;
class loadsave_t;
class player_t;
class rail_vehicle_t;

/// state of a route (Japanese: 進路)
enum il_route_state_t {
	IL_IDLE     = 0, ///< not set (lever normal)
	IL_SET      = 1, ///< set and locked, waiting for a train; the start signal clears when a train arrives
	IL_OCCUPIED = 2  ///< a train has been admitted into the route
};

/// one route from a start signal to an end tile
struct il_route_t {
	uint16 id;
	uint16 station;
	plainstring name;
	/// tiles of the route; tiles[0] is the start signal, back() is the end tile
	vector_tpl<koord3d> tiles;
	uint8 state;
	/// admitted train (only valid in IL_OCCUPIED, not saved)
	convoihandle_t convoy;
	/// made on the panel with start lever + destination button; deleted when released
	bool temp;

	il_route_t() : id(0), station(0), state(IL_IDLE), temp(false) {}
};

/**
 * Virtual departure signal: a platform track whose trains may only depart when a route
 * from it is set (for platforms without a real departure signal, e.g. dead-end platforms).
 * On a plain track without platform (siding, pull-out track) it works as a virtual shunting
 * signal (入換信号) in the same way.
 * There is no object on the map, so the automatic mode is not affected at all.
 */
struct il_departure_t {
	koord3d anchor;               ///< platform end where trains leave; start tile of its routes
	vector_tpl<koord3d> tiles;    ///< all tiles of this platform track
};

/**
 * Lever position of a point (junction tile), set on the panel. Only the leg pairs listed here
 * may be used by routes over this tile. The panel decides which pairs are normal / reverse
 * (from the track geometry); the interlocking only stores and enforces them.
 */
struct il_lever_t {
	koord3d pos;
	plainstring value;                ///< "N" (normal), "R" (reverse) or "a,b" (extra pair) for display
	vector_tpl<uint8> pairs;          ///< allowed leg pairs, two ribi values each
};

/// one interlocked station (the unit of one panel)
struct il_station_t {
	uint16 id;
	plainstring name;
	uint8 owner;   ///< player number
	bool manual;   ///< false = automatic mode (signals work as usual), true = operator mode
	/// signals controlled by this station (positions of signal_t)
	vector_tpl<koord3d> signals;
	/// virtual departure signals
	vector_tpl<il_departure_t *> departures;
	/// names given on the panel (signals, platforms, points, exits), parallel vectors
	vector_tpl<koord3d> label_pos;
	vector_tpl<plainstring> label_names;
	/// point lever positions (missing = automatic)
	vector_tpl<il_lever_t *> levers;

	~il_station_t() { clear_ptr_vector(departures); clear_ptr_vector(levers); }
};

/**
 * Holds all interlocking definitions and states.
 *
 * Everything that changes the game state must be called deterministically on all
 * clients, i.e. only from tool_interlocking_t (network tool), from the signal hook
 * or from step(). The event queue is local information for the external panel only.
 */
class interlocking_manager_t
{
public:
	static interlocking_manager_t *get();

	void reset();

	/**
	 * Execute one command (called from tool_interlocking_t::init on every client).
	 * @return NULL on success, otherwise an error text
	 */
	const char *execute(const char *param, player_t *player);

	/// see interlocking_hook_signal()
	bool on_signal(rail_vehicle_t *v, uint16 next_block, sint32 &restart_speed, bool call_by_step, bool &result);

	/// see interlocking_hook_departure()
	bool on_departure(rail_vehicle_t *v, sint32 &restart_speed, bool &result);

	void step();

	void rdwr(loadsave_t *file);
	void rotate90(sint16 y_size);

	// --- read only access for the external panel ---

	/// status of all stations and routes as one JSON object
	void get_status_json(cbuffer_t &buf) const;

	/// all rail signals in the rectangle as one JSON object
	void get_signals_json(cbuffer_t &buf, koord p1, koord p2) const;

	/// takes the next pending event (JSON); returns false if none
	bool pop_event(cbuffer_t &buf);

	/// number of stations (for tests)
	uint32 get_station_count() const { return stations.get_count(); }
	const il_route_t *get_route(uint16 id) const;

private:
	interlocking_manager_t() : next_id(1), last_wrong_route(0) {}
	~interlocking_manager_t() { reset(); }

	vector_tpl<il_station_t *> stations;
	vector_tpl<il_route_t *> routes;
	uint16 next_id;

	/// local events for the panel (not part of the game state)
	vector_tpl<plainstring> events;
	uint32 last_wrong_route; ///< only to avoid repeating the same event


	il_station_t *find_station(uint16 id) const;
	il_route_t *find_route(uint16 id) const;
	il_station_t *find_station_of_signal(koord3d pos) const;
	/// the station and departure whose anchor is pos (NULL if none)
	il_station_t *find_departure_anchor(koord3d pos, il_departure_t **dep = NULL) const;
	/// the station and departure that contains the platform tile pos (NULL if none)
	il_station_t *find_departure_track(koord3d pos, il_departure_t **dep = NULL) const;
	/// a registered start point of routes: interlocked signal or virtual departure signal
	bool is_start_point(const il_station_t *st, koord3d pos) const;
	/// tiles of the platform track at pos, and the end where trains leave
	static const char *platform_track(koord3d pos, vector_tpl<koord3d> &tiles, koord3d &anchor);
	/// same for a plain track without platform (siding, pull-out track): virtual shunting signal
	static const char *siding_track(koord3d pos, vector_tpl<koord3d> &tiles, koord3d &anchor);
	bool may_operate(const il_station_t *st, const player_t *player) const;

	void set_route_state(il_route_t *r, uint8 state);
	void push_event(const char *json);

	const char *cmd_set(il_route_t *r);
	/// replaces the route of the train from index start on and reserves it (shared by signals and departures)
	bool admit_train(rail_vehicle_t *v, uint16 start, il_route_t *r, sint32 &restart_speed, uint16 reserve_from);
	const char *cmd_cancel(il_route_t *r);
	/// route from a tile list made on the panel (start lever + destination button)
	const char *cmd_set_path(il_station_t *st, const char *path, const char *name);
	/// deletes temporary routes that are no longer set or occupied
	void purge_temp_routes();
	/// sets point levers: "x:y:z/value/a-b.c-d;..." (empty value = automatic), all or nothing
	const char *cmd_points(il_station_t *st, const char *spec);
	/// a point is locked when a set or occupied route runs over it or a train holds it
	bool point_locked(koord3d pos) const;
	/// NULL if the route agrees with all fixed point levers, otherwise an error
	const char *check_points(const il_route_t *r) const;

	/// breadth first search along the track from the start signal to the end tile
	static bool find_path(koord3d start, koord3d end, vector_tpl<koord3d> &tiles);

	/// builds the new route of the train from the interlocking route
	bool build_train_route(rail_vehicle_t *v, uint16 next_block, const il_route_t *r, vector_tpl<koord3d> &out) const;
};

#endif
