import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../helpers/jwt';

export const validateAuthToken = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        response.status(401).json({ message: 'Missing or invalid authorization header' });
        return;
    }

    const token = authHeader.slice('Bearer '.length);

    try {
        response.locals.user = await verifyToken(token);
        next();
    } catch (error) {
        response.status(401).json({ message: 'Invalid or expired token' });
    }
};
