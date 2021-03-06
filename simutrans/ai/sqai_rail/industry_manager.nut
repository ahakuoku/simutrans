/**
 * Classes to manage industry connections.
 */

/**
 * A link is a connection between two factories.
 * Save its state here.
 */
class industry_link_t
{
	f_src   = null // factory_x
	f_dest  = null // factory_x
	freight = null // good_desc_x

	state = 0
	lines = null   // array<line_x>

	double_ways_count = 0 // count of double way build
	double_ways_build = 0 // double way build: 0 = no ; 1 = yes

	// next check needed if ticks > next_check
	// state == st_missing: check availability again
	// state == st_build: check for possible upgrades
	next_check = 0 // only set for st_missing, next time availability has to be checked

	static st_free    = 0 /// not registered
	static st_planned = 1 /// link is planned
	static st_failed  = 2 /// construction failed, do not try again
	static st_built   = 3 /// connection successfully built
	static st_missing = 4 /// missing infrastructure, try again later

	constructor(s,d,f)
	{
		f_src = s
		f_dest = d
		freight = good_desc_x(f)
		lines = []
	}

	function append_line(l)
	{
		lines.append(l)
	}
	function remove_line(l)
	{
		lines.remove(l)
	}
	function _save()
	{
		return ::saveinstance("industry_link_t", this)
	}
}

/**
 * Manage the links operated by us.
 */
class industry_manager_t extends manager_t
{
	link_list = null
	link_iterator = null

	// print messages box
	// 1 = vehicles
	// 2 =
	// 3 =
	print_message_box = 0

	constructor()
	{
		base.constructor("industry_manager_t")
		link_list = {}
		::industry_manager = this
	}

	/// Generate unique key from link data
	static function key(src, des, fre)
	{
		return ("freight-" + fre + "-from-" + coord_to_key(src) + "-to-"  + coord_to_key(des) ).toalnum()
	}

	function set_link_state(src, des, fre, state)
	{
		local k = key(src, des, fre)

		try {
			link_list[k].state = state
		}
		catch(ev) {
			// not existing - create entry
			local l = industry_link_t(src, des, fre)
			l.state = state
			link_list[k] <- l
		}

		if (state == industry_link_t.st_built) {
			link_list[k].next_check = world.get_time().next_month_ticks

			local text = ""
			text = "Transport " + translate(fre) + " from "
			text += coord(src.x, src.y).href(src.get_name()) + " to "
			text += coord(des.x, des.y).href(des.get_name()) + "<br>"
		}

		if (state == industry_link_t.st_missing) {
			link_list[k].next_check = world.get_time().next_month_ticks
		}
	}

	function get_link_state(src, des, fre)
	{
		local link = access_link(src, des, fre)

		return link  ?  link.state  :  industry_link_t.st_free
	}

	function access_link(src, des, fre)
	{
		local k = key(src, des, fre)
		local res
		try {
			res = link_list[k]
		}
		catch(ev) {
			res = null
		}
		return res
	}

	/**
	 * Loop through all links.
	 */
	function work()
	{
		// iterate the link_iterator, which is a generator
		if (link_iterator == null) {
			// this is a generator
			link_iterator = link_iteration()
		}
		if (link_iterator.getstatus() != "dead") {
			resume link_iterator
		}
		else {
			link_iterator = null
			return r_t(RT_SUCCESS);
		}
		return r_t(RT_PARTIAL_SUCCESS);
	}

	function link_iteration()
	{
		foreach(link in link_list) {
			check_link(link)
			yield link
		}
	}

	/**
	 * Check link:
	 * - if state is st_missing set state to st_free after some time
	 * - for working links see after their lines
	 */
	function check_link(link)
	{
		switch(link.state) {
			case industry_link_t.st_free:
			case industry_link_t.st_planned:
			case industry_link_t.st_failed:
				return
			case industry_link_t.st_built:
				if (link.lines.len()==0) return
				break
			case industry_link_t.st_missing:
				if (link.next_check >= world.get_time().ticks) return
				// try to plan again
				link.state = industry_link_t.st_free
				break
		}

		// iterate through all lines
		foreach(index, line in link.lines) {
			if ( line.is_valid() ) {
				//gui.add_message_at(our_player, "####### valid line " + line.get_name(), world.get_time())
				check_link_line(link, line)
			} else {
				gui.add_message_at(our_player, "####### invalid line " + line, world.get_time())
				link.lines.remove(index)
			}
		}
	}

