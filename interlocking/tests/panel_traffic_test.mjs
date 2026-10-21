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

if (process.argv[2]) {
	context.source = fs.readFileSync(process.argv[2], "utf8");
	const result = run('parseOudOperations(source).map(d => ({name:d.name, entries:d.entries.length}))');
	assert.ok(result.length > 0);
	console.log("Real OuDiaSecond file:", result);
}
console.log("PASS: operation names, OuDiaSecond parsing, direction, operation changes, midnight, independent thresholds, station times and ambiguity");
