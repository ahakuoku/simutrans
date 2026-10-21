// Standalone test: g++ -std=c++14 -O2 interlocking/tests/aliases_blob_test.cc -o aliases_blob_test
#include "../il_aliases.h"
#include <cassert>
#include <cstdlib>
#include <cstdio>

// The standalone container test uses no game/logger instance.
log_t *dbg = NULL;
void log_t::fatal(const char *, const char *, ...) { std::abort(); }

static void copy_bytes(vector_tpl<uint8> &to, const vector_tpl<uint8> &from)
{
	to.clear();
	for(  uint32 i = 0; i < from.get_count(); i++  ) to.append(from[i]);
}

int main()
{
	vector_tpl<plainstring> names, values;
	names.append(plainstring("\xE9\xA7\x85,A")); values.append(plainstring("Diagram,Station"));
	names.append(plainstring("second")); values.append(plainstring("another"));
	il_blob_t saved(false);
	il_rdwr_station_aliases(saved, names, values);
	il_blob_t loaded(true); copy_bytes(loaded.data, saved.data);
	vector_tpl<plainstring> restored_names, restored_values;
	restored_names.append(plainstring("stale data from another map"));
	il_rdwr_station_aliases(loaded, restored_names, restored_values);
	assert(!loaded.broken && loaded.pos == saved.data.get_count());
	assert(restored_names.get_count() == 2 && restored_values.get_count() == 2);
	assert(restored_names[0] == names[0].c_str() && restored_values[0] == "Diagram,Station");
	assert(restored_names[1] == "second" && restored_values[1] == "another");

	// Empty saves clear an earlier map's dictionary.
	names.clear(); values.clear(); il_blob_t empty(false);
	il_rdwr_station_aliases(empty, names, values);
	copy_bytes(loaded.data, empty.data); loaded.pos = 0;
	il_rdwr_station_aliases(loaded, restored_names, restored_values);
	assert(!loaded.broken && restored_names.empty() && restored_values.empty());

	// A truncated section or an unreasonable count is rejected.
	copy_bytes(loaded.data, saved.data); loaded.data.pop_back(); loaded.pos = 0;
	il_rdwr_station_aliases(loaded, restored_names, restored_values);
	assert(loaded.broken);
	il_blob_t oversized(false); oversized.begin_section(); uint16 count = 513; oversized.rdwr_short(count); oversized.end_section();
	il_blob_t corrupt(true); copy_bytes(corrupt.data, oversized.data);
	il_rdwr_station_aliases(corrupt, restored_names, restored_values);
	assert(corrupt.broken);
	std::puts("PASS: shared alias save/load, UTF-8, empty-map reset and damaged data");
}
