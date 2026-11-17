import { OpenAPIRegistry, OpenApiGeneratorV3, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { ErrorResponse, z } from './zod';
import type { Permission } from './permissions';

export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponse } },
});

interface DocOptions {
  method: RouteConfig['method'];
  path: string;
  tag: string;
  summary: string;
  permission?: Permission;
  public?: boolean;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  response?: z.ZodType;
  status?: 200 | 201 | 204;
}

/** Registers one endpoint in the OpenAPI document with the standard error responses. */
export function doc(o: DocOptions) {
  const status = o.status ?? 200;
  registry.registerPath({
    method: o.method,
    path: o.path,
    tags: [o.tag],
    summary: o.summary,
    description: o.permission ? `Requires permission: \`${o.permission}\`` : undefined,
    security: o.public ? [] : [{ bearerAuth: [] }],
    request: {
      params: o.params,
      query: o.query,
      body: o.body ? { content: { 'application/json': { schema: o.body } }, required: true } : undefined,
    },
    responses: {
      [status]: o.response
        ? { description: 'Success', content: { 'application/json': { schema: o.response } } }
        : { description: 'Success' },
      400: errorResponse('Validation error'),
      ...(o.public ? {} : { 401: errorResponse('Missing or invalid token'), 403: errorResponse('Insufficient permissions') }),
      ...(o.params ? { 404: errorResponse('Resource not found') } : {}),
      409: errorResponse('Conflict or invalid state transition'),
      ...(o.public ? { 429: errorResponse('Too many attempts from this IP (rate limited)') } : {}),
    },
  });
}

export function buildOpenApiDocument() {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'B2B Order Management API',
      version: '1.0.0',
      description:
        'Multi-tenant B2B order management: customers, product catalog, quotes, orders and role-based access control. ' +
        'Money values are integer cents; rates and discounts are basis points (100 bps = 1%).',
    },
    servers: [{ url: '/api/v1' }],
  });
}
