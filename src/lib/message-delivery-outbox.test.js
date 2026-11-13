import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMessageDeliveryOutbox,
  DEFAULT_MESSAGE_DELIVERY_TTL_MS
} from './message-delivery-outbox.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-outbox-'));
  return { dir, journalPath: path.join(dir, 'delivery.jsonl') };
}

function record(msgId, receivedAt = '2026-08-18T10:00:00.000Z') {
  return {
    msgId,
    receivedAt,
    content: `message:${msgId}`,
    endpoint: `chat|type:group|msg:${msgId}`,
    historyChatId: 'group-1',
    historyEntry: { msgId, text: msgId, timestamp: receivedAt }
  };
}

test('suppresses only messages that have reached delivered state', () => {
  const { journalPath } = fixture();
  const duplicates = [];
  const outbox = createMessageDeliveryOutbox({
    journalPath,
    now: () => Date.parse('2026-08-18T10:00:01.000Z'),
    onDuplicate: (msgId) => duplicates.push(msgId)
  });

  assert.equal(outbox.enqueue(record('stable-1')).status, 'pending');
  assert.equal(outbox.enqueue(record('stable-1')).status, 'pending');
  outbox.markDelivered('stable-1');
  assert.equal(outbox.enqueue(record('stable-1')).status, 'duplicate');
  assert.deepEqual(duplicates, ['stable-1']);
});

test('restarts with pending records in receive order', () => {
  const { journalPath } = fixture();
  const beforeRestart = createMessageDeliveryOutbox({ journalPath });
  beforeRestart.enqueue(record('before-1', '2026-08-18T10:00:00.000Z'));
  beforeRestart.enqueue(record('before-2', '2026-08-18T10:00:01.000Z'));

  const afterRestart = createMessageDeliveryOutbox({ journalPath });
  assert.deepEqual(
    afterRestart.pendingRecords().map((entry) => entry.msgId),
    ['before-1', 'before-2']
  );
  assert.equal(afterRestart.lookup('before-1').state, 'pending');
});

const accepted = async () => ({ outcome: 'sent', notice: null });

