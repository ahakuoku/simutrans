# 新しい OTRP 本体への移植手順（TID 連動盤）

この機能は、OTRP 本体には**呼び出し口（フック）を約 30 行入れるだけ**で、中身はすべて `interlocking/` にある。
新しい OTRP（例: v50 → v60）に載せ替えるときは、この手順に従う。

## 手順

```sh
# 0. 新しい OTRP のソースを用意する（このリポジトリの本体コードを新版に置き換える）

# 1. interlocking/ フォルダを丸ごとコピーする（変更不要のはず）

# 2. フックのパッチを当てる
git apply --3way interlocking/hooks.patch
#    当たらなかった箇所は、下の「フック一覧」を見て手で入れる

# 3. フックの入れ漏れと、使っている本体関数の有無を確認する
sh interlocking/check_hooks.sh

# 4. ビルドする（コンパイルエラー = 本体側の関数が変わった箇所。そこだけ追従する）
make -j4

# 5. 動作確認（下の「テスト」を参照）
python3 interlocking/tests/run_test.py --sim build/default/sim --workdir <作業ディレクトリ>

# 6. 新しいフックの差分でパッチを作り直す
git diff -- vehicle/simvehicle.cc simworld.cc simmenu.h simmenu.cc Makefile \
    cmake/SimutransSourceList.cmake Simutrans-Main.vcxitems > interlocking/hooks.patch
```

フックはすべて `#ifdef TID_INTERLOCKING` で囲み、`// TID_IL` の目印を付けてある。
`grep -rn "TID_IL" --include=*.cc --include=*.h --include=Makefile .` で全部見つかる。
`interlocking/interlocking.h` の `#define TID_INTERLOCKING 1` をコメントアウトすると、元の OTRP と同じ動作になる。

## フック一覧

行番号は版によってずれるので、**関数名と目印のコード**で場所を示す。
v60 で関数が分割・改名されていたら、「役割」に合う場所を探して入れる。

### H1 信号判定 — `vehicle/simvehicle.cc`

- 役割: てこ扱い信号なら、信号を進行にするかどうかの判定を連動装置に任せる。
- 場所: `rail_vehicle_t::is_signal_clear()` の中。`cnv->clear_reserved_tiles();` を呼ぶ `if` ブロックの**直後**、
  信号の種類ごとの分岐（`is_simple_signal()` など）の**前**。
- ファイル先頭の `#include "simvehicle.h"` の後に `#include "../interlocking/interlocking.h" // TID_IL`。

```cpp
#ifdef TID_INTERLOCKING // TID_IL H1: signal controlled by the interlocking panel
	{ bool il_result; if(  interlocking_hook_signal( this, next_block, restart_speed, call_by_step, il_result )  ) { return il_result; } }
#endif
```

### H8 発車 — `vehicle/simvehicle.cc`

- 役割: 仮想出発信号（ホームに信号を置かない番線の出発管理）。発車しようとする列車を、出発進路が引かれるまでホームで待たせる。
- 場所: `rail_vehicle_t::can_enter_tile()` の中、`CAN_START` の分岐で、同じタイルの他の車両を調べるループの**後**、
  `if (!(w->has_signal()  ||  gr_current->get_crossing()))` の**前**。

```cpp
#ifdef TID_INTERLOCKING // TID_IL H8: virtual departure signal of the interlocking panel
				{ bool il_result; if(  interlocking_hook_departure( this, restart_speed, il_result )  ) { return il_result; } }
#endif
```

### H2 ステップ処理 — `simworld.cc`

- 役割: 列車が通過した進路を自動で解除する（全クライアントで同じ順に実行される場所であること）。
- 場所: `karte_t::step()` の先頭。

```cpp
#ifdef TID_INTERLOCKING // TID_IL H2
	interlocking_hook_step();
#endif
```

### H3 セーブ／ロード — `simworld.cc`

- 役割: 連動装置の定義と状態をセーブデータに入れる。
- 保存: `karte_t::save(loadsave_t *file, ...)` の中、`// save all open windows` の
  `file->rdwr_byte( active_player_nr );` の**直前**（motd の後）。

```cpp
#ifdef TID_INTERLOCKING // TID_IL H3
	interlocking_hook_save( file );
#endif
```

- 読み込み: `karte_t::load(loadsave_t *file)` の中、`if( env_t::restore_UI )` で
  `active_player_nr` とウィンドウ情報を読むブロックの**直前**（motd の後）。保存と同じ位置になること。

```cpp
#ifdef TID_INTERLOCKING // TID_IL H3
	interlocking_hook_load( file );
#endif
```

- 読み込み完了: 同じ関数の `file->set_buffered(false);` の**直後**。

```cpp
#ifdef TID_INTERLOCKING // TID_IL H3
	interlocking_hook_load_finished();
#endif
```

