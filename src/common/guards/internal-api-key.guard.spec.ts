import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { InternalApiKeyGuard } from './internal-api-key.guard';

describe('InternalApiKeyGuard', () => {
  const context = (key?: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-api-key': key } }) }),
    }) as any;

  it('accepts the configured key', () => {
    const guard = new InternalApiKeyGuard({ get: () => 'secret' } as any);
    expect(guard.canActivate(context('secret'))).toBe(true);
  });

  it('rejects an invalid key', () => {
    const guard = new InternalApiKeyGuard({ get: () => 'secret' } as any);
    expect(() => guard.canActivate(context('invalid'))).toThrow(UnauthorizedException);
  });

  it('fails closed when configuration is missing', () => {
    const guard = new InternalApiKeyGuard({ get: () => undefined } as any);
    expect(() => guard.canActivate(context('secret'))).toThrow(ServiceUnavailableException);
  });
});
