// node interlocking/tests/panel_traffic_test.mjs [optional real .oud2 file]
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = vm.createContext({
	localStore: () => null,
	document: { getElementById: () => ({ addEventListener() {} }) },
	window: { addEventListener() {} },
});
vm.runInContext(fs.readFileSync(new URL("../panel/traffic.js", import.meta.url), "utf8"), context);
const run = code => vm.runInContext(code, context);
assert.equal(run('operationNumber(" (123) A01 ")'), "A01");
assert.equal(run('operationNumber("（１２）B02")'), "B02");
assert.equal(run('operationNumber("(回送) A01")'), "(回送) A01");
assert.equal(run('oudTime("52240")'), 5 * 3600 + 22 * 60 + 40);
assert.equal(run('oudTime("2500")'), 25 * 3600);
assert.equal(run('oudTime("1260")'), null);

function file(trainFields, upFields = "", table = "") {
	return `FileType=OuDiaSecond.1.17\nRosen.\nEki.\nEkimei=始発\n.\nEki.\nEkimei=中間\n.\nEki.\nEkimei=終点\n.\nRessyasyubetsu.\nSyubetsumei=急行\n.\nDia.\nDiaName=平日\nKudari.\nRessya.\nRessyabangou=101\nSyubetsu=0\n${trainFields}\n.\n.\nNobori.\n${upFields}\n.\n${table}\n.\n.\n`;
}
context.source = file("EkiJikoku=1;2350,1;2355/2356,1;0010/\nOperationNumber0=A01\nOperationNumber1=B02",
	"Ressya.\nRessyabangou=102\nEkiJikoku=1;0100,1;0110,1;0120/\nOperationNumber0=A01\n.");
run("var diagrams = parseOudOperations(source); var d = diagrams[0];");
assert.equal(run('d.entries[0].end'), 23 * 3600 + 55 * 60);
assert.equal(run('d.entries[1].end'), 86400 + 10 * 60);
assert.equal(run('d.entries[2].destination'), "始発");
assert.equal(run('matchOperation("(8) A01", 23*3600+49*60, d, 60, 0).length'), 1);
assert.equal(run('matchOperation("A01", 23*3600+49*60-1, d, 60, 0).length'), 0);
assert.equal(run('matchOperation("B02", 11*60, d, 0, 60).length'), 1);
assert.equal(run('matchOperation("B02", 11*60+1, d, 0, 60).length'), 0);
assert.equal(run('matchOperation("B02", 5*60, d, 0, 0)[0].number'), "101");
assert.equal(run('matchOperation("B02", 23*3600+57*60, d, 0, 0, "中間").length'), 0);
run('d.entries.push({...d.entries[0], id:"another", number:"999"});');
assert.equal(run('matchOperation("A01", 23*3600+52*60, d, 0, 0).length'), 2);
assert.equal(run('matchOperation("unknown", 0, d, 100, 100).length'), 0);
context.source = file("EkiJikoku=1;1000,1;1010,1;1020/", "",
	"OperationTable.\nOTOperationNumber=C03\nOTRessya.\nOTHoukou=Ressyahoukou_Kudari\nOTRessyaIndex=0\nSihatsuEkiOrder=0\nSyuuchakuEkiOrder=2\n.\n.");
assert.equal(run('parseOudOperations(source)[0].entries[0].operation'), "C03");
assert.throws(() => run('parseOudOperations("not a diagram")'));
assert.throws(() => run('parseOudOperations("FileType=OuDiaSecond.1.17\\nRosen.")'));

// Older files save only station operations; there is no OperationNumberN or
// OperationTable. Expected assignments follow the 2.06.23 connector rules.
const upward = (fields, number = "102") => `Ressya.\nRessyabangou=${number}\n${fields}\n.`;
context.source = file("EkiJikoku=1;1000$0,1;1010$0,1;1020/$0\nOperation0B=3/950$/A01;A02\nOperation2A=0/2$1021/1022$0,5/$0",
	upward("EkiJikoku=1;1030$2,1;1040$0,1;1050/$0\nOperation0B=5/$\nOperation2A=3/1055$"));
