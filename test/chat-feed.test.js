import test from 'node:test';
import assert from 'node:assert/strict';

import { chatFeedMessages, isChatFeedMessage } from '../public/chat-feed.js';

test('General Chat includes conversation and chat-turn notices only', () => {
  const messages = [
    { id: 'user', type: 'message', source: 'user' },
    { id: 'legacy-chat', type: 'message', source: 'codex' },
    { id: 'reply', type: 'message', source: 'claude', chatTurnId: 'chat_1' },
    { id: 'reply-failed', type: 'blocker', source: 'system', chatTurnId: 'chat_2' },
    { id: 'plan-notice', type: 'system', source: 'system', chatTurnId: 'chat_3' },
    { id: 'task-progress', type: 'progress', source: 'codex', taskId: 'task_1' },
    { id: 'task-assigned', type: 'delegation', source: 'system', taskId: 'task_1' },
    { id: 'task-finished', type: 'review', source: 'system', taskId: 'task_1' },
    { id: 'task-blocked', type: 'blocker', source: 'system', taskId: 'task_1' },
    { id: 'autopilot', type: 'autopilot', source: 'system', taskId: 'task_1' },
    { id: 'workspace', type: 'system', source: 'system' }
  ];

  assert.deepEqual(
    chatFeedMessages(messages).map((message) => message.id),
    ['user', 'legacy-chat', 'reply', 'reply-failed', 'plan-notice']
  );
});

test('chat feed predicate rejects missing values and task activity', () => {
  assert.equal(isChatFeedMessage(null), false);
  assert.equal(isChatFeedMessage({ type: 'progress', taskId: 'task_1' }), false);
  assert.equal(isChatFeedMessage({ type: 'blocker', chatTurnId: 'chat_1' }), true);
});
