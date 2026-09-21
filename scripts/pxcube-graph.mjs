/** Build a Part-derived Tick dependency graph and topologically order it. */
export function topologicalTicks(ticks) {
  const byId = new Map(ticks.map((tick) => [tick.id, tick]));
  if (byId.size !== ticks.length) throw new Error('duplicate Tick id');

  const producers = new Map();
  for (const tick of ticks) for (const part of tick.produces ?? []) {
    const owners = producers.get(part) ?? [];
    owners.push(tick.id);
    producers.set(part, owners);
  }

  const incoming = new Map(ticks.map((tick) => [tick.id, new Set()]));
  const outgoing = new Map(ticks.map((tick) => [tick.id, new Set()]));
  const reasons = [];
  for (const consumer of ticks) for (const part of consumer.consumes ?? []) {
    for (const producerId of producers.get(part) ?? []) {
      if (producerId === consumer.id) continue;
      incoming.get(consumer.id).add(producerId);
      outgoing.get(producerId).add(consumer.id);
      reasons.push({ from: producerId, to: consumer.id, part });
    }
  }

  const sourceOrder = new Map(ticks.map((tick, index) => [tick.id, index]));
  const ready = ticks.filter((tick) => incoming.get(tick.id).size === 0).map((tick) => tick.id);
  const order = [];
  while (ready.length) {
    ready.sort((a, b) => sourceOrder.get(a) - sourceOrder.get(b));
    const id = ready.shift();
    order.push(id);
    for (const next of outgoing.get(id)) {
      incoming.get(next).delete(id);
      if (incoming.get(next).size === 0) ready.push(next);
    }
  }

  if (order.length !== ticks.length) {
    const blocked = ticks.map((tick) => tick.id).filter((id) => !order.includes(id));
    throw new Error(`Tick dependency cycle: ${blocked.join(', ')}`);
  }
  return { order, reasons };
}

export function invalidationClosure(ticks, seedTickIds) {
  const { order, reasons } = topologicalTicks(ticks);
  const downstream = new Map(ticks.map((tick) => [tick.id, new Set()]));
  for (const edge of reasons) downstream.get(edge.from).add(edge.to);

  const reached = new Set(seedTickIds);
  const queue = [...seedTickIds];
  while (queue.length) {
    const id = queue.shift();
    for (const next of downstream.get(id) ?? []) if (!reached.has(next)) {
      reached.add(next);
      queue.push(next);
    }
  }
  return order.filter((id) => reached.has(id));
}


/** Comparison obligations arise at invalidated produced Parts that have downstream consumers. */
export function comparisonObligations(ticks, seedTickIds) {
  const invalidated = new Set(invalidationClosure(ticks, seedTickIds));
  const consumersByPart = new Map();
  for (const tick of ticks) for (const part of tick.consumes ?? []) {
    const consumers = consumersByPart.get(part) ?? [];
    consumers.push(tick.id);
    consumersByPart.set(part, consumers);
  }
  const obligations = [];
  for (const tick of ticks) {
    if (!invalidated.has(tick.id)) continue;
    for (const part of tick.produces ?? []) {
      const consumers = consumersByPart.get(part) ?? [];
      if (consumers.length === 0) continue;
      obligations.push({
        producer: tick.id,
        part,
        consumers,
        reason: `${tick.id} may change ${part}; compare baseline vs candidate before trusting downstream consumers`
      });
    }
  }
  return obligations;
}
