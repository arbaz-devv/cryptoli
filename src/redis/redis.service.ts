import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis | null = null;
  private ready = false;
  private lastError: string | null = null;

  onModuleInit() {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
      this.lastError = 'REDIS_URL is not set';
      return;
    }
    try {
      this.client = new Redis(url, { maxRetriesPerRequest: 10 });
      this.client.on('ready', () => {
        this.ready = true;
        this.lastError = null;
      });
      this.client.on('error', (error: unknown) => {
        this.ready = false;
        this.lastError =
          error instanceof Error ? error.message : 'Unknown Redis error';
      });
      this.client.on('end', () => {
        this.ready = false;
      });
    } catch (error) {
      this.ready = false;
      this.lastError =
        error instanceof Error
          ? error.message
          : 'Failed to initialize Redis client';
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
    this.ready = false;
  }

  getClient(): Redis | null {
    return this.client;
  }

  isReady(): boolean {
    return this.ready && this.client !== null;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  setLastError(error: string | null): void {
    this.lastError = error;
  }
}
