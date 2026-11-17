import cors from 'cors';
import { sql } from 'drizzle-orm';
import express, { Router } from 'express';
import helmet from 'helmet';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Config } from './config';
import type { DB } from './db/client';
import { buildOpenApiDocument } from './lib/openapi';
import { authenticate } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import { authRouter } from './modules/auth';
import { customersRouter } from './modules/customers';
import { ordersRouter } from './modules/orders';
import { productsRouter } from './modules/products';
import { quotesRouter } from './modules/quotes';
import { usersRouter } from './modules/users';

export function createApp({ db, config }: { db: DB; config: Config }) {
  const app = express();
  const logger = pino({ level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL });

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',') }));
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  app.get('/health', async (_req, res) => {
    await db.execute(sql`select 1`);
    res.json({ status: 'ok' });
  });

  const openApiDocument = buildOpenApiDocument();
  app.get('/openapi.json', (_req, res) => res.json(openApiDocument));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  const requireAuth = authenticate(db, config.JWT_SECRET);
  const api = Router();
  api.use('/auth', authRouter(db, config, requireAuth));
  api.use('/users', requireAuth, usersRouter(db));
  api.use('/customers', requireAuth, customersRouter(db));
  api.use('/products', requireAuth, productsRouter(db));
  api.use('/quotes', requireAuth, quotesRouter(db));
  api.use('/orders', requireAuth, ordersRouter(db));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
