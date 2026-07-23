import { SESClient } from '@aws-sdk/client-ses';
import { requireEnv } from './env-vars';

export const sesClient = new SESClient({ region: requireEnv('AWS_REGION') });
