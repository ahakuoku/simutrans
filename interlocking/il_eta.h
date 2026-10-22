#ifndef INTERLOCKING_IL_ETA_H
#define INTERLOCKING_IL_ETA_H

#include "../simtypes.h"
#include "../simunits.h"

// Sum physical movement steps, retaining fractions of a tick across tiles.
// Speed is in the same internal units as convoi_t::sync_step().
class il_eta_t {
	uint64 ticks_fixed = 0;
public:
	void add(uint32 steps, uint32 speed, uint32 speed_percent) {
		if(  !steps || !speed || !speed_percent  ) return;
		ticks_fixed += ((uint64)steps << (YARDS_PER_VEHICLE_STEP_SHIFT + 16)) * 100 / ((uint64)speed * speed_percent);
	}
	uint32 ticks() const {
		const uint64 rounded = (ticks_fixed + 32768) >> 16;
		return rounded > 0xFFFFFFFFu ? 0xFFFFFFFFu : (uint32)rounded;
	}
};

#endif
