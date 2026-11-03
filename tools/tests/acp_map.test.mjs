import test from 'node:test';
import assert from 'node:assert/strict';
import { acpUpdates, toolResultUpdate, textOf } from '../../server/acp-map.mjs';

test('acp-1: user message maps to user_message_chunk', () => {
  const out = acpUpdates({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hi' }] } });
  assert.deepEqual(out, [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }]);
});

test('acp-2: assistant reasoning and text map to thought/message chunks', () => {
  const out = acpUpdates({
    type: 'assistant/message', seq: 2,
    data: { message: { content: [
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'answer' },
    ] } },
  });
  assert.deepEqual(out.map((u) => u.sessionUpdate), ['agent_thought_chunk', 'agent_message_chunk']);
  assert.deepEqual(out.map((u) => u.content.text), ['think', 'answer']);
});

test('acp-3: tool/call maps to pending tool_call with kind and rawInput', () => {
  const out = acpUpdates({ type: 'tool/call', seq: 3, data: { callId: 'c1', name: 'bash' } });
  assert.deepEqual(out, [{
    sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', kind: 'execute', status: 'pending',
    rawInput: { command: '' },
  }]);
  const edit = acpUpdates({
    type: 'tool/call', seq: 4,
    data: { callId: 'c2', name: 'edit', arguments: JSON.stringify({ path: '/tmp/a.txt', old_string: 'a', new_string: 'b' }) },
  });
  assert.equal(edit[0].kind, 'edit');
  assert.deepEqual(edit[0].rawInput, { filePath: '/tmp/a.txt', oldString: 'a', newString: 'b' });
});

test('acp-4: tool/result maps to completed tool_call_update with rawOutput and content', () => {
  const out = toolResultUpdate({
    type: 'tool/result', seq: 5,
    data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } },
  });
  assert.equal(out.sessionUpdate, 'tool_call_update');
  assert.equal(out.toolCallId, 'c1');
  assert.equal(out.status, 'completed');
  assert.equal(out.rawOutput, 'ok');
  assert.deepEqual(out.content, [{ type: 'content', content: { type: 'text', text: 'ok' } }]);
});

test('acp-5: textOf joins prompt text blocks', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'image' }]), 'a\nb');
});
