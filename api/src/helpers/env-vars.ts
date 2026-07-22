export const requireEnv = (name: string): string => {
    try {
        const value: string | undefined = process.env[name];
        if (!value) {
            throw new Error(`Missing environment variable: ${name}`);
        }
        return value;
    } catch (error) {
        throw new Error(`Missing environment variable: ${name}`);
    }
};