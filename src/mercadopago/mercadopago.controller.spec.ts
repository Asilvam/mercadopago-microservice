import { Test, TestingModule } from '@nestjs/testing';
import { MercadopagoController } from './mercadopago.controller';
import { MercadopagoService } from './mercadopago.service';

describe('MercadopagoController', () => {
  let controller: MercadopagoController;
  let service: jest.Mocked<MercadopagoService>;

  const mockService = {
    createPaymentPreference: jest.fn(),
    handleWebhook: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MercadopagoController],
      providers: [
        { provide: MercadopagoService, useValue: mockService },
      ],
    }).compile();

    controller = module.get<MercadopagoController>(MercadopagoController);
    service = module.get(MercadopagoService);
  });

  afterEach(() => jest.clearAllMocks());

  const defaultHeaders = {
    'x-request-id': 'test-req-id',
    'user-agent': 'MercadoPago/Test',
    'content-type': 'application/json',
  };
  const defaultIp = '127.0.0.1';

  describe('createPaymentPreference', () => {
    it('debería delegar al servicio y retornar el resultado', async () => {
      const dto = {
        courtId: 'cancha-1',
        date: '2026-09-01',
        time: '18:00',
        player1: 'Juan',
        amount: 15000,
        idCourtReserve: 'reserve-001',
      };
      const expectedResult = {
        preferenceId: 'pref-123',
        initPoint: 'https://mercadopago.cl/checkout/...',
      };

      mockService.createPaymentPreference.mockResolvedValue(expectedResult);

      const result = await controller.createPaymentPreference(dto as any);

      expect(service.createPaymentPreference).toHaveBeenCalledWith(dto);
      expect(result).toEqual(expectedResult);
    });
  });

  describe('handleWebhook — extracción de paymentId', () => {
    it('debería extraer paymentId de body.data.id (prioridad 1)', () => {
      const body = { data: { id: 'PAY-body-123' }, type: 'payment' };
      const query = { 'data.id': 'PAY-query-456' };

      controller.handleWebhook(query, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).toHaveBeenCalledWith(
        'PAY-body-123',
        'payment',
        expect.any(Object),
      );
    });

    it('debería extraer paymentId de query data.id (prioridad 2)', () => {
      const body = {};
      const query = { 'data.id': 'PAY-query-456', type: 'payment' };

      controller.handleWebhook(query, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).toHaveBeenCalledWith(
        'PAY-query-456',
        'payment',
        expect.any(Object),
      );
    });

    it('debería extraer paymentId de query.id (prioridad 3)', () => {
      const body = {};
      const query = { id: 'PAY-id-789', type: 'payment' };

      controller.handleWebhook(query, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).toHaveBeenCalledWith(
        'PAY-id-789',
        'payment',
        expect.any(Object),
      );
    });

    it('debería priorizar body.data.id sobre query params', () => {
      const body = { data: { id: 'FROM-BODY' }, type: 'payment' };
      const query = { 'data.id': 'FROM-QUERY', id: 'FROM-QUERY-ID' };

      controller.handleWebhook(query, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).toHaveBeenCalledWith(
        'FROM-BODY',
        'payment',
        expect.any(Object),
      );
    });
  });

  describe('handleWebhook — extracción de eventType', () => {
    it('debería extraer eventType de body.type (prioridad 1)', () => {
      const body = { data: { id: '123' }, type: 'payment' };
      const query = { type: 'merchant_order' };

      controller.handleWebhook(query, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).toHaveBeenCalledWith(
        '123',
        'payment',
        expect.any(Object),
      );
    });

    it('debería extraer eventType de query.type (prioridad 2)', () => {
      const body = { data: { id: '123' } };
      const query = { type: 'payment' };

      controller.handleWebhook(query, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).toHaveBeenCalledWith(
        '123',
        'payment',
        expect.any(Object),
      );
    });

    it('debería extraer eventType de query.topic (prioridad 3)', () => {
      const body = { data: { id: '123' } };
      const query = { topic: 'payment' };

      controller.handleWebhook(query, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).toHaveBeenCalledWith(
        '123',
        'payment',
        expect.any(Object),
      );
    });

    it('debería usar "unknown" si no hay eventType', () => {
      const body = { data: { id: '123' } };
      const query = {};

      // eventType será 'unknown', que no es 'payment', así que no llama a handleWebhook
      controller.handleWebhook(query, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).not.toHaveBeenCalled();
    });
  });

  describe('handleWebhook — sin paymentId', () => {
    it('debería NO llamar al servicio si no hay paymentId', () => {
      const body = {};
      const query = {};

      controller.handleWebhook(query, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).not.toHaveBeenCalled();
    });

    it('debería NO llamar al servicio con body vacío y query vacío', () => {
      controller.handleWebhook({}, {}, defaultHeaders, defaultIp);

      expect(service.handleWebhook).not.toHaveBeenCalled();
    });

    it('debería NO llamar al servicio con body null', () => {
      controller.handleWebhook({}, null as any, defaultHeaders, defaultIp);

      expect(service.handleWebhook).not.toHaveBeenCalled();
    });
  });

  describe('handleWebhook — filtro de eventos', () => {
    it('debería llamar a handleWebhook solo para eventos de tipo "payment"', () => {
      const body = { data: { id: '123' }, type: 'payment' };

      controller.handleWebhook({}, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).toHaveBeenCalled();
    });

    it('debería ignorar eventos de tipo "merchant_order"', () => {
      const body = { data: { id: '123' }, type: 'merchant_order' };

      controller.handleWebhook({}, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).not.toHaveBeenCalled();
    });

    it('debería ignorar eventos de tipo "plan"', () => {
      const body = { data: { id: '123' }, type: 'plan' };

      controller.handleWebhook({}, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).not.toHaveBeenCalled();
    });

    it('debería ignorar eventos de tipo "subscription"', () => {
      const body = { data: { id: '123' }, type: 'subscription' };

      controller.handleWebhook({}, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).not.toHaveBeenCalled();
    });
  });

  describe('handleWebhook — metadata del request', () => {
    it('debería pasar ipAddress, userAgent, contentType y source al servicio', () => {
      const body = { data: { id: '123' }, type: 'payment' };
      const headers = {
        'x-request-id': 'req-abc',
        'user-agent': 'MercadoPago/Webhook',
        'content-type': 'application/json',
      };

      controller.handleWebhook({}, body, headers, '192.168.1.1');

      expect(service.handleWebhook).toHaveBeenCalledWith(
        '123',
        'payment',
        expect.objectContaining({
          ipAddress: '192.168.1.1',
          userAgent: 'MercadoPago/Webhook',
          contentType: 'application/json',
          source: 'body',
        }),
      );
    });

    it('debería indicar source "body" cuando paymentId viene del body', () => {
      const body = { data: { id: '123' }, type: 'payment' };

      controller.handleWebhook({}, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).toHaveBeenCalledWith(
        '123',
        'payment',
        expect.objectContaining({ source: 'body' }),
      );
    });

    it('debería indicar source "query" cuando paymentId viene del query', () => {
      const body = {};
      const query = { 'data.id': '123', type: 'payment' };

      controller.handleWebhook(query, body, defaultHeaders, defaultIp);

      expect(service.handleWebhook).toHaveBeenCalledWith(
        '123',
        'payment',
        expect.objectContaining({ source: 'query' }),
      );
    });
  });
});
