import type { GuildMember, Snowflake } from "discord.js";
import { DataTypes, Model, Op, type Optional, type Sequelize } from "sequelize";

import log from "../../utils/logger.js";

export interface AustrianTranslationAttributes {
    id: string;
    addedByUserId: string;
    austrian: string;
    german: string;
    description: string | null;
}

export type AustrianTranslationCreationAttributes = Optional<
    AustrianTranslationAttributes,
    "id"
>;

export default class AustrianTranslation extends Model {
    declare id: number;
    declare addedByUserId: Snowflake;
    declare austrian: string;
    declare german: string;
    declare description: string | null;

    declare readonly createdAt: Date;
    declare readonly updatedAt: Date;

    static persistOrUpdate = async (
        addedBy: GuildMember,
        german: string,
        austrian: string,
        description: string | null,
    ): Promise<AustrianTranslation> => {
        log.debug(
            `Saving austrian translation for user ${addedBy}. German: ${german}; Austrian: ${austrian}`,
        );
        const result = await AustrianTranslation.upsert({
            addedByUserId: addedBy.id,
            austrian,
            german,
            description,
        });
        return result[0];
    };

    static findTranslation(
        austrian: string,
    ): Promise<AustrianTranslation | null> {
        return AustrianTranslation.findOne({
            where: {
                [Op.or]: [
                    {
                        // we want like to be case-insensitive, we don't need a placeholder
                        // We might have translations with punctuations in it, so we simply try to match the whole string against it
                        austrian: {
                            [Op.like]: austrian.trim().toLowerCase(),
                        },
                    },
                    {
                        // If we couldn't find a translation with the punctuations in it, we remove the special chars
                        austrian: {
                            [Op.like]: austrian
                                .trim()
                                .toLowerCase()
                                .replace(/[^\w\s]/gu, ""),
                        },
                    },
                ],
            },
        });
    }

    static initialize(sequelize: Sequelize) {
        AustrianTranslation.init(
            {
                id: {
                    type: DataTypes.INTEGER,
                    autoIncrement: true,
                    primaryKey: true,
                },
                german: {
                    type: DataTypes.STRING,
                    allowNull: false,
                    unique: false,
                },
                austrian: {
                    type: DataTypes.STRING,
                    allowNull: false,
                    unique: true,
                },
            },
            {
                sequelize,
                modelName: "AustrianTranslation",
                indexes: [
                    {
                        unique: true,
                        fields: ["austrian"],
                    },
                    {
                        unique: false,
                        fields: ["german"],
                    },
                ],
            },
        );
    }
}
