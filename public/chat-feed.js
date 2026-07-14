export function isChatFeedMessage(message) {
  return message?.type === 'message' || Boolean(message?.chatTurnId);
}

export function chatFeedMessages(messages) {
  return messages.filter(isChatFeedMessage);
}