	/**
	 * Manages convoys of one line: withdraw if there are too many, build new ones, upgrade to newer vehicles
	 */
	function check_link_line(link, line)
	{

		local  print_message_box = 0

		dbgprint("Check line " + line.get_name())
		//gui.add_message_at(our_player, "Check line " + line.get_name(), world.get_time())
		// find convoy
		local cnv = null
		local cnv_count = 0
		{
			local list = line.get_convoy_list()
			cnv_count = list.get_count()
			if (cnv_count == 0) {
				// 0 convoy destroy line
				if ( line.get_owner().nr == our_player.nr ) { destroy_line(line) }
				return
			}
			cnv = list[0]
		}

		if ( line.get_owner().nr == our_player.nr ) {
			// non profit in 5 months then destroy line //cnv.get_distance_traveled_total() > 3 &&
			local profit_count = line.get_profit()
			//if ( cnv.get_distance_traveled_total() < 3 ) { return }
			if ( (profit_count[4] < 0 || profit_count[4] == 0) && profit_count[3] == 0 && profit_count[2] == 0 && profit_count[1] == 0 && profit_count[0] == 0 ) {
				if ( cnv.get_distance_traveled_total() > 1 && cnv.get_distance_traveled_total() < 25 && cnv.get_loading_level() == 0 ) {
					destroy_line(line)
				} else {
					//gui.add_message_at(our_player, "return cnv/line new " + line.get_name(), world.get_time())
				}
				return
			}
		}


		if (cnv.is_withdrawn()) {
			// come back later
			return
		}

		// try to upgrade
		if (cnv.has_obsolete_vehicles()  &&  link.next_check < world.get_time().ticks) {
			link.next_check = world.get_time().next_month_ticks
			if (upgrade_link_line(link, line)) {
				// update successful
				return
			}
		}

		local lf = link.freight
		// capacity of convoy
		local capacity = 0
		{
 			local lf = link.freight
			foreach(v in cnv.get_vehicles()) {
				local f = v.get_freight()
				if (lf.is_interchangeable(f)) {
					capacity += v.get_capacity()
				}
			}
		}
		dbgprint("Capacity of convoy " + cnv.get_name() + " = " + capacity)
		dbgprint("Speed of convoy " + cnv.get_name() + " = " + cnv.get_speed())

		// iterate through schedule, check for available freight
		local freight_available = false
		local start_l = null
		local end_l = null
		{
			local entries = cnv.get_schedule().entries
			if ( entries.len() >= 2 ) {
				start_l = tile_x(entries[0].x, entries[0].y, entries[0].z)
				end_l = tile_x(entries[entries.len()-1].x, entries[entries.len()-1].y, entries[entries.len()-1].z)
			}

			local i = 0;

			while(i < entries.len()  &&  !freight_available) {
				local entry = entries[i]
				// stations on schedule
				local halt = entry.get_halt(our_player)
				if (halt == null) continue

				// next station on schedule
				local nexthalt = null
				i++
				while(i < entries.len()) {
					if (nexthalt = entries[i].get_halt(our_player)) break
					i++
				}
				if (nexthalt == null) {
					nexthalt = entries[0].get_halt(our_player)
				}
				// freight available ?
				local freight_on_schedule = halt.get_freight_to_halt(lf, nexthalt)
				local capacity_halt = halt.get_capacity(lf)
				dbgprint("Freight from " + halt.get_name() + " to " + nexthalt.get_name() + " = " + freight_on_schedule)
				// either start is 2/3 full or more good available as one cnv can transport
				freight_available = (3*freight_on_schedule > 2*capacity_halt)
					|| (freight_on_schedule > capacity);
			}
		}


		// calc gain per month of one convoy
		local gain_per_m = 0
		{
			local p = line.get_profit()
			gain_per_m = p.reduce(sum) / (p.len() * cnv_count)
			dbgprint("Gain pm = " + gain_per_m)
		}

		// check state if convoys (loading level, stopped, new)
		local cc_load  = 0
		local cc_stop  = 0
		local cc_new   = 0
		local cc_empty = 0
		local cnv_empty_stopped = null
		//local remove_cnv = 0
		{
			local list = line.get_convoy_list()
			foreach(c in list)
			{
				// convoy empty?
				local is_empty = c.get_loading_level() == 0
				// convoy new? less than 2 months old, and not much transported
				local d = c.get_traveled_distance()

				local is_new = (d[0] + d[1] == c.get_distance_traveled_total())
				if (is_new) {
					local t = c.get_transported_goods();
					if (t.reduce(sum) >= 2*capacity) {
						is_new = false
					}
				}
				if (is_new) {
					cc_new ++
					 is_empty = false
				}
				// new convoys do not count as empty
				if (is_empty) {
					cc_empty++
				}
				// convoy stopped? but not for loading
				local is_stopped = false
				if (c.get_speed() == 0) {
					if (c.get_loading_limit() > 0) {
						// loading
						cc_load ++
					}
					else {
						cc_stop ++
						is_stopped = true;
					}
				}

				if (is_empty  &&  is_stopped  &&  cnv_empty_stopped==null) {
					cnv_empty_stopped = c
				}

				// stucked road vehicles destroy
				if ( c.get_distance_traveled_total() > 0 && d[0] == 0 && d[1] == 0 && c.is_loading() == false && c.get_waytype() == wt_road && cnv_count > 1) {
					//gui.add_message_at(our_player, "####### destroy stucked road vehicles " + cnv_count, world.get_time())
					c.destroy(our_player)
					cnv_count--
					//remove_cnv++
				}

			}
		}
		dbgprint("Line:  loading = " + cc_load + ", stopped = " + cc_stop + ", new = " + cc_new + ", empty = " + cc_empty)
		dbgprint("")

		if (freight_available  &&  cc_new == 0  &&  cc_stop < 2) {

			// stations distance
			local l = abs(start_l.x - end_l.x) + abs(start_l.y - end_l.y)
			local c = 0
			if ( l > 50 && l <= 90 ) {
				c = 1
			}	else if ( l > 90 && l <= 160 ) {
				c = 2
			}	else if ( l > 160 && l <= 220 ) {
				c = 3
			} else if ( l > 220 && l <= 350 ) {
				c = 4
			} else if ( l > 350 && l <= 480 ) {
				c = 5
			} else if ( l > 480 ) {
				c = 6
			}


			// no signals and double tracks - limit 1 convoy for rail
			if (cnv.get_waytype() == wt_rail && cnv_count == 1 && c > 0 && link.double_ways_build == 0 ) {
				if ( print_message_box == 1 ) {
					gui.add_message_at(our_player, "####### cnv.get_waytype() " + cnv.get_waytype() + " cnv.name " + cnv.get_name(), world.get_time())
					gui.add_message_at(our_player, "####### lenght " + l + " double ways " + c, world.get_time())
				}
				//
				// check way for find fields for double track
				local s_fields = check_way_line(start_l, end_l, cnv.get_waytype(), l, c)
				local cc = 1

				gui.add_message_at(our_player, "####### s_fields.len() " + s_fields.len(), world.get_time())
				if ( s_fields.len() == 0 ) {
					s_fields = check_way_line(end_l, start_l, cnv.get_waytype(), l, c)
				}

				//gui.add_message_at(our_player, "####### s_fields " + s_fields, world.get_time())
				if ( s_fields == true ) {
					cc += c
				} else {
					//gui.add_message_at(our_player, "####### s_fields.len() " + s_fields.len(), world.get_time())

					local build = false
					if ( s_fields.len() == c || s_fields.len() == c - 1 ) {
						if ( s_fields.len() == c - 1 ) {
							c--
						}

						for ( local i = 0; i < c; i++ ) {
							build = build_double_track(s_fields[i], wt_rail)
							if ( build ) {
								cc++
								build = false
							}
						}
					}
				}

				if ( cc > 1 ) {
					link.double_ways_count = cc
					link.double_ways_build = 1
				} else {
					return
				}
			} else if (cnv.get_waytype() == wt_rail && (cnv_count > c || c == 0) ) {
				return
			}

			if ( link.double_ways_count > 0 ) {
				cnv_count = link.double_ways_count + 1
				//gui.add_message_at(our_player, "###---- set convoy count from link.double_ways_count " + cnv_count, world.get_time())
			}


			if (gain_per_m > 0) {
				// directly append
				// TODO put into report
				local proto = cnv_proto_t.from_convoy(cnv, lf)
				local wt = cnv.get_schedule().waytype

				local wt = cnv.get_waytype()

				if ( print_message_box == 1 ) {
					gui.add_message_at(our_player, "###---- check convoys line : " + line.get_name(), world.get_time())
				}

				// plan convoy prototype
				local freight = lf.get_name()
				local prototyper = prototyper_t(wt, freight)

				prototyper.min_speed = 1

				prototyper.max_vehicles = get_max_convoi_length(wt)
				prototyper.max_length = prototyper.max_vehicles * 8

				local cnv_valuator = valuator_simple_t()
				cnv_valuator.wt = wt
				cnv_valuator.freight = freight
				cnv_valuator.volume = line.get_transported_goods().reduce(max)
				cnv_valuator.max_cnvs = 200
				// no signals and double tracks - limit 1 convoy for rail
				if (wt == wt_rail) {
					cnv_valuator.max_cnvs = 1
				}

				// through schedule to estimate distance
				local dist = 0
				local entries = cnv.get_schedule().entries
				dist = abs(entries[0].x - entries[1].x) + abs(entries[0].y - entries[1].y)
				// add 10% from distance
				dist += dist / 100 * 10

				cnv_valuator.distance = dist

				local bound_valuator = valuator_simple_t.valuate_monthly_transport.bindenv(cnv_valuator)
				prototyper.valuate = bound_valuator

				if (prototyper.step().has_failed()) {
					if ( print_message_box == 1 ) {
						gui.add_message_at(our_player, "   ----> prototyper.step().has_failed() ", world.get_time())
					}
					return null
				}
				local proto = prototyper.best

				if ( print_message_box == 1 ) {
					gui.add_message_at(our_player, "   ----> proto : " + proto, world.get_time())
				}

				// build convoy
				local stations_list = cnv.get_schedule().entries
				local depot = null //cnv.get_home_depot()

				for (local i=0; i<stations_list.len(); i++) {
					local c = tile_x(stations_list[i].x, stations_list[i].y, stations_list[i].z)
					depot = search_depot(c, wt)
					if ( depot != null && depot != false ) {
						if ( print_message_box == 1 ) {
							gui.add_message_at(our_player, "####--> station " + coord_to_string(c), c)
							gui.add_message_at(our_player, "####--> depot " + depot, world.get_time())
						}
						break
					}
					if ( print_message_box == 1 ) {
							gui.add_message_at(our_player, "####--> not depot found", world.get_time())
					}

				}
				if ( depot == null || depot == false ) {
					return false
				}

				local c = vehicle_constructor_t()

				c.p_depot  = depot_x(depot.x, depot.y, depot.z)
				c.p_line   = line
				c.p_convoy = proto
				c.p_count  = 1
				append_child(c)
				dbgprint("==> build additional convoy")
				if ( print_message_box == 1 ) {
					gui.add_message_at(our_player, "####### cnv_count " + cnv_count, world.get_time())
					gui.add_message_at(our_player, "Line: " + line.get_name() + " ==> build additional convoy", world.get_time())
				}
			}
		}

		if (!freight_available  &&  cnv_count>1  &&  2*cc_empty >= cnv_count  &&  cnv_empty_stopped) {
			// freight, lots of empty and of stopped vehicles
			// -> something is blocked, maybe we block our own supply?
			// delete one convoy
			cnv_empty_stopped.destroy(our_player)
			dbgprint("==> destroy empty convoy")
			if ( print_message_box == 1 ) {
				gui.add_message_at(our_player, "####### cnv_count " + cnv_count, world.get_time())
				gui.add_message_at(our_player, "Line: " + line.get_name() + " ==> destroy empty convoy", world.get_time())
			}
		}
		dbgprint("")

	}

