import { createHmac } from 'crypto';
import { MercadopagoService } from './mercadopago.service';

jest.mock('uuid', () => ({ v4: jest.fn(() => 'test-uuid') }));

describe('MercadopagoService real webhook signature validation', () => {
  const secret = 'test-webhook-secret';
  const now = 1_792_000_000_000;
  let service: MercadopagoService;
  let enqueue: jest.Mock;

  const webhook = (timestamp = String(now), signingSecret = secret) => {
    const paymentId = '123456789';
    const requestId = 'test-request-id';
    const manifest = `id:${paymentId};request-id:${requestId};ts:${timestamp};`;
    const hash = createHmac('sha256', signingSecret).update(manifest).digest('hex');
    return {
      paymentId,
      eventType: 'payment',
      dataId: paymentId,
      requestId,
      xSignature: `ts=${timestamp},v1=${hash}`,
      metadata: { source: 'query' },
      payload: { body: { data: { id: paymentId } }, query: { 'data.id': paymentId } },
    };
  };

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const config: Record<string, string | number> = {
      MP_ACCESS_TOKEN: 'TEST-token-unused-for-network',
      MP_WEBHOOK_SECRET: secret,
      MP_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS: 300,
    };
    enqueue = jest.fn().mockResolvedValue({ created: true, eventKey: 'test-event' });
    service = new MercadopagoService(
      { get: (key: string) => config[key] } as any,
      { createAuditLog: jest.fn() } as any,
      { enqueue, claimNext: jest.fn().mockResolvedValue(null) } as any,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('accepts a valid HMAC through the real SDK before persisting', async () => {
    await expect(service.acceptWebhook(webhook())).resolves.toEqual(
      expect.objectContaining({ accepted: true, duplicate: false }),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('rejects a signature generated with a different secret', async () => {
    await expect(service.acceptWebhook(webhook(String(now), 'incorrect-secret')))
      .rejects.toThrow('Invalid Mercado Pago webhook signature');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(['dataId', 'requestId'])('rejects tampering with %s', async (field) => {
    await expect(service.acceptWebhook({ ...webhook(), [field]: 'tampered-value' }))
      .rejects.toThrow('Invalid Mercado Pago webhook signature');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each([-301_000, 301_000])('rejects a valid HMAC outside the time window (%i ms)', async (offset) => {
    await expect(service.acceptWebhook(webhook(String(now + offset))))
      .rejects.toThrow('Invalid Mercado Pago webhook signature');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a request without its signature header', async () => {
    await expect(service.acceptWebhook({ ...webhook(), xSignature: undefined }))
      .rejects.toThrow('Invalid Mercado Pago webhook signature');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
