import express from 'express';
import dotenv from 'dotenv';
import router from './routes/routes';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 8080;

const generalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests, please try again later.'
});

app.use(helmet());
app.get('/health', (_request, response) => response.status(200).json({ status: 'ok' }));

app.use(express.json({ limit: '100kb' }));
app.use(generalRateLimiter);
app.use('/api/v1', router);

console.log('Starting API server...');

app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on port ${port}`);
});
