export interface EmailNotification {
  to: string;
  subject: string;
  text: string;
}

export interface EmailNotificationOptions {
  from: string;
  enabled?: boolean;
  sendMail: (msg: { from: string; to: string; subject: string; text: string }) => Promise<void>;
}

/** Email delivery adapter; disabled by default to fail closed. */
export class EmailNotificationChannel {
  constructor(private readonly options: EmailNotificationOptions) {}

  async send(message: EmailNotification): Promise<void> {
    if (!this.options.enabled) return;
    await this.options.sendMail({
      from: this.options.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

export interface TelegramNotification {
  chatId: string;
  text: string;
}

export interface TelegramNotificationOptions {
  botToken: string;
  fetcher?: typeof fetch;
}

/** Thin Bot API adapter; caller must supply a chat ID obtained by a secure linking flow. */
export class TelegramNotificationChannel {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: TelegramNotificationOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async send(message: TelegramNotification): Promise<void> {
    if (!this.options.botToken || !message.chatId.trim() || !message.text.trim()) {
      throw new Error('Telegram notification is not configured');
    }
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.options.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: message.chatId, text: message.text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('Telegram delivery failed');
    }
    if (!response.ok) throw new Error('Telegram delivery failed');
    const body: unknown = await response.json().catch(() => null);
    if (body === null || typeof body !== 'object' || !('ok' in body) || body.ok !== true) {
      throw new Error('Telegram delivery failed');
    }
  }
}
