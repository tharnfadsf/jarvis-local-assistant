'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../jarvis-core.js');

test('sensitive data is detected before it can be stored as a note', () => {
  assert.equal(core.containsSensitiveData('my password is hunter2secret'), true);
  assert.equal(core.containsSensitiveData('api_key: sk-abc123def456'), true);
  assert.equal(core.containsSensitiveData('token = 9f8e7d6c5b4a3210'), true);
  assert.equal(core.containsSensitiveData('Bearer abcdef1234567890'), true);
  assert.equal(core.containsSensitiveData('sk-proj-abcdefghij'), true);
  assert.equal(core.containsSensitiveData('the meeting is at 4 PM'), false);
  assert.equal(core.containsSensitiveData('my favourite editor is VS Code'), false);
});

test('memory migration converts legacy strings to records and caps at 50', () => {
  const legacy = ['first note', '', null, 'second note'];
  const migrated = core.migrateMemory(legacy);
  assert.equal(migrated.length, 2);
  assert.equal(migrated[0].text, 'first note');
  assert.equal(typeof migrated[0].at, 'number');
  const big = core.migrateMemory(Array.from({ length: 80 }, (_, i) => `note ${i}`));
  assert.equal(big.length, 50);
  assert.equal(big[49].text, 'note 79'); // newest kept
});

test('adding a note rejects secrets, duplicates, and empty text', () => {
  let list = core.migrateMemory([]);
  const added = core.addMemoryEntry(list, 'I study at Kasetsart University', 1000);
  assert.equal(added.reason, null);
  assert.equal(added.entry.text, 'I study at Kasetsart University');
  list = added.list;

  const dup = core.addMemoryEntry(list, 'i study at kasetsart university', 2000);
  assert.equal(dup.reason, 'duplicate');
  assert.equal(dup.list.length, 1);

  const secret = core.addMemoryEntry(list, 'password is hunter2secret', 3000);
  assert.equal(secret.reason, 'sensitive');
  assert.equal(secret.list.length, 1);

  const empty = core.addMemoryEntry(list, '   ', 4000);
  assert.equal(empty.reason, 'empty');

  let growing = [];
  for (let i = 0; i < 60; i++) growing = core.addMemoryEntry(growing, `note number ${i}`, 5000 + i).list;
  assert.equal(growing.length, 50);
  assert.equal(growing[49].text, 'note number 59');
});

test('forget removes only notes whose tokens all match', () => {
  const list = core.migrateMemory(['the project deadline is friday', 'I like green tea', 'project kickoff notes']);
  const result = core.forgetMemoryMatching(list, 'project deadline');
  assert.equal(result.removed.length, 1);
  assert.equal(result.list.length, 2);
  assert.ok(result.list.every(item => !/deadline/.test(item.text)));
  const none = core.forgetMemoryMatching(list, 'unicorns');
  assert.equal(none.removed.length, 0);
  assert.equal(none.list.length, 3);
});

test('memory commands map to explicit deterministic kinds', () => {
  assert.deepEqual(core.parseMemoryCommand('remember that I use VS Code'), { kind: 'remember', text: 'I use VS Code' });
  assert.equal(core.parseMemoryCommand('note that my exam is on friday').kind, 'remember');
  assert.deepEqual(core.parseMemoryCommand('forget what I told you about the deadline'), { kind: 'forget', query: 'the deadline' });
  assert.equal(core.parseMemoryCommand('forget everything').kind, 'forget-all');
  assert.equal(core.parseMemoryCommand('forget all memories').kind, 'forget-all');
  const search = core.parseMemoryCommand('search our conversations for homework');
  assert.equal(search.kind, 'search-history');
  assert.equal(search.query, 'homework');
  assert.equal(core.parseMemoryCommand('what did we discuss yesterday').kind, 'recall-yesterday');
  assert.equal(core.parseMemoryCommand('what did I ask you to do last time').kind, 'recall-last-tasks');
  assert.equal(core.parseMemoryCommand('continue the project').kind, 'continue-context');
  assert.equal(core.parseMemoryCommand('what do you remember about me').kind, 'show-memory');
  assert.equal(core.parseMemoryCommand('what is the capital of france'), null);
});