run("var old = parseOudOperations(source)[0];");
assert.deepEqual(Array.from(run('old.entries.filter(e => e.number === "102").map(e => e.operation)')), ["A01", "A02"]);
assert.equal(run('matchOperation("A02", 10*3600+35*60, old, 0, 0)[0].number'), "102");
context.source = context.source.replace("Rosen.\n", "Rosen.\nOperationNumberReverse=1\n");
assert.deepEqual(Array.from(run('parseOudOperations(source)[0].entries.filter(e => e.number === "102").map(e => e.operation)')), ["A02", "A01"]);
// A different platform must not inherit the previous train's operation.
context.source = context.source.replace("1030$2", "1030$1");
assert.equal(run('parseOudOperations(source)[0].entries.filter(e => e.number === "102").length'), 0);

// Explicit changes apply from this station onward, including after operations.
context.source = file("EkiJikoku=1;1000,1;1010/1011,1;1020/\nOperation0B=4/0$930/955$/A01;A02\nOperation1A=6/B01;B02,6/");
run("old = parseOudOperations(source)[0];");
assert.deepEqual(Array.from(run('old.entries.map(e => [e.operation,e.from,e.to])'), a => Array.from(a)), [["A01", 0, 1], ["A02", 0, 1], ["B02", 1, 2], ["B01", 1, 2]]);

// Nested coupling and splitting preserve formation order and branch operations.
context.source = file("EkiJikoku=1;1000$0,1;1010/1011$0,1;1020/$0\nOperation0B=3/950$/A01;A02\nOperation1A=2/0$1/1012\nOperation1A.0A=0/2$1012/1013$0,5/$0",
	upward("EkiJikoku=,1;1110$2,1;1120/$0\nOperation1B=5/$\nOperation2A=3/1125$"));
run("old = parseOudOperations(source)[0];");
assert.deepEqual(Array.from(run('old.entries.filter(e => e.number === "102").map(e => e.operation)')), ["A02"]);
assert.equal(run('old.entries.some(e => e.number === "101" && e.operation === "A02" && e.from === 1)'), false);
context.source = file("EkiJikoku=1;1000,1;1010/1011,1;1020/\nOperation0B=3/950$/A01\nOperation1B=1/1$1010\nOperation1B.0B=3/1000$/B02");
run("old = parseOudOperations(source)[0];");
assert.deepEqual(Array.from(run('old.entries.filter(e => e.from === 1).map(e => e.operation)')), ["B02", "A01"]);

// Unique in/out link codes connect formations across stations and depot moves.
context.source = file("EkiJikoku=1;1000,1;1010,1;1020/\nOperation0B=3/950$/A01\nOperation2A=3/1025$DEPOT",
	upward("EkiJikoku=,1;1030,1;1040/\nOperation1B=3/1028$DEPOT/B99\nOperation2A=3/1045$"));
assert.equal(run('parseOudOperations(source)[0].entries.find(e => e.number === "102").operation'), "A01");
// Modern saved assignments retain priority over derived ones.
context.source = file("EkiJikoku=1;1000,1;1010,1;1020/\nOperationNumber0=SAVED\nOperation0B=3/950$/LEGACY");
assert.deepEqual(Array.from(run('parseOudOperations(source)[0].entries.map(e => e.operation)')), ["SAVED"]);

// Origin crossing is opt-in; conflicting starts must not receive guessed IDs.
context.source = file("EkiJikoku=1;2350,1;2355,1;0010/\nOperation0B=3/2340$/N01\nOperation2A=5/$0",
	upward("EkiJikoku=1;0020,1;0030,1;0040/\nOperation0B=5/$\nOperation2A=3/0045$"));
assert.equal(run('parseOudOperations(source)[0].entries.find(e => e.number === "102").operation'), "N01");
context.source = file("EkiJikoku=1;0200,1;0210,1;0220/\nOperation0B=3/0150$/N01\nOperation2A=5/$0",
	upward("EkiJikoku=1;0500,1;0510,1;0520/\nOperation0B=5/$\nOperation2A=3/0525$"));
