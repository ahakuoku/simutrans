/*
 * This file is part of the Simutrans project under the Artistic License.
 * (see LICENSE.txt)
 */

#ifndef INTERLOCKING_IL_QUERY_H
#define INTERLOCKING_IL_QUERY_H

#include "../dataobj/koord3d.h"

class cbuffer_t;

/// read only information for drawing the panel
namespace il_query {
	/// all rail tiles in the rectangle with ribi, halt, depot, signal and reservation
	void get_tracks_json(cbuffer_t &buf, koord p1, koord p2);
	/// Physical railway occupancy on every track connected to the seed station.
	void get_network_json(cbuffer_t &buf, koord3d seed);

	/// all stations that have railway platforms, with their platform tiles
	void get_halts_json(cbuffer_t &buf);
}

#endif
