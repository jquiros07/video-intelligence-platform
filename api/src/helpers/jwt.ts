import { SignJWT, jwtVerify } from 'jose';
import { requireEnv } from './env-vars';
import { AuthenticatedUser } from '../interfaces/auth.interface';

const secret = new TextEncoder().encode(requireEnv('JWT_SECRET_KEY'));
const expiresIn = requireEnv('JWT_EXPIRES_IN');

export const signToken = (userId: string, email: string): Promise<string> => {
    return new SignJWT({ email })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(secret);
};

export const verifyToken = async (token: string): Promise<AuthenticatedUser> => {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    return { userId: payload.sub as string, email: payload.email as string };
};
