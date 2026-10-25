/* Part of Simutrans, under the Artistic License (see LICENSE.txt). */
#ifndef INTERLOCKING_IL_OPERATIONS_H
#define INTERLOCKING_IL_OPERATIONS_H
#include "il_blob.h"

// Game state, including an unfinished upload so clients joining via a save
// execute subsequent upload commands against the same state.
struct il_operations_t {
	static const uint32 max_bytes = 8 * 1024 * 1024;
	plainstring id, file, upload, base, upload_file;
	vector_tpl<uint8> source, staged;
	uint32 expected = 0;
	sint16 diagram = -1;

	void reset() { id = ""; file = ""; source.clear(); diagram = -1; cancel(); }
	void cancel() { upload = ""; base = ""; upload_file = ""; staged.clear(); expected = 0; }
	const char *key() const { return id.c_str() && *id.c_str() ? id.c_str() : "-"; }
	static bool token(const char *s) {
		if(  !s || strlen(s) != 32  ) return false;
		for(  uint32 i = 0; i < 32; i++  ) if(  hex(s[i]) < 0  ) return false;
		return true;
	}
	static int hex(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1; }
	static bool number(const char *s, uint32 &n) {
		n = 0;
		if(  !s || !*s  ) return false;
		for(  ; *s; s++  ) {
			if(  *s < '0' || *s > '9' || n > (0xFFFFFFFFu - (*s - '0')) / 10  ) return false;
			n = n * 10 + (*s - '0');
		}
		return true;
	}
	bool begin(const char *t, const char *previous, uint32 size, const char *name) {
		if(  !token(t) || strcmp(previous, key()) || !size || size > max_bytes || !name || !*name || strlen(name) > 512  ) return false;
		cancel(); upload = t; base = previous; upload_file = name; expected = size;
		return true;
	}
	bool part(const char *t, uint32 offset, const char *bytes) {
		const uint32 len = (uint32)strlen(bytes);
		if(  !token(t) || upload != t || offset != staged.get_count() || !len || len > 3200 || len % 2 || offset + len / 2 > expected  ) return false;
		for(  uint32 i = 0; i < len; i += 2  ) {
			if(  hex(bytes[i]) < 0 || hex(bytes[i+1]) < 0 || !(hex(bytes[i]) * 16 + hex(bytes[i+1]))  ) return false;
		}
		for(  uint32 i = 0; i < len; i += 2  ) staged.append((uint8)(hex(bytes[i]) * 16 + hex(bytes[i+1])));
		return true;
	}
	bool commit(const char *t) {
		if(  !token(t) || upload != t || base != key() || staged.get_count() != expected  ) return false;
		const char magic[] = "FileType=OuDiaSecond.";
		const uint32 start = staged.get_count() >= 3 && staged[0] == 239 && staged[1] == 187 && staged[2] == 191 ? 3 : 0;
		if(  staged.get_count() < start + sizeof(magic) - 1  ) return false;
		for(  uint32 i = 0; i < sizeof(magic) - 1; i++  ) if(  staged[start+i] != (uint8)magic[i]  ) return false;
		swap(source, staged); id = t; file = upload_file; diagram = -1; cancel();
		return true;
	}
	bool select(const char *previous, sint16 index) {
		if(  strcmp(previous, key()) || index < -1 || (source.empty() && index != -1)  ) return false;
		diagram = index; return true;
	}
	bool clear(const char *previous) { if( strcmp(previous, key()) ) return false; reset(); return true; }
	void rdwr(il_blob_t &b) {
		b.begin_section();
		b.rdwr_str(id); b.rdwr_str(file); b.rdwr_short(diagram);
		bytes(b, source);
		b.rdwr_str(upload); b.rdwr_str(base); b.rdwr_str(upload_file); b.rdwr_long(expected);
		bytes(b, staged);
		if(  b.loading && (expected > max_bytes || staged.get_count() > expected || diagram < -1 ||
			(!source.empty() && !token(id.c_str())) || (!staged.empty() && !token(upload.c_str())))  ) b.broken = true;
		b.end_section();
	}
private:
	static void bytes(il_blob_t &b, vector_tpl<uint8> &v) {
		uint32 size = v.get_count(); b.rdwr_long(size);
		if(  size > max_bytes || (b.loading && (b.pos > b.data.get_count() || size > b.data.get_count() - b.pos))  ) { b.broken = true; return; }
		if(  b.loading  ) v.clear();
		for(  uint32 i = 0; i < size && !b.broken; i++  ) {
			uint8 c = b.loading ? 0 : v[i]; b.rdwr_byte(c);
			if(  b.loading  ) { if( !c ) b.broken = true; else v.append(c); }
		}
	}
};
#endif
