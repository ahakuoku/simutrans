#ifndef SIMTOOL_SCRIPT_GENERATOR_H
#define SIMTOOL_SCRIPT_GENERATOR_H

#include "simmenu.h"
#include "simworld.h"
#include "utils/cbuffer_t.h"


class tool_generate_script_t : public two_click_tool_t {
public:
	tool_generate_script_t() : two_click_tool_t(TOOL_GENERATE_SCRIPT | GENERAL_TOOL) {}
	char const* get_tooltip(player_t const*) const OVERRIDE { return "generate script"; }
	bool is_init_network_safe() const OVERRIDE { return true; }
	bool save_script(const char* fullpath) const;
private:
	cbuffer_t buf;
	
	char const* do_work(player_t*, koord3d const&, koord3d const&) OVERRIDE;
	void mark_tiles(player_t*, koord3d const&, koord3d const&) OVERRIDE;
	uint8 is_valid_pos(player_t*, koord3d const&, char const*&, koord3d const&) OVERRIDE { return 3; };
};

#endif
