import { describe, expect, it, vi } from 'vitest';
import { TelegramNotificationChannel } from '../../src/server/notification-channels';

describe('Telegram notification channel', () => {
  it('sends a plain text message to the linked chat without exposing the bot token in the body', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
    const channel = new TelegramNotificationChannel({ botToken: 'bot-secret', fetcher });

    await channel.send({ chatId: '12345', text: 'Review passed' });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botbot-secret/sendMessage');
    expect(JSON.parse(String(init.body))).toEqual({ chat_id: '12345', text: 'Review passed', disable_web_page_preview: true });
    expect(JSON.stringify(init.body)).not.toContain('bot-secret');
  });

  it('fails closed on a rejected Bot API response', async () => {
    const channel = new TelegramNotificationChannel({
      botToken: 'bot-secret',
      fetcher: async () => new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }),
    });

    await expect(channel.send({ chatId: '12345', text: 'Review passed' })).rejects.toThrow('Telegram delivery failed');
  });
});
