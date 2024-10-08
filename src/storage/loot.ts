import type {
    ChatInputCommandInteraction,
    GuildChannel,
    GuildMember,
    GuildTextBasedChannel,
    Message,
    TextChannel,
    User,
} from "discord.js";
import { type ExpressionBuilder, sql } from "kysely";

import type { BotContext } from "@/context.js";
import type {
    Database,
    Loot,
    LootId,
    LootInsertable,
    LootOrigin,
    LootAttribute,
} from "./db/model.js";

import db from "@db";
import {
    LootAttributeClassId,
    LootAttributeKindId,
    lootAttributeTemplates,
} from "@/service/lootData.js";

export type LootUseCommandInteraction = ChatInputCommandInteraction & {
    channel: GuildTextBasedChannel;
};

export interface LootTemplate {
    id: number;
    weight: number;
    displayName: string;
    titleText: string;
    dropDescription: string;
    infoDescription?: string;
    emote?: string;
    excludeFromInventory?: boolean;
    effects?: string[];

    onDrop?: (
        context: BotContext,
        winner: GuildMember,
        sourceChannel: TextChannel & GuildChannel,
        claimedLoot: Loot,
    ) => Promise<void>;

    /** @returns Return `true` if the item should be kept in the inventory, `false`/falsy if it should be deleted. If an exception occurs, the item will be kept. */
    onUse?: (
        interaction: LootUseCommandInteraction,
        context: BotContext,
        loot: Loot,
    ) => Promise<boolean>;
    asset: string | null;
}

export interface LootAttributeTemplate {
    id: number;
    classId: number;
    displayName: string;
    shortDisplay: string;
    color?: number;
    initialDropWeight?: number;
}

const notDeleted = (eb: ExpressionBuilder<Database, "loot" | "lootAttribute">) =>
    eb.or([eb("deletedAt", "is", null), eb("deletedAt", ">", sql<string>`current_timestamp`)]);

const hasAttribute = (attributeKindId: number) => (eb: ExpressionBuilder<Database, "loot">) =>
    eb(
        "id",
        "in",
        eb
            .selectFrom("lootAttribute")
            .where("attributeKindId", "=", attributeKindId)
            .select("lootId"),
    );

