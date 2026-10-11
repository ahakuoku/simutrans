/*
 * This file is part of the Simutrans project under the Artistic License.
 * (see LICENSE.txt)
 */

// must be included before all simutrans headers (winsock)
#include "../network/network.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "il_bridge.h"
#include "il_manager.h"
#include "il_query.h"
#include "il_json.h"
#include "il_tool.h"

#include "../simdebug.h"
#include "../simworld.h"
#include "../simconvoi.h"
#include "../dataobj/schedule.h"
#include "../simversion.h"
#include "../player/simplay.h"
#include "../pathes.h"
#include "../dataobj/environment.h"
#include "../utils/cbuffer_t.h"
#include "../utils/plainstring.h"

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

#define IL_BRIDGE_DEFAULT_PORT 13360
#define IL_BRIDGE_MAX_CLIENTS 8
#define IL_BRIDGE_MAX_LINE 8192
#define IL_BRIDGE_MAX_EVENTS 1000


namespace il_bridge {

enum client_mode_t {
	MODE_UNKNOWN = 0,
	MODE_LINES   = 1, ///< line protocol (console panel, tests, relay programs)
	MODE_HTTP    = 2  ///< browser (Web panel); one request per connection
};

struct client_t {
	SOCKET sock;
	char buf[IL_BRIDGE_MAX_LINE];
	size_t len;
	uint8 mode;
};

struct event_t {
	uint32 seq;
	plainstring json;
};

static bool initialized = false;
static SOCKET listen_sock = INVALID_SOCKET;
static int listen_port = 0;
static client_t clients[IL_BRIDGE_MAX_CLIENTS];

// events are kept for the Web panel, which polls them with /api/events?since=N
static vector_tpl<event_t> event_log;
static uint32 event_seq = 0;

// the tool keeps a pointer to its default_param, so it must stay valid
static char tool_param[4096];


// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

static int read_port()
{
	if(  const char *env = getenv("TID_IL_PORT")  ) {
		return atoi(env);
	}
	// a dedicated server has no operator: only with an explicit setting
	int port = env_t::server ? 0 : IL_BRIDGE_DEFAULT_PORT;
	cbuffer_t path;
	path.printf("%s%s", env_t::user_dir ? env_t::user_dir : "", "interlocking.tab");
	if(  FILE *f = fopen(path, "r")  ) {
		char line[256];
		while(  fgets(line, sizeof(line), f)  ) {
			if(  strncmp(line, "port", 4) == 0  ) {
				const char *eq = strchr(line, '=');
				if(  eq  ) {
					port = atoi(eq + 1);
				}
			}
		}
		fclose(f);
	}
	return port;
}


static void init()
{
	initialized = true;
	for(  int i = 0;  i < IL_BRIDGE_MAX_CLIENTS;  i++  ) {
		clients[i].sock = INVALID_SOCKET;
		clients[i].len = 0;
		clients[i].mode = MODE_UNKNOWN;
	}

	const int port = read_port();
	if(  port <= 0  ||  port > 65535  ) {
		return;
	}

#if USE_WINSOCK
	WSADATA wsa;
	if(  WSAStartup(MAKEWORD(2, 2), &wsa) != 0  ) {
		dbg->warning("il_bridge::init()", "cannot start winsock");
		return;
	}
#endif

	SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
	if(  s == INVALID_SOCKET  ) {
		dbg->warning("il_bridge::init()", "cannot create socket");
		return;
	}
	int on = 1;
	setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char *)&on, sizeof(on));

	struct sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons((unsigned short)port);
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // local only, never exposed to the network

	if(  bind(s, (struct sockaddr *)&addr, sizeof(addr)) != 0  ||  listen(s, 8) != 0  ) {
		dbg->warning("il_bridge::init()", "cannot listen on 127.0.0.1:%d", port);
		network_close_socket(s);
		return;
	}
	listen_sock = s;
	listen_port = port;
	dbg->message("il_bridge::init()", "interlocking panel: http://127.0.0.1:%d/", port);
}


// ---------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------

static void close_client(client_t &c)
{
	if(  c.sock != INVALID_SOCKET  ) {
		network_close_socket(c.sock);
	}
	c.sock = INVALID_SOCKET;
	c.len = 0;
	c.mode = MODE_UNKNOWN;
}


