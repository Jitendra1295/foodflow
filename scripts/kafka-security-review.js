// Bounded hardening regressions. All attack records use direct processing and isolated fixtures.
const assert = require('node:assert/strict');
const path = require('node:path');
require('dotenv').config({path:path.resolve(__dirname,'../services/auth-service/.env'),quiet:true});
const { randomUUID } = require('node:crypto');
const { Kafka, logLevel } = require('kafkajs');
const { Pool } = require('../services/delivery-service/node_modules/pg');
const { processRecord, processBatch, parseEvent } = require('../services/delivery-service/src/orderReadyConsumer');
const db = require('../services/delivery-service/src/db');
const { bootstrapLatest } = require('../services/delivery-service/src/kafkaBootstrap');
const { brokers, clientId, sasl } = require('../services/shared/kafkaConfig');
if (!brokers.every(b => /^(127\.0\.0\.1|localhost):\d+$/.test(b))) throw new Error('Security probes require localhost brokers.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis:5000, query_timeout:5000 });
const ids=[];
const topic=`foodflow-security-${randomUUID()}`;
const options={brokers,clientId:`${clientId}-security-regression`,logLevel:logLevel.NOTHING,connectionTimeout:2000,requestTimeout:3000,retry:{retries:0}};
const kafka=new Kafka({...options,sasl});
const admin=kafka.admin(); const producer=kafka.producer();
let checks=0;
async function check(name,fn) { await fn(); checks++; console.log(`PASS: ${name}`); }
async function api(route,body,headers={}) {
  const port=route.startsWith('/api/auth/')?3004:3001;
  const res=await fetch(`http://localhost:${port}${route}`,{method:route.endsWith('/status')?'PATCH':'POST',
    headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  const data=await res.json(); assert.ok(res.ok,JSON.stringify(data)); return data;
}
async function record(id,offset) {
  const event=(await pool.query('SELECT payload FROM order_data.outbox_events WHERE aggregate_id=$1',[id])).rows[0].payload;
  return {topic,partition:0,offset:String(offset),message:{key:Buffer.from(id),value:Buffer.from(JSON.stringify(event))}};
}
function edit(rec,change,offset) {
  const event=JSON.parse(rec.message.value); change(event);
  return {...rec,offset:String(offset),message:{...rec.message,value:Buffer.from(JSON.stringify(event))}};
}
async function main() {
  await admin.connect(); await producer.connect();
  await admin.createTopics({topics:[{topic,numPartitions:1,replicationFactor:1}],waitForLeaders:true});
  await check('Authenticated broker client can publish',async()=>{
    await producer.send({topic,messages:[{value:'isolated harmless probe'}]});
    assert.equal((await admin.fetchTopicOffsets(topic))[0].high,'1');
  });
  for(const [label,auth] of [['Unauthenticated broker client rejected',undefined],['Wrong broker password rejected',{mechanism:'plain',username:sasl.username,password:randomUUID()}]]) {
    await check(label,async()=>{
      const denied=new Kafka({...options,...(auth?{sasl:auth}:{})}).admin();
      try { await assert.rejects(async()=>{await denied.connect(); await denied.listTopics();}); }
      finally {await denied.disconnect().catch(()=>{});}
    });
  }
  const login=await api('/api/auth/login',{email:'customer@foodflow.local',password:process.env.DEMO_PASSWORD});
  for(let i=0;i<2;i++) {
    const order=await api('/api/orders',{restaurantId:'restaurant-pasta-house',items:[{menuItemId:'item-margherita',quantity:1}]},{Authorization:`Bearer ${login.accessToken}`});
    ids.push(order.id);
    for(const status of ['accepted','preparing','ready_for_pickup']) await api(`/internal/orders/${order.id}/status`,{status},{'X-Internal-Token':process.env.INTERNAL_API_TOKEN,'X-Operation-Id':`hardening:${order.id}:${status}`});
  }
  const first=await record(ids[0],0); const second=await record(ids[1],1);
  await check('Array ID rejected and quarantined without UUID conversion error',async()=>{
    const bad=edit(first,e=>{e.eventId=[randomUUID()];},2);
    assert.equal(parseEvent(bad.message).kind,'quarantine');
    assert.equal((await processRecord(bad)).reason,'INVALID_ORDER_READY');
  });
  await check('NUL poison quarantines and following valid event completes',async()=>{
    const bad={...first,offset:'10',message:{...first.message,offset:'10',value:Buffer.from([123,0,125])}};
    const commits=[];
    await processBatch({batch:{topic,partition:0,messages:[bad.message,{...first.message,offset:'11'}]},
      isRunning:()=>true,isStale:()=>false,heartbeat:async()=>{},resolveOffset:()=>{},
      consumer:{commitOffsets:async offsets=>commits.push(offsets[0].offset)}});
    assert.deepEqual(commits,['11','12']);
    const stored=(await pool.query('SELECT raw_value FROM delivery_data.kafka_quarantine WHERE topic=$1 AND kafka_offset=10',[topic])).rows[0].raw_value;
    assert.ok(stored.includes('\\u0000')); assert.equal(stored.includes('\u0000'),false);
  });
  await check('Authentic replay creates no duplicate delivery',async()=>{
    assert.equal((await processRecord(first)).state,'duplicate');
    assert.equal((await pool.query('SELECT count(*)::int n FROM delivery_data.deliveries WHERE order_id=$1',[ids[0]])).rows[0].n,1);
  });
  await check('Invented IDs cannot amplify processed-event storage',async()=>{
    for(let i=0;i<4;i++) assert.equal((await processRecord(edit(first,e=>{e.eventId=randomUUID();},20+i))).reason,'UNVERIFIED_EVENT');
    assert.equal((await pool.query('SELECT count(*)::int n FROM delivery_data.processed_events WHERE order_id=$1',[ids[0]])).rows[0].n,1);
  });
  await check('Tampered payload rejected against authoritative outbox',async()=>{
    assert.equal((await processRecord(edit(first,e=>{e.data.restaurantId='forged-restaurant';},25))).reason,'EVENT_PAYLOAD_MISMATCH');
  });
  await check('Permanent event ID conflict quarantines, recovery processes authentic event',async()=>{
    const eventId=JSON.parse(second.message.value).eventId;
    await pool.query(`INSERT INTO delivery_data.processed_events(event_id,order_id,event_type,topic,partition,kafka_offset) VALUES($1,$2,'ORDER_READY',$3,0,26)`,[eventId,ids[0],topic]);
    assert.equal((await processRecord({...second,offset:'26'})).reason,'EVENT_ID_CONFLICT');
    await pool.query('DELETE FROM delivery_data.processed_events WHERE event_id=$1',[eventId]);
    assert.equal((await processRecord(second)).state,'processed');
  });
  await check('Oversized and NUL-containing fields quarantine safely',async()=>{
    assert.equal((await processRecord({...first,offset:'27',message:{...first.message,value:Buffer.alloc(17000,120)}})).reason,'EVENT_TOO_LARGE');
    assert.equal((await processRecord(edit(first,e=>{e.data.restaurantId='bad\u0000restaurant';},28))).reason,'INVALID_ORDER_READY');
  });
  await check('Concurrent bootstrap serializes through actual PostgreSQL advisory locks',async()=>{
    let offset='-1';let changes=0;
    const mock={fetchOffsets:async()=>[{topic,partitions:[{partition:0,offset}]}],
      fetchTopicOffsets:async()=>{await new Promise(r=>setTimeout(r,50));return[{partition:0,high:'10'}];},
      setOffsets:async({partitions})=>{offset=partitions[0].offset;changes++;}};
    const results=await Promise.all([bootstrapLatest(mock,topic,topic),bootstrapLatest(mock,topic,topic)]);
    assert.deepEqual(results.sort(),[false,true]);assert.equal(changes,1);
    offset='11';assert.equal(await bootstrapLatest(mock,topic,topic),false);assert.equal(offset,'11');
  });
  await check('Provenance endpoint rejects missing internal token',async()=>{
    const id=JSON.parse(first.message.value).eventId;
    assert.equal((await fetch(`http://localhost:3001/internal/orders/${ids[0]}/ready-events/${id}`)).status,403);
  });
  console.log(`${checks} security regressions passed.`);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  await producer.disconnect().catch(()=>{});await admin.deleteTopics({topics:[topic]}).catch(()=>{});await admin.disconnect().catch(()=>{});
  try {
    await pool.query('DELETE FROM delivery_data.kafka_quarantine WHERE topic=$1',[topic]);
    if(ids.length) {
      await pool.query('DELETE FROM delivery_data.processed_events WHERE order_id=ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM delivery_data.deliveries WHERE order_id=ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM order_data.status_operations WHERE order_id=ANY($1::uuid[])',[ids]);
      await pool.query('DELETE FROM order_data.orders WHERE id=ANY($1::uuid[])',[ids]);
    }
  } finally {await pool.end();await db.close();}
});
