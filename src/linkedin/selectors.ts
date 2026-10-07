// LinkedIn DOM assumptions are kept here so a layout change does not affect workflow code.
export const SELECTORS = {
  profileHeading: "main h1, main h2",
  conversationRoot: ".msg-overlay-conversation-bubble--is-active, [role='dialog'][aria-label*='Message']",
  messagingConversationRoot: ".msg-convo-wrapper",
  conversationCard: ".msg-conversation-card",
  messageSearch: "input[name='searchTerm']",
  messageEvents: "[data-testid='message-event'], .msg-s-message-list__event",
  messageItem: ".msg-s-event-listitem",
  messageBody: ".msg-s-event-listitem__body",
  incomingMessage: ".msg-s-event-listitem--other",
  messageSender: ".msg-s-message-group__name",
  sentIndicator: ".msg-s-event-with-indicator__sending-indicator--sent",
  dateHeading: ".msg-s-message-list__time-heading",
  groupTimestamp: ".msg-s-message-group__timestamp",
  emptyConversation: "[data-testid='empty-message-list'], .msg-s-message-list__no-messages",
  composeRecipient: ".msg-connections-typeahead__added-recipients .artdeco-pill__text",
  composer: "[role='textbox'][contenteditable='true'], .msg-form__contenteditable[contenteditable='true']",
  messageTime: "time[datetime]",
} as const;

export const MESSAGE_ACTION = /^(Message|Pesan)$/i;
export const SEND_ACTION = /^(Send|Kirim)$/i;
export const CHALLENGE_TEXT = /captcha|security verification|verify your identity|suspicious login|enter the code|verifikasi keamanan|konfirmasi identitas|join linkedin|sign in to linkedin|bergabung di linkedin|masuk ke linkedin/i;
export const CHALLENGE_PATH = /\/(login|checkpoint|challenge|uas\/login)/i;
