import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {createRequire} from "node:module";
const {chromium} = createRequire(import.meta.url)("playwright");
const tiles = new Map(), dirs = [[0,-1,1],[1,0,2],[0,1,4],[-1,0,8]];
for (const line of [[[0,1],[1,1],[2,1],[3,1],[4,1],[5,1]],[[1,1],[1,2],[2,2],[3,2],[3,1]]]) {
 for (let i=0;i<line.length;i++) {
  const p=[...line[i],0],key=p.join(',');if(!tiles.has(key))tiles.set(key,{p,r:0,m:0});
  for(const j of [i-1,i+1]) if(line[j]) {const d=dirs.find(d=>d[0]===line[j][0]-p[0]&&d[1]===line[j][1]-p[1])[2];tiles.get(key).r|=d;tiles.get(key).m|=d;}
 }
}
tiles.get('0,1,0').m=2;tiles.get('0,1,0').s={aspect:'red',name:'場内信号',o:0};
tiles.get('4,1,0').h=1;tiles.get('5,1,0').h=1;
const station={id:1,name:'中継点テスト',owner:0,manual:true,kind:'electronic',view:[0,0,6,3,1],signals:[{pos:[0,1,0],aspect:'red'}],departures:[]};
const api={status:{stations:[station],routes:[],station_aliases:[],operations:{id:'-',bytes:0,diagram:-1}},
 info:{map:[64,64],player:0,players:[{nr:0,name:'鉄道'}]},halts:{halts:[{id:1,name:station.name,owner:0,tiles:[[4,1,0],[5,1,0]]}]},
 tracks:{tiles:[...tiles.values()],convoys:{}},events:{last:0,events:[]},panel:{rev:1,parts:[]}};