- 注意: 連動装置のデータは「マーカー 1 バイト（0xA5）＋本体」の形で書く。古いセーブではその位置が
  プレイヤー番号（0〜15）なので区別できる。**OTRP 側でセーブ末尾の構成（motd → プレイヤー番号 → ウィンドウ）が
  変わっていたら、ここは要確認**。

### H4 マップ回転・破棄 — `simworld.cc`

- 回転: `karte_t::rotate90()` の中、`script_api::rotate90();` の後。引数は回転後の `cached_size.x`。

```cpp
#ifdef TID_INTERLOCKING // TID_IL H4
	interlocking_hook_rotate90( cached_size.x );
#endif
```

- 破棄: `karte_t::destroy()` の最後、`"world destroyed"` のメッセージの直前。

```cpp
#ifdef TID_INTERLOCKING // TID_IL H4
	interlocking_hook_reset();
#endif
```

### H5 メインループ — `simworld.cc`

- 役割: 外部の盤との通信（ローカルだけの処理。ゲーム状態は変えない）。
- 場所: `karte_t::interactive()` のループ内、`eventmanager->check_events();` の直後。

```cpp
#ifdef TID_INTERLOCKING // TID_IL H5
		interlocking_hook_interactive();
#endif
```

- `simworld.cc` の include 群（`#include "player/ai_scripted.h"` の後など）に
  `#include "interlocking/interlocking.h" // TID_IL`。

### H6 ツール登録 — `simmenu.h` / `simmenu.cc`

- 役割: 盤からの操作をネットワーク同期するためのツール `TOOL_INTERLOCKING`。
- `simmenu.h`: simple tool の enum の**最後**（`SIMPLE_TOOL_COUNT` の直前）に `TOOL_INTERLOCKING, // TID_IL H6`。
- `simmenu.cc`:
  - include に `#include "interlocking/il_tool.h" // TID_IL`
  - `CASE_TO_STRING(TOOL_INTERLOCKING); // TID_IL H6`（ツール名の一覧）
  - `create_simple_tool()` の `switch` に `case TOOL_INTERLOCKING: tool = new tool_interlocking_t(); break; // TID_IL H6`

### H7 ビルド設定

- `Makefile`: `SOURCES += simworld.cc` の後に `interlocking/il_bridge.cc` `il_hooks.cc` `il_manager.cc` `il_query.cc` `il_tool.cc`。
- `cmake/SimutransSourceList.cmake`: `simworld.cc` の後に同じ 5 ファイル。
- `Simutrans-Main.vcxitems`: `simworld.cc` の `ClCompile` の後に同じ 5 ファイル。

## 移植の記録

### v50.2 → v62.0.3（2026-10）

- 方法: 本家のタグ `v62_0_3` をこのブランチにマージ（このリポジトリの main は本家の履歴の途中なので、共通の祖先がある）。
  `git fetch https://github.com/teamhimeh/simutrans refs/tags/v62_0_3:refs/tags/otrp-v62_0_3` → `git merge otrp-v62_0_3`
- 衝突: H6（ツール番号・ツール名・ツール生成）と H4（`destroy()`）の 3 か所だけ。本家の追加分の**後ろ**にフックを置いて解消。
- 本体の変更で `interlocking/` 側を直したところ:
  - v51 以降、経路探索は `step` の中でしか行えない（`sync_step` から呼ぶと共有の探索用配列を壊す）。
    選択信号と同じく、`sync_step` からの呼び出しでは `cnv->request_signal_check_in_step()` を呼んで停止し、
    step での再確認（`call_by_step == true`）のときに経路を作るようにした（`il_manager.cc` の `on_signal()`）。
  - テストの時刻表の文字列（`TOOL_CHANGE_CONVOI` の `g`）は、各停車駅の項目が 12 個 → 14 個に増えた。
- 確認したが変更不要だったところ:
  - セーブの末尾: 読み込み側に本家 124 系向けのブロック（チャット・速度記録）が増えたが、OTRP は 122 形式で保存するので
    そのブロックは通らない。保存側（motd の直後）と読み込み側のフックの位置は一致している。
  - 経路の置き換え（`remove_koord_from()` → `append()`）は v62 の選択信号も同じ方法。コーナー情報は座標から計算される。

## `interlocking/` から使っている本体の関数

v60 でこれらの名前や引数が変わっていたら、`interlocking/` 側を直す（`check_hooks.sh` でも確認する）。

