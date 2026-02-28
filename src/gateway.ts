import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type ChatInputCommandInteraction,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import {
  getAgent,
  setAgent,
  listAgentNames,
  deriveSessionKey,
} from "./agents/router.ts";

const MAX_DISCORD_LENGTH = 2000;

function splitMessage(text: string): string[] {
  if (text.length <= MAX_DISCORD_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    // コードブロック途中で切らないよう、改行で区切る
    let splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_LENGTH);
    if (splitAt <= 0) splitAt = MAX_DISCORD_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

async function handleAgentMessage(message: Message) {
  const sessionKey = deriveSessionKey(
    message.channel.id,
    message.author.id,
  );
  const agent = getAgent(message.guildId ?? undefined);

  // メンションテキストを除去
  const content = message.content
    .replace(/<@!?\d+>/g, "")
    .trim();

  if (!content) return;

  // typing 表示
  const channel = message.channel;
  if (!("sendTyping" in channel)) return;
  await channel.sendTyping();
  const typingInterval = setInterval(
    () => void channel.sendTyping(),
    8000,
  );

  try {
    const response = await agent.send(sessionKey, content);
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

async function handleSlashCommand(interaction: ChatInputCommandInteraction) {
  if (interaction.commandName !== "agent") return;

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "switch") {
    const name = interaction.options.getString("name", true);
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply("This command can only be used in a server.");
      return;
    }
    if (setAgent(guildId, name)) {
      await interaction.reply(`Switched to **${name}** agent.`);
    } else {
      await interaction.reply(
        `Unknown agent: ${name}. Available: ${listAgentNames().join(", ")}`,
      );
    }
  } else if (subcommand === "list") {
    await interaction.reply(
      `Available agents: ${listAgentNames().join(", ")}`,
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

  // スラッシュコマンド登録
  const agentCommand = new SlashCommandBuilder()
    .setName("agent")
    .setDescription("Manage AI agent backend")
    .addSubcommand((sub) =>
      sub
        .setName("switch")
        .setDescription("Switch the active agent")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Agent name (opencode or copilot)")
            .setRequired(true)
            .addChoices(
              ...listAgentNames().map((n) => ({ name: n, value: n })),
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List available agents"),
    );

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);

    // コマンド登録
    const rest = new REST({ version: "10" }).setToken(token);
    await rest.put(Routes.applicationCommands(readyClient.user.id), {
      body: [agentCommand.toJSON()],
    });
    console.log("Slash commands registered.");
  });

  // メッセージハンドリング
  client.on(Events.MessageCreate, async (message) => {
    // bot 自身のメッセージは無視
    if (message.author.bot) return;

    // メンションされた場合、またはスレッド内の場合にトリガー
    const isMentioned = message.mentions.has(client.user!);
    const isThread = message.channel.isThread();

    if (isMentioned || isThread) {
      await handleAgentMessage(message);
    }
  });

  // スラッシュコマンドハンドリング
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    await handleSlashCommand(interaction);
  });

  await client.login(token);
  return client;
}
