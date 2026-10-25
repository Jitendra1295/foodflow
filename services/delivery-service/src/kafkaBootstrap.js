async function bootstrapLatest(admin, groupId, topic) {
  const current = await admin.fetchOffsets({ groupId, topics: [topic] });
  const uncommitted = current.find((entry) => entry.topic === topic)?.partitions.filter((part) => part.offset === '-1') || [];
  if (!uncommitted.length) return false;

  const end = await admin.fetchTopicOffsets(topic);
  const partitions = uncommitted.map(({ partition }) => {
    const position = end.find((entry) => entry.partition === partition);
    if (!position) throw new Error(`Kafka topic ${topic} has no offset for partition ${partition}.`);
    return { partition, offset: position.high };
  });
  await admin.setOffsets({ groupId, topic, partitions });
  const saved = await admin.fetchOffsets({ groupId, topics: [topic] });
  for (const position of partitions) {
    const committed = saved.find((entry) => entry.topic === topic)?.partitions.find((part) => part.partition === position.partition);
    if (committed?.offset !== position.offset) throw new Error(`Could not persist initial Kafka offset for ${topic}:${position.partition}.`);
  }
  return true;
}

module.exports = { bootstrapLatest };
