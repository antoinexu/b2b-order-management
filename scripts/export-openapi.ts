/** Writes the generated OpenAPI document to docs/openapi.json (for Postman import, client generation, review). */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import '../src/app'; // importing the app registers every route's OpenAPI definition
import { buildOpenApiDocument } from '../src/lib/openapi';

const out = path.resolve(__dirname, '../docs/openapi.json');
writeFileSync(out, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`OpenAPI document written to ${path.relative(process.cwd(), out)}`);