static void send_raw(client_t &c, const char *data, size_t len)
{
	while(  len > 0  &&  c.sock != INVALID_SOCKET  ) {
		const int sent = send(c.sock, data, (int)len, MSG_NOSIGNAL);
		if(  sent <= 0  ) {
			close_client(c);
			return;
		}
		data += sent;
		len -= sent;
	}
}


static void send_line(client_t &c, const char *text)
{
	cbuffer_t line;
	line.append(text);
	line.append("\n");
	send_raw(c, line.get_str(), line.len());
}


static void send_http(client_t &c, int code, const char *content_type, const char *body, size_t body_len)
{
	const char *status = code == 200 ? "OK" : code == 400 ? "Bad Request" : code == 403 ? "Forbidden" : code == 404 ? "Not Found" : code == 413 ? "Payload Too Large" : "Error";
	cbuffer_t head;
	head.printf("HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %u\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
		code, status, content_type, (unsigned)body_len);
	send_raw(c, head.get_str(), head.len());
	send_raw(c, body, body_len);
	close_client(c);
}


static void send_http_json(client_t &c, const cbuffer_t &json)
{
	send_http(c, 200, "application/json; charset=utf-8", json.get_str(), json.len());
}


static void send_http_error(client_t &c, int code, const char *text)
{
	cbuffer_t json;
	json.append("{\"type\":\"error\",\"error\":\"");
	json.append(text);
	json.append("\"}");
	send_http(c, code, "application/json; charset=utf-8", json.get_str(), json.len());
}


// ---------------------------------------------------------------------------
// requests shared by both protocols
// ---------------------------------------------------------------------------

/// queues an interlocking command; the result arrives as {"type":"result"} event
static bool run_command(const char *param)
{
	tool_t *tool = tool_t::simple_tool[TOOL_INTERLOCKING];
	karte_t *welt = world();
	if(  tool == NULL  ||  welt == NULL  ) {
		return false;
	}
	strncpy(tool_param, param, sizeof(tool_param) - 1);
	tool_param[sizeof(tool_param) - 1] = 0;
	tool->set_default_param(tool_param);
	welt->set_tool(tool, welt->get_active_player());
	return true;
}


static void get_events_json(cbuffer_t &buf, uint32 since)
{
	buf.printf("{\"type\":\"events\",\"last\":%u,\"events\":[", event_seq);
	bool first = true;
	FOR(vector_tpl<event_t>, const &e, event_log) {
		if(  e.seq > since  ) {
			buf.append(first ? "" : ",");
			buf.append(e.json.c_str());
			first = false;
		}
	}
	buf.append("]}");
}


// ---------------------------------------------------------------------------
// line protocol
// ---------------------------------------------------------------------------

