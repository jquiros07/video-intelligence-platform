import { S3Client } from '@aws-sdk/client-s3';
import { requireEnv } from '../helpers/env-vars';

export const s3Client = new S3Client({ region: requireEnv('AWS_REGION') });
