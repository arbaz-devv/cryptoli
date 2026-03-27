import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Reader, AddressNotFoundError } from '@maxmind/geoip2-node';
import type ReaderModel from '@maxmind/geoip2-node/dist/src/readerModel';
import { join } from 'path';

export interface GeoLookupResult {
  country?: string;
  city?: string;
  region?: string;
  timezone?: string;
}

@Injectable()
export class GeoipService implements OnModuleInit {
  private reader: ReaderModel | null = null;
  private readonly logger = new Logger(GeoipService.name);
  private readonly dbPath = join(
    process.cwd(),
    'data',
    'geoip',
    'GeoLite2-City.mmdb',
  );

  async onModuleInit(): Promise<void> {
    try {
      this.reader = await Reader.open(this.dbPath);
      this.logger.log('GeoIP database loaded');
    } catch {
      this.logger.warn(
        'GeoIP database not available — lookups will return empty results',
      );
    }
  }

  lookup(ip: string): GeoLookupResult {
    if (!this.reader) return {};
    try {
      const res = this.reader.city(ip);
      return {
        country: res.country?.isoCode ?? res.registeredCountry?.isoCode,
        city: res.city?.names?.en,
        region: res.subdivisions?.[0]?.isoCode,
        timezone: res.location?.timeZone,
      };
    } catch (err) {
      if (err instanceof AddressNotFoundError) return {};
      this.logger.debug(`GeoIP lookup error for ${ip}: ${err}`);
      return {};
    }
  }
}
