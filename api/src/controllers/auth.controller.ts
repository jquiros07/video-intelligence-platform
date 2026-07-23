import { Request, Response } from 'express';
import { RegisterInput, LoginInput } from '../types/auth.types';
import { createUser, findUserByEmail } from '../data-access/user.data-access';
import { verifyEmailIdentity } from '../helpers/ses';
import { hashPassword, verifyPassword } from '../helpers/password';
import { signToken } from '../helpers/jwt';

export const registerUser = async (request: Request, response: Response): Promise<Response> => {
    const { name, lastname, email, password } = request.body as RegisterInput;

    try {
        const existingUser = await findUserByEmail(email);
        if (existingUser) {
            return response.status(409).json({ message: 'A user with this email already exists' });
        }

        const passwordHash = await hashPassword(password);
        const user = await createUser(name, lastname, email, passwordHash);
        await verifyEmailIdentity(email);

        return response.status(201).json({ message: 'User created successfully! Please verify your email address' });
    } catch (error) {
        console.error('Failed to register user', error);
        return response.status(500).json({ message: 'Failed to register user' });
    }
};

export const login = async (request: Request, response: Response): Promise<Response> => {
    const { email, password } = request.body as LoginInput;

    try {
        const user = await findUserByEmail(email);
        if (!user) {
            return response.status(401).json({ message: 'Invalid email or password' });
        }

        const isPasswordValid = await verifyPassword(user.passwordHash, password);
        if (!isPasswordValid) {
            return response.status(401).json({ message: 'Invalid email or password' });
        }

        const token = await signToken(user.userId, user.email);
        return response.status(200).json({ token });
    } catch (error) {
        console.error('Failed to log in user', error);
        return response.status(500).json({ message: 'Failed to log in' });
    }
};
