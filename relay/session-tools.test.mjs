import assert from 'node:assert/strict';
import test from 'node:test';
import { contextUsage, weeklyLimit, normalizeGoalInput, publicRuntime } from './session-tools.mjs';
import { CodexControlBridge, sessionRefForThreadId } from './codex-control.mjs';
import { createRelayServer } from './server.mjs';

test('context uses latest turn usage, never lifetime tokens; missing numbers stay unavailable', () => {
  assert.equal(contextUsage({ last: { totalTokens: 24000 }, total: { totalTokens: 900000 }, modelContextWindow: 100000 }).used_percent, 24);
  for (const value of [null, { last: { totalTokens: null }, modelContextWindow: 100000 }, { last: { totalTokens: 1 }, modelContextWindow: 0 }]) assert.equal(contextUsage(value), null);
  assert.equal(contextUsage({ last: { totalTokens: 200000 }, modelContextWindow: 100000 }).used_percent, 100);
});
test('weekly quota is selected by seven day duration, not its primary or secondary position', () => {
  assert.equal(weeklyLimit({ primary: { window_minutes: 300, used_percent: 10 }, secondary: { window_minutes: 10080, used_percent: 24 } }).remaining_percent, 76);
  assert.equal(weeklyLimit({ primary: { window_minutes: 10080, used_percent: 80 } }).remaining_percent, 20);
  assert.equal(weeklyLimit({ secondary: { window_minutes: 10080, used_percent: null } }), null);
  assert.equal(weeklyLimit({ primary: { window_minutes: 300, used_percent: 10 } }), null);
});
test('Goal budget is optional and input validation rejects empty, oversized, and invalid requests', () => {
  assert.deepEqual(normalizeGoalInput({ action: 'set', objective: 'Do the work' }), { action: 'set', objective: 'Do the work' });
  for (const body of [{ action: 'set', objective: '' }, { action: 'set', objective: 'x'.repeat(4001) }, { action: 'set', objective: 'x', token_budget: 0 }, { action: 'delete' }]) assert.throws(() => normalizeGoalInput(body));
});
test('runtime fields and Goal text are sanitized without leaking original IDs, paths or keys', () => {
  const result = publicRuntime({ threadId: 'raw-id', goal_available: true, goal: { objective: 'Read C:\\private\\code.txt and sk-abcdefghijklmnopqrstuv', status: 'active', threadId: 'raw-id' }, context: null, weekly: null }, 'sha256:abcdef');
  const text = JSON.stringify(result);
  assert.ok(!text.includes('raw-id')); assert.ok(!text.includes('private')); assert.ok(!text.includes('sk-abcdefghijklmnopqrstuv'));
});
test('runtime read is read-only, survives unsupported Goal and caches account quota across events', async () => {
  const bridge = new CodexControlBridge({ enabled: true, spawnServer: false });
  bridge.state = 'ready'; bridge.indexUpdatedAt = Date.now();
  const id='fixture-thread'; const ref=sessionRefForThreadId(id);
  bridge.threadIndex.set(ref, { id, status: { type: 'notLoaded' } });
  const calls=[];
  bridge.rpc={ async request(method) { calls.push(method); if(method==='thread/goal/get') throw Error('unsupported'); if(method==='account/rateLimits/read') return {rateLimits:{primary:{usedPercent:20,windowDurationMins:10080}}}; throw Error('Unexpected '+method); } };
  bridge.handleNotification('thread/tokenUsage/updated', {threadId:id, tokenUsage:{last:{totalTokens:3000},modelContextWindow:10000}});
  const runtime=await bridge.getSessionRuntime(ref); await bridge.getSessionRuntime(ref);
  assert.equal(runtime.context.used_percent,30);
  bridge.handleNotification('thread/settings/updated',{threadId:id}); assert.equal(bridge.contextBySession.has(ref),false); assert.equal(runtime.weekly.remaining_percent,80); assert.equal(runtime.goal_available,false);
  assert.equal(calls.filter(x=>x==='account/rateLimits/read').length,1); assert.ok(!calls.includes('thread/resume'));
});
test('Goal updates target one native conversation, with no synthetic turn or implicit token budget', async () => {
  const bridge = new CodexControlBridge({ enabled: true, spawnServer: false });
  bridge.state='ready'; bridge.indexUpdatedAt=Date.now();
  const ref=sessionRefForThreadId('target'); bridge.threadIndex.set(ref,{id:'target',status:{type:'idle'},canAcceptDirectInput:true});
  const calls=[]; bridge.rpc={async request(method,params){calls.push({method,params}); return {goal:{objective:'Finish the change',status:'active',tokensUsed:0}};}};
  await bridge.updateSessionGoal(ref,normalizeGoalInput({action:'set',objective:'Finish the change'}));
  assert.deepEqual(calls,[{method:'thread/goal/set',params:{threadId:'target',status:'active',objective:'Finish the change'}}]);
});
test('Goal mobile route authenticates, isolates sessions, deduplicates updates, and keeps exact text out of store', async (t) => {
  let writes=0;
  const ref='sha256:aaaaaaaaaaaaaaaaaaaaaaaa';
  const created=createRelayServer({codexControl:{getStatus:()=>({state:'ready'}),statusForSession:()=> 'ready', updateSessionGoal:async (_ref,input)=>{writes++;return {goal:{objective:input.objective,status:'active',tokens_used:0}};}, getSessionRuntime:async()=>({goal_available:true,context:null,weekly:null,goal:null,threadId:'private'})},pushSender:async()=>({status:'not_configured'})});
  await new Promise(r=>created.server.listen(0,'127.0.0.1',r)); t.after(()=>new Promise(r=>created.server.close(r)));
  const base='http://127.0.0.1:'+created.server.address().port;
  const req=async(path,method='GET',body,secret)=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(secret?{Authorization:'Bearer '+secret}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
  const registration=await req('/v1/devices/register','POST',{device_id:'phone-fixture',platform:'test'});
  await req('/v1/pairings/claim','POST',{pairing_code:registration.body.pairing_code});
  const secret=registration.body.device_secret;
  created.store.devices.get('phone-fixture').agentSessions=[{session_ref:ref,source:'codex',state:'turn_finished',updated_at:new Date().toISOString(),prompts:[]}];
  const path='/v1/devices/phone-fixture/sessions/'+encodeURIComponent(ref);
  const body={action:'set',objective:'private-goal-marker',idempotency_key:'goal-test-12345678'};
  assert.equal((await req(path+'/goal','PATCH',body)).status,401);
  const results=await Promise.all([req(path+'/goal','PATCH',body,secret),req(path+'/goal','PATCH',body,secret)]);
  assert.deepEqual(results.map(r=>r.status),[200,200]); assert.equal(writes,1);
  assert.equal((await req(path.replace('aaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbb')+'/goal','PATCH',body,secret)).status,404);
  assert.ok(!JSON.stringify([...created.store.devices.values()]).includes('private-goal-marker'));
  assert.ok(!JSON.stringify((await req(path+'/runtime','GET',undefined,secret)).body).includes('private'));
});