static void handle_line(client_t &c, char *line)
{
	// strip CR/LF and leading blanks
	size_t n = strlen(line);
	while(  n > 0  &&  (line[n - 1] == '\r'  ||  line[n - 1] == '\n'  ||  line[n - 1] == ' ')  ) {
		line[--n] = 0;
	}
	while(  *line == ' '  ) {
		line++;
	}
	if(  *line == 0  ) {
		return;
	}

	interlocking_manager_t *il = interlocking_manager_t::get();
	cbuffer_t answer;
	int x1, y1, x2, y2;

	if(  strncmp(line, "cmd ", 4) == 0  ) {
		if(  !run_command(line + 4)  ) {
			send_line(c, "{\"type\":\"error\",\"error\":\"game not ready\"}");
		}
		return;
	}
	else if(  strcmp(line, "status") == 0  ) {
		il->get_status_json(answer);
	}
	else if(  strncmp(line, "signals ", 8) == 0  &&  sscanf(line + 8, "%d %d %d %d", &x1, &y1, &x2, &y2) == 4  ) {
		il->get_signals_json(answer, koord((sint16)x1, (sint16)y1), koord((sint16)x2, (sint16)y2));
	}
	else if(  strncmp(line, "tracks ", 7) == 0  &&  sscanf(line + 7, "%d %d %d %d", &x1, &y1, &x2, &y2) == 4  ) {
		il_query::get_tracks_json(answer, koord((sint16)x1, (sint16)y1), koord((sint16)x2, (sint16)y2));
	}
	else if(  strcmp(line, "halts") == 0  ) {
		il_query::get_halts_json(answer);
	}
	else if(  getenv("TID_IL_DEBUG")  &&  strncmp(line, "debug_tool ", 11) == 0  ) {
		// test helper (only with TID_IL_DEBUG set): run any simple tool, network safe like a GUI click
		char *p = line + 11;
		const int id = atoi(p);
		while(  *p  &&  *p != ' '  ) {
			p++;
		}
		if(  *p == ' '  ) {
			p++;
		}
		karte_t *welt = world();
		if(  id < 0  ||  id >= SIMPLE_TOOL_COUNT  ||  tool_t::simple_tool[id] == NULL  ||  welt == NULL  ) {
			answer.append("{\"type\":\"error\",\"error\":\"invalid tool\"}");
		}
		else {
			strncpy(tool_param, p, sizeof(tool_param) - 1);
			tool_param[sizeof(tool_param) - 1] = 0;
			tool_t::simple_tool[id]->set_default_param(tool_param);
			welt->set_tool(tool_t::simple_tool[id], welt->get_active_player());
			answer.append("{\"type\":\"debug_tool\",\"ok\":true}");
		}
	}
	else if(  getenv("TID_IL_DEBUG")  &&  strcmp(line, "debug_convoys") == 0  ) {
		// test helper (only with TID_IL_DEBUG set): list all convoys
		answer.append("{\"type\":\"convoys\",\"convoys\":[");
		bool first = true;
		FOR(vector_tpl<convoihandle_t>, const cnv, world()->convoys()) {
			const koord3d pos = cnv->get_pos();
			answer.printf("%s{\"id\":%u,\"pos\":[%d,%d,%d],\"state\":%d,\"speed\":%d,\"stop\":%d}", first ? "" : ",", cnv.get_id(), pos.x, pos.y, pos.z, cnv->get_state(), cnv->get_akt_speed(),
				cnv->get_schedule() ? (int)cnv->get_schedule()->get_current_stop() : -1);
			first = false;
		}
		answer.append("]}");
	}
	else if(  getenv("TID_IL_DEBUG")  &&  strncmp(line, "debug_save ", 11) == 0  ) {
		// test helper (only with TID_IL_DEBUG set): save the game into the save folder
		cbuffer_t fn;
		fn.printf(SAVE_PATH_X "%s.sve", line + 11);
		world()->save(fn, false, SAVEGAME_VER_NR, true);
		answer.append("{\"type\":\"debug_save\",\"ok\":true}");
	}
	else if(  strcmp(line, "ping") == 0  ) {
		answer.append("{\"type\":\"pong\"}");
	}
	else {
		answer.append("{\"type\":\"error\",\"error\":\"unknown request (cmd, status, signals, tracks, halts, ping)\"}");
	}
	send_line(c, answer);
}


static void process_lines(client_t &c)
{
	char *start = c.buf;
	char *end = c.buf + c.len;
	for(  char *p = c.buf;  p < end  &&  c.sock != INVALID_SOCKET;  p++  ) {
		if(  *p == '\n'  ) {
			*p = 0;
			handle_line(c, start);
			start = p + 1;
		}
	}
	if(  c.sock == INVALID_SOCKET  ) {
		return;
	}
	// keep the incomplete rest
	const size_t rest = end - start;
	memmove(c.buf, start, rest);
	c.len = rest;
	if(  c.len >= IL_BRIDGE_MAX_LINE - 1  ) {
		// line too long: drop it
		c.len = 0;
	}
}


// ---------------------------------------------------------------------------
// HTTP (Web panel)
// ---------------------------------------------------------------------------

static bool starts_with_nocase(const char *s, const char *prefix, size_t n)
{
	for(  size_t i = 0;  i < n;  i++  ) {
		char a = s[i], b = prefix[i];
		if(  a >= 'A'  &&  a <= 'Z'  ) a += 'a' - 'A';
		if(  b >= 'A'  &&  b <= 'Z'  ) b += 'a' - 'A';
		if(  a != b  ) {
			return false;
		}
	}
	return true;
}


/// value of a header (case insensitive name), copied into out; false if missing
static bool get_header(const char *head, const char *name, char *out, size_t out_size)
{
	const size_t nlen = strlen(name);
	for(  const char *p = strstr(head, "\r\n");  p  &&  p[2];  p = strstr(p + 2, "\r\n")  ) {
		const char *line = p + 2;
		if(  starts_with_nocase(line, name, nlen)  &&  line[nlen] == ':'  ) {
			const char *v = line + nlen + 1;
			while(  *v == ' '  ) {
				v++;
			}
			size_t i = 0;
			while(  v[i]  &&  v[i] != '\r'  &&  i + 1 < out_size  ) {
				out[i] = v[i];
				i++;
			}
			out[i] = 0;
			return true;
		}
	}
	return false;
}


