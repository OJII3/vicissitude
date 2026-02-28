import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";
import { opencodeAgent } from "./agents/opencode.ts";

const MAX_DISCORD_LENGTH = 2000;

function deriveSessionKey(channelId: string, userId: string): string {
  return `discord:${channelId}:${userId}`;
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_DISCORD_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_LENGTH);
    if (splitAt <= 0) splitAt = MAX_DISCORD_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

async function handleMessage(message: Message) {
  const sessionKey = deriveSessionKey(message.channel.id, message.author.id);

  const content = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!content) return;

  const channel = message.channel;
  if (!("sendTyping" in channel)) return;
  await channel.sendTyping();
  const typingInterval = setInterval(
    () => void channel.sendTyping(),
    8000,
  );

  try {
    const response = await opencodeAgent.send(sessionKey, content);
    clearInterval(typingInterval);

    const chunks = splitMessage(response.text);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply(chunks[i]!);
      } else if ("send" in channel) {
        await channel.send(chunks[i]!);
      }
    }
  } catch (error) {
    clearInterval(typingInterval);
    console.error("Agent error:", error);
    await message.reply(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function startGateway() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN is required in .env.local");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const isMentioned = message.mentions.has(client.user!);
    const isThread = message.channel.isThread();

    if (isMentioned || isThread) {
      await handleMessage(message);
    }
  });

  await client.login(token);
  return client;
}