assert.equal(run('parseOudOperations(source)[0].entries.some(e => e.number === "102")'), false);
context.source = context.source.replace("Rosen.\n", "Rosen.\nOperationCrossKitenJikoku=1\n");
assert.equal(run('parseOudOperations(source)[0].entries.find(e => e.number === "102").operation'), "N01");

context.source = file("EkiJikoku=1;1000,1;1010,1;1020/\nOperation0B=3/950$/A01\nOperation2A=5/$0",
	upward("EkiJikoku=1;1030,1;1040,1;1050/\nOperation0B=5/$") + "\n" + upward("EkiJikoku=1;1030,1;1045,1;1100/\nOperation0B=5/$", "103"));
assert.equal(run('parseOudOperations(source)[0].entries.some(e => e.number !== "101")'), false);

context.source = file("EkiJikoku=1;1000,1;1010,1;1020/\nOperation0B=3/950$/LOOP\nOperation2A=5/$0");
context.source = context.source.replace("Ekimei=終点\n", "Ekimei=終点\nLoopOriginEkiIndex=0\n");
context.source = context.source.replace(".\n.\nNobori.\n", ".\n" + upward("EkiJikoku=1;1030,1;1040,1;1050/\nOperation0B=5/$\nOperation2A=3/1055$") + "\n.\nNobori.\n");
assert.equal(run('parseOudOperations(source)[0].entries.find(e => e.number === "102").operation'), "LOOP");

context.delayEntry = { from: 0, to: 2, stops: [{ name: "A", arrival: 36000, departure: 36060 }, { name: "B", arrival: 36600, departure: 36660 }, { name: "C", arrival: 37200, departure: null }] };
assert.equal(run('trainDelay({loading:true,halt:"A",arrival_elapsed:0},36120,delayEntry).text'), "遅延 2分00秒（A 到着基準）");
assert.equal(run('trainDelay({loading:true,halt:"A",arrival_elapsed:240},36240,delayEntry).text'), "遅延 3分00秒（A 発車待ち）");
assert.equal(run('trainDelay({loading:true,halt:"A",arrival_elapsed:0},36000,delayEntry).seconds'), 0);
assert.equal(run('trainDelay({loading:false,next_halt:"C",eta_seconds:900},36600,delayEntry).text'), "推定遅延 5分00秒（C 到着見込）");
assert.equal(run('trainDelay({loading:false,next_halt:"C",eta_seconds:300},36600,delayEntry).text'), "早着見込 5分00秒（C 到着見込）");
assert.equal(run('trainDelay({loading:false,next_halt:"missing",eta_seconds:900},36600,delayEntry).seconds'), null);
for (const seconds of [null, -60, 0, 1, 59, 60, 61]) {
	context.delaySeconds = seconds;
	assert.equal(run('isDelayLate({seconds:delaySeconds})'), seconds >= 60, `red threshold: ${seconds}`);
}
assert.equal(run('trainDelay({},36600,delayEntry).text'), "遅延不明");
assert.equal(run('trainDelay({},36600,null).text'), "遅延不明");
assert.equal(run('trainDelay({loading:true,halt:"A",arrival_elapsed:0},35900,{from:0,to:0,stops:[{name:"A",arrival:null,departure:36000}]}).text'), "定刻（A 発車待ち）");
assert.equal(run('trainDelay({loading:true,halt:"A",arrival_elapsed:60},660,{from:0,to:0,stops:[{name:"A",arrival:87000,departure:87120}]}).seconds'), 0);

