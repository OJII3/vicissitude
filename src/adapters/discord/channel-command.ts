import {
  ChannelType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandChannelOption,
} from "discord.js";
import type { ChannelCapabilities } from "../../modules/channels/channel-capability.js";
import type { Clock } from "../../shared/clock.js";

const channelTypes = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildPublicThread,
  ChannelType.GuildPrivateThread,
  ChannelType.GuildNewsThread,
] as const;
const channelOption = (option: SlashCommandChannelOption) =>
  option
    .setName("channel")
    .setDescription("対象チャンネル")
    .addChannelTypes(...channelTypes)
    .setRequired(true);

export const channelCommand = new SlashCommandBuilder()
  .setName("vicissitude-channel")
  .setDescription("Vicissitudeのチャンネル権限を管理します")
  .setDMPermission(false)
  .addSubcommand((sub) => sub.setName("show").setDescription("現在の権限を表示します").addChannelOption(channelOption))
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("チャンネル権限を設定します")
      .addChannelOption(channelOption)
      .addBooleanOption((o) => o.setName("observe").setDescription("イベントを観察する"))
      .addBooleanOption((o) => o.setName("mentions").setDescription("mentionへ応答する"))
      .addBooleanOption((o) => o.setName("join").setDescription("自発参加する"))
      .addBooleanOption((o) => o.setName("topics").setDescription("自発投稿する"))
      .addBooleanOption((o) => o.setName("reactions").setDescription("reactionを追加する"))
      .addBooleanOption((o) => o.setName("threads").setDescription("threadを作成する"))
      .addBooleanOption((o) => o.setName("files").setDescription("fileを共有する"))
      .addBooleanOption((o) => o.setName("links").setDescription("外部linkを共有する"))
      .addStringOption((o) =>
        o.setName("reason").setDescription("変更理由").setMinLength(1).setMaxLength(500).setRequired(true),
      ),
  );

interface Repository {
  get(guildId: string, channelId: string): Promise<ChannelCapabilities>;
  patch(
    guildId: string,
    channelId: string,
    patch: ChannelCapabilitiesPatch,
    actor: string,
    reason: string,
    now: Date,
  ): Promise<void>;
}

export type ChannelCapabilitiesPatch = Partial<
  Pick<
    ChannelCapabilities,
    | "observeEvents"
    | "respondToMentions"
    | "spontaneousJoin"
    | "spontaneousTopic"
    | "addReactions"
    | "createThreads"
    | "shareFiles"
    | "shareExternalLinks"
  >
>;

export async function handleChannelCommand(
  interaction: ChatInputCommandInteraction<"cached">,
  expectedGuildId: string,
  adminUserIds: ReadonlySet<string>,
  repository: Repository,
  clock: Clock,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "DMでは使用できません。", ephemeral: true });
    return;
  }
  if (interaction.guildId !== expectedGuildId) {
    await interaction.reply({ content: "このGuildでは使用できません。", ephemeral: true });
    return;
  }
  if (!adminUserIds.has(interaction.user.id)) {
    await interaction.reply({ content: "この操作は許可されていません。", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const channel = interaction.options.getChannel("channel", true);
    const capabilityChannelId = channel.isThread() ? channel.parentId : channel.id;
    if (!capabilityChannelId) throw new Error("Thread has no parent channel");
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "set") {
      const patch: ChannelCapabilitiesPatch = {};
      const options: Array<[string, keyof ChannelCapabilitiesPatch]> = [
        ["observe", "observeEvents"],
        ["mentions", "respondToMentions"],
        ["join", "spontaneousJoin"],
        ["topics", "spontaneousTopic"],
        ["reactions", "addReactions"],
        ["threads", "createThreads"],
        ["files", "shareFiles"],
        ["links", "shareExternalLinks"],
      ];
      for (const [option, property] of options) {
        const value = interaction.options.getBoolean(option);
        if (value !== null) patch[property] = value;
      }
      const reason = interaction.options.getString("reason", true).trim();
      if (!reason) throw new Error("Reason is required");
      await repository.patch(interaction.guildId, capabilityChannelId, patch, interaction.user.id, reason, clock.now());
      await interaction.editReply({ content: "チャンネル権限を更新しました。" });
      return;
    }
    const current = await repository.get(interaction.guildId, capabilityChannelId);
    if (subcommand === "show") {
      await interaction.editReply({ content: `\`\`\`json\n${JSON.stringify(current, null, 2)}\n\`\`\`` });
      return;
    }
    if (subcommand !== "set") throw new Error(`Unsupported subcommand: ${subcommand}`);
    throw new Error(`Unsupported subcommand: ${subcommand}`);
  } catch (error) {
    try {
      await interaction.editReply({ content: "チャンネル権限の処理に失敗しました。" });
    } catch {
      // The original error is more useful to the gateway logger.
    }
    throw error;
  }
}