	/**
	 * Upgrade: plan a new convoy type with the prototyper, then
	 * sell existing convoys, create new ones.
	 */
	function upgrade_link_line(link, line)
	{
		// find convoy
		local cnv = null
		{
			local list = line.get_convoy_list()
			if (list.get_count() == 0) {
				// no convois - strange
				return false
			}
			cnv = list[0]
		}
		local wt = cnv.get_waytype()
		// estimate transport volume
		local transported = line.get_transported_goods().reduce(max)

		// plan convoy prototype
		local prototyper = prototyper_t(wt, link.freight.get_name())

		// iterate through schedule to estimate distance
		local dist = 0
		{
			local entries = cnv.get_schedule().entries
			local halts = []
			for(local i=0; i < entries.len(); i++) {
				if (entries[i].get_halt(our_player)) {
					halts.append( entries[i] )
				}
			}
			if (halts.len() < 2) {
				// not enough halts??
				return false
			}
			dist = abs(halts.top().x - halts[0].x) + abs(halts.top().y - halts[0].y)

			for(local i=1; i < halts.len(); i++) {
				dist = max(dist, abs(halts[i].x - halts[i-1].x) + abs(halts[i].y - halts[i-1].y) )
			}
		}

		local wt = wt
		// TODO do something smarter
		prototyper.min_speed  = 1
		prototyper.max_vehicles = get_max_convoi_length(wt)
		prototyper.max_length = 1
		if (wt == wt_water) {
			prototyper.max_length = 4
		}

		local cnv_valuator    = valuator_simple_t()
		cnv_valuator.wt       = wt
		cnv_valuator.freight  = link.freight.get_name()
		cnv_valuator.volume   = transported
		cnv_valuator.max_cnvs = 200
		cnv_valuator.distance = dist

		local bound_valuator = valuator_simple_t.valuate_monthly_transport.bindenv(cnv_valuator)
		prototyper.valuate = bound_valuator

		if (prototyper.step().has_failed()) {
			return false
		}

		local planned_convoy = prototyper.best
		// check whether different from current convoy
		local cnv_veh = cnv.get_vehicles()
		local pro_veh = planned_convoy.veh

		local different = cnv_veh.len() != pro_veh.len()
		for(local i=0; i<cnv_veh.len()  &&  !different; i++) {
			different = !cnv_veh[i].is_equal(pro_veh[i])
		}
		if (!different) {
			return false
		}

		dbgprint("Upgrade line "  + line.get_name())
		// build the new one, withdraw the old ones
		// directly append
		local depot  = cnv.get_home_depot()
		// TODO put into report
		local c = vehicle_constructor_t()
		c.p_depot    = depot_x(depot.x, depot.y, depot.z)
		c.p_line     = line
		c.p_convoy   = planned_convoy
		c.p_count    = min(planned_convoy.nr_convoys, 3)
		c.p_withdraw = true
		append_child(c)
		return true
	}

	// keys were broken for rotated maps, regenerate keys for all entries
	function repair_keys()
	{
		link_iterator = null
		local save_list = link_list
		link_list = {}

		foreach(link in save_list) {
			link_list[ key(link.f_src, link.f_dest, link.freight.get_name()) ] <- link
		}

	}

	function _save()
	{
		link_iterator = null // wont save
		return ::saveinstance("industry_manager_t", this)
	}

}
