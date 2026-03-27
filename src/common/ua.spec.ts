import { getDeviceAndBrowser } from './ua';

describe('getDeviceAndBrowser', () => {
  it('parses a Chrome desktop UA', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const result = getDeviceAndBrowser(ua);
    expect(result.device).toBe('desktop');
    expect(result.browser).toBe('chrome');
    expect(result.os).toBe('windows');
  });

  it('parses a mobile UA as mobile device', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    const result = getDeviceAndBrowser(ua);
    expect(result.device).toBe('mobile');
    expect(result.browser).toBe('mobile_safari');
    expect(result.os).toBe('ios');
  });

  it('parses a tablet UA as tablet device', () => {
    const ua =
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    const result = getDeviceAndBrowser(ua);
    expect(result.device).toBe('tablet');
  });

  it('defaults unknown device type to desktop', () => {
    const ua =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const result = getDeviceAndBrowser(ua);
    expect(result.device).toBe('desktop');
  });

  it('returns unknown for unrecognizable UA strings', () => {
    const result = getDeviceAndBrowser('totally-not-a-browser');
    expect(result.device).toBe('desktop');
    expect(result.browser).toBe('unknown');
    expect(result.os).toBe('unknown');
  });

  it('handles empty string UA', () => {
    const result = getDeviceAndBrowser('');
    expect(result.device).toBe('desktop');
    expect(result.browser).toBe('unknown');
    expect(result.os).toBe('unknown');
  });

  it('replaces spaces with underscores in browser names', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
    const result = getDeviceAndBrowser(ua);
    // Edge browser name should not contain spaces
    expect(result.browser).not.toMatch(/\s/);
  });

  it('replaces spaces with underscores in OS names', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const result = getDeviceAndBrowser(ua);
    expect(result.os).not.toMatch(/\s/);
  });
});
