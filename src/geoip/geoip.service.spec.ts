import { Test } from '@nestjs/testing';
import { GeoipService } from './geoip.service';

describe('GeoipService', () => {
  let service: GeoipService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [GeoipService],
    }).compile();
    service = module.get(GeoipService);
  });

  describe('lookup() without database', () => {
    it('should return empty result when no .mmdb loaded', () => {
      // onModuleInit not called — reader is null
      expect(service.lookup('8.8.8.8')).toEqual({});
    });

    it('should return empty result for empty IP', () => {
      expect(service.lookup('')).toEqual({});
    });

    it('should return empty result for private IP', () => {
      expect(service.lookup('127.0.0.1')).toEqual({});
    });
  });

  describe('onModuleInit()', () => {
    it('should not throw regardless of .mmdb presence', async () => {
      await expect(service.onModuleInit()).resolves.not.toThrow();
    });

    it('should return empty for private IPs after init', async () => {
      await service.onModuleInit();
      expect(service.lookup('127.0.0.1')).toEqual({});
    });

    it('should return empty for invalid IPs after init', async () => {
      await service.onModuleInit();
      expect(service.lookup('not-an-ip')).toEqual({});
    });
  });
});
