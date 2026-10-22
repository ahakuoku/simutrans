// g++ -std=c++14 -O2 interlocking/tests/network_eta_test.cc -o network_eta_test
#include "../il_eta.h"
#include <cassert>
#include <cstdio>
#include <cstdlib>

static uint32 remaining(uint32 tiles, uint32 tile_steps, uint32 passed, uint32 speed, uint32 percent = 100)
{
	il_eta_t eta;
	eta.add(tile_steps - passed, speed, percent);
	for(  uint32 i = 1; i < tiles; i++  ) eta.add(tile_steps, speed, percent);
	return eta.ticks();
}

int main()
{
	const uint32 speed = kmh_to_speed(100);
	// With a constant actual speed, the arrival prediction must stay stable
	// over a long straight, including movement within a tile (old ETA drifted).
	for(  uint32 steps : {256u, 181u}  ) {
		const uint32 initial = remaining(80, steps, 0, speed);
		for(  uint32 tiles = 0; tiles < 70; tiles++  ) {
			for(  uint32 partial = 0; partial < steps; partial += 17  ) {
				il_eta_t travelled;
				travelled.add(tiles * steps + partial, speed, 100);
				const uint32 predicted = travelled.ticks() + remaining(80 - tiles, steps, partial, speed);
				assert(std::abs((int)predicted - (int)initial) <= 1);
			}
		}
	}
	// A diagonal must use its actual steps, not the length of a straight tile.
	assert(remaining(80, 181, 0, speed) < remaining(80, 256, 0, speed) * 71 / 100);
	assert(remaining(80, 256, 0, speed, 200) * 2 == remaining(80, 256, 0, speed));
	// Past slow track must not slow the forecast for the remaining fast track.
	il_eta_t full, travelled, tail;
	full.add(10 * 256, kmh_to_speed(40), 100);
	full.add(70 * 256, speed, 100);
	travelled.add(10 * 256, kmh_to_speed(40), 100);
	tail.add(70 * 256, speed, 100);
	assert(std::abs((int)full.ticks() - (int)(travelled.ticks() + tail.ticks())) <= 1);
	std::puts("PASS: straight/diagonal arrival stability, within-tile progress, speed scaling and changing limits");
}
