import {
    SlashCommandBuilder,
    SlashCommandStringOption,
    SlashCommandSubcommandBuilder,
    SlashCommandUserOption
} from "@discordjs/builders";

import {
    CommandInteraction,
    Client,
    GuildMember,
    User,
    CacheType,
    MessageActionRow, MessageButton, MessageComponentInteraction
} from "discord.js";

import {ApplicationCommand, CommandPermission, CommandResult, UserInteraction} from "./command";
import {getConfig} from "../utils/configHandler";
import Nicknames from "../storage/model/Nickname";
import {isTrusted} from "../utils/userUtils";

const config = getConfig();

type Vote = "YES" | "NO";

interface UserVote {
    readonly vote: Vote;
    readonly trusted: boolean;

}

function getWeightOfUserVote(vote: UserVote): number {
    return vote.trusted ? 2 : 1;
}

interface Suggestion {
    readonly nicknameUserID: string;
    readonly nickname: string;

}

const ongoingSuggestions: Record<string, Suggestion> = {};
const idVoteMap: Record<string, Record<string, UserVote>> = {};

function getUserVoteMap(messageid: string) {
    if (idVoteMap[messageid] === undefined) {
        idVoteMap[messageid] = {};
    }
    return idVoteMap[messageid];
}

export class Nickname implements ApplicationCommand {
    modCommand: boolean = false;
    name: string = "nickname";
    description: string = "Setzt Nicknames für einen User";
    permissions: readonly CommandPermission[] = [];

    get applicationCommand(): Pick<SlashCommandBuilder, "toJSON"> {
        return new SlashCommandBuilder()
            .setName(this.name)
            .setDescription(this.description)
            .addSubcommand(
                new SlashCommandSubcommandBuilder()
                    .setName("add")
                    .setDescription("Fügt einen nickname hinzu brudi")
                    .addUserOption(new SlashCommandUserOption()
                        .setRequired(true)
                        .setName("user")
                        .setDescription("Wem du tun willst"))
                    .addStringOption(new SlashCommandStringOption()
                        .setRequired(true)
                        .setName("nickname")
                        .setDescription("Was du tun willst")
                    ))
            .addSubcommand(
                new SlashCommandSubcommandBuilder()
                    .setName("delete")
                    .setDescription("Entfernt einen Nickname brudi")
                    .addUserOption(new SlashCommandUserOption()
                        .setRequired(true)
                        .setName("user")
                        .setDescription("Wem du tun willst"))
                    .addStringOption(new SlashCommandStringOption()
                        .setRequired(true)
                        .setName("nickname")
                        .setDescription("Was du tun willst")
                    ))
            .addSubcommand(
                new SlashCommandSubcommandBuilder()
                    .setName("deleteall")
                    .setDescription("Entfernt alle nicknames brudi")
                    .addUserOption(new SlashCommandUserOption()
                        .setRequired(true)
                        .setName("user")
                        .setDescription("Wem du tun willst")))
            .addSubcommand(
                new SlashCommandSubcommandBuilder()
                    .setName("list")
                    .setDescription("Zeigt alle nicknames brudi")
                    .addUserOption(new SlashCommandUserOption()
                        .setRequired(true)
                        .setName("user")
                        .setDescription("Wem du tun willst")));
    }

    async handleInteraction(command: CommandInteraction, client: Client<boolean>): Promise<CommandResult> {
        try {
            const option = command.options.getSubcommand();
            const commandUser = command.guild?.members.cache.find(m => m.id === command.user.id)!;
            // We know that the user option is in every subcommand.
            const user = command.options.getUser("user", true);
            const isNotTrusted = !commandUser?.roles.cache.has(config.ids.trusted_role_id);
            const isDifferentUser = user.id !== commandUser.user.id;


            // Yes, we could use a switch-statement here. No, that wouldn't make the code more readable as we're than
            // struggling with the nickname parameter which is mandatory only in "add" and "delete" commands.
            // Yes, we could rearrange the code parts into separate functions. Feel free to do so.
            // Yes, "else" is uneccessary as we're returning in every block. However, I find the semantics more clear.
            if (option === "deleteall") {
                if (isNotTrusted && isDifferentUser) {
                    return command.reply("Hurensohn. Der Command ist nix für dich.");
                }
                const member = command.guild?.members.cache.get(user.id)!;
                await Nicknames.deleteNickNames(user.id);
                await this.updateNickName(member!, null);
                return command.reply("Ok Brudi. Hab alles gelöscht");
            }
            else if (option === "list") {
                const nicknames = await Nicknames.getNicknames(user.id);
                if (nicknames.length === 0) {
                    return command.reply("Ne Brudi für den hab ich keine Nicknames");
                }
                return command.reply(`Hab für den Brudi folgende Nicknames:\n${nicknames.map(n => n.nickName).join(", ")}`);
            }
            else if (option === "add") {
                if (isNotTrusted) {
                    return command.reply("Hurensohn. Der Command ist nix für dich.");
                }
                let nickname = command.options.getString("nickname", true);
                if (await Nicknames.nickNameExist(user.id, nickname)) {
                    return command.reply(`Würdest du Hurensohn aufpassen, wüsstest du, dass für ${user} '${nickname}' bereits existiert.`);
                }
                return Nickname.createNickNameVote(command, user, nickname);
                //    await this.addNickname(command, user);
            }
            else if (option === "delete") {
                if (isNotTrusted && isDifferentUser) {
                    return command.reply("Hurensohn. Der Command ist nix für dich.");
                }
                // We don't violate the DRY principle, since we're referring to another subcommand object as in the "add" subcommand.
                // Code is equal but knowledge differs.
                const nickname = command.options.getString("nickname", true);
                await Nicknames.deleteNickName(user.id, nickname);
                const member = command.guild?.members.cache.get(user.id)!;
                if (member.nickname === nickname) {
                    await this.updateNickName(member!, null);
                }
                return command.reply(`Ok Brudi. Hab für ${user} ${nickname} gelöscht`);
            }

            return command.reply("Das hätte nie passieren dürfen");
        }
        catch (e) {
            console.log(e);
            return command.reply("Das hätte nie passieren dürfen");
        }
    }

