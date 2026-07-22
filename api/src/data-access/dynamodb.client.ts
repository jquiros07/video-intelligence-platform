import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { requireEnv } from '../helpers/env-vars';

const client = new DynamoDBClient({ region: requireEnv('AWS_REGION') });

export const dynamoDb = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
});
