import { VerifyEmailIdentityCommand } from '@aws-sdk/client-ses';
import { sesClient } from './ses.client';

export const verifyEmailIdentity = (email: string): Promise<object> => {
    const command = new VerifyEmailIdentityCommand({ EmailAddress: email });
    return sesClient.send(command);
};