    private static async createNickNameVote(command: CommandInteraction<CacheType>, user: User, nickname: string) {
        const row = new MessageActionRow()
            .addComponents(
                new MessageButton()
                    .setCustomId("nicknameVoteYes")
                    .setLabel("Guter")
                    .setStyle("SUCCESS"),
                new MessageButton()
                    .setCustomId("nicknameVoteNo")
                    .setLabel("Lass ma")
                    .setStyle("DANGER")
            );
        await command.reply({
            content: `Eh Brudis, soll ich für ${user} ${nickname} hinzufügen?`,
            components: [row]
        });
        const message = await command.fetchReply();
        ongoingSuggestions[message.id] = {nicknameUserID: user.id, nickname};
        getUserVoteMap(message.id)[user.id] = {
            vote: "YES",
            trusted: isTrusted(command.guild?.members.cache.get(user.id)!)
        };
        return;
    }


    async updateNickName(user: GuildMember, nickname: string | null) {
        await user.setNickname(nickname);
    }
}


export class NicknameButtonHandler implements UserInteraction {
    readonly ids = ["nicknameVoteYes", "nicknameVoteNo"];
    readonly name = "NicknameButtonhandler";
    readonly threshold = 5;


    async handleInteraction(interaction: MessageComponentInteraction, client: Client): Promise<void> {
        let suggestion = ongoingSuggestions[interaction.message.id];

        if (suggestion === undefined) {
            return interaction.update({
                content: "Ich find den Namensvorschlag nicht. Irgend ein Huso muss wohl den Bot neugestartet haben. Macht am besten ne Neue auf",
                components: []
            });
        }
        let userVoteMap = getUserVoteMap(interaction.message.id);

        const isTrust = isTrusted(interaction.guild?.members.cache.get(interaction.user.id)!);
        if (!isTrust) {
            return interaction.reply({
                content: "Neeeeee, du bist nicht cool genug. Ich hab dein Vote nicht gezählt",
                ephemeral: true
            });
        }
        if (interaction.customId === "nicknameVoteYes") {
            userVoteMap[interaction.user.id] = {vote: "YES", trusted: isTrust};
        }
        else if (interaction.customId === "nicknameVoteNo") {
            userVoteMap[interaction.user.id] = {vote: "NO", trusted: isTrust};
        }
        // evaluate the Uservotes
        let votes = Object.values(userVoteMap);
        if (votes.filter(userVote => userVote.vote === "NO").reduce((sum, uservote) => sum + getWeightOfUserVote(uservote), 0) >= this.threshold) {
            return interaction.update({
                content: `Der Vorschlag: \`${suggestion.nickname}\` für <@${suggestion.nicknameUserID}> war echt nicht so geil`,
                components: []
            });
        }
        if (votes.filter(vote => vote.vote === "YES").reduce((sum, uservote) => sum + getWeightOfUserVote(uservote), 0) >= this.threshold) {
            try {
                await Nicknames.insertNickname(suggestion.nicknameUserID, suggestion.nickname);
            }
            catch (error) {
                return interaction.update(`Würdet ihr Hurensöhne aufpassen, wüsstest ihr, dass für <@${suggestion.nicknameUserID}> \`${suggestion.nickname}\` bereits existiert.`);
            }

            return interaction.update({
                content: `Für <@${suggestion.nicknameUserID}> ist jetzt  \`${suggestion.nickname}\` in der Rotation`,
                components: []
            });
        }
        return interaction.reply({content: "Hast abgestimmt", ephemeral: true});
    }
}


