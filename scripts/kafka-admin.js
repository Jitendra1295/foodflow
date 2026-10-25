// Authenticated local topic setup and explicit recovery from committed outbox payloads.
const { Kafka, logLevel } = require('kafkajs');
const { brokers, clientId, sasl } = require('../services/shared/kafkaConfig');
const kafka = new Kafka({brokers,clientId:`${clientId}-admin`,sasl,logLevel:logLevel.ERROR,connectionTimeout:3000,requestTimeout:5000,retry:{retries:2}});
async function main() {
  const admin=kafka.admin();
  try {
    await admin.connect();
    if(process.argv.includes('--ensure-topic')) {
      await admin.createTopics({topics:[{topic:'order-events',numPartitions:1,replicationFactor:1}],waitForLeaders:true});
      console.log('order-events topic ready');
    }
    if(process.argv.includes('--replay-outbox')) {
      const db=require('../services/order-service/src/db');
      const producer=kafka.producer();let count=0;let cursor=null;
      try {
        await producer.connect();
        while(true) {
          const rows=await db.query(`SELECT id,aggregate_id,payload FROM order_data.outbox_events
            WHERE event_type='ORDER_READY' AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 100`,[cursor]);
          if(!rows.rowCount) break;
          await producer.send({topic:'order-events',acks:-1,messages:rows.rows.map(row=>({key:row.aggregate_id,value:JSON.stringify(row.payload)}))});
          count+=rows.rowCount;cursor=rows.rows.at(-1).id;
        }
        console.log(`Replayed ${count} committed outbox events with original IDs; database outbox state unchanged.`);
      } finally {await producer.disconnect();await db.close();}
    }
    console.log(JSON.stringify(await admin.fetchTopicOffsets('order-events')));
    if(process.argv.includes('--describe-group')) {
      console.log(JSON.stringify(await admin.fetchOffsets({groupId:process.env.KAFKA_CONSUMER_GROUP_ID||'foodflow-delivery-service-v1',topics:['order-events']})));
    }
  } finally {await admin.disconnect();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