static int get_query_int(const char *query, const char *name, int def)
{
	const size_t nlen = strlen(name);
	for(  const char *p = query;  p  &&  *p;  ) {
		if(  strncmp(p, name, nlen) == 0  &&  p[nlen] == '='  ) {
			return atoi(p + nlen + 1);
		}
		p = strchr(p, '&');
		if(  p  ) {
			p++;
		}
	}
	return def;
}


/// directory with the panel files (index.html ...), searched once
static const char *panel_dir()
{
	static plainstring dir;
	static bool searched = false;
	if(  !searched  ) {
		searched = true;
		vector_tpl<plainstring> candidates;
		if(  const char *env = getenv("TID_IL_PANEL_DIR")  ) {
			cbuffer_t d;
			d.printf("%s/", env);
			candidates.append(plainstring(d.get_str()));
		}
		cbuffer_t d1, d2, d3;
		d1.printf("%sinterlocking_panel/", env_t::data_dir);
		d2.printf("%sinterlocking_panel/", env_t::user_dir ? env_t::user_dir : "");
		d3.printf("%s../interlocking/panel/", env_t::data_dir); // running from the source tree
		candidates.append(plainstring(d1.get_str()));
		candidates.append(plainstring(d2.get_str()));
		candidates.append(plainstring(d3.get_str()));
		FOR(vector_tpl<plainstring>, const &c, candidates) {
			cbuffer_t fn;
			fn.printf("%sindex.html", c.c_str());
			if(  FILE *f = fopen(fn, "rb")  ) {
				fclose(f);
				dir = c;
				dbg->message("il_bridge", "panel files from %s", c.c_str());
				break;
			}
		}
	}
	return dir.c_str();
}


static void serve_file(client_t &c, const char *path)
{
	if(  *path == '/'  ) {
		path++;
	}
	if(  *path == 0  ) {
		path = "index.html";
	}
	// only plain relative names
	for(  const char *p = path;  *p;  p++  ) {
		const bool ok = (*p >= 'a'  &&  *p <= 'z')  ||  (*p >= 'A'  &&  *p <= 'Z')  ||  (*p >= '0'  &&  *p <= '9')  ||  *p == '.'  ||  *p == '-'  ||  *p == '_'  ||  *p == '/';
		if(  !ok  ) {
			send_http_error(c, 404, "not found");
			return;
		}
	}
	if(  strstr(path, "..")  ) {
		send_http_error(c, 404, "not found");
		return;
	}

	const char *dir = panel_dir();
	if(  dir == NULL  ||  *dir == 0  ) {
		const char *msg = "<!doctype html><meta charset=utf-8><title>TID panel</title>"
			"<p>Panel files not found. Copy <code>interlocking/panel/</code> to <code>interlocking_panel/</code> "
			"in the Simutrans folder (or set TID_IL_PANEL_DIR).</p>";
		send_http(c, 404, "text/html; charset=utf-8", msg, strlen(msg));
		return;
	}

	cbuffer_t fn;
	fn.printf("%s%s", dir, path);
	FILE *f = fopen(fn, "rb");
	if(  f == NULL  ) {
		send_http_error(c, 404, "not found");
		return;
	}
	fseek(f, 0, SEEK_END);
	const long size = ftell(f);
	fseek(f, 0, SEEK_SET);
	if(  size < 0  ||  size > 4 * 1024 * 1024  ) {
		fclose(f);
		send_http_error(c, 404, "not found");
		return;
	}
	char *data = (char *)malloc(size + 1);
	const size_t got = fread(data, 1, size, f);
	fclose(f);

	const char *ext = strrchr(path, '.');
	const char *type = "application/octet-stream";
	if(  ext  ) {
		if(  strcmp(ext, ".html") == 0  ) type = "text/html; charset=utf-8";
		else if(  strcmp(ext, ".js") == 0  ) type = "text/javascript; charset=utf-8";
		else if(  strcmp(ext, ".css") == 0  ) type = "text/css; charset=utf-8";
		else if(  strcmp(ext, ".json") == 0  ) type = "application/json; charset=utf-8";
		else if(  strcmp(ext, ".svg") == 0  ) type = "image/svg+xml";
		else if(  strcmp(ext, ".png") == 0  ) type = "image/png";
	}
	send_http(c, 200, type, data, got);
	free(data);
}


