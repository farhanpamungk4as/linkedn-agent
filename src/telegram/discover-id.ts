import "dotenv/config";

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type?: string };
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
  };
}

interface TelegramUpdatesResponse {
  ok?: boolean;
  description?: string;
  result?: TelegramUpdate[];
}

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN belum diisi di .env");
  process.exitCode = 1;
} else {
  console.log("Menunggu pesan selama 60 detik. Sekarang buka bot ini di Telegram lalu kirim /start ...");
  const params = new URLSearchParams({
    timeout: "60",
    allowed_updates: JSON.stringify(["message"]),
  });
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?${params}`);
  const data = await response.json() as TelegramUpdatesResponse;
  if (!response.ok || !data.ok) {
    console.error(`Telegram menolak request: ${data.description ?? `HTTP ${response.status}`}`);
    process.exitCode = 1;
  } else {
    const users = new Map<number, { id: number; username: string; name: string; chatId: number }>();
    for (const update of data.result ?? []) {
      if (!update.message?.from) continue;
      const from = update.message.from;
      users.set(from.id, {
        id: from.id,
        username: from.username ? `@${from.username}` : "—",
        name: [from.first_name, from.last_name].filter(Boolean).join(" ") || "—",
        chatId: update.message.chat.id,
      });
    }
    if (!users.size) {
      console.log("Belum ada pesan. Pastikan chat yang dibuka adalah bot dari token di .env, lalu ulangi command dan kirim /start saat command sedang menunggu.");
    } else {
      console.log("Akun Telegram yang mengirim pesan ke bot:");
      for (const user of users.values()) {
        console.log(`- ${user.name} (${user.username})`);
        console.log(`  TELEGRAM_ALLOWED_USER_ID=${user.id}`);
        console.log(`  TELEGRAM_CHAT_ID=${user.chatId}`);
      }
    }
  }
}