const journalStates = (journalPath) => fs.readFileSync(journalPath, 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('marks forwarding before forwarding, so a restart can tell queued from started', async () => {
  const { journalPath } = fixture();
  const outbox = createMessageDeliveryOutbox({ journalPath });
  outbox.enqueue(record('queued'));
  outbox.enqueue(record('started'));
  outbox.markForwarding('started');

  const restarted = createMessageDeliveryOutbox({ journalPath });
  assert.deepEqual(restarted.pendingRecords().map((entry) => entry.msgId), ['queued', 'started']);
  assert.equal(restarted.lookup('queued').forwarding, undefined);
  assert.equal(restarted.lookup('started').forwarding, true);

  let markedBeforeForward;
  await outbox.deliver(outbox.lookup('queued').record, {
    forward: async () => {
      markedBeforeForward = createMessageDeliveryOutbox({ journalPath }).lookup('queued').forwarding;
      return { outcome: 'sent', notice: null };
    },
    recordHistory: () => true
  });
  assert.equal(markedBeforeForward, true, 'marker is durable before c4-receive starts');
});

test('a forwarding marker that cannot be written stops the forward', async () => {
  const { journalPath } = fixture();
  const outbox = createMessageDeliveryOutbox({
    journalPath,
    appendEvent(event) {
      if (event.forwarding) throw new Error('simulated marker failure');
      fs.appendFileSync(journalPath, `${JSON.stringify(event)}\n`);
    }
  });
  const pending = outbox.enqueue(record('no-marker')).record;
  let forwards = 0;
  await assert.rejects(
    outbox.deliver(pending, { forward: async () => { forwards += 1; return { outcome: 'sent' }; }, recordHistory: () => true }),
    (error) => error.forwarded === false
  );
  assert.equal(forwards, 0);
});

test('finishes an interrupted record without forwarding it again', () => {
  const { journalPath } = fixture();
  const writer = createMessageDeliveryOutbox({ journalPath });
  writer.enqueue(record('crash-in-c4'));
  writer.markForwarding('crash-in-c4');

  const restarted = createMessageDeliveryOutbox({ journalPath });
  restarted.markFailed('crash-in-c4', 'interrupted');
  assert.deepEqual(restarted.pendingRecords(), []);
  assert.equal(restarted.enqueue(record('crash-in-c4')).status, 'duplicate');

  const again = createMessageDeliveryOutbox({ journalPath });
  assert.deepEqual(again.pendingRecords(), [], 'finished state survives restart');
  assert.equal(again.lookup('crash-in-c4').outcome, 'failed');
  assert.equal(again.lookup('crash-in-c4').reason, 'interrupted');
});

test('journal stays readable by the previous version: only pending/delivered, pending carries its record', () => {
  const { journalPath } = fixture();
  const outbox = createMessageDeliveryOutbox({ journalPath });
  outbox.enqueue(record('a'));
  outbox.markForwarding('a');
  outbox.markFailed('a', 'uncertain');
  outbox.enqueue(record('b'));
  outbox.markForwarding('b');
  outbox.markDelivered('b');

  for (const event of journalStates(journalPath)) {
    assert.ok(['pending', 'delivered'].includes(event.state), JSON.stringify(event));
    if (event.state === 'pending') assert.equal(event.record?.msgId, event.msgId);
  }
  // A version that only knows pending/delivered sees both as delivered: never resent.
  const last = Object.fromEntries(journalStates(journalPath).map((e) => [e.msgId, e.state]));
  assert.deepEqual(last, { a: 'delivered', b: 'delivered' });
});

test('a lost delivered marker after C4 acceptance never leads to a second forward', async () => {
  const { journalPath } = fixture();
  createMessageDeliveryOutbox({ journalPath }).enqueue(record('ack-gap'));

  const warnings = [];
  const ambiguous = createMessageDeliveryOutbox({
    journalPath,
    appendEvent(event) {
      if (event.state === 'delivered') throw new Error('simulated delivered marker failure');
      fs.appendFileSync(journalPath, `${JSON.stringify(event)}\n`);
    },
    onAmbiguousDelivery: (msgId, error) => warnings.push(`${msgId}:${error.message}`)
  });
  await assert.rejects(
    ambiguous.deliver(ambiguous.pendingRecords()[0], { forward: async () => ({ outcome: 'sent', notice: null }), recordHistory: () => true }),
    /simulated delivered marker failure/
  );
  assert.equal(warnings.length, 1);

  // After a restart the record is pending with the forwarding marker: it is
  // finished as interrupted, not forwarded again.
  const restarted = createMessageDeliveryOutbox({ journalPath });
  assert.equal(restarted.lookup('ack-gap').forwarding, true);
});

test('records history and delivered state when Core has the message', async () => {
  for (const outcome of ['sent', 'committed']) {
    const { journalPath } = fixture();
    const outbox = createMessageDeliveryOutbox({ journalPath });
    const pending = outbox.enqueue(record(`ok-${outcome}`)).record;
    const history = [];
    const result = await outbox.deliver(pending, {
      forward: async () => ({ outcome, notice: null }),
      recordHistory: (entry) => { history.push(entry.msgId); return true; }
    });
    assert.equal(result.delivered, true, outcome);
    assert.deepEqual(history, [`ok-${outcome}`]);
    assert.equal(outbox.lookup(`ok-${outcome}`).state, 'delivered');
  }
});

test('a history write failure after C4 acceptance is reported, not retried', async () => {
  const { journalPath } = fixture();
  const outbox = createMessageDeliveryOutbox({ journalPath });
  const pending = outbox.enqueue(record('history-gap')).record;
  const reported = [];
  const result = await outbox.deliver(pending, {
    forward: accepted,
    recordHistory: () => false,
    onHistoryFailure: (msgId) => reported.push(msgId)
  });
  assert.equal(result.delivered, true);
  assert.deepEqual(reported, ['history-gap']);
  assert.equal(outbox.lookup('history-gap').state, 'delivered');
});

test('finishes rejected or uncertain messages as failed, without history, never resent', async () => {
  const cases = [
    ['not_stored', async () => ({ outcome: 'not_stored', notice: 'try later' })],
    ['uncertain', async () => ({ outcome: 'uncertain', notice: 'may not have arrived' })],
    ['uncertain', async () => { throw new Error('C4 unavailable'); }]
  ];
  for (const [index, [expected, forward]] of cases.entries()) {
    const { journalPath } = fixture();
    const outbox = createMessageDeliveryOutbox({ journalPath });
    const msgId = `c4-failure-${index}`;
    const pending = outbox.enqueue(record(msgId)).record;
    let historyWrites = 0;
    const result = await outbox.deliver(pending, {
      forward,
      recordHistory: () => { historyWrites += 1; return true; }
    });
    assert.equal(result.delivered, false);
    assert.equal(result.outcome, expected);
    assert.equal(historyWrites, 0);
    assert.equal(outbox.lookup(msgId).outcome, 'failed');
    assert.equal(outbox.lookup(msgId).reason, expected);
    assert.equal(outbox.enqueue(record(msgId)).status, 'duplicate');
  }
});

test('expires failed suppression after the same TTL as delivered', () => {
  const { journalPath } = fixture();
  const failedAt = Date.parse('2026-08-18T10:00:00.000Z');
  const writer = createMessageDeliveryOutbox({ journalPath, now: () => failedAt });
  writer.enqueue(record('ttl-failed'));
  writer.markFailed('ttl-failed', 'uncertain');

  const within = createMessageDeliveryOutbox({ journalPath, now: () => failedAt + DEFAULT_MESSAGE_DELIVERY_TTL_MS });
  assert.equal(within.enqueue(record('ttl-failed')).status, 'duplicate');
  const outside = createMessageDeliveryOutbox({ journalPath, now: () => failedAt + DEFAULT_MESSAGE_DELIVERY_TTL_MS + 1 });
  assert.equal(outside.enqueue(record('ttl-failed')).status, 'pending');
});

test('expires delivered suppression only after the retry-safe TTL', () => {
  const { journalPath } = fixture();
  const deliveredAt = Date.parse('2026-08-18T10:00:00.000Z');
  const writer = createMessageDeliveryOutbox({ journalPath, now: () => deliveredAt });
  writer.enqueue(record('ttl-msg'));
  writer.markDelivered('ttl-msg');

  const within = createMessageDeliveryOutbox({
    journalPath,
    now: () => deliveredAt + DEFAULT_MESSAGE_DELIVERY_TTL_MS
  });
  assert.equal(within.enqueue(record('ttl-msg')).status, 'duplicate');

  const outside = createMessageDeliveryOutbox({
    journalPath,
    now: () => deliveredAt + DEFAULT_MESSAGE_DELIVERY_TTL_MS + 1
  });
  assert.equal(outside.enqueue(record('ttl-msg')).status, 'pending');
});

test('reports corrupt persistence instead of silently treating it as delivered', () => {
  const { journalPath } = fixture();
  fs.writeFileSync(journalPath, '{not-json}\n');
  const errors = [];
  const outbox = createMessageDeliveryOutbox({
    journalPath,
    onError: (message) => errors.push(message)
  });

  assert.equal(outbox.enqueue(record('new-message')).status, 'pending');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unable to parse delivery journal line 1/);
});

