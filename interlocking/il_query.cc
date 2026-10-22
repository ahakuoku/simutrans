/*
 * This file is part of the Simutrans project under the Artistic License.
 * (see LICENSE.txt)
 */

/*
 * Read only queries for the external panel (layout drawing, station list).
 * Nothing here changes the game state.
 */

#include "il_query.h"
#include "il_json.h"

#include "../simworld.h"
#include "../simhalt.h"
#include "../simconvoi.h"
#include "../boden/grund.h"
#include "../boden/wege/schiene.h"
#include "../obj/signal.h"
#include "../player/simplay.h"
#include "../tpl/inthashtable_tpl.h"
#include "../vehicle/simvehicle.h"
#include "../dataobj/schedule.h"
#include <set>

// the panel never needs more than this
#define IL_QUERY_MAX_AREA   160
#define IL_QUERY_MAX_TILES  8000


static const char *aspect_name(signal_t *sig)
{
	switch(  sig->get_state()  ) {
		case roadsign_t::STATE_GREEN:  return "green";
		case roadsign_t::STATE_YELLOW: return "yellow";
		default:                       return "red";
	}
}


void il_query::get_tracks_json(cbuffer_t &buf, koord p1, koord p2)
{
	karte_t *welt = world();
	sint16 x1 = min(p1.x, p2.x), x2 = max(p1.x, p2.x);
	sint16 y1 = min(p1.y, p2.y), y2 = max(p1.y, p2.y);
	x2 = min(x2, (sint16)(x1 + IL_QUERY_MAX_AREA - 1));
	y2 = min(y2, (sint16)(y1 + IL_QUERY_MAX_AREA - 1));

	buf.printf("{\"type\":\"tracks\",\"area\":[%d,%d,%d,%d],\"tiles\":[", x1, y1, x2, y2);
	vector_tpl<convoihandle_t> convoys;
	bool first = true;
	uint32 count = 0;
	for(  sint16 y = y1;  y <= y2;  y++  ) {
		for(  sint16 x = x1;  x <= x2;  x++  ) {
			const planquadrat_t *plan = welt->access(koord(x, y));
			if(  plan == NULL  ) {
				continue;
			}
			for(  uint8 i = 0;  i < plan->get_boden_count()  &&  count < IL_QUERY_MAX_TILES;  i++  ) {
				grund_t *gr = plan->get_boden_bei(i);
				schiene_t *sch = gr ? (schiene_t *)gr->get_weg(track_wt) : NULL;
				if(  sch == NULL  ) {
					continue;
				}
				count++;
				buf.append(first ? "" : ",");
				first = false;
				buf.append("{\"p\":");
				append_json_pos(buf, gr->get_pos());
				buf.printf(",\"r\":%u,\"m\":%u", (unsigned)sch->get_ribi_unmasked(), (unsigned)sch->get_ribi());
				const halthandle_t h = gr->get_halt();
				if(  h.is_bound()  ) {
					buf.printf(",\"h\":%u", h.get_id());
				}
				// level: underground (tunnel) or elevated (bridge), for the height filter of the panel
				if(  gr->ist_im_tunnel()  ) {
					buf.append(",\"u\":1");
				}
				else if(  gr->ist_bruecke()  ) {
					buf.append(",\"b\":1");
				}
				if(  gr->has_depot()  ) {
					buf.append(",\"d\":1");
				}
				const convoihandle_t c = sch->get_reserved_convoi();
				if(  c.is_bound()  ) {
					buf.printf(",\"c\":%u", c.get_id());
					convoys.append_unique(c);
				}
				if(  signal_t *sig = gr->find<signal_t>()  ) {
					buf.printf(",\"s\":{\"dir\":%u,\"aspect\":\"%s\",\"o\":%d,\"name\":", (unsigned)sig->get_dir(), aspect_name(sig), sig->get_owner_nr());
					append_json_string(buf, sig->get_desc()->get_name());
					if(  sig->get_desc()->is_choose_sign()  ) {
						// choose signal; "g": its guide setting (連結誘導) is on
						buf.printf(",\"ch\":1,\"g\":%d", sig->is_guide_signal() ? 1 : 0);
					}
					buf.append("}");
				}
				buf.append("}");
			}
		}
	}
	buf.append("],\"convoys\":{");
	first = true;
	FOR(vector_tpl<convoihandle_t>, const c, convoys) {
		buf.printf("%s\"%u\":", first ? "" : ",", c.get_id());
		append_json_string(buf, c->get_name());
		first = false;
	}
	buf.append("}}");
}


