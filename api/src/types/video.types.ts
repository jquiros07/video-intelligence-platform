import { z } from 'zod';
import { requireEnv } from '../helpers/env-vars';

const ALLOWED_VIDEO_CONTENT_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo'] as const;

const parseSizeToBytes = (size: string): number => {
    const match = /^(\d+(?:\.\d+)?)\s*(kb|mb|gb)$/i.exec(size.trim());
    if (!match) {
        throw new Error(`Invalid size format: ${size}`);
    }

    const multipliers: Record<string, number> = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
    return Math.floor(parseFloat(match[1]) * multipliers[match[2].toLowerCase()]);
};

const MAX_VIDEO_SIZE_BYTES = parseSizeToBytes(requireEnv('VIDEO_UPLOAD_LIMIT'));

export const videoUploadSchema = z.object({
    fileName: z.string().trim().min(1),
    contentType: z.enum(ALLOWED_VIDEO_CONTENT_TYPES),
    fileSize: z.number().int().positive().max(MAX_VIDEO_SIZE_BYTES),
});

export type VideoUploadInput = z.infer<typeof videoUploadSchema>;