assert.equal(run('oudStationName("ゲームA", [["ゲームA","A"]])'), "A");
assert.equal(run('oudStationName("未設定", [["ゲームA","A"]])'), "未設定");
assert.equal(run('oudStationName("ゲームA", [["ゲームA","A"],["A","B"]])'), "A", "aliases are a direct game-to-diagram mapping");
run('operationConfig.stationAliases = [["ゲームA","A"],["ゲームC","C"]];');
assert.equal(run('trainDelay({loading:true,halt:"ゲームA",arrival_elapsed:0},36120,delayEntry).text'), "遅延 2分00秒（ゲームA 到着基準）");
assert.equal(run('trainDelay({loading:false,next_halt:"ゲームC",eta_seconds:900},36600,delayEntry).text'), "推定遅延 5分00秒（ゲームC 到着見込）");
context.aliasDiagram = { entries: [{ ...context.delayEntry, id: "alias", operation: "A01", start: 36000, end: 37200 }] };
assert.equal(run('matchOperation("A01",37000,aliasDiagram,0,0,"ゲームA").length'), 0, "alias applies to the station identification window");
assert.equal(run('matchOperation("A01",36000,aliasDiagram,0,0,"ゲームA").length'), 1);
assert.equal(run('displayStationName("ゲームA")'), "ゲームA");
run('stationNameMode = "alias";');
assert.equal(run('displayStationName("ゲームA")'), "A");
assert.equal(run('displayStationName("未設定")'), "未設定");
assert.equal(run('trainDelay({loading:false,next_halt:"ゲームC",eta_seconds:900},36600,delayEntry).text'), "推定遅延 5分00秒（C 到着見込）");
assert.equal(run('matchOperation("A01",36000,aliasDiagram,0,0,"ゲームA").length'), 1);
run('stationNameMode = "game";');
run('operationConfig.stationAliases = [];');

context.source = file("EkiJikoku=1;1000,1;1010,1;1020/\nOperationNumber0=A01",
	upward("EkiJikoku=1;1025,1;1035,1;1045/\nOperationNumber0=A01"));
run("var turning = parseOudOperations(source)[0];");
assert.equal(run('matchOperation("A01",37500,turning,120,1800,"終点").length'), 2, "reproduce overlapping arrival/departure service windows");
assert.equal(run('matchOperation("A01",37500,turning,120,1800,"終点",{loading:true,halt:"終点",service_from:"終点",service_to:"中間"})[0].number'), "102");
assert.equal(run('matchOperation("A01",37620,turning,120,1800,"",{loading:false,service_from:"終点",service_to:"中間"}).length'), 1);
assert.equal(run('matchOperation("A01",37620,turning,120,1800,"",{loading:false,service_from:"終点",service_to:"中間"})[0].number'), "102");
assert.equal(run('matchOperation("A01",37200,turning,120,1800,"",{loading:false,service_from:"中間",service_to:"終点"})[0].number'), "101", "incoming service is retained before turning");
assert.equal(run('matchOperation("A01",37500,turning,120,1800,"",{service_from:"unknown",service_to:"unknown"}).length'), 2, "missing station information must not guess a direction");
run('operationConfig.stationAliases = [["ゲーム終点","終点"],["ゲーム中間","中間"]];');
assert.equal(run('matchOperation("A01",37500,turning,120,1800,"ゲーム終点",{loading:true,halt:"ゲーム終点",service_from:"ゲーム終点",service_to:"ゲーム中間"})[0].number'), "102");
run('operationConfig.stationAliases = [];');
context.source = file("EkiJikoku=1;2340,1;2350,1;0000/\nOperationNumber0=A01",
	upward("EkiJikoku=1;0005,1;0015,1;0025/\nOperationNumber0=A01"));
run("turning = parseOudOperations(source)[0];");
assert.equal(run('matchOperation("A01",360,turning,120,1800,"",{loading:false,service_from:"終点",service_to:"中間"})[0].number'), "102", "midnight turnaround uses the new service");

if (process.argv[2]) {
	context.source = fs.readFileSync(process.argv[2], "utf8");
	const result = run('parseOudOperations(source).map(d => ({name:d.name, entries:d.entries.length}))');
	assert.ok(result.length > 0);
	if (/^Operation\d+B=(?:3|4)\//m.test(context.source)) assert.ok(result.some(d => d.entries > 0), "legacy sample must reconstruct actual assignments");
	console.log("Real OuDiaSecond file:", result);
}
console.log("PASS: modern and legacy operations, turnarounds, platforms, shunts, coupling/splitting, renumbering, link codes, midnight, conflicts and thresholds");
