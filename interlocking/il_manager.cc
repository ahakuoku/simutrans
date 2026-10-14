/*
 * This file is part of the Simutrans project under the Artistic License.
 * (see LICENSE.txt)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "il_manager.h"
#include "il_json.h"

#include "../simworld.h"
#include "../simconvoi.h"
#include "../simhalt.h"
#include "../boden/grund.h"
#include "../boden/wege/schiene.h"
#include "../obj/signal.h"
#include "../vehicle/simvehicle.h"
#include "../dataobj/loadsave.h"
#include "../dataobj/route.h"
#include "../dataobj/ribi.h"
#include "../player/simplay.h"
#include "../utils/cbuffer_t.h"


// version of the interlocking data block in the savegame (independent of the OTRP version)
// 1: stations, signals, routes  2: + virtual departure signals  3: + temporary routes, names  4: + point levers
// 5: + kind (relay), operators, signal levers, point positions, timers
// 6: + kind of virtual signals (departure / shunting), sidings in other stops
// 7: + lever pairs (one lever for two signals)
// 8: + side of signal levers set by hand
// 9: + shunting levers (white / green), lever of turned levers and routes
#define IL_SAVE_VERSION 9

// ticks per second of game time at normal speed (time multiplier 16: one tick per millisecond)
#define IL_TICKS_PER_SECOND 1000

// maximum number of tiles searched when defining a route
#define IL_MAX_SEARCH_NODES 4096

// maximum number of tiles a route may have
#define IL_MAX_ROUTE_TILES 1024

// maximum number of pending events for the external panel
#define IL_MAX_EVENTS 256


static interlocking_manager_t *il_instance = NULL;


interlocking_manager_t *interlocking_manager_t::get()
{
	if(  il_instance == NULL  ) {
		il_instance = new interlocking_manager_t();
	}
	return il_instance;
}


void interlocking_manager_t::reset()
{
	clear_ptr_vector(stations);
	clear_ptr_vector(routes);
	next_id = 1;
	push_event("{\"type\":\"reset\"}");
}


// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

static const char *state_name(uint8 state)
{
	switch(  state  ) {
		case IL_SET:      return "set";
		case IL_OCCUPIED: return "occupied";
		case IL_RELEASING: return "releasing";
		default:          return "idle";
	}
}


/// t has been reached (tick counter may wrap)
static bool tick_reached(uint32 t)
{
	return (sint32)(world()->get_ticks() - t) >= 0;
}


/// seconds left until t (0 if reached)
static uint32 seconds_left(uint32 t)
{
	const sint32 d = (sint32)(t - world()->get_ticks());
	return d <= 0 ? 0 : (uint32)((d + IL_TICKS_PER_SECOND - 1) / IL_TICKS_PER_SECOND);
}


uint8 il_station_t::shunt_lever(koord3d pos) const
{
	for(  uint32 i = 0;  i < shunt_pos.get_count();  i++  ) {
		if(  shunt_pos[i] == pos  ) {
			return shunt_col[i];
		}
	}
	return 0;
}


il_slever_t *il_station_t::find_slever(koord3d pos, sint8 lever) const
{
	FOR(vector_tpl<il_slever_t *>, l, slevers) {
		if(  l->pos == pos  &&  (lever < 0  ||  l->lever == (uint8)lever)  ) {
			return l;
		}
	}
	return NULL;
}


sint32 il_station_t::find_pair(koord3d pos) const
{
	for(  uint32 i = 0;  i < pair_left.get_count();  i++  ) {
		if(  pair_left[i] == pos  ||  pair_right[i] == pos  ) {
			return (sint32)i;
		}
	}
	return -1;
}


/// removes the lever pairs with this start point (the signal is no longer registered)
static void remove_shunt_lever(il_station_t *st, koord3d pos)
{
	for(  uint32 i = st->shunt_pos.get_count();  i-- > 0;  ) {
		if(  st->shunt_pos[i] == pos  ) {
			st->shunt_pos.remove_at(i);
			st->shunt_col.remove_at(i);
		}
	}
}


static void remove_side(il_station_t *st, koord3d pos)
{
	for(  uint32 i = st->side_pos.get_count();  i-- > 0;  ) {
		if(  st->side_pos[i] == pos  ) {
			st->side_pos.remove_at(i);
			st->side_val.remove_at(i);
		}
	}
}


static void remove_pairs(il_station_t *st, koord3d pos)
{
	sint32 i;
	while(  (i = st->find_pair(pos)) >= 0  ) {
		st->pair_left.remove_at((uint32)i);
		st->pair_right.remove_at((uint32)i);
	}
}


il_point_t *il_station_t::find_point(koord3d pos) const
{
	FOR(vector_tpl<il_point_t *>, p, points) {
		if(  p->pos == pos  ) {
			return p;
		}
	}
	return NULL;
}


static schiene_t *get_rail(koord3d pos)
{
	grund_t *gr = world()->lookup(pos);
	return gr ? (schiene_t *)gr->get_weg(track_wt) : NULL;
}


static signal_t *get_signal(koord3d pos)
{
	grund_t *gr = world()->lookup(pos);
	return gr ? gr->find<signal_t>() : NULL;
}


il_station_t *interlocking_manager_t::find_station(uint16 id) const
{
	FOR(vector_tpl<il_station_t *>, st, stations) {
		if(  st->id == id  ) {
			return st;
		}
	}
	return NULL;
}


il_route_t *interlocking_manager_t::find_route(uint16 id) const
{
	FOR(vector_tpl<il_route_t *>, r, routes) {
		if(  r->id == id  ) {
			return r;
		}
	}
	return NULL;
}


const il_route_t *interlocking_manager_t::get_route(uint16 id) const
{
	return find_route(id);
}


il_station_t *interlocking_manager_t::find_station_of_signal(koord3d pos) const
{
	FOR(vector_tpl<il_station_t *>, st, stations) {
		if(  st->signals.is_contained(pos)  ) {
			return st;
		}
	}
	return NULL;
}


il_station_t *interlocking_manager_t::find_departure_anchor(koord3d pos, il_departure_t **dep) const
{
	FOR(vector_tpl<il_station_t *>, st, stations) {
		FOR(vector_tpl<il_departure_t *>, d, st->departures) {
			if(  d->anchor == pos  ) {
				if(  dep  ) *dep = d;
				return st;
			}
		}
	}
	return NULL;
}


il_station_t *interlocking_manager_t::find_departure_track(koord3d pos, il_departure_t **dep) const
{
	FOR(vector_tpl<il_station_t *>, st, stations) {
		FOR(vector_tpl<il_departure_t *>, d, st->departures) {
			if(  d->tiles.is_contained(pos)  ) {
				if(  dep  ) *dep = d;
				return st;
			}
		}
	}
	return NULL;
}


bool interlocking_manager_t::is_start_point(const il_station_t *st, koord3d pos) const
{
	if(  st->signals.is_contained(pos)  ) {
		return true;
	}
	FOR(vector_tpl<il_departure_t *>, d, st->departures) {
		if(  d->anchor == pos  ) {
			return true;
		}
	}
	return false;
}


const char *interlocking_manager_t::platform_track(koord3d pos, vector_tpl<koord3d> &tiles, koord3d &anchor)
{
	tiles.clear();
	grund_t *gr = world()->lookup(pos);
	if(  gr == NULL  ||  gr->get_weg(track_wt) == NULL  ) {
		return "no track at this position";
	}
	const halthandle_t halt = gr->get_halt();
	if(  !halt.is_bound()  ) {
		return siding_track(pos, tiles, anchor);
	}
	// all tiles of the same stop connected along this track
	vector_tpl<grund_t *> todo;
	todo.append(gr);
	tiles.append(pos);
	vector_tpl<koord3d> ends;
	for(  uint32 i = 0;  i < todo.get_count()  &&  tiles.get_count() < 256;  i++  ) {
		grund_t *g = todo[i];
		const ribi_t::ribi r = g->get_weg(track_wt)->get_ribi_unmasked();
		bool is_end = false;
		for(  int d = 0;  d < 4;  d++  ) {
			grund_t *to = NULL;
			if(  (r & ribi_t::nesw[d])  &&  g->get_neighbour(to, track_wt, ribi_t::nesw[d])  ) {
				if(  to->get_halt() == halt  ) {
					if(  !tiles.is_contained(to->get_pos())  ) {
						tiles.append(to->get_pos());
						todo.append(to);
					}
				}
				else {
					is_end = true; // the track goes on outside the platform
				}
			}
		}
		if(  is_end  ) {
			ends.append(g->get_pos());
		}
	}
	if(  ends.empty()  ) {
		return "the platform track is not connected";
	}
	if(  ends.is_contained(pos)  ) {
		anchor = pos;
	}
	else if(  ends.get_count() == 1  ) {
		anchor = ends[0];
	}
	else {
		return "click the platform end where trains leave";
	}
	return NULL;
}


/// plain track: no junction, no platform, no signal, no depot
static bool is_plain_track(const grund_t *gr)
{
	const weg_t *w = gr ? gr->get_weg(track_wt) : NULL;
	return w  &&  !ribi_t::is_threeway(w->get_ribi_unmasked())  &&  !gr->get_halt().is_bound()
		&&  !w->has_signal()  &&  gr->get_depot() == NULL;
}


const char *interlocking_manager_t::siding_track(koord3d pos, vector_tpl<koord3d> &tiles, koord3d &anchor)
{
	tiles.clear();
	grund_t *gr = world()->lookup(pos);
	if(  !is_plain_track(gr)  ) {
		return "not a platform or a plain track";
	}
	// the plain track between junctions, signals and platforms (a siding, a pull-out track)
	vector_tpl<grund_t *> todo;
	todo.append(gr);
	tiles.append(pos);
	vector_tpl<koord3d> ends;
	for(  uint32 i = 0;  i < todo.get_count()  &&  tiles.get_count() < 256;  i++  ) {
		grund_t *g = todo[i];
		const ribi_t::ribi r = g->get_weg(track_wt)->get_ribi_unmasked();
		bool is_end = false;
		for(  int d = 0;  d < 4;  d++  ) {
			grund_t *to = NULL;
			if(  (r & ribi_t::nesw[d])  &&  g->get_neighbour(to, track_wt, ribi_t::nesw[d])  ) {
				if(  is_plain_track(to)  ) {
					if(  !tiles.is_contained(to->get_pos())  ) {
						tiles.append(to->get_pos());
						todo.append(to);
					}
				}
				else {
					is_end = true; // the track goes on to a junction, a signal or a platform
				}
			}
		}
		if(  is_end  ) {
			ends.append(g->get_pos());
		}
	}
	if(  ends.empty()  ) {
		return "the track is not connected";
	}
	if(  ends.is_contained(pos)  ) {
		anchor = pos;
	}
	else if(  ends.get_count() == 1  ) {
		anchor = ends[0];
	}
	else {
		return "click the track end where trains leave";
	}
	return NULL;
}


bool interlocking_manager_t::train_stops_on(const convoi_t *cnv, const il_departure_t *dep) const
{
	// the train stops on this platform (its destination is a tile of it, or of the same stop)
	const koord3d dest = cnv->get_route()->back();
	if(  dep->tiles.is_contained(dest)  ) {
		return true;
	}
	const grund_t *a = world()->lookup(dep->anchor);
	const grund_t *d = world()->lookup(dest);
	return a  &&  d  &&  a->get_halt().is_bound()  &&  a->get_halt() == d->get_halt();
}


bool interlocking_manager_t::ends_behind_train(const il_route_t *r) const
{
	const uint32 n = r->tiles.get_count();
	if(  n < 2  ) {
		return false;
	}
	grund_t *gr = world()->lookup(r->tiles[n - 1]);
	grund_t *to = NULL;
	const ribi_t::ribi dir = ribi_type(r->tiles[n - 2], r->tiles[n - 1]);
	if(  gr == NULL  ||  !ribi_t::is_single(dir)  ||  !gr->get_neighbour(to, track_wt, dir)  ) {
		return false;
	}
	const schiene_t *sch = (const schiene_t *)to->get_weg(track_wt);
	if(  sch == NULL  ||  !sch->is_reserved()  ) {
		return false;
	}
	// only a train on the same platform or siding track (not one passing beyond its end)
	if(  gr->get_halt().is_bound()  ) {
		return to->get_halt() == gr->get_halt();
	}
	il_departure_t *dep = NULL;
	return find_departure_track(r->tiles[n - 1], &dep)  &&  dep->tiles.is_contained(to->get_pos());
}


uint32 interlocking_manager_t::room_at_end(const il_route_t *r) const
{
	// the tiles at the end that belong to the same stop, or to the same siding (virtual signal track)
	const koord3d end = r->tiles.back();
	const grund_t *egr = world()->lookup(end);
	const halthandle_t h = egr ? egr->get_halt() : halthandle_t();
	il_departure_t *dep = NULL;
	if(  !h.is_bound()  ) {
		find_departure_track(end, &dep);
	}
	uint32 room = 0;
	for(  uint32 i = r->tiles.get_count();  i-- > 1;  ) {
		const grund_t *gr = world()->lookup(r->tiles[i]);
		const bool same = h.is_bound() ? (gr  &&  gr->get_halt() == h) : (dep  &&  dep->tiles.is_contained(r->tiles[i]));
		if(  !same  ) {
			break;
		}
		room++;
	}
	return room;
}


bool interlocking_manager_t::may_operate(const il_station_t *st, const player_t *player) const
{
	if(  player  &&  st->operators.is_contained(player->get_player_nr())  ) {
		return true;
	}
	return may_manage(st, player);
}


bool interlocking_manager_t::may_manage(const il_station_t *st, const player_t *player) const
{
	return player_t::check_owner(world()->get_player(st->owner), player);
}


bool interlocking_manager_t::is_shunt_start(koord3d pos) const
{
	il_departure_t *dep = NULL;
	return find_departure_anchor(pos, &dep)  &&  dep->kind == 1;
}


il_station_t *interlocking_manager_t::find_departure_of_train(const rail_vehicle_t *v, il_departure_t **dep, uint16 &k) const
{
	const convoi_t *cnv = v->get_convoi();
	const route_t *rt = cnv->get_route();
	const uint16 from = max(v->get_route_index(), (uint16)1) - 1;
	FOR(vector_tpl<il_station_t *>, st, stations) {
		FOR(vector_tpl<il_departure_t *>, d, st->departures) {
			if(  !d->tiles.is_contained(v->get_pos())  ) {
				continue;
			}
			// the train must leave over the anchor (the end with the routes of this signal)
			for(  uint32 i = from;  i < rt->get_count();  i++  ) {
				if(  rt->at(i) == d->anchor  ) {
					k = (uint16)i;
					*dep = d;
					return st;
				}
			}
		}
	}
	return NULL;
}


bool interlocking_manager_t::train_approaching(const il_route_t *r) const
{
	il_departure_t *dep = NULL;
	if(  find_departure_anchor(r->tiles[0], &dep)  ) {
		// virtual departure / shunting signal: a train on the platform track (siding)
		FOR(vector_tpl<koord3d>, const &t, dep->tiles) {
			const schiene_t *sch = get_rail(t);
			if(  sch  &&  sch->is_reserved()  ) {
				return true;
			}
		}
		return false;
	}
	// a train in the block in rear of the signal reserves up to the signal tile
	const schiene_t *sch = get_rail(r->tiles[0]);
	return sch  &&  sch->is_reserved();
}


uint32 interlocking_manager_t::throw_points(il_station_t *st, const il_route_t *r)
{
	const uint32 now = world()->get_ticks();
	uint32 ready = now;
	for(  uint32 i = 1;  i + 1 < r->tiles.get_count();  i++  ) {
		const schiene_t *sch = get_rail(r->tiles[i]);
		if(  sch == NULL  ||  !ribi_t::is_threeway(sch->get_ribi_unmasked())  ) {
			continue;
		}
		const uint8 a = ribi_type(r->tiles[i], r->tiles[i - 1]);
		const uint8 b = ribi_type(r->tiles[i], r->tiles[i + 1]);
		il_point_t *pt = st->find_point(r->tiles[i]);
		if(  pt == NULL  ) {
			pt = new il_point_t();
			pt->pos = r->tiles[i];
			pt->a = pt->b = 0;
			pt->moving_until = now;
			st->points.append(pt);
		}
		if(  !((pt->a == a  &&  pt->b == b)  ||  (pt->a == b  &&  pt->b == a))  ) {
			pt->a = a;
			pt->b = b;
			pt->moving_until = now + st->t_throw * IL_TICKS_PER_SECOND;
		}
		if(  !tick_reached(pt->moving_until)  &&  (sint32)(pt->moving_until - ready) > 0  ) {
			ready = pt->moving_until;
		}
	}
	return ready;
}


bool interlocking_manager_t::may_clear(const il_route_t *r) const
{
	const il_station_t *st = find_station(r->station);
	if(  st == NULL  ) {
		return true;
	}
	if(  st->all_stop  ) {
		return false;
	}
	return st->kind != IL_RELAY  ||  tick_reached(r->ready_at);
}


const char *interlocking_manager_t::cmd_signal_lever(il_station_t *st, koord3d pos, char side, uint8 lever)
{
	if(  st->kind != IL_RELAY  ) {
		return "only on a relay panel";
	}
	if(  !is_start_point(st, pos)  ) {
		return "start is not a registered signal of this station";
	}
	if(  lever  &&  !st->shunt_lever(pos)  ) {
		return "no shunting lever at this signal";
	}
	il_slever_t *l = st->find_slever(pos, (sint8)lever);
	if(  side == 'L'  ||  side == 'R'  ) {
		if(  !st->manual  ) {
			return "station is in automatic mode";
		}
		if(  l  ) {
			return l->side == side ? NULL : "turn the lever back first";
		}
		const sint32 pi = lever ? -1 : st->find_pair(pos);
		if(  pi >= 0  ) {
			// one lever for two signals: each signal has its side, and the lever turns to one side only
			const koord3d other = st->pair_left[(uint32)pi] == pos ? st->pair_right[(uint32)pi] : st->pair_left[(uint32)pi];
			if(  side != (st->pair_left[(uint32)pi] == pos ? 'L' : 'R')  ) {
				return "this side belongs to the other signal of the lever";
			}
			if(  st->find_slever(other)  ) {
				return "turn the lever back first";
			}
		}
		// only one lever may wait for its destination button: the button belongs to that lever
		FOR(vector_tpl<il_slever_t *>, o, st->slevers) {
			if(  !o->used  ) {
				return "another lever is waiting for its destination";
			}
		}
		l = new il_slever_t();
		l->pos = pos;
		l->side = (uint8)side;
		l->used = false;
		l->lever = lever;
		st->slevers.append(l);
		return NULL;
	}
	// back to normal: a route that is set with this lever is cancelled (with approach locking)
	FOR(vector_tpl<il_route_t *>, r, routes) {
		if(  r->tiles[0] == pos  &&  r->state == IL_SET  &&  r->shunt == (lever != 0)  ) {
			cmd_cancel(r);
		}
	}
	if(  l  ) {
		st->slevers.remove(l);
		delete l;
	}
	return NULL;
}



void interlocking_manager_t::push_event(const char *json)
{
	// events are only for the local external panel; drop the oldest when nobody reads them
	if(  events.get_count() >= IL_MAX_EVENTS  ) {
		events.remove_at(0);
	}
	events.append(plainstring(json));
}


bool interlocking_manager_t::pop_event(cbuffer_t &buf)
{
	if(  events.empty()  ) {
		return false;
	}
	buf.append(events[0].c_str());
	events.remove_at(0);
	return true;
}


void interlocking_manager_t::set_route_state(il_route_t *r, uint8 state)
{
	if(  r->state == state  ) {
		return;
	}
	r->state = state;
	if(  state != IL_OCCUPIED  ) {
		r->convoy = convoihandle_t();
	}
	cbuffer_t buf;
	buf.printf("{\"type\":\"route\",\"id\":%u,\"station\":%u,\"state\":\"%s\"", r->id, r->station, state_name(state));
	if(  state == IL_OCCUPIED  &&  r->convoy.is_bound()  ) {
		buf.append(",\"convoy\":");
		append_json_string(buf, r->convoy->get_name());
	}
	buf.append("}");
	push_event(buf);
}


// ---------------------------------------------------------------------------
// route search (used only when a route is defined)
// ---------------------------------------------------------------------------

bool interlocking_manager_t::find_path(koord3d start, koord3d end, vector_tpl<koord3d> &tiles)
{
	struct node_t {
		koord3d pos;
		ribi_t::ribi dir;   ///< direction of travel when entering this tile
		sint32 parent;
	};
	vector_tpl<node_t> nodes;

	tiles.clear();

	grund_t *gr = world()->lookup(start);
	weg_t *w = gr ? gr->get_weg(track_wt) : NULL;
	if(  w == NULL  ) {
		return false;
	}

	node_t first;
	first.pos = start;
	first.dir = ribi_t::none;
	first.parent = -1;
	nodes.append(first);

	for(  uint32 i = 0;  i < nodes.get_count()  &&  nodes.get_count() < IL_MAX_SEARCH_NODES;  i++  ) {
		const node_t cur = nodes[i];
		if(  i > 0  &&  cur.pos == end  ) {
			// found: collect the tiles backwards
			vector_tpl<koord3d> rev;
			for(  sint32 n = (sint32)i;  n >= 0;  n = nodes[n].parent  ) {
				rev.append(nodes[n].pos);
			}
			for(  sint32 n = (sint32)rev.get_count() - 1;  n >= 0;  n--  ) {
				tiles.append(rev[n]);
			}
			return tiles.get_count() <= IL_MAX_ROUTE_TILES;
		}

		grund_t *g = world()->lookup(cur.pos);
		weg_t *way = g ? g->get_weg(track_wt) : NULL;
		if(  way == NULL  ) {
			continue;
		}
		// get_ribi() respects the masks of one way signals, so a train can only leave
		// the start signal in its direction of travel
		ribi_t::ribi exits = way->get_ribi();
		if(  cur.dir != ribi_t::none  ) {
			// no reversing on the track
			exits &= ~ribi_t::backward(cur.dir);
		}
		for(  int d = 0;  d < 4;  d++  ) {
			const ribi_t::ribi dir = ribi_t::nesw[d];
			if(  (exits & dir) == 0  ) {
				continue;
			}
			grund_t *to = NULL;
			if(  !g->get_neighbour(to, track_wt, dir)  ) {
				continue;
			}
			const koord3d npos = to->get_pos();
			// visited with the same direction?
			bool visited = false;
			FOR(vector_tpl<node_t>, const &n, nodes) {
				if(  n.pos == npos  &&  n.dir == dir  ) {
					visited = true;
					break;
				}
			}
			if(  visited  ) {
				continue;
			}
			node_t nn;
			nn.pos = npos;
			nn.dir = dir;
			nn.parent = (sint32)i;
			nodes.append(nn);
		}
	}
	return false;
}


// ---------------------------------------------------------------------------
// commands (executed on all clients by tool_interlocking_t)
// ---------------------------------------------------------------------------

// splits param at commas; the last field takes the rest of the string
static uint32 split_param(char *buf, char **fields, uint32 max_fields)
{
	uint32 n = 0;
	char *p = buf;
	while(  n < max_fields  ) {
		fields[n++] = p;
		if(  n == max_fields  ) {
			break;
		}
		char *c = strchr(p, ',');
		if(  c == NULL  ) {
			break;
		}
		*c = 0;
		p = c + 1;
	}
	return n;
}


const char *interlocking_manager_t::execute(const char *param, player_t *player)
{
	if(  param == NULL  ) {
		return "no command";
	}

	char buf[4096];
	strncpy(buf, param, sizeof(buf) - 1);
	buf[sizeof(buf) - 1] = 0;

	// names may contain commas: they are the last field of st_new and rt_def
	uint32 max_fields = 10;
	if(  strncmp(buf, "st_new,", 7) == 0  ) {
		max_fields = 2;
	}
	else if(  strncmp(buf, "rt_def,", 7) == 0  ) {
		max_fields = 9;
	}
	else if(  strncmp(buf, "set_path,", 9) == 0  ||  strncmp(buf, "set_path_s,", 11) == 0  ||  strncmp(buf, "rt_path,", 8) == 0  ) {
		max_fields = 4;
	}
	else if(  strncmp(buf, "rt_name,", 8) == 0  ||  strncmp(buf, "st_sid,", 7) == 0  ) {
		max_fields = 3;
	}
	else if(  strncmp(buf, "name_set,", 9) == 0  ) {
		max_fields = 6;
	}
	else if(  strncmp(buf, "pt_set,", 7) == 0  ) {
		max_fields = 3;
	}
	char *f[10];
	const uint32 n = split_param(buf, f, max_fields);
	const char *cmd = f[0];
	const char *error = NULL;

	if(  strcmp(cmd, "st_new") == 0  &&  n >= 2  ) {
		il_station_t *st = new il_station_t();
		st->id = next_id++;
		st->name = f[1];
		st->owner = player ? player->get_player_nr() : 1;
		st->manual = false;
		stations.append(st);
		cbuffer_t ev;
		ev.printf("{\"type\":\"station\",\"id\":%u,\"name\":", st->id);
		append_json_string(ev, st->name.c_str());
		ev.append("}");
		push_event(ev);
	}
	else if(  strcmp(cmd, "st_del") == 0  &&  n >= 2  ) {
		il_station_t *st = find_station((uint16)atoi(f[1]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_manage(st, player)  ) {
			error = "not owner";
		}
		else {
			for(  uint32 i = routes.get_count();  i-- > 0;  ) {
				if(  routes[i]->station == st->id  ) {
					delete routes[i];
					routes.remove_at(i);
				}
			}
			stations.remove(st);
			delete st;
		}
	}
	else if(  strcmp(cmd, "st_mode") == 0  &&  n >= 3  ) {
		il_station_t *st = find_station((uint16)atoi(f[1]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else {
			st->manual = atoi(f[2]) != 0;
			if(  !st->manual  ) {
				// back to automatic: all routes waiting for a train are cancelled, the levers go back
				FOR(vector_tpl<il_route_t *>, r, routes) {
					if(  r->station == st->id  &&  (r->state == IL_SET  ||  r->state == IL_RELEASING)  ) {
						set_route_state(r, IL_IDLE);
					}
				}
				clear_ptr_vector(st->slevers);
			}
			cbuffer_t ev;
			ev.printf("{\"type\":\"mode\",\"station\":%u,\"manual\":%s}", st->id, st->manual ? "true" : "false");
			push_event(ev);
		}
	}
	else if(  (strcmp(cmd, "sig_add") == 0  ||  strcmp(cmd, "sig_del") == 0)  &&  n >= 5  ) {
		il_station_t *st = find_station((uint16)atoi(f[1]));
		const koord3d pos((sint16)atoi(f[2]), (sint16)atoi(f[3]), (sint8)atoi(f[4]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else if(  cmd[4] == 'a'  ) {
			il_station_t *other = find_station_of_signal(pos);
			if(  get_signal(pos) == NULL  ||  get_rail(pos) == NULL  ) {
				error = "no rail signal at this position";
			}
			else if(  other  ) {
				error = other == st ? "signal already registered" : "signal belongs to another station";
			}
			else {
				st->signals.append(pos);
			}
		}
		else {
			if(  !st->signals.remove(pos)  ) {
				error = "signal not registered";
			}
			else {
				remove_pairs(st, pos);
				remove_side(st, pos);
				remove_shunt_lever(st, pos);
			}
		}
	}
	else if(  (strcmp(cmd, "dep_add") == 0  ||  strcmp(cmd, "dep_del") == 0)  &&  n >= 5  ) {
		il_station_t *st = find_station((uint16)atoi(f[1]));
		const koord3d pos((sint16)atoi(f[2]), (sint16)atoi(f[3]), (sint8)atoi(f[4]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else if(  cmd[4] == 'a'  ) {
			// a track may have one virtual signal at each end (sidings that can be left both ways)
			il_departure_t *d = new il_departure_t();
			if(  (error = platform_track(pos, d->tiles, d->anchor)) == NULL  ) {
				const grund_t *agr = world()->lookup(d->anchor);
				// D = departure signal, S = shunting signal; default: departure at a platform
				d->kind = n >= 6 ? (f[5][0] == 'S' ? 1 : 0) : (agr  &&  agr->get_halt().is_bound() ? 0 : 1);
				FOR(vector_tpl<il_station_t *>, ost, stations) {
					FOR(vector_tpl<il_departure_t *>, od, ost->departures) {
						if(  od->anchor == d->anchor  ) {
							error = ost == st ? "platform already registered" : "platform belongs to another station";
						}
						else if(  ost != st  &&  od->tiles.is_contained(d->anchor)  ) {
							error = "platform belongs to another station";
						}
					}
				}
			}
			if(  error  ) {
				delete d;
			}
			else {
				st->departures.append(d);
			}
		}
		else {
			// the signal at this end, or the only one of this track
			il_departure_t *existing = NULL;
			uint32 on_track = 0;
			FOR(vector_tpl<il_departure_t *>, d, st->departures) {
				if(  d->anchor == pos  ) {
					existing = d;
					on_track = 1;
					break;
				}
				if(  d->tiles.is_contained(pos)  ) {
					existing = d;
					on_track++;
				}
			}
			if(  existing == NULL  ) {
				error = "platform not registered";
			}
			else if(  on_track > 1  ) {
				error = "click the platform end where trains leave";
			}
			else {
				remove_pairs(st, existing->anchor);
				remove_side(st, existing->anchor);
				remove_shunt_lever(st, existing->anchor);
				st->departures.remove(existing);
				delete existing;
			}
		}
	}
	else if(  strcmp(cmd, "st_cfg") == 0  &&  n >= 7  ) {
		// kind, panel orientation, time releases and throwing time
		il_station_t *st = find_station((uint16)atoi(f[1]));
		const uint8 kind = (uint8)atoi(f[2]);
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_manage(st, player)  ) {
			error = "not owner";
		}
		else if(  kind > IL_RELAY  ) {
			error = "bad setting";
		}
		else {
			if(  kind != st->kind  ) {
				FOR(vector_tpl<il_route_t *>, r, routes) {
					if(  r->station == st->id  &&  r->state != IL_IDLE  ) {
						error = "release all routes first";
					}
				}
			}
			if(  !error  ) {
				st->kind = kind;
				st->rot = (uint8)(atoi(f[3]) & 3);
				st->t_approach = (uint16)clamp(atoi(f[4]), 0, 600);
				st->t_shunt = (uint16)clamp(atoi(f[5]), 0, 600);
				st->t_throw = (uint16)clamp(atoi(f[6]), 0, 60);
				if(  kind != IL_RELAY  ) {
					clear_ptr_vector(st->slevers);
					clear_ptr_vector(st->points);
				}
			}
		}
	}
	else if(  strcmp(cmd, "st_ops") == 0  &&  n >= 2  ) {
		// further companies that may operate the station: "nr.nr.nr" (empty = owner only)
		il_station_t *st = find_station((uint16)atoi(f[1]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_manage(st, player)  ) {
			error = "not owner";
		}
		else {
			st->operators.clear();
			for(  const char *q = n >= 3 ? f[2] : "";  *q;  ) {
				const int nr = atoi(q);
				if(  nr >= 0  &&  nr < MAX_PLAYER_COUNT  &&  nr != st->owner  &&  !st->operators.is_contained((uint8)nr)  ) {
					st->operators.append((uint8)nr);
				}
				while(  *q  &&  *q != '.'  ) {
					q++;
				}
				if(  *q  ) {
					q++;
				}
			}
		}
	}
	else if(  strcmp(cmd, "st_sid") == 0  &&  n >= 2  ) {
		// other stops in the area that are used as sidings: "x:y:z;x:y:z" (one tile of each)
		il_station_t *st = find_station((uint16)atoi(f[1]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else {
			st->siding_halts.clear();
			for(  const char *q = n >= 3 ? f[2] : "";  q  &&  *q;  ) {
				int x, y, z;
				if(  sscanf(q, "%d:%d:%d", &x, &y, &z) == 3  ) {
					st->siding_halts.append(koord3d((sint16)x, (sint16)y, (sint8)z));
				}
				q = strchr(q, ';');
				if(  q  ) {
					q++;
				}
			}
		}
	}
	else if(  strcmp(cmd, "lv_pair") == 0  &&  n >= 8  ) {
		// one lever for two signals: left signal, right signal
		il_station_t *st = find_station((uint16)atoi(f[1]));
		const koord3d pl((sint16)atoi(f[2]), (sint16)atoi(f[3]), (sint8)atoi(f[4]));
		const koord3d pr((sint16)atoi(f[5]), (sint16)atoi(f[6]), (sint8)atoi(f[7]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else if(  !is_start_point(st, pl)  ||  !is_start_point(st, pr)  ) {
			error = "start is not a registered signal of this station";
		}
		else if(  pl == pr  ||  st->find_pair(pl) >= 0  ||  st->find_pair(pr) >= 0  ) {
			error = "the signal already has a lever pair";
		}
		else if(  st->find_slever(pl)  ||  st->find_slever(pr)  ) {
			error = "turn the lever back first";
		}
		else {
			st->pair_left.append(pl);
			st->pair_right.append(pr);
		}
	}
	else if(  strcmp(cmd, "lv_side") == 0  &&  n >= 6  ) {
		// the side a signal lever turns to: L / R, or A = decided by the panel
		il_station_t *st = find_station((uint16)atoi(f[1]));
		const koord3d pos((sint16)atoi(f[2]), (sint16)atoi(f[3]), (sint8)atoi(f[4]));
		const char side = f[5][0];
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else if(  !is_start_point(st, pos)  ) {
			error = "start is not a registered signal of this station";
		}
		else if(  st->find_slever(pos)  ) {
			error = "turn the lever back first";
		}
		else {
			remove_side(st, pos);
			if(  side == 'L'  ||  side == 'R'  ) {
				st->side_pos.append(pos);
				st->side_val.append((uint8)side);
			}
		}
	}
	else if(  strcmp(cmd, "lv_shunt") == 0  &&  n >= 6  ) {
		// an extra shunting lever at a start point: W (white, 入換信号機), G (green, 入換標識) or N (none)
		il_station_t *st = find_station((uint16)atoi(f[1]));
		const koord3d pos((sint16)atoi(f[2]), (sint16)atoi(f[3]), (sint8)atoi(f[4]));
		const char col = f[5][0];
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else if(  !is_start_point(st, pos)  ) {
			error = "start is not a registered signal of this station";
		}
		else if(  st->find_slever(pos, 1)  ) {
			error = "turn the lever back first";
		}
		else {
			remove_shunt_lever(st, pos);
			if(  col == 'W'  ||  col == 'G'  ||  col == 'P'  ) {
				st->shunt_pos.append(pos);
				st->shunt_col.append((uint8)col);
			}
		}
	}
	else if(  strcmp(cmd, "lv_unpair") == 0  &&  n >= 5  ) {
		il_station_t *st = find_station((uint16)atoi(f[1]));
		const koord3d pos((sint16)atoi(f[2]), (sint16)atoi(f[3]), (sint8)atoi(f[4]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else if(  st->find_pair(pos) < 0  ) {
			error = "no lever pair";
		}
		else {
			remove_pairs(st, pos);
		}
	}
	else if(  strcmp(cmd, "st_stop") == 0  &&  n >= 3  ) {
		il_station_t *st = find_station((uint16)atoi(f[1]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else {
			st->all_stop = atoi(f[2]) != 0;
		}
	}
	else if(  strcmp(cmd, "sl_turn") == 0  &&  n >= 6  ) {
		il_station_t *st = find_station((uint16)atoi(f[1]));
		const koord3d pos((sint16)atoi(f[2]), (sint16)atoi(f[3]), (sint8)atoi(f[4]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else {
			error = cmd_signal_lever(st, pos, f[5][0], n >= 7  &&  f[6][0] == 'S' ? 1 : 0);
		}
	}
	else if(  (strcmp(cmd, "set_path") == 0  ||  strcmp(cmd, "set_path_s") == 0)  &&  n >= 3  ) {
		il_station_t *st = find_station((uint16)atoi(f[1]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else if(  !st->manual  ) {
			error = "station is in automatic mode";
		}
		else {
			error = cmd_set_path(st, f[2], n >= 4 ? f[3] : "", cmd[8] == '_');
		}
	}
	else if(  strcmp(cmd, "pt_set") == 0  &&  n >= 3  ) {
		il_station_t *st = find_station((uint16)atoi(f[1]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else {
			error = cmd_points(st, f[2]);
		}
	}
	else if(  strcmp(cmd, "name_set") == 0  &&  n >= 5  ) {
		il_station_t *st = find_station((uint16)atoi(f[1]));
		const koord3d pos((sint16)atoi(f[2]), (sint16)atoi(f[3]), (sint8)atoi(f[4]));
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else {
			const char *name = n >= 6 ? f[5] : "";
			// note: vector_tpl::index_of() asserts when the element is missing
			for(  uint32 i = 0;  i < st->label_pos.get_count();  i++  ) {
				if(  st->label_pos[i] == pos  ) {
					st->label_pos.remove_at(i);
					st->label_names.remove_at(i);
					break;
				}
			}
			if(  *name  ) {
				st->label_pos.append(pos);
				st->label_names.append(plainstring(name));
			}
		}
	}
	else if(  strcmp(cmd, "rt_def") == 0  &&  n >= 8  ) {
		il_station_t *st = find_station((uint16)atoi(f[1]));
		const koord3d start((sint16)atoi(f[2]), (sint16)atoi(f[3]), (sint8)atoi(f[4]));
		const koord3d end((sint16)atoi(f[5]), (sint16)atoi(f[6]), (sint8)atoi(f[7]));
		vector_tpl<koord3d> tiles;
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else if(  !is_start_point(st, start)  ) {
			error = "start is not a registered signal of this station";
		}
		else if(  start == end  ) {
			error = "start and end are the same tile";
		}
		else if(  !find_path(start, end, tiles)  ) {
			error = "no track from the start signal to the end tile";
		}
		else {
			il_route_t *r = new il_route_t();
			r->id = next_id++;
			r->station = st->id;
			r->name = n >= 9 ? f[8] : "";
			FOR(vector_tpl<koord3d>, const &t, tiles) {
				r->tiles.append(t);
			}
			r->state = IL_IDLE;
			routes.append(r);
			cbuffer_t ev;
			ev.printf("{\"type\":\"route_defined\",\"id\":%u,\"station\":%u,\"tiles\":%u}", r->id, st->id, r->tiles.get_count());
			push_event(ev);
		}
	}
	else if(  strcmp(cmd, "rt_path") == 0  &&  n >= 3  ) {
		// a predefined route along a given tile list (made by the panel)
		il_station_t *st = find_station((uint16)atoi(f[1]));
		vector_tpl<koord3d> tiles;
		if(  st == NULL  ) {
			error = "unknown station";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else if(  (error = parse_path(st, f[2], tiles)) == NULL  ) {
			il_route_t *r = new_route(st, tiles, n >= 4 ? f[3] : "", false);
			cbuffer_t ev;
			ev.printf("{\"type\":\"route_defined\",\"id\":%u,\"station\":%u,\"tiles\":%u}", r->id, st->id, r->tiles.get_count());
			push_event(ev);
		}
	}
	else if(  strcmp(cmd, "rt_del") == 0  &&  n >= 2  ) {
		il_route_t *r = find_route((uint16)atoi(f[1]));
		il_station_t *st = r ? find_station(r->station) : NULL;
		if(  r == NULL  ||  st == NULL  ) {
			error = "unknown route";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else if(  r->state == IL_OCCUPIED  ) {
			error = "route is occupied";
		}
		else {
			routes.remove(r);
			delete r;
		}
	}
	else if(  strcmp(cmd, "rt_name") == 0  &&  n >= 2  ) {
		il_route_t *r = find_route((uint16)atoi(f[1]));
		il_station_t *st = r ? find_station(r->station) : NULL;
		if(  r == NULL  ||  st == NULL  ) {
			error = "unknown route";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else {
			r->name = n >= 3 ? f[2] : "";
		}
	}
	else if(  (strcmp(cmd, "set") == 0  ||  strcmp(cmd, "cancel") == 0)  &&  n >= 2  ) {
		il_route_t *r = find_route((uint16)atoi(f[1]));
		il_station_t *st = r ? find_station(r->station) : NULL;
		if(  r == NULL  ||  st == NULL  ) {
			error = "unknown route";
		}
		else if(  !may_operate(st, player)  ) {
			error = "not owner";
		}
		else if(  cmd[0] == 's'  ) {
			error = !st->manual ? "station is in automatic mode" : st->kind == IL_RELAY ? "use the levers on a relay panel" : cmd_set(r);
		}
		else {
			error = cmd_cancel(r);
		}
	}
	else {
		error = "unknown command or missing parameters";
	}

	purge_temp_routes();

	cbuffer_t ev;
	ev.append("{\"type\":\"result\",\"command\":");
	append_json_string(ev, param);
	ev.printf(",\"ok\":%s", error ? "false" : "true");
	if(  error  ) {
		ev.append(",\"error\":");
		append_json_string(ev, error);
	}
	ev.append("}");
	push_event(ev);

	return error;
}


const char *interlocking_manager_t::cmd_set(il_route_t *r)
{
	if(  r->state != IL_IDLE  ) {
		return "route is not idle";
	}
	// conflicting routes: any other route that is set and shares a tile
	FOR(vector_tpl<il_route_t *>, o, routes) {
		if(  o == r  ||  (o->state != IL_SET  &&  o->state != IL_RELEASING)  ) {
			continue;
		}
		if(  o->tiles[0] == r->tiles[0]  ) {
			return "another route from this signal is set";
		}
		FOR(vector_tpl<koord3d>, const &t, r->tiles) {
			// a route may start where another ends (home route up to the platform end, departure route from there)
			if(  (t == r->tiles[0]  &&  t == o->tiles.back())  ||  (t == r->tiles.back()  &&  t == o->tiles[0])  ) {
				continue;
			}
			if(  o->tiles.is_contained(t)  ) {
				return "conflicting route is set";
			}
		}
	}
	if(  const char *pe = check_points(r)  ) {
		return pe;
	}
	// the track must exist and be free; tiles[0] (the signal) belongs to the block in front of it
	for(  uint32 i = 1;  i < r->tiles.get_count();  i++  ) {
		schiene_t *sch = get_rail(r->tiles[i]);
		if(  sch == NULL  ) {
			return "track of the route is missing";
		}
		if(  sch->is_reserved()  ) {
			return "track is occupied";
		}
	}
	if(  get_signal(r->tiles[0]) == NULL  &&  find_departure_anchor(r->tiles[0]) == NULL  ) {
		return "start signal is missing";
	}
	set_route_state(r, IL_SET);
	return NULL;
}


const char *interlocking_manager_t::cmd_cancel(il_route_t *r)
{
	if(  r->state == IL_OCCUPIED  ) {
		return "train already admitted";
	}
	if(  r->state == IL_IDLE  ) {
		return "route is not set";
	}
	if(  r->state == IL_RELEASING  ) {
		return NULL; // the time release is running already
	}
	il_station_t *st = find_station(r->station);
	if(  st  &&  st->kind == IL_RELAY  &&  train_approaching(r)  ) {
		// approach locking: the route stays locked until the time release runs out
		const uint16 t = is_shunt_start(r->tiles[0])  ||  r->shunt ? st->t_shunt : st->t_approach;
		if(  t > 0  ) {
			r->release_at = world()->get_ticks() + t * IL_TICKS_PER_SECOND;
			set_route_state(r, IL_RELEASING);
			return NULL;
		}
	}
	set_route_state(r, IL_IDLE);
	return NULL;
}


bool interlocking_manager_t::point_locked(koord3d pos) const
{
	FOR(vector_tpl<il_route_t *>, r, routes) {
		if(  r->state != IL_IDLE  &&  r->tiles.is_contained(pos)  ) {
			return true;
		}
	}
	const schiene_t *sch = get_rail(pos);
	return sch  &&  sch->is_reserved();
}


const char *interlocking_manager_t::cmd_points(il_station_t *st, const char *spec)
{
	// parse everything first: all or nothing (both points of a crossover move together)
	vector_tpl<il_lever_t *> parsed;
	const char *error = NULL;
	for(  const char *p = spec;  p  &&  *p  &&  !error;  ) {
		int x, y, z;
		if(  sscanf(p, "%d:%d:%d", &x, &y, &z) != 3  ) {
			error = "bad point lever";
			break;
		}
		il_lever_t *lv = new il_lever_t();
		parsed.append(lv);
		lv->pos = koord3d((sint16)x, (sint16)y, (sint8)z);
		const char *end = strchr(p, ';');
		const char *s1 = strchr(p, '/');
		if(  s1  &&  (!end  ||  s1 < end)  ) {
			const char *s2 = strchr(s1 + 1, '/');
			if(  s2 == NULL  ||  (end  &&  s2 > end)  ) {
				error = "bad point lever";
				break;
			}
			char val[32];
			const size_t vl = min((size_t)(s2 - s1 - 1), sizeof(val) - 1);
			memcpy(val, s1 + 1, vl);
			val[vl] = 0;
			lv->value = val;
			// pairs "a-b.c-d"
			for(  const char *q = s2 + 1;  *q  &&  q != end;  ) {
				int a, b;
				if(  sscanf(q, "%d-%d", &a, &b) != 2  ) {
					error = "bad point lever";
					break;
				}
				lv->pairs.append((uint8)a);
				lv->pairs.append((uint8)b);
				while(  *q  &&  *q != '.'  &&  q != end  ) {
					q++;
				}
				if(  *q == '.'  ) {
					q++;
				}
			}
		}
		// check the tile
		grund_t *gr = world()->lookup(lv->pos);
		weg_t *w = gr ? gr->get_weg(track_wt) : NULL;
		if(  !error  &&  (w == NULL  ||  ribi_t::is_threeway(w->get_ribi_unmasked()) == false)  ) {
			error = "no point at this position";
		}
		for(  uint32 i = 0;  !error  &&  i < lv->pairs.get_count();  i++  ) {
			const uint8 leg = lv->pairs[i];
			if(  !ribi_t::is_single(leg)  ||  (w->get_ribi_unmasked() & leg) == 0  ) {
				error = "bad point lever";
			}
		}
		if(  !error  &&  point_locked(lv->pos)  ) {
			error = "the point is locked";
		}
		p = end ? end + 1 : NULL;
	}
	if(  !error  ) {
		FOR(vector_tpl<il_lever_t *>, lv, parsed) {
			// replace the old position of this point
			for(  uint32 i = 0;  i < st->levers.get_count();  i++  ) {
				if(  st->levers[i]->pos == lv->pos  ) {
					delete st->levers[i];
					st->levers.remove_at(i);
					break;
				}
			}
			if(  lv->value.c_str()  &&  *lv->value.c_str()  &&  !lv->pairs.empty()  ) {
				st->levers.append(lv);
				if(  st->kind == IL_RELAY  ) {
					// the point moves into the position of the lever (throwing time)
					il_point_t *pt = st->find_point(lv->pos);
					if(  pt == NULL  ) {
						pt = new il_point_t();
						pt->pos = lv->pos;
						pt->a = pt->b = 0;
						st->points.append(pt);
					}
					bool in_place = false;
					for(  uint32 j = 0;  j + 1 < lv->pairs.get_count();  j += 2  ) {
						if(  (pt->a == lv->pairs[j]  &&  pt->b == lv->pairs[j + 1])  ||  (pt->b == lv->pairs[j]  &&  pt->a == lv->pairs[j + 1])  ) {
							in_place = true;
						}
					}
					if(  !in_place  ) {
						pt->a = lv->pairs[0];
						pt->b = lv->pairs[1];
						pt->moving_until = world()->get_ticks() + st->t_throw * IL_TICKS_PER_SECOND;
					}
				}
			}
			else {
				delete lv; // automatic
			}
		}
		return NULL;
	}
	clear_ptr_vector(parsed);
	return error;
}


const char *interlocking_manager_t::check_points(const il_route_t *r) const
{
	for(  uint32 i = 1;  i + 1 < r->tiles.get_count();  i++  ) {
		FOR(vector_tpl<il_station_t *>, st, stations) {
			FOR(vector_tpl<il_lever_t *>, lv, st->levers) {
				if(  lv->pos != r->tiles[i]  ) {
					continue;
				}
				const uint8 a = ribi_type(r->tiles[i], r->tiles[i - 1]);
				const uint8 b = ribi_type(r->tiles[i], r->tiles[i + 1]);
				bool ok = false;
				for(  uint32 j = 0;  j + 1 < lv->pairs.get_count();  j += 2  ) {
					if(  (lv->pairs[j] == a  &&  lv->pairs[j + 1] == b)  ||  (lv->pairs[j] == b  &&  lv->pairs[j + 1] == a)  ) {
						ok = true;
					}
				}
				if(  !ok  ) {
					return "a point is set against the route";
				}
			}
		}
	}
	return NULL;
}


const char *interlocking_manager_t::parse_path(il_station_t *st, const char *path, vector_tpl<koord3d> &tiles) const
{
	// path: "x:y:z;x:y:z;..." from the start point to the destination
	tiles.clear();
	for(  const char *p = path;  p  &&  *p;  ) {
		int x, y, z;
		if(  sscanf(p, "%d:%d:%d", &x, &y, &z) != 3  ) {
			return "bad path";
		}
		tiles.append(koord3d((sint16)x, (sint16)y, (sint8)z));
		p = strchr(p, ';');
		if(  p  ) {
			p++;
		}
	}
	if(  tiles.get_count() < 2  ||  tiles.get_count() > IL_MAX_ROUTE_TILES  ) {
		return "bad path";
	}
	if(  !is_start_point(st, tiles[0])  ) {
		return "start is not a registered signal of this station";
	}
	// the path must follow the track in the direction of travel
	ribi_t::ribi prev = ribi_t::none;
	for(  uint32 i = 0;  i + 1 < tiles.get_count();  i++  ) {
		grund_t *gr = world()->lookup(tiles[i]);
		weg_t *w = gr ? gr->get_weg(track_wt) : NULL;
		const koord diff = tiles[i + 1].get_2d() - tiles[i].get_2d();
		const ribi_t::ribi d = ribi_t::is_single(ribi_type(diff)) ? ribi_type(diff) : (ribi_t::ribi)ribi_t::none;
		grund_t *to = NULL;
		if(  w == NULL  ) {
			return "the path does not follow the track";
		}
		// at a virtual departure the train may leave the platform end in any direction
		const ribi_t::ribi allowed = (i == 0  &&  find_departure_anchor(tiles[0])) ? w->get_ribi_unmasked() : w->get_ribi();
		if(  d == ribi_t::none  ||  (allowed & d) == 0  ||  (prev != ribi_t::none  &&  d == ribi_t::backward(prev))
			||  !gr->get_neighbour(to, track_wt, d)  ||  to->get_pos() != tiles[i + 1]  ) {
			return "the path does not follow the track";
		}
		prev = d;
	}
	return NULL;
}


il_route_t *interlocking_manager_t::new_route(il_station_t *st, const vector_tpl<koord3d> &tiles, const char *name, bool temp)
{
	il_route_t *r = new il_route_t();
	r->id = next_id++;
	r->station = st->id;
	r->name = name;
	r->temp = temp;
	FOR(vector_tpl<koord3d>, const &t, tiles) {
		r->tiles.append(t);
	}
	r->state = IL_IDLE;
	routes.append(r);
	return r;
}


const char *interlocking_manager_t::cmd_set_path(il_station_t *st, const char *path, const char *name, bool extra)
{
	vector_tpl<koord3d> tiles;
	if(  const char *e = parse_path(st, path, tiles)  ) {
		return e;
	}
	il_slever_t *lever = NULL;
	if(  st->kind == IL_RELAY  ) {
		// relay: the signal lever has to be turned first, once per route (the one waiting for its destination)
		FOR(vector_tpl<il_slever_t *>, l, st->slevers) {
			if(  l->pos == tiles[0]  &&  (lever == NULL  ||  !l->used)  ) {
				lever = l;
			}
		}
		if(  lever == NULL  ) {
			return "turn the signal lever first";
		}
		if(  lever->used  ) {
			return "turn the lever back first";
		}
	}
	if(  lever  ) {
		extra = lever->lever != 0;
	}
	const uint8 col = st->shunt_lever(tiles[0]);
	if(  extra  &&  !col  ) {
		return "no shunting lever at this signal";
	}
	il_route_t *r = new_route(st, tiles, name, true);
	// white / green: shunting route; pink (calling-on, 誘導): a train route
	r->shunt = extra  &&  col != 'P';
	const char *error = NULL;
	if(  ends_behind_train(r)  &&  !(extra  &&  (col == 'G'  ||  col == 'P'))  ) {
		// up to a train standing on the track: only with a shunting indicator (入換標識) or a calling-on lever (誘導)
		error = "only a shunting indicator lever leads up to a standing train";
	}
	if(  !error  ) {
		error = cmd_set(r);
	}
	if(  error  ) {
		routes.remove(r);
		delete r;
	}
	else if(  lever  ) {
		lever->used = true;
		r->ready_at = throw_points(st, r);
	}
	return error;
}


void interlocking_manager_t::purge_temp_routes()
{
	for(  uint32 i = routes.get_count();  i-- > 0;  ) {
		if(  routes[i]->temp  &&  routes[i]->state == IL_IDLE  ) {
			delete routes[i];
			routes.remove_at(i);
		}
	}
}


// ---------------------------------------------------------------------------
// signal hook
// ---------------------------------------------------------------------------

bool interlocking_manager_t::build_train_route(rail_vehicle_t *v, uint16 next_block, const il_route_t *r, vector_tpl<koord3d> &out) const
{
	convoi_t *cnv = v->get_convoi();
	const route_t *rt = cnv->get_route();
	const koord3d dest = rt->back();
	const uint32 count = r->tiles.get_count();

	out.clear();

	// 1. the destination lies on the interlocking route: stop there
	FOR(vector_tpl<koord3d>, const &t, r->tiles) {
		out.append(t);
		if(  t == dest  ) {
			return true;
		}
	}

	const koord3d end = r->tiles[count - 1];
	const halthandle_t end_halt = haltestelle_t::get_halt(end, cnv->get_owner());
	const halthandle_t dest_halt = haltestelle_t::get_halt(dest, cnv->get_owner());

	// 2. the route ends on a platform of the destination stop: go on to the end of that platform
	if(  end_halt.is_bound()  &&  end_halt == dest_halt  &&  count >= 2  ) {
		const ribi_t::ribi dir = ribi_type(r->tiles[count - 2], end);
		grund_t *gr = world()->lookup(end);
		for(  int i = 0;  gr  &&  i < 256;  i++  ) {
			grund_t *to = NULL;
			weg_t *w = gr->get_weg(track_wt);
			if(  !w  ||  (w->get_ribi() & dir) == 0  ||  !gr->get_neighbour(to, track_wt, dir)  ) {
				break;
			}
			if(  haltestelle_t::get_halt(to->get_pos(), cnv->get_owner()) != end_halt  ) {
				break;
			}
			// another train stands further in (a siding with trains one behind the other): stop behind it
			const schiene_t *sch = get_rail(to->get_pos());
			if(  sch  &&  sch->is_reserved()  &&  sch->get_reserved_convoi() != cnv->self  ) {
				break;
			}
			out.append(to->get_pos());
			gr = to;
		}
		return true;
	}

	// 3. otherwise continue from the end of the route to the destination
	route_t ext;
	const uint16 len = world()->get_settings().get_advance_to_end() ? 8888 : cnv->get_entire_convoy_length();
	if(  !ext.calc_route(world(), end, dest, v, speed_to_kmh(cnv->get_min_top_speed()), len, cnv->needs_electrification())  ) {
		return false;
	}
	if(  ext.get_count() < 2  ) {
		return true;
	}
	if(  count >= 2  &&  ext.at(1) == r->tiles[count - 2]  ) {
		// the train would have to reverse at the end of the route
		return false;
	}
	for(  uint32 i = 1;  i < ext.get_count();  i++  ) {
		out.append(ext.at(i));
	}
	(void)next_block;
	return true;
}


bool interlocking_manager_t::on_signal(rail_vehicle_t *v, uint16 next_block, sint32 &restart_speed, bool call_by_step, bool &result)
{
	convoi_t *cnv = v->get_convoi();
	if(  cnv == NULL  ||  next_block >= cnv->get_route()->get_count()  ) {
		return false;
	}
	const koord3d spos = cnv->get_route()->at(next_block);
	il_station_t *st = find_station_of_signal(spos);
	if(  st == NULL  ||  !st->manual  ) {
		// not interlocked or automatic mode: the core handles the signal as usual
		return false;
	}
	signal_t *sig = get_signal(spos);
	if(  sig == NULL  ) {
		return false;
	}

	// find the route that is set from this signal (or already admitted this train)
	il_route_t *r = NULL;
	FOR(vector_tpl<il_route_t *>, rr, routes) {
		if(  rr->tiles[0] != spos  ) {
			continue;
		}
		if(  rr->state == IL_SET  ||  (rr->state == IL_OCCUPIED  &&  rr->convoy == cnv->self)  ) {
			r = rr;
			break;
		}
	}

	if(  r == NULL  ) {
		// no route: the signal stays at danger
		sig->set_state(roadsign_t::STATE_RED);
		restart_speed = 0;
		result = false;
		return true;
	}

	if(  r->state == IL_SET  &&  !may_clear(r)  ) {
		// relay: the points are still moving, or the emergency stop lever is on
		sig->set_state(roadsign_t::STATE_RED);
		restart_speed = 0;
		result = false;
		return true;
	}
	if(  r->state == IL_SET  &&  !cnv->is_waiting()  &&  !call_by_step  ) {
		// like the choose signal (OTRP v51+): the route search may only run in a step,
		// not in a sync_step. Stop at the signal and let the convoy check again in its step.
		cnv->request_signal_check_in_step();
		sig->set_state(roadsign_t::STATE_RED);
		restart_speed = -1;
		result = false;
		return true;
	}
	if(  r->state == IL_SET  ) {
		cnv->set_signal_check_in_step_request_invalid();
	}
	result = admit_train(v, next_block, r, restart_speed, next_block + 1);
	sig->set_state(result ? roadsign_t::STATE_GREEN : roadsign_t::STATE_RED);
	return true;
}


bool interlocking_manager_t::admit_train(rail_vehicle_t *v, uint16 start, il_route_t *r, sint32 &restart_speed, uint16 reserve_from)
{
	convoi_t *cnv = v->get_convoi();
	if(  r->state == IL_SET  &&  ends_behind_train(r)  ) {
		// behind a standing train the whole train must fit on the track, the tail must not foul the points
		const uint32 need = (cnv->get_entire_convoy_length() + CARUNITS_PER_TILE - 1) / CARUNITS_PER_TILE;
		if(  room_at_end(r) < need  ) {
			const uint32 key = ((uint32)r->id << 16) | cnv->self.get_id() | 0x8000u;
			if(  key != last_wrong_route  ) {
				last_wrong_route = key;
				cbuffer_t ev;
				ev.printf("{\"type\":\"too_long\",\"id\":%u,\"room\":%u,\"need\":%u,\"convoy\":", r->id, room_at_end(r), need);
				append_json_string(ev, cnv->get_name());
				ev.append("}");
				push_event(ev);
			}
			restart_speed = 0;
			return false;
		}
	}
	// a train passing a platform with a virtual departure signal needs the departure route, too
	// (場内 + 出発): it waits at the home signal until both are set, then runs through both
	il_route_t *through = NULL;
	il_route_t combined;
	const il_route_t *plan = r;
	if(  r->state == IL_SET  ) {
		il_departure_t *dep = NULL;
		const koord3d end = r->tiles.back();
		if(  find_departure_track(end, &dep)  &&  dep->anchor != r->tiles[0]  &&  !dep->tiles.is_contained(r->tiles[0])  &&  !train_stops_on(cnv, dep)  ) {
			FOR(vector_tpl<il_route_t *>, o, routes) {
				if(  o->tiles[0] == dep->anchor  &&  o->state == IL_SET  &&  !o->shunt  ) {
					through = o;
				}
			}
			if(  through == NULL  ||  !may_clear(through)  ) {
				restart_speed = 0;
				return false;
			}
			// home route, on along the platform to its end, then the departure route
			FOR(vector_tpl<koord3d>, const &t, r->tiles) {
				combined.tiles.append(t);
			}
			vector_tpl<koord3d> along;
			if(  end != dep->anchor  &&  find_path(end, dep->anchor, along)  ) {
				for(  uint32 i = 1;  i < along.get_count();  i++  ) {
					combined.tiles.append(along[i]);
				}
			}
			for(  uint32 i = 1;  i < through->tiles.get_count();  i++  ) {
				combined.tiles.append(through->tiles[i]);
			}
			combined.id = r->id;
			combined.state = IL_SET;
			plan = &combined;
		}
	}
	if(  r->state == IL_SET  ) {
		vector_tpl<koord3d> tiles;
		if(  !build_train_route(v, start, plan, tiles)  ) {
			// report only once per route and train (the train checks again and again)
			const uint32 key = ((uint32)r->id << 16) | cnv->self.get_id();
			if(  key != last_wrong_route  ) {
				last_wrong_route = key;
				cbuffer_t ev;
				ev.printf("{\"type\":\"wrong_route\",\"id\":%u,\"convoy\":", r->id);
				append_json_string(ev, cnv->get_name());
				ev.append("}");
				push_event(ev);
			}
			restart_speed = 0;
			return false;
		}
		route_t target_rt;
		FOR(vector_tpl<koord3d>, const &t, tiles) {
			target_rt.append(t);
		}
		// same as the choose signal: replace the route of the train (and of coupled trains)
		convoihandle_t c = cnv->self;
		while(  c.is_bound()  ) {
			c->access_route()->remove_koord_from(start);
			c->access_route()->append(&target_rt);
			c = c->get_coupling_convoi();
		}
	}

	uint16 next_signal, next_crossing;
	if(  v->block_reserver(cnv->get_route(), reserve_from, next_signal, next_crossing, 0, true, false)  ) {
		cnv->set_next_stop_index(min(next_crossing, next_signal));
		r->convoy = cnv->self;
		set_route_state(r, IL_OCCUPIED);
		if(  through  ) {
			through->convoy = cnv->self;
			set_route_state(through, IL_OCCUPIED);
		}
		return true;
	}
	restart_speed = 0;
	return false;
}


bool interlocking_manager_t::on_departure(rail_vehicle_t *v, sint32 &restart_speed, bool &result)
{
	convoi_t *cnv = v->get_convoi();
	if(  cnv == NULL  ) {
		return false;
	}
	il_departure_t *dep = NULL;
	uint16 k = route_t::INVALID_INDEX;
	// no departure, or the train leaves the other way (not over a controlled end)
	il_station_t *st = find_departure_of_train(v, &dep, k);
	if(  st == NULL  ||  !st->manual  ) {
		return false;
	}
	const uint16 from = max(v->get_route_index(), (uint16)1) - 1;

	il_route_t *r = NULL;
	FOR(vector_tpl<il_route_t *>, rr, routes) {
		if(  rr->tiles[0] == dep->anchor  &&  (rr->state == IL_SET  ||  (rr->state == IL_OCCUPIED  &&  rr->convoy == cnv->self))  ) {
			r = rr;
			break;
		}
	}
	if(  r == NULL  ) {
		// no departure route: the train waits at the platform
		restart_speed = 0;
		result = false;
		return true;
	}
	if(  r->state == IL_OCCUPIED  ) {
		// already admitted: the core reserves as usual
		return false;
	}
	if(  !may_clear(r)  ) {
		restart_speed = 0;
		result = false;
		return true;
	}
	result = admit_train(v, k, r, restart_speed, from);
	return true;
}


// ---------------------------------------------------------------------------
// step: automatic release (approximation of the route section locking)
// ---------------------------------------------------------------------------

void interlocking_manager_t::step()
{
	FOR(vector_tpl<il_route_t *>, r, routes) {
		if(  r->state == IL_RELEASING  &&  tick_reached(r->release_at)  ) {
			set_route_state(r, IL_IDLE); // time release (時素) has run out
			continue;
		}
		if(  r->state != IL_OCCUPIED  ) {
			continue;
		}
		// the route is released as soon as the train no longer holds the first tile behind the signal;
		// the rest of the route is still protected by the reservation of the train itself
		schiene_t *sch = r->tiles.get_count() > 1 ? get_rail(r->tiles[1]) : NULL;
		const convoihandle_t holder = sch ? sch->get_reserved_convoi() : convoihandle_t();
		if(  !r->convoy.is_bound()  &&  holder.is_bound()  ) {
			// after loading: the admitted train is not saved, take it from the reservation
			r->convoy = holder;
		}
		if(  !holder.is_bound()  ||  holder != r->convoy  ) {
			set_route_state(r, IL_IDLE);
		}
	}
	purge_temp_routes();
}


// ---------------------------------------------------------------------------
// load / save / rotate
// ---------------------------------------------------------------------------

static void rdwr_pos_vector(loadsave_t *file, vector_tpl<koord3d> &v)
{
	uint32 count = v.get_count();
	file->rdwr_long(count);
	if(  file->is_loading()  ) {
		v.clear();
		for(  uint32 i = 0;  i < count;  i++  ) {
			koord3d k;
			k.rdwr(file);
			v.append(k);
		}
	}
	else {
		for(  uint32 i = 0;  i < count;  i++  ) {
			v[i].rdwr(file);
		}
	}
}


void interlocking_manager_t::rdwr(loadsave_t *file)
{
	uint16 version = IL_SAVE_VERSION;
	file->rdwr_short(version);
	if(  file->is_loading()  ) {
		reset();
	}
	file->rdwr_short(next_id);

	uint32 count = stations.get_count();
	file->rdwr_long(count);
	for(  uint32 i = 0;  i < count;  i++  ) {
		il_station_t *st = file->is_loading() ? new il_station_t() : stations[i];
		file->rdwr_short(st->id);
		file->rdwr_str(st->name);
		file->rdwr_byte(st->owner);
		file->rdwr_bool(st->manual);
		rdwr_pos_vector(file, st->signals);
		if(  version >= 2  ) {
			uint32 dcount = st->departures.get_count();
			file->rdwr_long(dcount);
			for(  uint32 j = 0;  j < dcount;  j++  ) {
				il_departure_t *d = file->is_loading() ? new il_departure_t() : st->departures[j];
				d->anchor.rdwr(file);
				rdwr_pos_vector(file, d->tiles);
				if(  version >= 6  ) {
					file->rdwr_byte(d->kind);
				}
				else if(  file->is_loading()  ) {
					// before: a virtual signal on a track without platform was a shunting signal
					const grund_t *agr = world()->lookup(d->anchor);
					d->kind = agr  &&  agr->get_halt().is_bound() ? 0 : 1;
				}
				if(  file->is_loading()  ) {
					st->departures.append(d);
				}
			}
		}
		if(  version >= 3  ) {
			uint32 lcount = st->label_pos.get_count();
			file->rdwr_long(lcount);
			for(  uint32 j = 0;  j < lcount;  j++  ) {
				koord3d k = file->is_loading() ? koord3d::invalid : st->label_pos[j];
				plainstring nm = file->is_loading() ? plainstring() : st->label_names[j];
				k.rdwr(file);
				file->rdwr_str(nm);
				if(  file->is_loading()  ) {
					st->label_pos.append(k);
					st->label_names.append(nm);
				}
			}
		}
		if(  version >= 4  ) {
			uint32 vcount = st->levers.get_count();
			file->rdwr_long(vcount);
			for(  uint32 j = 0;  j < vcount;  j++  ) {
				il_lever_t *lv = file->is_loading() ? new il_lever_t() : st->levers[j];
				lv->pos.rdwr(file);
				file->rdwr_str(lv->value);
				uint32 pc = lv->pairs.get_count();
				file->rdwr_long(pc);
				for(  uint32 k = 0;  k < pc;  k++  ) {
					uint8 v = file->is_loading() ? 0 : lv->pairs[k];
					file->rdwr_byte(v);
					if(  file->is_loading()  ) {
						lv->pairs.append(v);
					}
				}
				if(  file->is_loading()  ) {
					st->levers.append(lv);
				}
			}
		}
		if(  version >= 5  ) {
			file->rdwr_byte(st->kind);
			file->rdwr_byte(st->rot);
			file->rdwr_short(st->t_approach);
			file->rdwr_short(st->t_shunt);
			file->rdwr_short(st->t_throw);
			file->rdwr_bool(st->all_stop);
			uint32 oc = st->operators.get_count();
			file->rdwr_long(oc);
			for(  uint32 j = 0;  j < oc;  j++  ) {
				uint8 nr = file->is_loading() ? 0 : st->operators[j];
				file->rdwr_byte(nr);
				if(  file->is_loading()  ) {
					st->operators.append(nr);
				}
			}
			uint32 sc = st->slevers.get_count();
			file->rdwr_long(sc);
			for(  uint32 j = 0;  j < sc;  j++  ) {
				il_slever_t *l = file->is_loading() ? new il_slever_t() : st->slevers[j];
				l->pos.rdwr(file);
				file->rdwr_byte(l->side);
				file->rdwr_bool(l->used);
				if(  version >= 9  ) {
					file->rdwr_byte(l->lever);
				}
				if(  file->is_loading()  ) {
					st->slevers.append(l);
				}
			}
			uint32 pc = st->points.get_count();
			file->rdwr_long(pc);
			for(  uint32 j = 0;  j < pc;  j++  ) {
				il_point_t *pt = file->is_loading() ? new il_point_t() : st->points[j];
				pt->pos.rdwr(file);
				file->rdwr_byte(pt->a);
				file->rdwr_byte(pt->b);
				file->rdwr_long(pt->moving_until);
				if(  file->is_loading()  ) {
					st->points.append(pt);
				}
			}
		}
		if(  version >= 6  ) {
			rdwr_pos_vector(file, st->siding_halts);
		}
		if(  version >= 7  ) {
			rdwr_pos_vector(file, st->pair_left);
			rdwr_pos_vector(file, st->pair_right);
		}
		if(  version >= 9  ) {
			rdwr_pos_vector(file, st->shunt_pos);
			uint32 cc = st->shunt_col.get_count();
			file->rdwr_long(cc);
			for(  uint32 j = 0;  j < cc;  j++  ) {
				uint8 v = file->is_loading() ? 0 : st->shunt_col[j];
				file->rdwr_byte(v);
				if(  file->is_loading()  ) {
					st->shunt_col.append(v);
				}
			}
		}
		if(  version >= 8  ) {
			rdwr_pos_vector(file, st->side_pos);
			uint32 sc = st->side_val.get_count();
			file->rdwr_long(sc);
			for(  uint32 j = 0;  j < sc;  j++  ) {
				uint8 v = file->is_loading() ? 0 : st->side_val[j];
				file->rdwr_byte(v);
				if(  file->is_loading()  ) {
					st->side_val.append(v);
				}
			}
		}
		if(  file->is_loading()  ) {
			stations.append(st);
		}
	}

	count = routes.get_count();
	file->rdwr_long(count);
	for(  uint32 i = 0;  i < count;  i++  ) {
		il_route_t *r = file->is_loading() ? new il_route_t() : routes[i];
		file->rdwr_short(r->id);
		file->rdwr_short(r->station);
		file->rdwr_str(r->name);
		file->rdwr_byte(r->state);
		rdwr_pos_vector(file, r->tiles);
		if(  version >= 3  ) {
			file->rdwr_bool(r->temp);
		}
		if(  version >= 5  ) {
			file->rdwr_long(r->ready_at);
			file->rdwr_long(r->release_at);
		}
		if(  version >= 9  ) {
			file->rdwr_bool(r->shunt);
		}
		if(  file->is_loading()  ) {
			r->convoy = convoihandle_t();
			if(  r->tiles.empty()  ) {
				delete r;
				continue;
			}
			routes.append(r);
		}
	}
}


void interlocking_manager_t::rotate90(sint16 y_size)
{
	FOR(vector_tpl<il_station_t *>, st, stations) {
		for(  uint32 i = 0;  i < st->signals.get_count();  i++  ) {
			st->signals[i].rotate90(y_size);
		}
		for(  uint32 i = 0;  i < st->label_pos.get_count();  i++  ) {
			st->label_pos[i].rotate90(y_size);
		}
		FOR(vector_tpl<il_lever_t *>, lv, st->levers) {
			lv->pos.rotate90(y_size);
			for(  uint32 i = 0;  i < lv->pairs.get_count();  i++  ) {
				lv->pairs[i] = ribi_t::rotate90(lv->pairs[i]);
			}
			int a, b;
			if(  lv->value.c_str()  &&  sscanf(lv->value.c_str(), "%d,%d", &a, &b) == 2  ) {
				const uint8 ra = ribi_t::rotate90((ribi_t::ribi)a), rb = ribi_t::rotate90((ribi_t::ribi)b);
				char tmp[16];
				sprintf(tmp, "%d,%d", min(ra, rb), max(ra, rb));
				lv->value = tmp;
			}
		}
		FOR(vector_tpl<il_slever_t *>, l, st->slevers) {
			l->pos.rotate90(y_size);
		}
		for(  uint32 i = 0;  i < st->siding_halts.get_count();  i++  ) {
			st->siding_halts[i].rotate90(y_size);
		}
		for(  uint32 i = 0;  i < st->pair_left.get_count();  i++  ) {
			st->pair_left[i].rotate90(y_size);
			st->pair_right[i].rotate90(y_size);
		}
		for(  uint32 i = 0;  i < st->side_pos.get_count();  i++  ) {
			st->side_pos[i].rotate90(y_size);
		}
		for(  uint32 i = 0;  i < st->shunt_pos.get_count();  i++  ) {
			st->shunt_pos[i].rotate90(y_size);
		}
		FOR(vector_tpl<il_point_t *>, pt, st->points) {
			pt->pos.rotate90(y_size);
			pt->a = ribi_t::rotate90(pt->a);
			pt->b = ribi_t::rotate90(pt->b);
		}
		// the map turns clockwise: turn the relay panel back, so that it looks the same as before
		st->rot = (st->rot + 3) & 3;
		FOR(vector_tpl<il_departure_t *>, d, st->departures) {
			d->anchor.rotate90(y_size);
			for(  uint32 i = 0;  i < d->tiles.get_count();  i++  ) {
				d->tiles[i].rotate90(y_size);
			}
		}
	}
	FOR(vector_tpl<il_route_t *>, r, routes) {
		for(  uint32 i = 0;  i < r->tiles.get_count();  i++  ) {
			r->tiles[i].rotate90(y_size);
		}
	}
	push_event("{\"type\":\"rotated\"}");
}


// ---------------------------------------------------------------------------
// read only information for the external panel
// ---------------------------------------------------------------------------

void interlocking_manager_t::get_status_json(cbuffer_t &buf) const
{
	buf.append("{\"type\":\"status\",\"stations\":[");
	bool first = true;
	FOR(vector_tpl<il_station_t *>, st, stations) {
		buf.append(first ? "" : ",");
		first = false;
		buf.printf("{\"id\":%u,\"name\":", st->id);
		append_json_string(buf, st->name.c_str());
		buf.printf(",\"owner\":%u,\"manual\":%s", st->owner, st->manual ? "true" : "false");
		buf.printf(",\"kind\":\"%s\",\"rot\":%u,\"t_approach\":%u,\"t_shunt\":%u,\"t_throw\":%u,\"all_stop\":%s,\"operators\":[",
			st->kind == IL_RELAY ? "relay" : "electronic", st->rot, st->t_approach, st->t_shunt, st->t_throw, st->all_stop ? "true" : "false");
		for(  uint32 i = 0;  i < st->operators.get_count();  i++  ) {
			buf.printf("%s%u", i ? "," : "", st->operators[i]);
		}
		buf.append("],\"siding_halts\":[");
		for(  uint32 i = 0;  i < st->siding_halts.get_count();  i++  ) {
			buf.append(i ? "," : "");
			append_json_pos(buf, st->siding_halts[i]);
		}
		buf.append("],\"pairs\":[");
		for(  uint32 i = 0;  i < st->pair_left.get_count();  i++  ) {
			buf.append(i ? ",[" : "[");
			append_json_pos(buf, st->pair_left[i]);
			buf.append(",");
			append_json_pos(buf, st->pair_right[i]);
			buf.append("]");
		}
		buf.append("],\"sides\":[");
		for(  uint32 i = 0;  i < st->side_pos.get_count();  i++  ) {
			buf.append(i ? ",{\"pos\":" : "{\"pos\":");
			append_json_pos(buf, st->side_pos[i]);
			buf.printf(",\"side\":\"%c\"}", st->side_val[i]);
		}
		buf.append("],\"shunt_levers\":[");
		for(  uint32 i = 0;  i < st->shunt_pos.get_count();  i++  ) {
			buf.append(i ? ",{\"pos\":" : "{\"pos\":");
			append_json_pos(buf, st->shunt_pos[i]);
			buf.printf(",\"color\":\"%c\"}", st->shunt_col[i]);
		}
		buf.append("],\"slevers\":[");
		for(  uint32 i = 0;  i < st->slevers.get_count();  i++  ) {
			buf.append(i ? ",{\"pos\":" : "{\"pos\":");
			append_json_pos(buf, st->slevers[i]->pos);
			buf.printf(",\"side\":\"%c\",\"used\":%s,\"shunt\":%s}", st->slevers[i]->side, st->slevers[i]->used ? "true" : "false", st->slevers[i]->lever ? "true" : "false");
		}
		buf.append("],\"points\":[");
		for(  uint32 i = 0;  i < st->points.get_count();  i++  ) {
			const il_point_t *pt = st->points[i];
			buf.append(i ? ",{\"pos\":" : "{\"pos\":");
			append_json_pos(buf, pt->pos);
			buf.printf(",\"pair\":[%u,%u],\"moving\":%u}", pt->a, pt->b, seconds_left(pt->moving_until));
		}
		buf.append("],\"signals\":[");
		for(  uint32 i = 0;  i < st->signals.get_count();  i++  ) {
			const koord3d pos = st->signals[i];
			signal_t *sig = get_signal(pos);
			buf.append(i ? "," : "");
			buf.append("{\"pos\":");
			append_json_pos(buf, pos);
			buf.printf(",\"aspect\":\"%s\"", sig == NULL ? "missing" : sig->get_state() == roadsign_t::STATE_GREEN ? "green" : sig->get_state() == roadsign_t::STATE_YELLOW ? "yellow" : "red");
			// approach indication: the train that holds the signal tile (waiting at or approaching the signal)
			const schiene_t *sch = get_rail(pos);
			const convoihandle_t holder = sch ? sch->get_reserved_convoi() : convoihandle_t();
			if(  holder.is_bound()  ) {
				buf.append(",\"train\":");
				append_json_string(buf, holder->get_name());
			}
			buf.append("}");
		}
		buf.append("],\"labels\":[");
		for(  uint32 i = 0;  i < st->label_pos.get_count();  i++  ) {
			buf.append(i ? ",{\"pos\":" : "{\"pos\":");
			append_json_pos(buf, st->label_pos[i]);
			buf.append(",\"name\":");
			append_json_string(buf, st->label_names[i].c_str());
			buf.append("}");
		}
		buf.append("],\"levers\":[");
		for(  uint32 i = 0;  i < st->levers.get_count();  i++  ) {
			const il_lever_t *lv = st->levers[i];
			buf.append(i ? ",{\"pos\":" : "{\"pos\":");
			append_json_pos(buf, lv->pos);
			buf.append(",\"value\":");
			append_json_string(buf, lv->value.c_str());
			buf.append(",\"pairs\":[");
			for(  uint32 j = 0;  j + 1 < lv->pairs.get_count();  j += 2  ) {
				buf.printf("%s[%u,%u]", j ? "," : "", lv->pairs[j], lv->pairs[j + 1]);
			}
			buf.append("]}");
		}
		// virtual departure signals: the train standing on the platform track
		buf.append("],\"departures\":[");
		for(  uint32 i = 0;  i < st->departures.get_count();  i++  ) {
			const il_departure_t *d = st->departures[i];
			buf.append(i ? "," : "");
			buf.append("{\"pos\":");
			append_json_pos(buf, d->anchor);
			if(  d->kind == 1  ) {
				buf.append(",\"shunt\":true"); // virtual shunting signal (siding)
			}
			buf.append(",\"tiles\":[");
			convoihandle_t holder;
			for(  uint32 j = 0;  j < d->tiles.get_count();  j++  ) {
				buf.append(j ? "," : "");
				append_json_pos(buf, d->tiles[j]);
				const schiene_t *sch = get_rail(d->tiles[j]);
				if(  !holder.is_bound()  &&  sch  ) {
					holder = sch->get_reserved_convoi();
				}
			}
			buf.append("]");
			if(  holder.is_bound()  ) {
				buf.append(",\"train\":");
				append_json_string(buf, holder->get_name());
				buf.printf(",\"waiting\":%s", holder->is_waiting() ? "true" : "false");
			}
			buf.append("}");
		}
		buf.append("]}");
	}
	buf.append("],\"routes\":[");
	first = true;
	FOR(vector_tpl<il_route_t *>, r, routes) {
		buf.append(first ? "" : ",");
		first = false;
		buf.printf("{\"id\":%u,\"station\":%u,\"name\":", r->id, r->station);
		append_json_string(buf, r->name.c_str());
		buf.printf(",\"state\":\"%s\",\"temp\":%s,\"shunt\":%s", state_name(r->state), r->temp ? "true" : "false", r->shunt ? "true" : "false");
		if(  r->state == IL_SET  &&  !may_clear(r)  ) {
			buf.printf(",\"waiting\":%u", max(seconds_left(r->ready_at), (uint32)1)); // points moving / emergency stop
		}
		if(  r->state == IL_RELEASING  ) {
			buf.printf(",\"release_in\":%u", seconds_left(r->release_at));
		}
		buf.append(",\"start\":");
		append_json_pos(buf, r->tiles[0]);
		buf.append(",\"end\":");
		append_json_pos(buf, r->tiles.back());
		// occupation of the route tiles: 1 = reserved by a train
		buf.append(",\"occupied\":[");
		for(  uint32 i = 0;  i < r->tiles.get_count();  i++  ) {
			const schiene_t *sch = get_rail(r->tiles[i]);
			buf.append(i ? "," : "");
			buf.append(sch  &&  sch->is_reserved() ? "1" : "0");
		}
		buf.append("],\"tiles\":[");
		for(  uint32 i = 0;  i < r->tiles.get_count();  i++  ) {
			buf.append(i ? "," : "");
			append_json_pos(buf, r->tiles[i]);
		}
		buf.append("]}");
	}
	buf.append("]}");
}


void interlocking_manager_t::get_signals_json(cbuffer_t &buf, koord p1, koord p2) const
{
	const sint16 x1 = min(p1.x, p2.x), x2 = max(p1.x, p2.x);
	const sint16 y1 = min(p1.y, p2.y), y2 = max(p1.y, p2.y);
	buf.append("{\"type\":\"signals\",\"signals\":[");
	bool first = true;
	uint32 found = 0;
	for(  sint16 y = y1;  y <= y2  &&  found < 1000;  y++  ) {
		for(  sint16 x = x1;  x <= x2  &&  found < 1000;  x++  ) {
			const planquadrat_t *plan = world()->access(koord(x, y));
			if(  plan == NULL  ) {
				continue;
			}
			for(  uint8 i = 0;  i < plan->get_boden_count();  i++  ) {
				grund_t *gr = plan->get_boden_bei(i);
				signal_t *sig = gr ? gr->find<signal_t>() : NULL;
				if(  sig == NULL  ) {
					continue;
				}
				buf.append(first ? "" : ",");
				first = false;
				found++;
				buf.append("{\"pos\":");
				append_json_pos(buf, gr->get_pos());
				buf.printf(",\"dir\":%u,\"name\":", (unsigned)sig->get_dir());
				append_json_string(buf, sig->get_desc()->get_name());
				const il_station_t *st = find_station_of_signal(gr->get_pos());
				buf.printf(",\"station\":%d}", st ? (int)st->id : -1);
			}
		}
	}
	buf.append("]}");
}
