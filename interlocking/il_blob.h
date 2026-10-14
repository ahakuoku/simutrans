/*
 * This file is part of the Simutrans project under the Artistic License.
 * (see LICENSE.txt)
 */

#ifndef INTERLOCKING_IL_BLOB_H
#define INTERLOCKING_IL_BLOB_H

#include "../simtypes.h"
#include "../dataobj/koord3d.h"
#include "../tpl/vector_tpl.h"
#include <string.h>

#include "../utils/plainstring.h"

/**
 * The interlocking data in the savegame as one block of bytes with its length, made of
 * sections that also carry their length. A newer version may add fields at the end of a
 * section (or new sections at the end): an older program reads what it knows and skips
 * the rest, so it can still open the savegame.
 * (header only: no source file to add to the build of the core)
 */
class il_blob_t
{
public:
	vector_tpl<uint8> data;
	uint32 pos;
	bool loading;
	bool broken;   ///< read past the end (damaged data)

	explicit il_blob_t(bool load) : pos(0), loading(load), broken(false) {}

	void rdwr_byte(uint8 &v);
	void rdwr_bool(bool &v) { uint8 b = v ? 1 : 0; rdwr_byte(b); v = b != 0; }
	void rdwr_short(uint16 &v);
	void rdwr_short(sint16 &v) { uint16 u = (uint16)v; rdwr_short(u); v = (sint16)u; }
	void rdwr_long(uint32 &v);
	void rdwr_str(plainstring &s);
	void rdwr_pos(koord3d &k);
	void rdwr_pos_vector(vector_tpl<koord3d> &v);
	void rdwr_byte_vector(vector_tpl<uint8> &v);

	/// a section: its length is written in front; when loading, end_section() skips what was not read
	void begin_section();
	void end_section();

private:
	vector_tpl<uint32> sections;
};


inline void il_blob_t::rdwr_byte(uint8 &v)
{
	if(  loading  ) {
		if(  pos >= data.get_count()  ) {
			broken = true;
			v = 0;
			return;
		}
		v = data[pos++];
	}
	else {
		data.append(v);
	}
}


inline void il_blob_t::rdwr_short(uint16 &v)
{
	uint8 lo = (uint8)(v & 0xFF), hi = (uint8)(v >> 8);
	rdwr_byte(lo);
	rdwr_byte(hi);
	v = (uint16)(lo | (hi << 8));
}


inline void il_blob_t::rdwr_long(uint32 &v)
{
	uint16 lo = (uint16)(v & 0xFFFF), hi = (uint16)(v >> 16);
	rdwr_short(lo);
	rdwr_short(hi);
	v = (uint32)lo | ((uint32)hi << 16);
}


inline void il_blob_t::rdwr_str(plainstring &s)
{
	const char *c = s.c_str();
	uint16 len = loading ? 0 : (uint16)(c ? strlen(c) : 0);
	rdwr_short(len);
	if(  loading  ) {
		char *buf = new char[len + 1];
		for(  uint16 i = 0;  i < len;  i++  ) {
			uint8 b = 0;
			rdwr_byte(b);
			buf[i] = (char)b;
		}
		buf[len] = 0;
		s = buf;
		delete [] buf;
	}
	else {
		for(  uint16 i = 0;  i < len;  i++  ) {
			uint8 b = (uint8)c[i];
			rdwr_byte(b);
		}
	}
}


inline void il_blob_t::rdwr_pos(koord3d &k)
{
	sint16 x = k.x, y = k.y;
	uint8 z = (uint8)k.z;
	rdwr_short(x);
	rdwr_short(y);
	rdwr_byte(z);
	if(  loading  ) {
		k = koord3d(x, y, (sint8)z);
	}
}


inline void il_blob_t::rdwr_pos_vector(vector_tpl<koord3d> &v)
{
	uint32 count = v.get_count();
	rdwr_long(count);
	if(  loading  ) {
		v.clear();
		for(  uint32 i = 0;  i < count  &&  !broken;  i++  ) {
			koord3d k;
			rdwr_pos(k);
			v.append(k);
		}
	}
	else {
		for(  uint32 i = 0;  i < count;  i++  ) {
			rdwr_pos(v[i]);
		}
	}
}


inline void il_blob_t::rdwr_byte_vector(vector_tpl<uint8> &v)
{
	uint32 count = v.get_count();
	rdwr_long(count);
	if(  loading  ) {
		v.clear();
		for(  uint32 i = 0;  i < count  &&  !broken;  i++  ) {
			uint8 b = 0;
			rdwr_byte(b);
			v.append(b);
		}
	}
	else {
		for(  uint32 i = 0;  i < count;  i++  ) {
			rdwr_byte(v[i]);
		}
	}
}


inline void il_blob_t::begin_section()
{
	if(  loading  ) {
		uint32 len = 0;
		rdwr_long(len);
		sections.append(pos + len);
	}
	else {
		sections.append(data.get_count());
		uint32 dummy = 0;
		rdwr_long(dummy);
	}
}


inline void il_blob_t::end_section()
{
	if(  sections.empty()  ) {
		return;
	}
	const uint32 mark = sections.back();
	sections.pop_back();
	if(  loading  ) {
		// skip what a newer version added to this section
		if(  mark > data.get_count()  ) {
			broken = true;
			pos = data.get_count();
		}
		else {
			pos = mark;
		}
	}
	else {
		const uint32 len = data.get_count() - mark - 4;
		data[mark] = (uint8)(len & 0xFF);
		data[mark + 1] = (uint8)((len >> 8) & 0xFF);
		data[mark + 2] = (uint8)((len >> 16) & 0xFF);
		data[mark + 3] = (uint8)(len >> 24);
	}
}

#endif