test('history search scores real keyword hits and respects the limit', () => {
  const history = [
    { who: 'YOU', text: 'finish the Jarvis homework tonight', at: 3000 },
    { who: 'JARVIS', text: 'Understood, Sir.', at: 3100 },
    { who: 'YOU', text: 'buy groceries after class', at: 2000 },
    { who: 'YOU', text: 'jarvis project status check', at: 1000 }
  ];
  const hits = core.searchHistory(history, 'jarvis', 2);
  assert.ok(hits.length <= 2);
  assert.ok(hits[0].text.includes('Jarvis') || hits[0].text.includes('jarvis'));
  assert.equal(core.searchHistory(history, 'zebra', 5).length, 0);
  assert.equal(core.searchHistory([], 'anything').length, 0);
  assert.equal(core.searchHistory(history, 'a').length, 0); // single-char tokens ignored
});

test('historyForDay only returns rows inside the requested range', () => {
  const history = [
    { who: 'YOU', text: 'early', at: 1000 },
    { who: 'YOU', text: 'inside', at: 5000 },
    { who: 'YOU', text: 'late', at: 9999 }
  ];
  const rows = core.historyForDay(history, 4000, 9000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'inside');
});

test('summarizeMessages is deterministic and labels the day', () => {
  assert.equal(core.summarizeMessages([]), '');
  const rows = [
    { who: 'YOU', text: 'set up the report', at: 1 },
    { who: 'JARVIS', text: 'done', at: 2 }
  ];
  const summary = core.summarizeMessages(rows, 'Yesterday');
  assert.match(summary, /^Yesterday: 2 messages\./);
  assert.match(summary, /You asked about "set up the report"\./);
  const onlyJarvis = core.summarizeMessages([{ who: 'JARVIS', text: 'hello', at: 1 }], 'Today');
  assert.match(onlyJarvis, /Only JARVIS spoke during that stretch\./);
});

test('buildRecall returns only query hits, or the recent tail without one', () => {
  const history = [
    { who: 'YOU', text: 'finish the jarvis homework', at: 100 },
    { who: 'JARVIS', text: 'noted', at: 200 },
    { who: 'YOU', text: 'buy groceries', at: 300 }
  ];
  const hit = core.buildRecall(history, ['older summary'], 'jarvis homework');
  assert.equal(hit.messages.length, 1);
  assert.equal(hit.searched, true);
  assert.equal(hit.summaries.length, 1);

  const miss = core.buildRecall(history, [], 'pizza recipes');
  assert.equal(miss.messages.length, 0);
  assert.equal(miss.searched, false);

  const tail = core.buildRecall(history, [], '');
  assert.equal(tail.messages.length, 3);
  assert.equal(tail.searched, false);
});

test('did-i-mention answers from notes and history with quotes', () => {
  const notes = [{ text: 'Dentist appointment tomorrow', at: 0 }, { text: 'I like green tea', at: 0 }];
  const history = [
    { who: 'YOU', text: 'remind me about the dentist bill', at: 2000 },
    { who: 'JARVIS', text: 'Noted.', at: 2100 }
  ];
  const hit = core.answerDidMention('dentist', notes, history);
  assert.equal(hit.found, true);
  assert.match(hit.reply, /Dentist appointment tomorrow/);
  assert.match(hit.reply, /dentist bill/);
  const miss = core.answerDidMention('paris', notes, history);
  assert.equal(miss.found, false);
  assert.match(miss.reply, /do not have anything about/);
  const vague = core.answerDidMention('it', notes, history);
  assert.equal(vague.found, false);
  assert.match(vague.reply, /too vague/);
});
