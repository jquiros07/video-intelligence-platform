import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createUploadPresignedUrl } from '../data-access/video.data-access';
import { AuthenticatedUser } from '../interfaces/auth.interface';
import { VideoUploadInput } from '../types/video.types';

export const uploadVideo = async (request: Request, response: Response): Promise<Response> => {
    const { fileName, contentType } = request.body as VideoUploadInput;
    const { userId } = response.locals.user as AuthenticatedUser;
    const key = `videos/${userId}/${uuidv4()}-${fileName}`;

    try {
        const uploadUrl = await createUploadPresignedUrl(key, contentType);
        return response.status(200).json({ uploadUrl, key });
    } catch (error) {
        console.error('Failed to create presigned upload URL', error);
        return response.status(500).json({ message: 'Failed to create upload URL' });
    }
};
