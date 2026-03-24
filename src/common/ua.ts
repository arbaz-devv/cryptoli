import UAParser from 'ua-parser-js';

export function getDeviceAndBrowser(userAgent: string): {
  device: string;
  browser: string;
  os: string;
} {
  const parser = new UAParser.UAParser(userAgent || '');
  const result = parser.getResult();
  const d = (result.device?.type || 'desktop').toLowerCase();
  const deviceType = d === 'mobile' || d === 'tablet' ? d : 'desktop';
  return {
    device: deviceType,
    browser: (result.browser?.name || 'unknown')
      .toLowerCase()
      .replace(/\s+/g, '_'),
    os: (result.os?.name || 'unknown').toLowerCase().replace(/\s+/g, '_'),
  };
}