void il_query::get_network_json(cbuffer_t &buf, koord3d seed)
{
	karte_t *welt = world();
	vector_tpl<grund_t *> todo;
	vector_tpl<weg_t *> ways;
	std::set<weg_t *> reached;
	std::set<grund_t *> grounds;
	const auto add = [&](grund_t *g, weg_t *w) {
		if(  w && w->get_waytype() == track_wt && reached.insert(w).second  ) {
			todo.append(g); ways.append(w); grounds.insert(g);
		}
	};
	grund_t *start = welt->lookup(seed);
	if(  start && start->get_weg(track_wt)  ) {
		const halthandle_t halt = start->get_halt();
		if(  halt.is_bound()  ) {
			FOR(slist_tpl<haltestelle_t::tile_t>, const &t, halt->get_tiles()) {
				add(t.grund, t.grund->get_weg_nr(0));
				add(t.grund, t.grund->get_weg_nr(1));
			}
		}
		else { add(start, start->get_weg(track_wt)); }
	}
	// Unmasked physical connections: signals, reservations and turnout positions
	// must not hide trains. get_neighbour handles slopes, bridges and tunnels.
	// Track objects, rather than tiles, distinguish two disjoint diagonal legs.
	for(  uint32 i = 0; i < todo.get_count(); i++  ) {
		grund_t *g = todo[i];
		const ribi_t::ribi r = ways[i]->get_ribi_unmasked();
		for(  int d = 0; d < 4; d++  ) {
			grund_t *to = NULL;
			if(  (r & ribi_t::nesw[d]) && g->get_neighbour(to, track_wt, ribi_t::nesw[d])  ) {
				add(to, to->get_weg(track_wt, ribi_t::backward(ribi_t::nesw[d])));
			}
		}
	}
	const uint32 seconds = (uint32)(((uint64)(welt->get_ticks() % welt->ticks_per_world_month) * 86400) / welt->ticks_per_world_month);
	buf.printf("{\"type\":\"network\",\"time\":\"%02u:%02u:%02u\",\"seconds\":%u,\"track_count\":%u,\"convoys\":[",
		seconds / 3600, seconds / 60 % 60, seconds % 60, seconds, (uint32)grounds.size());
	bool first = true;
	FOR(vector_tpl<convoihandle_t>, const c, welt->convoys()) {
		if(  !c.is_bound() || c->in_depot() || !c->get_vehicle_count() || c->front()->get_waytype() != track_wt  ) continue;
		vector_tpl<koord3d> occupied;
		for(  uint16 i = 0; i < c->get_vehicle_count(); i++  ) {
			const vehicle_t *v = c->get_vehikel(i);
			const koord3d p = v->get_pos();
			const grund_t *g = welt->lookup(p);
			if(  g && reached.count(g->get_weg(track_wt, v->get_current_corner_set()))  ) occupied.append_unique(p);
		}
		if(  occupied.empty()  ) continue;
		buf.printf("%s{\"id\":%u,\"name\":", first ? "" : ",", c.get_id());
		first = false;
		append_json_string(buf, c->get_name());
		buf.append(",\"pos\":"); append_json_pos(buf, c->get_pos());
		const grund_t *g = welt->lookup(occupied[0]);
		buf.append(",\"halt\":");
		append_json_string(buf, g && g->get_halt().is_bound() ? g->get_halt()->get_name() : "");
		const schedule_t *schedule = c->get_schedule();
		const bool editing = c->get_state() == convoi_t::EDIT_SCHEDULE;
		bool loading = c->is_loading();
		// Opening the editor changes LOADING to EDIT_SCHEDULE. A convoy that
		// already reached the scheduled platform is still dwelling there.
		if(  editing && schedule && schedule->get_count() && g && g->get_halt().is_bound()  ) {
			const route_t *route = c->get_route();
			const halthandle_t target = haltestelle_t::get_stoppable_halt(schedule->get_current_entry().pos, c->get_owner(), track_wt);
			loading = target == g->get_halt() && !route->empty() && route->back() == c->front()->get_pos() && c->front()->get_steps() >= c->front()->get_steps_next();
		}
		buf.printf(",\"loading\":%s,\"schedule_editing\":%s", loading ? "true" : "false", editing ? "true" : "false");
		// The ordered last/current halt -> next scheduled halt distinguishes
		// two services of the same operation while their tolerance windows overlap.
		halthandle_t from = loading && g ? g->get_halt() : halthandle_t();
		if(  !loading && schedule && schedule->get_count()  ) {
			// last_stop_pos belongs to freight accounting: opening the editor
			// overwrites it even between stations, and closing it does not restore it.
			for(  uint32 offset = 1; offset < schedule->get_count(); offset++  ) {
				const schedule_entry_t &entry = schedule->at((schedule->get_current_stop() + schedule->get_count() - offset) % schedule->get_count());
				if(  entry.is_pass_stop()  ) continue;
				from = haltestelle_t::get_stoppable_halt(entry.pos, c->get_owner(), track_wt);
				if(  from.is_bound()  ) break;
			}
		}
		if(  from.is_bound()  ) {
			buf.append(",\"service_from\":"); append_json_string(buf, from->get_name());
		}
		if(  schedule && schedule->get_count()  ) {
			const grund_t *to = welt->lookup(loading ? schedule->get_next_entry().pos : schedule->get_current_entry().pos);
			if(  to && to->get_halt().is_bound()  ) {
				buf.append(",\"service_to\":"); append_json_string(buf, to->get_halt()->get_name());
			}
		}
		if(  loading && c->get_arrived_time() != 0  ) {
			buf.printf(",\"arrival_elapsed\":%u", (uint32)((uint64)(welt->get_ticks() - c->get_arrived_time()) * 86400 / welt->ticks_per_world_month));
		}
		else if(  !loading && schedule && schedule->get_count()  ) {
			const grund_t *target = welt->lookup(c->get_schedule()->get_current_entry().pos);
			if(  target && target->get_halt().is_bound()  ) {
				buf.append(",\"next_halt\":"); append_json_string(buf, target->get_halt()->get_name());
				uint32 ticks;
				if(  c->calc_panel_ticks_until_arrival(ticks)  ) {
					buf.printf(",\"eta_seconds\":%u", (uint32)((uint64)ticks * 86400 / welt->ticks_per_world_month));
				}
			}
		}
		buf.append(",\"occupied\":[");
		for(  uint32 i = 0; i < occupied.get_count(); i++  ) {
			if(  i  ) buf.append(",");
			append_json_pos(buf, occupied[i]);
		}
		buf.append("]}");
	}
	buf.append("],\"tiles\":[");
	for(  uint32 i = 0; i < todo.get_count(); i++  ) {
		grund_t *g = todo[i];
		const ribi_t::ribi r = ways[i]->get_ribi_unmasked();
		if(  i  ) buf.append(",");
		buf.append("{\"p\":"); append_json_pos(buf, g->get_pos());
		buf.printf(",\"r\":%u", (unsigned)r);
		if(  g->get_halt().is_bound()  ) {
			buf.append(",\"halt\":"); append_json_string(buf, g->get_halt()->get_name());
		}
		if(  signal_t *sig = g->find<signal_t>()  ) {
			if(  sig->get_dir() & r  ) {
				buf.printf(",\"s\":{\"dir\":%u,\"aspect\":\"%s\",\"name\":", (unsigned)sig->get_dir(), aspect_name(sig));
				append_json_string(buf, sig->get_desc()->get_name()); buf.append("}");
			}
		}
		buf.append("}");
	}
	buf.append("]}");
}

