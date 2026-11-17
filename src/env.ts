import { loadEnvFile } from 'node:process';

// Native loading preserves variables already supplied by the shell or container.
try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
