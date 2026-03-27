import { GeoipService, GeoLookupResult } from '../../src/geoip/geoip.service';

export function createGeoipMock(): jest.Mocked<GeoipService> {
  return {
    onModuleInit: jest.fn().mockResolvedValue(undefined),
    lookup: jest.fn().mockReturnValue({} as GeoLookupResult),
  } as unknown as jest.Mocked<GeoipService>;
}