void il_query::get_halts_json(cbuffer_t &buf)
{
	buf.append("{\"type\":\"halts\",\"halts\":[");
	bool first = true;
	FOR(vector_tpl<halthandle_t>, const h, haltestelle_t::get_alle_haltestellen()) {
		// only stations with railway platforms
		bool has_rail = false;
		FOR(slist_tpl<haltestelle_t::tile_t>, const &t, h->get_tiles()) {
			if(  t.grund->get_weg(track_wt)  ) {
				has_rail = true;
				break;
			}
		}
		if(  !has_rail  ) {
			continue;
		}
		buf.append(first ? "" : ",");
		first = false;
		buf.printf("{\"id\":%u,\"name\":", h.get_id());
		append_json_string(buf, h->get_name());
		buf.printf(",\"owner\":%d,\"tiles\":[", h->get_owner() ? h->get_owner()->get_player_nr() : -1);
		bool first_tile = true;
		FOR(slist_tpl<haltestelle_t::tile_t>, const &t, h->get_tiles()) {
			if(  t.grund->get_weg(track_wt)  ) {
				buf.append(first_tile ? "" : ",");
				first_tile = false;
				append_json_pos(buf, t.grund->get_pos());
			}
		}
		buf.append("]}");
	}
	buf.append("]}");
}
