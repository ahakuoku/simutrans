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
