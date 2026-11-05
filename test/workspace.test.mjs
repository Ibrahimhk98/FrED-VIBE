import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { createSocket } from 'node:dgram';
import dnsPacket from 'dns-packet';
import { createExplorerWindow, returnToAcquisition } from '../dashboard/workspace.js';
import { availableKits } from '../dashboard/kits.js';
import { kitFromService, startDiscovery } from '../scripts/discovery.mjs';
import { createDashboardServer } from '../scripts/dashboard_server.mjs';

test('analysis reuses its window, snapshots without transferring samples, and returns without navigation', () => {
  let receive, opens = 0, reuses = 0, focuses = 0, liveFocus = 0;
  const messages = [], snapshot = {audio:[{pcm:new Int16Array([123,-456])}], imu:[]};
  const analysis = {closed:false, focus(){focuses++;}, postMessage(message){messages.push(structuredClone(message));}};
  const owner = {crypto:{randomUUID:()=> 'unique-live-tab'},location:{origin:'http://localhost:8000'},
    addEventListener(type,handler){receive=handler;}, open(url,name){assert.equal(name,'pal-explorer-unique-live-tab');if(url==='')reuses++;else{assert.equal(url,'explorer.html');opens++;}return analysis;},
    focus(){liveFocus++;}};
  const open = createExplorerWindow(owner, () => snapshot, () => ({recording:true,connected:true}), assert.fail);
  open(); open(); assert.equal(opens,1); assert.equal(reuses,1); assert.equal(focuses,1);
  receive({origin:owner.location.origin,source:analysis,data:{type:'pal-session-request'}});
  snapshot.audio.push({pcm:new Int16Array([789])}); // acquisition continues
  assert.equal(messages[0].session.audio.length,1); assert.equal(snapshot.audio.length,2);
  assert.deepEqual([...snapshot.audio[0].pcm],[123,-456]);
  messages[0].session.audio[0].pcm[0]=0; assert.equal(snapshot.audio[0].pcm[0],123);
  receive({origin:'http://untrusted.invalid',source:analysis,data:{type:'pal-session-request'}});
  receive({origin:owner.location.origin,source:{},data:{type:'pal-session-request'}});
  assert.equal(messages.length,1);
  receive({origin:owner.location.origin,source:analysis,data:{type:'pal-state-request'}});
  assert.deepEqual(messages[1],{type:'pal-state',state:{recording:true,connected:true}});
  assert.equal(returnToAcquisition({opener:owner,location:owner.location,open(url,name){assert.equal(url,'');assert.equal(name,'pal-live-unique-live-tab');return owner;}}),true); assert.equal(liveFocus,1);
  analysis.closed=true; open(); assert.equal(opens,2);
});

test('popup blocking and closed acquisition leave the original recording intact', () => {
  let blocked = 0;
  const owner = {crypto:{randomUUID:()=> 'other-tab'},location:{origin:'http://localhost:8000'},addEventListener(){},open(){return null;}};
  createExplorerWindow(owner, assert.fail, assert.fail, () => blocked++)(); assert.equal(blocked,1);
  assert.equal(returnToAcquisition({opener:{closed:true}}),false);
  assert.equal(returnToAcquisition({opener:null}),false);
});

test('two discovered kits retain separate IPs; fresh DHCP addresses override saved entries', () => {
  const service = id => ({host:`pal-${id}.local.`,type:'pal-telemetry',protocol:'tcp',port:81});
  const a = kitFromService({...service('112233445566'),addresses:['fe80::1','192.168.4.2','192.168.4.2']},100);
  const b = kitFromService({...service('112233445577'),addresses:['192.168.4.3']},100);
  assert.equal(a.id,'112233445566'); assert.deepEqual(a.addresses,['192.168.4.2']);
  const saved = [{id:a.id,name:a.name,host:'192.168.4.99'}, {id:'host:192.168.4.3',name:'manual',host:b.host}, {id:'older',name:'Older kit',host:'192.168.4.5'}];
  const all = availableKits(saved,[a,b]); assert.equal(all.length,3);
  assert.deepEqual(all.map(k=>[k.host,k.discovered]),[['192.168.4.2',true],['192.168.4.3',true],['192.168.4.5',false]]);
  assert.equal(availableKits(saved,[])[0].discovered,false);
  assert.equal(kitFromService({...service('112233445566'),port:80,addresses:['192.168.4.2']}),null);
  assert.equal(kitFromService({...service('112233445566'),addresses:['bad-address']}),null);
});

test('local discovery endpoint serves kit IPs, rejects remote origins and serves dashboard modules', async t => {
  const inventory = {kits:[{id:'112233445566',host:'192.168.4.2'}],error:''};
  const server = createDashboardServer({snapshot:()=>inventory});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections();server.close(resolve);}));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base+'/api/kits'); assert.equal(response.status,200); assert.deepEqual(await response.json(),inventory);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(base+'/api/kits',{headers:{Origin:'http://untrusted.invalid'}})).status,403);
  const remoteHostStatus = await new Promise((resolve,reject) => get(base+'/api/kits',{headers:{Host:'untrusted.invalid'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
  assert.equal(remoteHostStatus,403);
  const app = await fetch(base+'/workspace.js'); assert.equal(app.status,200); assert.match(app.headers.get('content-type'),/javascript/);
  assert.equal((await fetch(base+'/package.json')).status,404);
});

test('discovery receives two DNS service announcements and removes a departing kit over loopback UDP', async t => {
  const socket = createSocket('udp4'), sender = createSocket('udp4');
  await new Promise(resolve=>socket.bind(0,'127.0.0.1',resolve));
  const port = socket.address().port;
  const discovery = startDiscovery({socket,port,bind:false,multicast:false,ip:'127.0.0.1'});
  t.after(()=>{discovery.close();sender.close();});
  const service = '_pal-telemetry._tcp.local';
  const records = (id,ip,ttl=120) => {
    const host = `pal-${id}.local`, name = `pal-${id}.${service}`;
    return [{name:service,type:'PTR',ttl,data:name},
      {name,type:'SRV',ttl,data:{port:81,target:host,priority:0,weight:0}},
      {name:host,type:'A',ttl,data:ip}];
  };
  const send = answers => new Promise((resolve,reject)=>sender.send(dnsPacket.encode({type:'response',answers}),port,'127.0.0.1',e=>e?reject(e):resolve()));
  const until = async check => {for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Discovery did not receive the UDP announcement');};
  await send([...records('112233445566','192.168.4.2'),...records('112233445577','192.168.4.3')]);
  await until(()=>discovery.snapshot().kits.length===2);
  assert.deepEqual(discovery.snapshot().kits.map(k=>k.host),['192.168.4.2','192.168.4.3']);
  await send(records('112233445566','192.168.4.2',0));
  await until(()=>discovery.snapshot().kits.length===1);
  assert.equal(discovery.snapshot().kits[0].id,'112233445577');
});
