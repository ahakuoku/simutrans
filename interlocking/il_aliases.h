/* Part of Simutrans, under the Artistic License (see LICENSE.txt). */
#ifndef INTERLOCKING_IL_ALIASES_H
#define INTERLOCKING_IL_ALIASES_H

#include "il_blob.h"

// Shared dictionary section, introduced in interlocking block version 17.
inline void il_rdwr_station_aliases(il_blob_t &b, vector_tpl<plainstring> &games, vector_tpl<plainstring> &diagrams)
{
	b.begin_section();
	uint16 count = (uint16)games.get_count(); b.rdwr_short(count);
	if(  count > 512  ) b.broken = true;
	if(  b.loading  ) { games.clear(); diagrams.clear(); }
	for(  uint16 i = 0; i < count && !b.broken; i++  ) {
		plainstring game, dia;
		if(  !b.loading  ) { game = games[i]; dia = diagrams[i]; }
		b.rdwr_str(game); b.rdwr_str(dia);
		if(  b.loading  ) { games.append(game); diagrams.append(dia); }
	}
	b.end_section();
}

#endif