export async function createLoot(
    template: LootTemplate,
    winner: User,
    message: Message<true> | null,
    now: Date,
    origin: LootOrigin,
    predecessorLootId: LootId | null,
    rarityAttribute: LootAttributeTemplate | null,
    ctx = db(),
) {
    return ctx.transaction().execute(async ctx => {
        const res = await ctx
            .insertInto("loot")
            .values({
                displayName: template.displayName,
                description: template.dropDescription,
                lootKindId: template.id,
                usedImage: template.asset,
                winnerId: winner.id,
                claimedAt: now.toISOString(),
                guildId: message?.guildId ?? "",
                channelId: message?.channelId ?? "",
                messageId: message?.id ?? "",
                origin,
                predecessor: predecessorLootId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

        if (rarityAttribute) {
            await addLootAttributeIfNotPresent(res.id, rarityAttribute, ctx);
        }

        return res;
    });
}

export async function findOfUser(user: User, ctx = db()) {
    return await ctx
        .selectFrom("loot")
        .where("winnerId", "=", user.id)
        .where(notDeleted)
        .selectAll()
        .execute();
}

export type LootWithAttributes = Loot & { attributes: Readonly<LootAttribute>[] };
export async function findOfUserWithAttributes(
    user: User,
    ctx = db(),
): Promise<LootWithAttributes[]> {
    return await ctx.transaction().execute(async ctx => {
        const lootItems = (await findOfUser(user, ctx)) as LootWithAttributes[];

        for (const loot of lootItems) {
            loot.attributes = await ctx
                .selectFrom("lootAttribute")
                .where("lootId", "=", loot.id)
                .where(notDeleted)
                .selectAll()
                .execute();
        }

        return lootItems;
    });
}

export async function findOfMessage(message: Message<true>, ctx = db()) {
    return await ctx
        .selectFrom("loot")
        .where("messageId", "=", message.id)
        .where(notDeleted)
        .selectAll()
        .executeTakeFirst();
}

export async function getUserLootsByTypeId(userId: User["id"], lootKindId: number, ctx = db()) {
    return await ctx
        .selectFrom("loot")
        .where("winnerId", "=", userId)
        .where("lootKindId", "=", lootKindId)
        .where(notDeleted)
        .selectAll()
        .execute();
}

export async function getUserLootsWithAttribute(
    userId: User["id"],
    attributeKindId: number,
    ctx = db(),
) {
    return await ctx
        .selectFrom("loot")
        .where("winnerId", "=", userId)
        .where(notDeleted)
        .where(hasAttribute(attributeKindId))
        .selectAll()
        .execute();
}

export async function getUserLootById(userId: User["id"], lootId: LootId, ctx = db()) {
    return await ctx
        .selectFrom("loot")
        .where("winnerId", "=", userId)
        .where("id", "=", lootId)
        .where(notDeleted)
        .selectAll()
        .executeTakeFirst();
}

export async function getLootsByKindId(lootKindId: number, ctx = db()) {
    return await ctx
        .selectFrom("loot")
        .where("lootKindId", "=", lootKindId)
        .where(notDeleted)
        .selectAll()
        .execute();
}

export async function getLootsWithAttribute(attributeKindId: number, ctx = db()) {
    return await ctx
        .selectFrom("loot")
        .where(notDeleted)
        .where(hasAttribute(attributeKindId))
        .selectAll()
        .execute();
}

export async function transferLootToUser(
    lootId: LootId,
    userId: User["id"],
    trackPredecessor: boolean,
    ctx = db(),
) {
    return await ctx.transaction().execute(async ctx => {
        const oldLoot = await ctx
            .selectFrom("loot")
            .where("id", "=", lootId)
            .selectAll()
            .executeTakeFirstOrThrow();

        await deleteLoot(oldLoot.id, ctx);

        const replacement = {
            ...oldLoot,
            winnerId: userId,
            origin: "owner-transfer",
            predecessor: trackPredecessor ? lootId : null,
        } as const;

        if ("id" in replacement) {
            // @ts-ignore
            // biome-ignore lint/performance/noDelete: Setting it to undefined would keep the key
            delete replacement.id;
        }

        return await ctx
            .insertInto("loot")
            .values(replacement)
            .returningAll()
            .executeTakeFirstOrThrow();
    });
}

export async function replaceLoot(
    lootId: LootId,
    replacementLoot: LootInsertable,
    trackPredecessor: boolean,
    ctx = db(),
): Promise<Loot> {
    return await ctx.transaction().execute(async ctx => {
        await deleteLoot(lootId, ctx);

        const replacement = trackPredecessor
            ? { ...replacementLoot, predecessor: lootId }
            : { ...replacementLoot, predecessor: null };

        return await ctx
            .insertInto("loot")
            .values(replacement)
            .returningAll()
            .executeTakeFirstOrThrow();
    });
}

export async function deleteLoot(lootId: LootId, ctx = db()): Promise<LootId> {
    const res = await ctx
        .updateTable("loot")
        .where("id", "=", lootId)
        .set({ deletedAt: sql`current_timestamp` })
        .returning("id")
        .executeTakeFirstOrThrow();
    return res.id;
}

export async function getLootAttributes(lootId: LootId, ctx = db()) {
    return await ctx
        .selectFrom("lootAttribute")
        .where("lootId", "=", lootId)
        .where(notDeleted)
        .orderBy("lootAttribute.attributeKindId asc")
        .selectAll()
        .execute();
}

export async function addLootAttributeIfNotPresent(
    lootId: LootId,
    attributeTemplate: LootAttributeTemplate,
    ctx = db(),
) {
    return await ctx
        .insertInto("lootAttribute")
        .values({
            lootId,
            attributeKindId: attributeTemplate.id,
            attributeClassId: attributeTemplate.classId,
            displayName: attributeTemplate.displayName,
            shortDisplay: attributeTemplate.shortDisplay,
            color: attributeTemplate.color,
            deletedAt: null,
        })
        .onConflict(oc => oc.doNothing())
        .returningAll()
        .executeTakeFirstOrThrow();
}
