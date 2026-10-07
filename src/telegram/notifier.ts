import type { AppConfig } from "../config/index.js";
import type { Logger } from "../config/logger.js";

export interface Notifier {
  notify(message: string, options?: NotifyOptions): Promise<void>;
}

export interface TelegramButton { text: string; url?: string; callback_data?: string; }
export interface NotifyOptions { buttons?: TelegramButton[][]; }

export class ConsoleNotifier implements Notifier {
  async notify(message: string, _options?: NotifyOptions): Promise<void> {
    console.log(`[mock telegram] ${message}`);
  }
}

export class TelegramNotifier implements Notifier {
  constructor(private readonly token: string, private readonly chatId: string) {}

  async notify(message: string, options?: NotifyOptions): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: message,
        ...(options?.buttons?.length ? { reply_markup: { inline_keyboard: options.buttons } } : {}) }),
    });
    if (!response.ok) throw new Error(`Telegram API returned HTTP ${response.status}`);
    const body = await response.json() as { ok?: boolean };
    if (!body.ok) throw new Error("Telegram API did not accept the notification");
  }
}

export function createNotifier(config: AppConfig, logger: Logger): Notifier {
  const target = config.telegramChatId || config.telegramAllowedUserId;
  if (config.telegramBotToken && target) {
    logger.info("Telegram notifier enabled");
    return new TelegramNotifier(config.telegramBotToken, target);
  }
  logger.info("Mock Telegram notifier enabled");
  return new ConsoleNotifier();
}