| 関数 | 使っている場所 |
|---|---|
| `rail_vehicle_t::block_reserver()` | `il_manager.cc` の `on_signal()` |
| `convoi_t::access_route()` / `get_route()` / `get_coupling_convoi()` / `set_next_stop_index()` | 同上（経路の置き換え） |
| `route_t::calc_route()` / `remove_koord_from()` / `append()` | 同上 |
| `schiene_t::is_reserved()` / `get_reserved_convoi()` | 進路の設定判定・自動解除 |
| `grund_t::get_neighbour()` / `weg_t::get_ribi()` | 進路の探索 |
| `haltestelle_t::get_halt()` / `get_alle_haltestellen()` / `get_tiles()` | 着点が番線かどうかの判定、盤の駅一覧（`il_query.cc`） |
| `planquadrat_t::get_boden_bei()` / `grund_t::get_halt()` / `has_depot()` | 盤の配線略図（`il_query.cc`） |
| `signal_t::set_state()` / `get_state()` | 信号の現示 |
| `tool_t::simple_tool[]` / `karte_t::set_tool()` | ブリッジからのコマンド実行 |

**選択信号の経路置き換え処理（`rail_vehicle_t::is_choose_signal_clear()`）を参考に、同等の処理を
`il_manager.cc` の `on_signal()` に書いている。** OTRP 側でこの処理が変わっていたら、こちらにも反映するか確認する。

## テスト

自動テストはヘッドレス版のゲームを起動して使う。

- `run_test.py`（Python）: 連動装置の動作（行単位プロトコル）。シナリオ il-test
- `panel_test.mjs`（Node.js + Playwright）: Web 盤を実際のブラウザで操作する。シナリオ il-test
- `pass_test.py`: 通過列車。`tandem_test.py [--relay] [--lever G|P]`: 縦列停車。`panel_tandem_test.mjs`: 盤の「手前」の着点。
  この 3 つはシナリオ il-tandem（作業ディレクトリの `pak64/scenario/il-tandem` を `interlocking/tests/il-tandem` へのリンクにする）
- `coupling_test.py [--relay] [--save | --auto]`: 留置線でピンクのてこで連結させ、連結したまま出発させる。
  `--save` はピンクの進路を引いてからセーブ・ロード、`--auto` は自動モード。シナリオ il-coupling（S1・S2 が選択信号。リンクは同様）
- `coupling_more_test.py --case mid|depart [--relay]`: mid＝途中駅で切り離し、残った列車が出発点の手前から出る（y=12 の線）。
  depart＝番線の出発点のピンクのてこで、子編成が番線から連結しに行く
- `coupling_platform_test.py [--relay]`: 番線で連結、終端駅で切り離し、それぞれ出発の進路で出す。シナリオ il-coupling

選択信号の処理のほか、**`convoi_t` の到着（経路の終わりに着くと到着扱い）**と
**`rail_vehicle_t::block_reserver()` がマス単位で予約すること**を前提にしている（縦列停車・同じ駅の別番線への停車）。
OTRP 側でここが変わったら tandem_test.py で確認する。

連結は OTRP の `rail_vehicle_t::can_couple()`（public）と `convoi_t::can_start_coupling()` を使う。
`can_enter_tile()` は、連結相手が先の閉塞にいる子編成には、その手前の信号を確かめない（選択信号で「連結誘導」オンのときを除く）。
連動盤の信号で子編成を止めるには、その信号を選択信号＋連結誘導にする必要がある（coupling_test.py の前提）。

```sh
NODE_PATH=$(npm root -g) node interlocking/tests/panel_test.mjs build/default/sim <作業ディレクトリ> <スクリーンショットの保存先>
```

`interlocking/tests/run_test.py` が、ヘッドレス版のゲームを起動して外部の盤と同じ経路（TCP ブリッジ）で操作し、
次を確認する: てこ扱い信号で列車が止まる／敵対進路の拒否／扱者が選んだ番線を通る／通過後の自動解除／
マップ回転／セーブ・ロード。

```sh
# ヘッドレス版のビルド（config.default）
#   BACKEND = posix / COLOUR_DEPTH = 0 / OSTYPE = linux / MULTI_THREAD = 1
make -j4

# 作業ディレクトリ: simutrans/ の config, text, script, themes, font と pak64 を置き、
#   pak64/scenario/il-test を interlocking/tests/il-test へのリンク（またはコピー）にする
python3 interlocking/tests/run_test.py --sim build/default/sim --workdir <作業ディレクトリ>
```

## AI に移植を頼む場合の依頼文テンプレート

```
OTRP 本体を vXX に更新し、TID 連動盤（interlocking/）を載せ直してください。
手順は interlocking/PORTING.md に従ってください。
- interlocking/ はそのまま使い、本体には hooks.patch のフック（// TID_IL）だけを入れること
- パッチが当たらない箇所は、PORTING.md の「フック一覧」の役割と場所の説明から入れる場所を判断すること
- check_hooks.sh とビルドが通ることを確認し、run_test.py の結果を報告すること
- 本体の既存コードのロジックは変更しないこと
```
