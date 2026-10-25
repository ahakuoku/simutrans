// g++ -std=c++14 -O2 interlocking/tests/operations_blob_test.cc -o operations_blob_test
#include "../il_operations.h"
#include <cassert>
#include <cstdlib>
#include <cstdio>
#include <string>
log_t *dbg = NULL;
void log_t::fatal(const char *, const char *, ...) { std::abort(); }
static const char *a = "11111111111111111111111111111111";
static const char *c = "22222222222222222222222222222222";
static std::string hex(const std::string &s) {
	std::string result;
	for( unsigned char b : s ) { result += "0123456789abcdef"[b >> 4]; result += "0123456789abcdef"[b & 15]; }
	return result;
}
static void reload(const il_blob_t &saved, il_operations_t &value) {
	il_blob_t loaded(true);
	for( uint32 i = 0; i < saved.data.get_count(); i++ ) loaded.data.append(saved.data[i]);
	value.rdwr(loaded); assert(!loaded.broken);
}
int main() {
	il_operations_t data;
	const std::string text = "FileType=OuDiaSecond.1.17\n" + std::string(100000, 'x') + "\n駅名=七井\n";
	assert(!data.begin("bad", "-", 10, "test.oud2"));
	assert(!data.begin(a, "-", il_operations_t::max_bytes + 1, "test.oud2"));
	assert(data.begin(a, "-", text.size(), "日本語.oud2"));
	assert(!data.part(a, 1, "41"));
	assert(!data.part(a, 0, "4100")); assert(data.staged.empty());
	assert(data.part(a, 0, hex(text.substr(0, 1600)).c_str()));
	assert(!data.commit(a)); assert(data.source.empty());
	// A joining network client must receive and resume the same partial upload.
	il_blob_t partial(false); data.rdwr(partial);
	il_operations_t restored; reload(partial, restored);
	for( uint32 i = 1600; i < text.size(); i += 1600 ) assert(restored.part(a, i, hex(text.substr(i, 1600)).c_str()));
	assert(restored.commit(a)); assert(restored.source.get_count() == text.size());
	for( uint32 i = 0; i < text.size(); i++ ) assert(restored.source[i] == (uint8)text[i]);
	assert(restored.select(a, 2));
	il_blob_t saved(false); restored.rdwr(saved); reload(saved, data);
	assert(data.diagram == 2 && data.id == a && data.file == "日本語.oud2");
	// An interrupted/replaced upload never changes the committed diagram.
	assert(data.begin(c, a, 100, "next.oud2"));
	assert(!data.commit(c)); assert(data.id == a && data.diagram == 2);
	assert(!data.begin(a, "-", 100, "stale.oud2"));
	assert(!data.clear(c)); assert(!data.select(c, 0));
	assert(data.clear(a)); assert(data.source.empty() && data.diagram == -1);
	il_blob_t empty(false); data.rdwr(empty); reload(empty, restored);
	assert(restored.source.empty() && restored.staged.empty() && restored.diagram == -1);
	// Corrupt byte counts are bounded, including payloads above the old 64KiB string limit.
	il_blob_t broken(true); for( uint32 i = 0; i < saved.data.get_count(); i++ ) broken.data.append(saved.data[i]); broken.data.pop_back(); restored.rdwr(broken); assert(broken.broken);
	uint32 number;
	assert(!il_operations_t::number("4294967296", number));
	assert(!il_operations_t::number("-1", number));
	std::puts("PASS: large UTF-8 diagram save/load, shared selection, staged network join, interrupted upload, conflicts and reset");
}