const commands=[];
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/cmd') {let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  commands.push(body);
  if(body.startsWith('sl_turn,')) {const v=body.split(',');station.slevers=v[5]==='N'?[]:[{pos:v.slice(2,5).map(Number),side:v[5],used:false}];}
  if(body.startsWith('set_path,')&&station.slevers) for(const lever of station.slevers)lever.used=true;
  api.events.events.push({seq:++api.events.last,type:'result',command:body,ok:true});res.end('{}');
 });return;}
 if(url.pathname.startsWith('/api/')) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(url.pathname==='/api/events'?{last:api.events.last,events:api.events.events.filter(e=>e.seq>Number(url.searchParams.get('since')))}:api[url.pathname.slice(5)]||{}));return;}
 const file=new URL(path.basename(url.pathname)||'index.html',new URL('../panel/',import.meta.url));
 if(!fs.existsSync(file)){res.writeHead(404).end();return;}
 res.setHeader('Content-Type',file.pathname.endsWith('.js')?'text/javascript':file.pathname.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
try {
 const page=await browser.newPage({viewport:{width:1400,height:900}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.locator('#conntext').getByText('ゲームに接続中',{exact:true}).waitFor();
 await page.locator('#map g.clickable').filter({has:page.locator('title').getByText('場内信号',{exact:false})}).click();
 await page.locator('#routeViaPick').click();
 await page.locator('[data-route-tile="2,2,0"]').click();
 assert.equal(await page.locator('#map .route-waypoint').count(),1);
 await page.locator('#routeViaPick').click();
 await page.locator('#map .dest.blink').first().click();
 await page.waitForFunction(()=>pending.size===0);
 assert.match(commands.find(c=>c.startsWith('set_path,')),/1:2:0;2:2:0;3:2:0/);
 // Relay signal levers expose the same waypoint controls and submit the chosen path.
 station.kind='relay';
 await page.reload();
 await page.locator('#map .mapknob').first().click();
 await page.locator('#routeViaPick').waitFor();
 await page.locator('#routeViaPick').click();
 await page.locator('[data-route-tile="2,2,0"]').click();
 await page.locator('#routeViaPick').click();
 await page.locator('#map .dest.blink').first().click();
 await page.waitForFunction(()=>pending.size===0);
 assert.equal(commands.filter(c=>c.startsWith('set_path,')).length,2);
 assert.match(commands.filter(c=>c.startsWith('set_path,')).at(-1),/1:2:0;2:2:0;3:2:0/);
 station.kind='electronic';delete station.slevers;
 await page.reload();
 // Register a permanent route using the same ordered checkpoint.
 await page.locator('[data-tab="setup"]').click();
 assert.match(await page.locator('#routeHint').innerText(),/中継点を指定/);
 await page.locator('#btnManualRoute').click();
 assert.equal(await page.locator('#manualRouteViaControls #routeViaBar').isVisible(),true);
 assert.equal(await page.locator('#routeViaPick').isDisabled(),true);
 assert.match(await page.locator('#routeHint').innerText(),/手順1/);
 await page.locator('#map g.clickable').filter({has:page.locator('title').getByText('場内信号',{exact:false})}).click();
 await page.locator('#routeViaPick').click();
 assert.match(await page.locator('#routeHint').innerText(),/手順2: 中継点を通過順/);
 await page.locator('[data-route-point="1,1,0"]').click();
 assert.equal(await page.locator('#map .route-waypoint').count(),1);
 await page.locator('[data-route-tile="2,2,0"]').click();
 assert.equal(await page.locator('#map .route-waypoint').count(),2);
 if(process.env.ROUTE_VIA_SCREENSHOT) await page.screenshot({path:process.env.ROUTE_VIA_SCREENSHOT});
 await page.locator('#routeViaPick').click();
 assert.match(await page.locator('#routeHint').innerText(),/手順3/);
 page.once('dialog',d=>d.accept('中継点経由'));
 await page.locator('[data-route-tile="5,1,0"]').click();
 await page.waitForFunction(()=>!manualRoute);
 await page.waitForFunction(()=>pending.size===0);
 assert.match(commands.find(c=>c.startsWith('rt_path,')),/1:2:0;2:2:0;3:2:0/);
 // Use the stored definition by signal + destination, with no temporary waypoint selection.
 const registeredTiles=commands.find(c=>c.startsWith('rt_path,')).split(',')[2].split(';').map(p=>p.split(':').map(Number));
 api.status.routes=[{id:1,station:1,name:'1L',state:'idle',temp:false,shunt:false,start:registeredTiles[0],end:registeredTiles.at(-1),tiles:registeredTiles,occupied:registeredTiles.map(()=>0)}];
 await page.locator('[data-tab="run"]').click();
 await page.locator('#map g.clickable').filter({has:page.locator('title').getByText('場内信号',{exact:false})}).click();
 await page.waitForFunction(()=>status.routes.some(r=>r.name==='1L'));
 await page.locator('#map .dest.blink').first().click();
 await page.waitForFunction(()=>pending.size===0);
 assert.match(commands.filter(c=>c.startsWith('set_path,')).at(-1),/1:2:0;2:2:0;3:2:0.*1L$/);
 // A custom panel line maps the clicked position back to its game tile.
 api.panel.parts=[{t:'T',x1:2,y1:4,x2:6,y2:4,b:[[1,2,0],[2,2,0],[3,2,0]]},
  {t:'S',x1:1,y1:1,x2:1,y2:1,b:[[0,1,0]]},{t:'D',x1:8,y1:1,x2:8,y2:1,b:[[5,1,0]]}];
 station.parts=3;station.parts_rev=1;
 await page.locator('[data-tab="run"]').click();
 await page.locator('#map [data-part="1"]').waitFor();
 await page.locator('#map [data-part="1"]').click();
 await page.locator('#routeViaPick').click();
 const line=page.locator('[data-route-part="0"]'), b=await line.boundingBox();
 await page.mouse.click(b.x+b.width/2,b.y+b.height/2);
 assert.match(await page.locator('#routeViaBar').innerText(),/2, 2, 0/);
 assert.equal(await page.locator('#map .route-waypoint').count(),1);
 await page.locator('#routeViaUndo').click();assert.equal(await page.locator('#map .route-waypoint').count(),0);
 // Manual creation also works when clicking custom point and destination symbols.
 api.panel.parts.push({t:'P',x1:2,y1:1,x2:2,y2:1,b:[[1,1,0]]});
 api.panel.rev++;station.parts=4;station.parts_rev=2;
 await page.locator('[data-tab="setup"]').click();
 await page.locator('#map [data-part="3"]').waitFor();
 await page.locator('#btnManualRoute').click();
 await page.locator('#map [data-part="1"]').click();
 await page.locator('#routeViaPick').click();
 await page.locator('#map [data-part="3"]').click();
 assert.equal(await page.locator('#map .route-waypoint').count(),1);
 const customLine=page.locator('[data-route-part="0"]'), cb=await customLine.boundingBox();
 await page.mouse.click(cb.x+cb.width/2,cb.y+cb.height/2);
 await page.locator('#routeViaPick').click();
 page.once('dialog',d=>d.accept('カスタム盤の中継点経由'));
 await page.locator('#map [data-part="2"]').click();
 await page.waitForFunction(()=>!manualRoute&&pending.size===0);
 assert.equal(commands.filter(c=>c.startsWith('rt_path,')).length,2);
 assert.match(commands.filter(c=>c.startsWith('rt_path,')).at(-1),/1:2:0;2:2:0;3:2:0/);
 assert.deepEqual(errors,[]);
 // Optional read-only check against the user's saved definitions, replayed in this mock server.
 if(process.env.ROUTE_VIA_LIVE_URL) {
  const base=process.env.ROUTE_VIA_LIVE_URL;
  const read=async url=>{const response=await fetch(base+url);assert.ok(response.ok);return response.json();};
  api.status=await read('/api/status');api.info=await read('/api/info');api.halts=await read('/api/halts');
  const definition=api.status.routes.find(r=>!r.temp&&r.name===(process.env.ROUTE_VIA_LIVE_NAME||'1L'));
  assert.ok(definition,'live registered route exists');
  const selectedStation=api.status.stations.find(s=>s.id===definition.station), area=selectedStation.view;
  api.tracks=await read(`/api/tracks?x1=${area[0]}&y1=${area[1]}&x2=${area[2]}&y2=${area[3]}`);
  await page.reload();
  await page.waitForFunction(id=>{const r=status.routes.find(r=>r.id===id);return r&&tileIndex.has(key(r.end))&&stationTiles?.has(key(r.start));},definition.id);
  const selected=await page.evaluate(id=>{
   const r=status.routes.find(r=>r.id===id);stationId=r.station;render();
   const start={pos:r.start,dep:isDepartureAnchor(station(),r.start)};
   const d=[...findDestinations(start,[])].find(([,d])=>d.registeredName===r.name);
   return d?{name:d[1].registeredName,path:d[1].path.map(t=>t.p)}:null;
  },definition.id);
  assert.ok(selected,'live registered path is offered by the destination button');
  assert.deepEqual(selected.path.slice(0,definition.tiles.length),definition.tiles);
  console.log(`PASS: read-only replay preserves the saved ${definition.name} path (${definition.tiles.length} tiles)`);
 }
 console.log('PASS: electronic and relay waypoint routes, permanent route path, custom panel picking and undo');
} finally {await browser.close();await new Promise(r=>server.close(r));}
