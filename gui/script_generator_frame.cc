/*
 * This file is part of the Simutrans project under the Artistic License.
 * (see LICENSE.txt)
 */

#include "script_generator_frame.h"

#include "../script/script_tool_manager.h"
#include "../dataobj/environment.h"
#include "../dataobj/tabfile.h"
#include "../dataobj/translator.h"
#include "../simdebug.h"
#include "../simworld.h"
#include "../simtool-script-generator.h"
#include "../sys/simsys.h"
#include "../utils/cbuffer_t.h"
#include "../utils/simstring.h"


script_generator_frame_t::script_generator_frame_t(tool_generate_script_t* tl) : savegame_frame_t(".nut", false, "generated-scripts/", false)
{
	this->tool = tl;

	set_name(translator::translate("Save generated script"));
	set_focus(NULL);
}


/**
 * Action, started after button pressing.
 */
bool script_generator_frame_t::item_action(const char *fullpath)
{
	tool->save_script(fullpath);
	return true;
}


bool script_generator_frame_t::ok_action(const char *fullpath)
{
	tool->save_script(fullpath);
	return true;
}


const char *script_generator_frame_t::get_info(const char *)
{
	return "";
}


bool script_generator_frame_t::check_file( const char *, const char * )
{
	return true;
}
