import cors from 'cors';
import { sql } from 'drizzle-orm';
import express, { Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Config } from './config';
import type { DB } from './db/client';
import { buildOpenApiDocument } from './lib/openapi';
import { createLogger } from './lib/logger';
import { authenticate } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import { authRouter } from './modules/auth';
import { customersRouter } from './modules/customers';
import { ordersRouter } from './modules/orders';
import { organizationRouter } from './modules/organization';
import { productsRouter } from './modules/products';
import { quotesRouter } from './modules/quotes';
import { usersRouter } from './modules/users';

export function createApp({ db, config }: { db: DB; config: Config }) {
  const app = express();
  const logger = createLogger(config);

  app.disable('x-powered-by');
  // Behind a load balancer, trust its X-Forwarded-For so rate limiting sees real client IPs.
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',') }));
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  // 503 (not 500) when the database is unreachable, so orchestrators and load balancers mark the instance unhealthy.
  app.get('/health', async (req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: 'ok' });
    } catch (err) {
      req.log.warn({ err }, 'Health check failed: database unreachable');
      res.status(503).json({ status: 'unavailable' });
    }
  });

  const openApiDocument = buildOpenApiDocument();
  app.get('/openapi.json', (_req, res) => res.json(openApiDocument));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  const requireAuth = authenticate(db, config.JWT_SECRET);
  const api = Router();
  api.use('/auth', authRouter(db, config, requireAuth));
  api.use('/organization', requireAuth, organizationRouter(db));
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