static void handle_http(client_t &c, char *head, const char *body)
{
	char method[8] = { 0 };
	char target[1024] = { 0 };
	if(  sscanf(head, "%7s %1023s", method, target) != 2  ) {
		send_http_error(c, 400, "bad request");
		return;
	}

	// protection against DNS rebinding: the browser must talk to us as localhost
	char host[256];
	if(  !get_header(head, "Host", host, sizeof(host))  ) {
		send_http_error(c, 403, "forbidden");
		return;
	}
	char expected[3][64];
	sprintf(expected[0], "127.0.0.1:%d", listen_port);
	sprintf(expected[1], "localhost:%d", listen_port);
	sprintf(expected[2], "[::1]:%d", listen_port);
	if(  strcmp(host, expected[0]) != 0  &&  strcmp(host, expected[1]) != 0  &&  strcmp(host, expected[2]) != 0  ) {
		send_http_error(c, 403, "forbidden");
		return;
	}

	char *query = strchr(target, '?');
	if(  query  ) {
		*query++ = 0;
	}

	interlocking_manager_t *il = interlocking_manager_t::get();
	cbuffer_t json;

	if(  strcmp(method, "POST") == 0  ) {
		// commands only from our own page: other web sites cannot set this header without CORS permission
		char marker[16];
		if(  !get_header(head, "X-IL-Panel", marker, sizeof(marker))  ||  strcmp(marker, "1") != 0  ) {
			send_http_error(c, 403, "forbidden");
			return;
		}
		if(  strcmp(target, "/api/cmd") == 0  ) {
			if(  !run_command(body)  ) {
				send_http_error(c, 400, "game not ready");
				return;
			}
			json.append("{\"type\":\"queued\",\"ok\":true}");
			send_http_json(c, json);
			return;
		}
		send_http_error(c, 404, "not found");
		return;
	}

	if(  strcmp(method, "GET") != 0  ) {
		send_http_error(c, 400, "bad request");
		return;
	}

	if(  strcmp(target, "/api/status") == 0  ) {
		il->get_status_json(json);
	}
	else if(  strcmp(target, "/api/events") == 0  ) {
		get_events_json(json, (uint32)get_query_int(query, "since", 0));
	}
	else if(  strcmp(target, "/api/halts") == 0  ) {
		il_query::get_halts_json(json);
	}
	else if(  strcmp(target, "/api/tracks") == 0  ) {
		il_query::get_tracks_json(json,
			koord((sint16)get_query_int(query, "x1", 0), (sint16)get_query_int(query, "y1", 0)),
			koord((sint16)get_query_int(query, "x2", 0), (sint16)get_query_int(query, "y2", 0)));
	}
	else if(  strcmp(target, "/api/info") == 0  ) {
		karte_t *welt = world();
		json.printf("{\"type\":\"info\",\"protocol\":2,\"map\":[%d,%d],\"player\":%d,\"players\":[",
			welt ? welt->get_size().x : 0, welt ? welt->get_size().y : 0,
			welt  &&  welt->get_active_player() ? welt->get_active_player()->get_player_nr() : -1);
		// company names, for sorting stations and signals by company in the panel
		bool first = true;
		for(  uint8 i = 0;  welt  &&  i < MAX_PLAYER_COUNT;  i++  ) {
			if(  player_t *pl = welt->get_player(i)  ) {
				json.printf("%s{\"nr\":%d,\"name\":", first ? "" : ",", i);
				append_json_string(json, pl->get_name());
				json.append("}");
				first = false;
			}
		}
		json.append("]}");
	}
	else if(  strncmp(target, "/api/", 5) == 0  ) {
		send_http_error(c, 404, "not found");
		return;
	}
	else {
		serve_file(c, target);
		return;
	}
	send_http_json(c, json);
}


/// handles the request once it is complete
static void process_http(client_t &c)
{
	c.buf[c.len] = 0;
	char *end_of_head = strstr(c.buf, "\r\n\r\n");
	if(  end_of_head == NULL  ) {
		if(  c.len >= IL_BRIDGE_MAX_LINE - 1  ) {
			send_http_error(c, 413, "request too large");
		}
		return;
	}
	*end_of_head = 0;
	char *body = end_of_head + 4;
	char value[32];
	const size_t content_length = get_header(c.buf, "Content-Length", value, sizeof(value)) ? (size_t)atoi(value) : 0;
	const size_t have = c.len - (body - c.buf);
	if(  have < content_length  ) {
		if(  c.len >= IL_BRIDGE_MAX_LINE - 1  ) {
			send_http_error(c, 413, "request too large");
		}
		else {
			*end_of_head = '\r'; // wait for the rest of the body
		}
		return;
	}
	body[content_length] = 0;
	handle_http(c, c.buf, body);
}


// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

static void read_client(client_t &c)
{
	const size_t room = IL_BRIDGE_MAX_LINE - 1 - c.len;
	if(  room == 0  ) {
		close_client(c);
		return;
	}
	const int got = recv(c.sock, c.buf + c.len, (int)room, 0);
	if(  got <= 0  ) {
		close_client(c);
		return;
	}
	c.len += got;

	if(  c.mode == MODE_UNKNOWN  &&  c.len >= 4  ) {
		c.mode = (strncmp(c.buf, "GET ", 4) == 0  ||  strncmp(c.buf, "POST", 4) == 0  ||  strncmp(c.buf, "HEAD", 4) == 0  ||  strncmp(c.buf, "OPTI", 4) == 0) ? MODE_HTTP : MODE_LINES;
	}
	if(  c.mode == MODE_LINES  ) {
		process_lines(c);
	}
	else if(  c.mode == MODE_HTTP  ) {
		process_http(c);
	}
}


void poll()
{
	if(  !initialized  ) {
		init();
	}
	if(  listen_sock == INVALID_SOCKET  ) {
		return;
	}

	fd_set fds;
	FD_ZERO(&fds);
	FD_SET(listen_sock, &fds);
	SOCKET max_sock = listen_sock;
	for(  int i = 0;  i < IL_BRIDGE_MAX_CLIENTS;  i++  ) {
		if(  clients[i].sock != INVALID_SOCKET  ) {
			FD_SET(clients[i].sock, &fds);
			if(  clients[i].sock > max_sock  ) {
				max_sock = clients[i].sock;
			}
		}
	}
	struct timeval tv = { 0, 0 };
	if(  select((int)max_sock + 1, &fds, NULL, NULL, &tv) > 0  ) {
		if(  FD_ISSET(listen_sock, &fds)  ) {
			SOCKET s = accept(listen_sock, NULL, NULL);
			if(  s != INVALID_SOCKET  ) {
				int slot = -1;
				for(  int i = 0;  i < IL_BRIDGE_MAX_CLIENTS;  i++  ) {
					if(  clients[i].sock == INVALID_SOCKET  ) {
						slot = i;
						break;
					}
				}
				if(  slot < 0  ) {
					network_close_socket(s);
				}
				else {
#ifdef SO_NOSIGPIPE
					// macOS has no MSG_NOSIGNAL: a closed panel must not kill the game
					int on = 1;
					setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, (const char *)&on, sizeof(on));
#endif
					clients[slot].sock = s;
					clients[slot].len = 0;
					clients[slot].mode = MODE_UNKNOWN;
				}
			}
		}
		for(  int i = 0;  i < IL_BRIDGE_MAX_CLIENTS;  i++  ) {
			if(  clients[i].sock != INVALID_SOCKET  &&  FD_ISSET(clients[i].sock, &fds)  ) {
				read_client(clients[i]);
			}
		}
	}

	// forward the events of the interlocking: pushed to line clients, kept for the Web panel
	cbuffer_t ev;
	while(  interlocking_manager_t::get()->pop_event(ev)  ) {
		event_t e;
		e.seq = ++event_seq;
		e.json = ev.get_str();
		if(  event_log.get_count() >= IL_BRIDGE_MAX_EVENTS  ) {
			event_log.remove_at(0);
		}
		event_log.append(e);
		for(  int i = 0;  i < IL_BRIDGE_MAX_CLIENTS;  i++  ) {
			if(  clients[i].mode == MODE_LINES  ) {
				send_line(clients[i], ev);
			}
		}
		ev.clear();
	}
}


void shutdown()
{
	for(  int i = 0;  i < IL_BRIDGE_MAX_CLIENTS;  i++  ) {
		close_client(clients[i]);
	}
	if(  listen_sock != INVALID_SOCKET  ) {
		network_close_socket(listen_sock);
		listen_sock = INVALID_SOCKET;
	}
}

} // namespace il_bridge
