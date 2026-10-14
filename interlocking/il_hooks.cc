/*
 * This file is part of the Simutrans project under the Artistic License.
 * (see LICENSE.txt)
 */

/*
 * Implementation of the hook entry points declared in interlocking.h.
 * Keep these functions thin: the logic lives in il_manager.cc / il_bridge.cc.
 */

#include "interlocking.h"
#include "il_manager.h"
#include "il_bridge.h"

#include "../dataobj/loadsave.h"
#include "../dataobj/environment.h"


/*
 * The interlocking data is stored after the "message of the day" and before the
 * active player number / window data. It starts with a marker byte which can
 * never be a player number. An old savegame has the active player number there.
 */
#define IL_SAVE_MARKER 0xA5   // old format: the data follows directly (interlocking data versions 1..9)
#define IL_BLOCK_MARKER 0xA6  // the data as one block with its length (il_blob_t), readable by later versions

static bool restore_ui_suppressed = false;


bool interlocking_hook_signal(rail_vehicle_t *v, uint16 next_block, sint32 &restart_speed, bool call_by_step, bool &result)
{
	return interlocking_manager_t::get()->on_signal(v, next_block, restart_speed, call_by_step, result);
}


bool interlocking_hook_departure(rail_vehicle_t *v, sint32 &restart_speed, bool &result)
{
	return interlocking_manager_t::get()->on_departure(v, restart_speed, result);
}


void interlocking_hook_step()
{
	interlocking_manager_t::get()->step();
}


void interlocking_hook_save(loadsave_t *file)
{
	uint8 marker = IL_BLOCK_MARKER;
	file->rdwr_byte(marker);
	interlocking_manager_t::get()->save_block(file);
}


void interlocking_hook_load(loadsave_t *file)
{
	interlocking_manager_t::get()->reset();
	if(  file->is_version_less(102, 4)  ) {
		// nothing follows in such old savegames
		return;
	}
	uint8 marker = 0;
	file->rdwr_byte(marker);
	if(  marker == IL_BLOCK_MARKER  ) {
		interlocking_manager_t::get()->load_block(file);
	}
	else if(  marker == IL_SAVE_MARKER  ) {
		interlocking_manager_t::get()->rdwr(file);
	}
	else if(  env_t::restore_UI  ) {
		// savegame without interlocking data: we consumed the active player number,
		// so the window data cannot be restored this time
		env_t::restore_UI = false;
		restore_ui_suppressed = true;
	}
}


void interlocking_hook_load_finished()
{
	if(  restore_ui_suppressed  ) {
		env_t::restore_UI = true;
		restore_ui_suppressed = false;
	}
}


void interlocking_hook_rotate90(sint16 y_size)
{
	interlocking_manager_t::get()->rotate90(y_size);
}


void interlocking_hook_reset()
{
	interlocking_manager_t::get()->reset();
}


void interlocking_hook_interactive()
{
	il_bridge::poll();
}
