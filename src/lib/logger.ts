import pino, { type DestinationStream } from 'pino';
import type { Config } from '../config';

export function createLogger(config: Pick<Config, 'NODE_ENV' | 'LOG_LEVEL'>, destination?: DestinationStream) {
  const options: pino.LoggerOptions = {
    level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      remove: true,
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
