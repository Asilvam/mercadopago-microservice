import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MercadopagoController } from './mercadopago.controller';
import { MercadopagoService } from './mercadopago.service';
import { ConfigService } from '@nestjs/config';

describe('MercadopagoController', () => {
  let controller: MercadopagoController;
  let service: jest.Mocked<MercadopagoService>;

  const mockService = {
    createPaymentPreference: jest.fn(),
    acceptWebhook: jest.fn(),
    getReliabilityMetrics: jest.fn(),
  };

  const defaultHeaders = {
    'x-request-id': 'test-req-id',
    'x-signature': 'ts=123,v1=hash',
    'user-agent': 'MercadoPago/Test',
    'content-type': 'application/json',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MercadopagoController],
      providers: [
        { provide: MercadopagoService, useValue: mockService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('internal-secret') } },
      ],
    }).compile();

    controller = module.get(MercadopagoController);
    service = module.get(MercadopagoService);
    mockService.acceptWebhook.mockResolvedValue({
      accepted: true,
      duplicate: false,
      eventKey: 'event-key',
    });
  });

  afterEach(() => jest.clearAllMocks());

  it('delega la creación de preferencias', async () => {
    const dto = {
      courtId: 'cancha-1',
      date: '2026-09-01',
      time: '18:00',
      player1: 'Juan',
      amount: 15000,
      idCourtReserve: 'reserve-001',
    };
    const expected = { preferenceId: 'pref-123', initPoint: 'https://checkout' };
    mockService.createPaymentPreference.mockResolvedValue(expected);

    await expect(controller.createPaymentPreference(dto)).resolves.toEqual(expected);
    expect(service.createPaymentPreference).toHaveBeenCalledWith(dto);
  });

  it('expone métricas operativas sin payloads sensibles', () => {
    mockService.getReliabilityMetrics.mockReturnValue({
      audit: { persisted: 5, connected: true },
      inbox: { enqueued: 3 },
      webhook: { signaturesAccepted: 2 },
    } as never);

    expect(controller.getReliabilityHealth()).toEqual({
      status: 'ok',
      metrics: {
        audit: { persisted: 5, connected: true },
        inbox: { enqueued: 3 },
        webhook: { signaturesAccepted: 2 },
      },
    });
  });

  it('normaliza body, firma y metadata antes de persistir el webhook', async () => {
    const body = { data: { id: 'PAY-body-123' }, type: 'payment', id: 99 };
    const query = { 'data.id': 'PAY-query-456', type: 'payment' };

    await controller.handleWebhook(query, body, defaultHeaders, '127.0.0.1');

    expect(service.acceptWebhook).toHaveBeenCalledWith({
      paymentId: 'PAY-body-123',
      eventType: 'payment',
      requestId: 'test-req-id',
      dataId: 'PAY-query-456',
      xSignature: 'ts=123,v1=hash',
      metadata: expect.objectContaining({
        ipAddress: '127.0.0.1',
        source: 'body',
        userAgent: 'MercadoPago/Test',
      }),
      payload: { body, query },
    });
  });

  it.each([
    [{ data: { id: 'body-id' }, type: 'payment' }, {}, 'body-id'],
    [{}, { 'data.id': 'query-data-id', type: 'payment' }, 'query-data-id'],
    [{}, { id: 'query-id', topic: 'payment' }, 'query-id'],
  ])('extrae paymentId desde los formatos soportados', async (body, query, expectedId) => {
    await controller.handleWebhook(query, body, defaultHeaders, '127.0.0.1');

    expect(service.acceptWebhook).toHaveBeenCalledWith(expect.objectContaining({ paymentId: expectedId, eventType: 'payment' }));
  });

  it('espera la persistencia antes de completar la respuesta', async () => {
    let persist: (value: { accepted: true; duplicate: boolean; eventKey: string }) => void;
    mockService.acceptWebhook.mockReturnValue(
      new Promise((resolve) => {
        persist = resolve;
      }),
    );

    let completed = false;
    const response = controller.handleWebhook({}, { data: { id: '123' }, type: 'payment' }, defaultHeaders, '127.0.0.1').then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    persist!({ accepted: true, duplicate: false, eventKey: 'event-key' });
    await response;
    expect(completed).toBe(true);
  });

  it('rechaza una notificación sin paymentId', async () => {
    await expect(controller.handleWebhook({}, {}, defaultHeaders, '127.0.0.1')).rejects.toBeInstanceOf(BadRequestException);
    expect(service.acceptWebhook).not.toHaveBeenCalled();
  });

  it('acepta pero ignora eventos que no son payment', async () => {
    await expect(controller.handleWebhook({}, { data: { id: '123' }, type: 'merchant_order' }, defaultHeaders, '127.0.0.1')).resolves.toEqual({ accepted: true, ignored: true });
    expect(service.acceptWebhook).not.toHaveBeenCalled();
  });
});
