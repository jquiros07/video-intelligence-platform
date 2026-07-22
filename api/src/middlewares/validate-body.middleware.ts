import { Request, Response, NextFunction } from 'express';
import { ZodType } from 'zod';

export const validateBody = (schema: ZodType) => {
    return (request: Request, response: Response, next: NextFunction): void => {
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) {
            response.status(400).json({ message: 'Invalid request body', errors: parsed.error.flatten().fieldErrors });
            return;
        }

        request.body = parsed.data;
        next();
    };
};
