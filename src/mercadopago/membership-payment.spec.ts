import { validate } from 'class-validator';
import { MercadopagoService } from './mercadopago.service';
import { CreateMembershipPreferenceDto } from './dto/membership-payment.dto';

jest.mock('mercadopago', () => ({
  MercadoPagoConfig: jest.fn(),
  Preference: jest.fn(() => ({ create: jest.fn() })),
  Payment: jest.fn(() => ({ get: jest.fn(), search: jest.fn() })),
  WebhookSignatureValidator: { validate: jest.fn() },
  InvalidWebhookSignatureError: class extends Error {},
}));
jest.mock('uuid', () => ({ v4: () => 'isolated-uuid' }));

describe('Membership Mercado Pago purpose isolation', () => {
  const reference = 'membership-11111111-1111-4111-8111-111111111111';
  let settings: Record<string, string>;
  let service: MercadopagoService;
  let create: jest.Mock, get: jest.Mock, search: jest.Mock, preferenceSearch: jest.Mock;
  let inbox: any;
  const fetchMock = jest.fn();
  const dto = () => ({ purpose: 'MEMBERSHIP', reference, amount: 180, pricingMode: 'TEST', expiresAt: new Date(Date.now() + 1800000).toISOString() });
  const payment = (changes = {}) => ({
    id: 123,
    external_reference: reference,
    transaction_amount: 180,
    currency_id: 'CLP',
    collector_id: 999,
    live_mode: true,
    status: 'approved',
    date_approved: '2026-10-17T12:00:00Z',
    metadata: { purpose: 'MEMBERSHIP', membership_reference: reference, pricing_mode: 'TEST' },
    ...changes,
  });
  beforeEach(() => {
    jest.clearAllMocks();
    settings = {
      MP_ACCESS_TOKEN: 'fixture-token-never-real',
      INTERNAL_API_KEY: 'fixture-internal-key',
      MP_WEBHOOK_SECRET: 'fixture-webhook-secret',
      MP_SUCCESS_URL: 'http://localhost:5173/payment/success?old=value#old',
      NOTIFICATION_URL: 'https://provider-fixture.example.invalid/webhook',
      BACKEND_URL: 'http://localhost:3500',
    };
    create = jest.fn().mockResolvedValue({
      id: 'pref-fixture',
      collector_id: 999,
      init_point: 'https://www.mercadopago.cl/checkout/v1/redirect?pref_id=fixture',
      sandbox_init_point: 'https://sandbox.mercadopago.cl/checkout/v1/redirect?pref_id=fixture',
    });
    get = jest.fn().mockResolvedValue(payment());
    search = jest.fn().mockResolvedValue({ results: [payment()], paging: { total: 1 } });
    preferenceSearch = jest.fn().mockResolvedValue({ total: 1, elements: [{ id: 'pref-fixture', collector_id: 999, external_reference: reference, live_mode: true }] });
    const sdk = jest.requireMock('mercadopago');
    sdk.Preference.mockImplementation(() => ({ create, search: preferenceSearch }));
    sdk.Payment.mockImplementation(() => ({ get, search }));
    inbox = {
      enqueue: jest.fn().mockResolvedValue({ created: true }),
      claimNext: jest.fn().mockResolvedValue(null),
      executeEffectOnce: jest.fn(async (_a, _b, _c, handler) => {
        await handler();
        return true;
      }),
    };
    service = new MercadopagoService({ get: (key: string) => settings[key] } as any, { createAuditLog: jest.fn().mockResolvedValue(undefined) } as any, inbox);
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ id: 999, site_id: 'MLC' }) });
    global.fetch = fetchMock;
  });
  it('creates a separate monthly preference with exact amount, metadata, expiration and return reference', async () => {
    const result = await service.createMembershipPreference(dto());
    expect(result.preferenceId).toBe('pref-fixture');
    const body = create.mock.calls[0][0].body;
    expect(body.external_reference).toBe(reference);
    expect(body.notification_url).toBe(settings.NOTIFICATION_URL);
    expect(body.items[0]).toMatchObject({ unit_price: 180, currency_id: 'CLP' });
    expect(body.metadata).toEqual({ purpose: 'MEMBERSHIP', membership_reference: reference, pricing_mode: 'TEST' });
    expect(body.back_urls.success).toContain(`reference=${reference}`);
    expect(body.back_urls.success).toBe(`http://localhost:5173/monthlypayments?reference=${reference}`);
    expect(body.auto_return).toBeUndefined();
    expect(body.expires).toBe(true);
  });
  it('reuses the existing HTTPS frontend origin without changing reservation return paths', async () => {
    settings.MP_SUCCESS_URL = 'https://frontend.example.invalid/payment/success';
    await service.createMembershipPreference(dto());
    const body = create.mock.calls[0][0].body;
    expect(body.back_urls.success).toBe(`https://frontend.example.invalid/monthlypayments?reference=${reference}`);
    expect(body.back_urls.pending).toBe(body.back_urls.success);
    expect(body.back_urls.failure).toBe(body.back_urls.success);
    expect(body.auto_return).toBe('approved');
    expect(settings.MP_SUCCESS_URL).toBe('https://frontend.example.invalid/payment/success');
  });
  it('selects sandbox using the verified provider preference, not the low TEST tariff', async () => {
    preferenceSearch.mockResolvedValue({ total: 1, elements: [{ id: 'pref-fixture', collector_id: 999, external_reference: reference, live_mode: false }] });
    expect((await service.createMembershipPreference(dto())).initPoint).toContain('sandbox.mercadopago.cl');
  });
  it('uses a supported preference search limit while checking uniqueness', async () => {
    await service.createMembershipPreference(dto());
    expect(preferenceSearch).toHaveBeenCalledWith({ options: { external_reference: reference, limit: 2 } });
    await service.getMembershipPayment('123');
    expect(preferenceSearch).toHaveBeenLastCalledWith({ options: { external_reference: reference, limit: 2 } });
  });
  it('requires a verified Chile account before creating a preference, with no monthly env variables', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 999, site_id: 'MLA' }) });
    await expect(service.createMembershipPreference(dto())).rejects.toThrow('Chile');
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects unexpected redirect URLs and incomplete provider evidence', async () => {
    create.mockResolvedValue({ id: 'pref-fixture', collector_id: 999, init_point: 'https://evil.example.invalid/pay' });
    await expect(service.createMembershipPreference(dto())).rejects.toThrow('Unexpected');
    preferenceSearch.mockResolvedValue({ total: 1, elements: [{ id: 'pref-fixture', collector_id: 999, external_reference: reference }] });
    await expect(service.getMembershipPayment('123')).rejects.toThrow('mode');
  });
  it('validates complete dues amounts and fixed monthly purpose through DTOs', async () => {
    for (const change of [{ amount: 0 }, { amount: 1.5 }, { amount: -1 }, { purpose: 'RESERVATION' }, { reference: 'a-reservation-id' }, { pricingMode: 'client-price' }]) {
      expect((await validate(Object.assign(new CreateMembershipPreferenceDto(), dto(), change))).length).toBeGreaterThan(0);
      await expect(service.createMembershipPreference({ ...dto(), ...change })).rejects.toThrow();
    }
  });
  it('reads fresh provider facts and rejects missing or inconsistent purpose/reference', async () => {
    expect(await service.getMembershipPayment('123')).toMatchObject({ paymentId: '123', purpose: 'MEMBERSHIP', amount: 180, collectorId: '999', liveMode: true });
    get.mockResolvedValue(payment({ metadata: {} }));
    await expect(service.getMembershipPayment('123')).rejects.toThrow('inconsistent');
  });
  it('dispatches membership approval only to monthly callback, never reservation activation/email', async () => {
    await service.handleWebhook('123');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:3500/membership-billing/internal/mercado-pago');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ paymentId: '123' });
    expect(inbox.executeEffectOnce.mock.calls[0][2]).toBe('MEMBERSHIP_PAYMENT');
  });
  it('processes a later refund with a distinct durable effect key', async () => {
    await service.handleWebhook('123');
    const first = inbox.executeEffectOnce.mock.calls[0][0];
    get.mockResolvedValue(payment({ status: 'refunded', transaction_amount_refunded: 180 }));
    await service.handleWebhook('123');
    expect(inbox.executeEffectOnce.mock.calls[1][0]).not.toBe(first);
  });
  it('never falls back to reservation callbacks for malformed monthly metadata', async () => {
    get.mockResolvedValue(payment({ metadata: { purpose: 'RESERVATION' } }));
    await expect(service.handleWebhook('123')).rejects.toThrow('inconsistent');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('reconciles through the inbox and refuses partial provider searches', async () => {
    expect(await service.reconcileMembership(reference)).toEqual({ queued: 1 });
    expect(inbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({ paymentId: '123', eventType: 'payment' }));
    search.mockResolvedValue({ results: [payment()], paging: { total: 2 } });
    await expect(service.reconcileMembership(reference)).rejects.toThrow('Incomplete');
  });
  it('reports readiness from the existing account and webhook configuration without creating preferences', async () => {
    expect(await service.membershipConfiguration()).toEqual({ ready: true, collectorId: '999', currency: 'CLP' });
    expect(create).not.toHaveBeenCalled();
  });
  it('refuses readiness without a signed public webhook', async () => {
    delete settings.MP_WEBHOOK_SECRET;
    await expect(service.membershipConfiguration()).rejects.toThrow('signed public');
    settings.MP_WEBHOOK_SECRET = 'fixture';
    settings.NOTIFICATION_URL = 'http://localhost:3000/mercadopago/webhook';
    await expect(service.membershipConfiguration()).rejects.toThrow('signed public');
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects a preference collected by another account', async () => {
    create.mockResolvedValue({ id: 'pref-fixture', collector_id: 998, init_point: 'https://www.mercadopago.cl/checkout' });
    await expect(service.createMembershipPreference(dto())).rejects.toThrow('collector');
  });
  it('never guesses a mode when provider preferences are ambiguous or incomplete', async () => {
    preferenceSearch.mockResolvedValue({ total: 2, elements: [] });
    await expect(service.createMembershipPreference(dto())).rejects.toThrow('uniquely');
  });
  it('does not deliver a mismatched account or mode to the backend callback', async () => {
    get.mockResolvedValue(payment({ live_mode: false }));
    await expect(service.handleWebhook('123')).rejects.toThrow('mode');
    expect(fetchMock.mock.calls.every((call) => call[0] === 'https://api.mercadopago.com/users/me')).toBe(true);
    expect(inbox.executeEffectOnce).not.toHaveBeenCalled();
  });
  it('does not offer sandbox checkout for standard monthly dues', async () => {
    preferenceSearch.mockResolvedValue({ total: 1, elements: [{ id: 'pref-fixture', collector_id: 999, external_reference: reference, live_mode: false }] });
    await expect(service.createMembershipPreference({ ...dto(), pricingMode: 'STANDARD' })).rejects.toThrow('Sandbox');
  });
});
