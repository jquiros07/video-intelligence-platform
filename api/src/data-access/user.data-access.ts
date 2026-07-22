import { v4 as uuidv4 } from 'uuid';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamoDb } from './dynamodb.client';
import { requireEnv } from '../helpers/env-vars';
import { User } from '../interfaces/user.interface';

const USERS_TABLE = requireEnv('DYNAMODB_USERS_TABLE');
const EMAIL_INDEX = requireEnv('DYNAMODB_USERS_EMAIL_INDEX');

// GSI queries are eventually consistent, so a duplicate email created in the same instant
// as another can slip past this check. Acceptable tradeoff for this table's key schema.
export const findUserByEmail = async (email: string): Promise<User | undefined> => {
    const result = await dynamoDb.send(new QueryCommand({
        TableName: USERS_TABLE,
        IndexName: EMAIL_INDEX,
        KeyConditionExpression: 'email = :email',
        ExpressionAttributeValues: { ':email': email },
        Limit: 1,
    }));

    return result.Items?.[0] as User | undefined;
};

export const createUser = async (name: string, lastname: string, email: string, passwordHash: string): Promise<User> => {
    const user: User = {
        userId: uuidv4(),
        name,
        lastname,
        email,
        passwordHash,
        createdAt: new Date().toISOString(),
    };

    await dynamoDb.send(new PutCommand({
        TableName: USERS_TABLE,
        Item: user,
        ConditionExpression: 'attribute_not_exists(userId)',
    }));

    return user;
};
