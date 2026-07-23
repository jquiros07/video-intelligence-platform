import express from 'express';
import dotenv from 'dotenv';
import router from './routes/routes';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 8080;

const generalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests, please try again later.'
});

app.use(helmet());
// Skip /health: the ALB hits it every ~30s and it'd otherwise drown out real traffic.
app.use(morgan('combined', { skip: (request) => request.path === '/health' }));
app.get('/health', (_request, response) => response.status(200).json({ status: 'ok' }));

app.use(express.json({ limit: '100kb' }));
app.use(generalRateLimiter);
app.use('/api/v1', router);

console.log('Starting API server...');

app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on port ${port}`);
});
