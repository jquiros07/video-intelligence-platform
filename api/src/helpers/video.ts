import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from './s3.client';
import { requireEnv } from './env-vars';

const VIDEOS_BUCKET = requireEnv('VIDEOS_BUCKET');
const UPLOAD_URL_EXPIRES_IN_SECONDS = 300;

export const createUploadPresignedUrl = (key: string, contentType: string): Promise<string> => {
    const command = new PutObjectCommand({
        Bucket: VIDEOS_BUCKET,
        Key: key,
        ContentType: contentType,
    });

    return getSignedUrl(s3Client, command, { expiresIn: UPLOAD_URL_EXPIRES_IN_SECONDS });
};