test('does not forward when pending state cannot be persisted', async () => {
  const { journalPath } = fixture();
  const outbox = createMessageDeliveryOutbox({
    journalPath,
    appendEvent() {
      throw new Error('simulated pending write failure');
    }
  });
  let forwards = 0;

  assert.throws(() => outbox.enqueue(record('write-failure')), /simulated pending write failure/);
  assert.equal(outbox.lookup('write-failure'), null);
  assert.equal(forwards, 0);
});

test('a failed-state write error still reports the outcome so the user can be told', async () => {
  const { journalPath } = fixture();
  const errors = [];
  const outbox = createMessageDeliveryOutbox({
    journalPath,
    appendEvent(event) {
      if (event.outcome === 'failed') throw new Error('simulated failed marker failure');
      fs.appendFileSync(journalPath, `${JSON.stringify(event)}\n`);
    },
    onError: (message) => errors.push(message)
  });
  const pending = outbox.enqueue(record('fail-write')).record;
  const result = await outbox.deliver(pending, {
    forward: async () => ({ outcome: 'not_stored', notice: 'try later' }),
    recordHistory: () => true
  });
  assert.deepEqual(result, { delivered: false, outcome: 'not_stored', notice: 'try later' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /simulated failed marker failure/);
  assert.equal(outbox.lookup('fail-write').state, 'pending', 'stays a duplicate in memory');
  assert.equal(outbox.lookup('fail-write').forwarding, true, 'finished as interrupted at the next startup');
});
