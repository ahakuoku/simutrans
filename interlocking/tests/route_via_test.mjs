import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const context = vm.createContext({console, TextEncoder});
const run = code => vm.runInContext(code, context);
run(`
const N=1,E=2,S=4,W=8,DIRS=[1,2,4,8],BACK={1:4,2:8,4:1,8:2},DXY={1:[0,-1],2:[1,0],4:[0,1],8:[-1,0]};
const key=p=>p.join(',');
let st={id:1,manual:true,levers:[],departures:[]},status={routes:[]},stationId=1,tab='run',manualRoute=null;
let tileIndex=new Map(),stationTiles=new Set(),tracks={tiles:[]};
let layout={points:[],exits:[],groups:[],sidings:[],groupOf:new Map(),sidingOf:new Map()};
const station=()=>st, isRelay=()=>false, render=()=>{}, toast=()=>{}, signalLabel=()=> '信号', shuntColor=()=> 'P', refuseOther=()=>false;
const platformName=()=> 'ホーム',sidingName=()=> '留置線',exitName=()=> '出口';
let sent=[]; const command=(c)=>sent.push(c);
const neighbour=(t,d)=>tileIndex.get(key([t.p[0]+DXY[d][0],t.p[1]+DXY[d][1],0]));
function addLine(points) {
 for(let i=0;i<points.length;i++) {
  const p=[...points[i],0], k=key(p); if(!tileIndex.has(k))tileIndex.set(k,{p,r:0,m:0});
  const t=tileIndex.get(k);
  for(const j of [i-1,i+1]) if(points[j]) {const d=DIRS.find(d=>DXY[d][0]===points[j][0]-p[0]&&DXY[d][1]===points[j][1]-p[1]); t.r|=d;t.m|=d;}
 }
}
addLine([[0,1],[1,1],[2,1],[3,1],[4,1],[5,1]]);
addLine([[1,1],[1,2],[2,2],[3,2],[3,1]]);
tileIndex.get('0,1,0').m=E;
tracks.tiles=[...tileIndex.values()];stationTiles=new Set(tileIndex.keys());
layout.groups=[[tileIndex.get('5,1,0')]];layout.groupOf.set('5,1,0',0);
`);
run(fs.readFileSync(new URL("../panel/operate.js", import.meta.url), "utf8"));
const path = expr => Array.from(run(expr), p => Array.from(p.p || p).join(","));
for (const start of [
    '{pos:[0,1,0],dep:false}',
    '{pos:[0,1,0],dep:true}',
    '{pos:[0,1,0],dep:false,shunt:true,color:"W"}',
    '{pos:[0,1,0],dep:false,shunt:true,color:"G"}',
    '{pos:[0,1,0],dep:false,shunt:true,color:"P"}',
    '{pos:[0,1,0],dep:true,shunt:true,color:"G"}'
]) {
    run(`nxStart=${start};routeVia=[[1,2,0],[3,2,0]];`);
    const selected = path("findDestinations(nxStart).get('p0').path");
    assert.ok(selected.includes("2,2,0"), start);
    assert.ok(selected.indexOf("1,2,0") < selected.indexOf("3,2,0"));
    assert.equal(run("findDestinations(nxStart,[[99,99,0]]).size"), 0);
    run("destinationClicked('p0')");
    assert.match(run("sent.at(-1)"), /1:2:0;2:2:0;3:2:0/);
    assert.equal(run("routeVia.length"), 0);
}
run("nxStart={pos:[0,1,0]};routeVia=[[2,2,0]];tileIndex.get('2,2,0').c=9;");
assert.equal(run("findDestinations(nxStart).get('p0').free"), false, "occupied waypoint cannot be bypassed on a free alternative");
run("delete tileIndex.get('2,2,0').c;");
assert.ok(path("manualPathVia([0,1,0],[5,1,0],[[2,2,0]])").includes("2,2,0"));
assert.equal(run("manualPathVia([0,1,0],[5,1,0],[[99,99,0]])"), null);
assert.equal(run("manualPathVia([0,1,0],[5,1,0],[[3,2,0],[1,2,0]])"), null, "out-of-order waypoints must not create a loop");
run("nxStart={pos:[0,1,0]};routeViaContext='';syncRouteVia();routeViaPicking=true;addRouteVia([2,2,0]);");
assert.equal(run("routeVia.length"), 1);
run("nxStart={pos:[1,1,0]};syncRouteVia();");
assert.equal(run("routeVia.length"), 0, "waypoints reset when the start changes");
assert.equal(run("routePathCommand('set_path',st,Array(600).fill([12345,12345,0]),'長い進路')"), null);
// Registered routes apply to signal + destination operation without re-entering waypoints.
run(`nxStart={pos:[0,1,0]};routeVia=[];
const registeredPath=manualPathVia([0,1,0],[5,1,0],[[2,2,0]]);
status.routes=[{id:1,station:1,name:'1L',state:'idle',temp:false,start:[0,1,0],end:[5,1,0],tiles:registeredPath}];`);
assert.ok(path("findDestinations(nxStart).get('p0').path").includes('2,2,0'));
assert.equal(run("findDestinations(nxStart).get('p0').registeredName"),'1L');
run("destinationClicked('p0')");
assert.match(run("sent.at(-1)"),/1:2:0;2:2:0;3:2:0.*1L$/);
run("nxStart={pos:[0,1,0]};tileIndex.get('2,2,0').c=9;");
assert.equal(run("findDestinations(nxStart).get('p0').free"),false,'occupied registered branch must not fall back to the free direct branch');
run("delete tileIndex.get('2,2,0').c;routeVia=[[2,1,0]];");
assert.equal(run("findDestinations(nxStart).has('p0')"),false,'temporary waypoints cannot silently replace a registered branch');
run(`routeVia=[];layout.points=[{t:tileIndex.get('1,1,0'),normal:[[W,E]],reverse:[[W,S]]}];st.levers=[{pos:[1,1,0],value:'N'}];`);
assert.equal(run("findDestinations(nxStart).has('p0')"),false,'points set against a registered branch must not cause a fallback');
run("layout.points=[];st.levers=[];status.routes[0].temp=true;");
assert.ok(!path("findDestinations(nxStart).get('p0').path").includes('2,2,0'),'temporary routes are not stored definitions');
run("status.routes=[];");
console.log("PASS: ordered route waypoints for main/departure/shunting/calling-on, occupied paths, manual routes, loops and reset");
console.log("PASS: registered route selection, stored name, occupancy and point restrictions without alternative branch fallback");
